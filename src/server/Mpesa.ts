import { randomBytes } from 'node:crypto'
import { Challenge, Method, Receipt, Store } from 'mppx'
import * as Methods from '../Methods.js'
import { Daraja, type DarajaConfig, DarajaError, normalizePhone } from '../daraja/Daraja.js'
import { parseC2BConfirmation, parseRatibaCallback, parseStkCallback } from '../daraja/Callbacks.js'
import { type InitRecord, keys, type StkRecord, type SubscriptionRecord } from './State.js'

type AnyRecord = StkRecord | SubscriptionRecord | InitRecord | { expires: number; type: 'mppx:replay' } | string

export type RequestInfo = { headers: Headers; url: URL }

export type MpesaServerConfig = {
  /** Daraja credentials, or a pre-built client. */
  daraja: DarajaConfig | Daraja
  /** Durable atomic store. */
  store: Store.AtomicStore<any>
  /** Same secret passed to `Mppx.create`. Used to verify Challenges at the initiate endpoint. */
  secretKey: string
  /** Public origin Safaricom and clients can reach */
  publicUrl: string
  /** Path prefix for the method's routes. @default "/mpesa" */
  basePath?: string
  /** Unguessable path segment for Daraja callbacks (callbacks are unsigned). At least 16 chars. */
  callbackToken: string
  /** Receiving Paybill/till. @default the Daraja shortcode */
  recipient?: string
  shortcodeType?: 'paybill' | 'till'
  /** AccountReference shown on STK prompts (max 12 chars). @default "MPP" */
  accountReference?: string
  /**
   * Maps a request to a stable customer identity (API key, user id, wallet...).
   * Needed for subscriptions: MPP says a subscriptionId alone must not grant access,
   * so later requests are matched to an active subscription through this identity.
   */
  identify?: (request: RequestInfo) => string | undefined | Promise<string | undefined>
  /** Extra time after a period ends before access lapses (Ratiba runs once a day). @default 1 day */
  gracePeriodMs?: number
  /** Default subscription length when the Challenge has no `subscriptionExpires`. @default 365 days */
  defaultSubscriptionMs?: number
  /** How long a pending STK Push waits for its callback before the status route queries Daraja. @default 20s */
  stkQueryAfterMs?: number
  /** Log hook for callbacks and failures. */
  log?: (event: string, data?: Record<string, unknown>) => void
}

const DAY = 24 * 60 * 60 * 1000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function newRef(): string {
  // 12 uppercase alphanumerics.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(12)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/**
 * Creates the server side of the `mpesa` payment method.
 *
 * Returns the two MPP server methods (pass them to `Mppx.create`) and a
 * `handle` function that serves the initiate, status and Daraja callback routes.
 */
export function mpesa(config: MpesaServerConfig) {
  if (config.callbackToken.length < 16) throw new Error('callbackToken must be at least 16 characters')

  const daraja = config.daraja instanceof Daraja ? config.daraja : new Daraja(config.daraja)
  const store = config.store as Store.AtomicStore<Record<string, AnyRecord>>
  const basePath = (config.basePath ?? '/mpesa').replace(/\/$/, '')
  const origin = config.publicUrl.replace(/\/$/, '')
  const recipient = config.recipient ?? daraja.config.shortcode
  const shortcodeType = config.shortcodeType ?? 'paybill'
  const grace = config.gracePeriodMs ?? DAY
  const log = config.log ?? (() => {})

  const urls = {
    initiate: `${origin}${basePath}/initiate`,
    status: `${origin}${basePath}/status`,
    stkCallback: `${origin}${basePath}/callback/stk/${config.callbackToken}`,
    ratibaCallback: `${origin}${basePath}/callback/ratiba/${config.callbackToken}`,
    c2bConfirmation: `${origin}${basePath}/callback/c2b/${config.callbackToken}`,
  }

  const methodDetails = { initiateUrl: urls.initiate, statusUrl: urls.status, shortcodeType }
  type Defaults = { currency: 'KES'; recipient: string; methodDetails: typeof methodDetails }
  const defaults: Defaults = { currency: 'KES', recipient, methodDetails }

  const get = async <T>(key: string) => (await store.get(key)) as T | null
  const put = (key: string, value: AnyRecord) => store.put(key, value)

  /** Atomically mutates a record; returns the updated value (or null if missing). */
  const mutate = <T extends AnyRecord>(key: string, fn: (current: T) => T | undefined) =>
    store.update(key, (current) => {
      if (current === null) return { op: 'noop', result: null }
      const next = fn(current as T)
      return next === undefined ? { op: 'noop', result: current as T } : { op: 'set', value: next, result: next }
    }) as Promise<T | null>

  // -------------------------------------------------------------------------
  // MPP server methods
  // -------------------------------------------------------------------------

  const charge = Method.toServer<typeof Methods.charge, Defaults>(Methods.charge, {
    defaults,
    async broadcast({ credential }) {
      const { challenge } = credential
      const id = credential.payload.checkoutRequestId
      let rec = await get<StkRecord>(keys.stk(id))
      if (!rec || rec.kind !== 'stk') throw new Error('Unknown M-Pesa payment')
      if (rec.challengeId !== challenge.id) throw new Error('M-Pesa payment was made for a different challenge')
      if (rec.amount !== challenge.request.amount) throw new Error('M-Pesa amount does not match the challenge')
      if (rec.recipient !== challenge.request.recipient) throw new Error('M-Pesa recipient does not match the challenge')
      if (rec.status === 'pending') rec = (await refreshStk(id)) ?? rec
      if (rec.status !== 'paid') throw new Error(`M-Pesa payment not completed: ${rec.reason ?? rec.status}`)

      const claimed = await Store.tryClaim(store, keys.usedStk(id), Date.now() + 90 * DAY)
      if (!claimed) throw new Error('M-Pesa payment has already been redeemed')
      await mutate<StkRecord>(keys.stk(id), (r) => ({ ...r, consumedAt: Date.now() }))

      return Receipt.from({
        method: Methods.METHOD_NAME,
        reference: rec.mpesaReceiptNumber ?? id,
        status: 'success',
        timestamp: new Date().toISOString(),
        ...(challenge.request.externalId ? { externalId: challenge.request.externalId } : {}),
      })
    },
  })

  const subscription = Method.toServer<typeof Methods.subscription, Defaults>(Methods.subscription, {
    defaults,
    async request({ request }) {
      // Reject periods Ratiba cannot represent before a Challenge is ever issued.
      Methods.toRatibaFrequency(request.periodCount, request.periodUnit)
      return request
    },
    async authorize({ input, request }) {
      if (!config.identify) return undefined
      const identity = await config.identify({ headers: input.headers, url: new URL(input.url) })
      if (!identity) return undefined
      const ref = await get<string>(keys.identity(identity))
      if (!ref) return undefined
      const rec = await get<SubscriptionRecord>(keys.sub(ref))
      if (!rec || !isActive(rec)) return undefined
      if (
        rec.amount !== request.amount ||
        rec.periodCount !== request.periodCount ||
        rec.periodUnit !== request.periodUnit ||
        rec.recipient !== request.recipient
      )
        return undefined
      return { receipt: subscriptionReceipt(rec, request.externalId) }
    },
    async broadcast({ credential, envelope }) {
      const { challenge } = credential
      const ref = credential.payload.standingOrderRef
      const rec = await get<SubscriptionRecord>(keys.sub(ref))
      if (!rec || rec.kind !== 'subscription') throw new Error('Unknown M-Pesa standing order')
      if (rec.challengeId !== challenge.id) throw new Error('Standing order was created for a different challenge')
      const r = challenge.request
      if (
        rec.amount !== r.amount ||
        rec.periodCount !== r.periodCount ||
        rec.periodUnit !== r.periodUnit ||
        rec.recipient !== r.recipient
      )
        throw new Error('Standing order terms do not match the challenge')
      if (!isActive(rec)) throw new Error(`Standing order not active: ${rec.reason ?? rec.status}`)

      if (config.identify && envelope?.capturedRequest) {
        const identity = await config.identify({
          headers: envelope.capturedRequest.headers,
          url: envelope.capturedRequest.url,
        })
        if (identity) {
          await put(keys.identity(identity), ref)
          await mutate<SubscriptionRecord>(keys.sub(ref), (s) => ({ ...s, identity }))
        }
      }
      return subscriptionReceipt(rec, r.externalId)
    },
  })

  function isActive(rec: SubscriptionRecord, now = Date.now()) {
    return rec.status === 'active' && rec.paidThrough !== undefined && rec.paidThrough + grace > now && rec.expiresAt > now
  }

  function subscriptionReceipt(rec: SubscriptionRecord, externalId?: string) {
    return Receipt.from({
      method: Methods.METHOD_NAME,
      reference: rec.lastTransactionId ?? rec.ref,
      subscriptionId: rec.ref,
      status: 'success',
      timestamp: new Date().toISOString(),
      ...(externalId ? { externalId } : {}),
    })
  }

  /** Falls back to STK Push Query when the callback is late. */
  async function refreshStk(id: string): Promise<StkRecord | null> {
    let result
    try {
      result = await daraja.stkQuery(id)
    } catch (error) {
      // Daraja answers "still processing" with an HTTP error; treat as pending.
      log('stk.query.pending', { id, error: String(error) })
      return null
    }
    if (result.ResultCode === undefined) return null
    return mutate<StkRecord>(keys.stk(id), (r) => {
      if (r.status !== 'pending') return undefined
      return result.ResultCode === '0'
        ? { ...r, status: 'paid' }
        : { ...r, status: 'failed', reason: result.ResultDesc ?? `ResultCode ${result.ResultCode}` }
    })
  }

  // -------------------------------------------------------------------------
  // HTTP routes
  // -------------------------------------------------------------------------

  async function initiate(req: Request): Promise<Response> {
    let body: { challenge?: string; phone?: string }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return json({ error: 'invalid_json' }, 400)
    }
    if (!body.challenge || !body.phone) return json({ error: 'challenge and phone are required' }, 400)

    let phone: string
    try {
      phone = normalizePhone(body.phone)
    } catch (e) {
      return json({ error: 'invalid_phone', message: (e as Error).message }, 400)
    }

    let challenge: Challenge.Challenge
    try {
      challenge = Challenge.deserialize(body.challenge)
    } catch {
      return json({ error: 'invalid_challenge' }, 400)
    }
    if (!Challenge.verify(challenge, { secretKey: config.secretKey }))
      return json({ error: 'challenge_not_issued_here' }, 400)
    if (challenge.method !== Methods.METHOD_NAME) return json({ error: 'wrong_method' }, 400)
    if (challenge.expires && Date.parse(challenge.expires) < Date.now()) return json({ error: 'challenge_expired' }, 400)

    // Idempotency: one STK Push / standing order per Challenge.
    type Lock = { won: true } | { won: false; existing: InitRecord }
    const lock = await store.update<string, Lock>(keys.init(challenge.id), (current) =>
      current === null
        ? { op: 'set', value: { state: 'starting' } as InitRecord, result: { won: true } }
        : { op: 'noop', result: { won: false, existing: current as InitRecord } },
    )
    if (!lock.won) {
      const existing = lock.existing
      if (existing.state === 'started') return json({ id: existing.id, kind: existing.kind, status: 'pending' })
      return json({ error: 'in_progress' }, 409)
    }

    try {
      if (challenge.intent === 'charge') return await startCharge(challenge, phone)
      if (challenge.intent === 'subscription') return await startSubscription(challenge, phone)
      await store.delete(keys.init(challenge.id))
      return json({ error: 'unsupported_intent' }, 400)
    } catch (error) {
      await store.delete(keys.init(challenge.id))
      log('initiate.failed', { challengeId: challenge.id, error: String(error) })
      const status = error instanceof DarajaError ? 502 : 400
      return json({ error: 'initiate_failed', message: (error as Error).message }, status)
    }
  }

  async function startCharge(challenge: Challenge.Challenge, phone: string) {
    const request = challenge.request as { amount: string; recipient: string; description?: string }
    const push = await daraja.stkPush({
      phone,
      amount: request.amount,
      partyB: request.recipient,
      shortcodeType,
      accountReference: config.accountReference ?? 'MPP',
      description: request.description ?? 'MPP payment',
      callbackUrl: urls.stkCallback,
    })
    const id = push.CheckoutRequestID
    const rec: StkRecord = {
      kind: 'stk',
      challengeId: challenge.id,
      amount: request.amount,
      recipient: request.recipient,
      phone,
      status: 'pending',
      createdAt: Date.now(),
    }
    await put(keys.stk(id), rec)
    await put(keys.init(challenge.id), { state: 'started', id, kind: 'stk' })
    return json({ id, kind: 'stk', status: 'pending', message: push.CustomerMessage ?? 'Approve the M-Pesa prompt on your phone' })
  }

  async function startSubscription(challenge: Challenge.Challenge, phone: string) {
    const request = challenge.request as {
      amount: string
      recipient: string
      periodCount: string
      periodUnit: Methods.PeriodUnit
      description?: string
      subscriptionExpires?: string
    }
    const frequency = Methods.toRatibaFrequency(request.periodCount, request.periodUnit)
    const ref = newRef()
    const now = new Date()
    const expiresAt = request.subscriptionExpires
      ? Date.parse(request.subscriptionExpires)
      : now.getTime() + (config.defaultSubscriptionMs ?? 365 * DAY)

    const rec: SubscriptionRecord = {
      kind: 'subscription',
      ref,
      challengeId: challenge.id,
      amount: request.amount,
      recipient: request.recipient,
      periodCount: request.periodCount,
      periodUnit: request.periodUnit,
      phone,
      accountReference: ref,
      status: 'pending',
      createdAt: now.getTime(),
      expiresAt,
    }
    // Write before calling Daraja so a fast callback always finds the record.
    await put(keys.sub(ref), rec)
    await put(keys.account(ref), ref)
    await daraja.createStandingOrder({
      name: `MPP ${ref}`,
      startDate: now,
      endDate: new Date(expiresAt),
      phone,
      amount: request.amount,
      frequency,
      receiver: request.recipient,
      shortcodeType,
      accountReference: ref,
      description: (request.description ?? 'MPP sub').slice(0, 13),
      callbackUrl: `${urls.ratibaCallback}?ref=${ref}`,
    })
    await put(keys.init(challenge.id), { state: 'started', id: ref, kind: 'subscription' })
    return json({
      id: ref,
      kind: 'subscription',
      status: 'pending',
      message: 'Approve the M-Pesa Ratiba standing order on your phone',
    })
  }

  async function status(req: Request): Promise<Response> {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return json({ error: 'id is required' }, 400)

    const stk = await get<StkRecord>(keys.stk(id))
    if (stk) {
      let rec = stk
      if (rec.status === 'pending' && Date.now() - rec.createdAt > (config.stkQueryAfterMs ?? 20_000))
        rec = (await refreshStk(id)) ?? rec
      return json({ id, kind: 'stk', status: rec.status, reference: rec.mpesaReceiptNumber, reason: rec.reason })
    }
    const sub = await get<SubscriptionRecord>(keys.sub(id))
    if (sub)
      return json({
        id,
        kind: 'subscription',
        status: sub.status,
        reference: sub.lastTransactionId,
        paidThrough: sub.paidThrough ? new Date(sub.paidThrough).toISOString() : undefined,
        reason: sub.reason,
      })
    return json({ error: 'not_found' }, 404)
  }

  async function stkCallback(req: Request): Promise<Response> {
    const cb = parseStkCallback(await req.json())
    log('callback.stk', { ...cb })
    await mutate<StkRecord>(keys.stk(cb.checkoutRequestId), (r) => {
      if (r.status !== 'pending') return undefined
      if (cb.resultCode !== 0) return { ...r, status: 'failed', reason: cb.resultDesc }
      if (cb.amount !== undefined && Number(cb.amount) !== Number(r.amount))
        return { ...r, status: 'failed', reason: `amount mismatch: paid ${cb.amount}, expected ${r.amount}` }
      return { ...r, status: 'paid', mpesaReceiptNumber: cb.mpesaReceiptNumber }
    })
    return json({ ResultCode: 0, ResultDesc: 'Accepted' })
  }

  async function ratibaCallback(req: Request): Promise<Response> {
    const ref = new URL(req.url).searchParams.get('ref')
    const cb = parseRatibaCallback(await req.json())
    log('callback.ratiba', { ref, ...cb })
    if (ref) {
      await mutate<SubscriptionRecord>(keys.sub(ref), (s) => {
        if (s.status !== 'pending') return undefined
        if (!cb.ok) return { ...s, status: 'failed', reason: cb.description ?? `responseCode ${cb.responseCode}` }
        const now = new Date()
        return {
          ...s,
          status: 'active',
          activatedAt: now.getTime(),
          paidThrough: Methods.addPeriod(now, s.periodCount, s.periodUnit).getTime(),
          lastTransactionId: cb.transactionId,
        }
      })
      if (cb.transactionId && cb.ok) await Store.tryClaim(store, keys.usedTrans(cb.transactionId), Date.now() + 400 * DAY)
    }
    return json({ ResultCode: 0, ResultDesc: 'Accepted' })
  }

  /** Renewal collections arrive on the Paybill's C2B confirmation URL. */
  async function c2bCallback(req: Request): Promise<Response> {
    const c2b = parseC2BConfirmation(await req.json())
    log('callback.c2b', { ...c2b })
    const ref = await get<string>(keys.account(c2b.billRefNumber))
    if (ref && (await Store.tryClaim(store, keys.usedTrans(c2b.transId), Date.now() + 400 * DAY))) {
      await mutate<SubscriptionRecord>(keys.sub(ref), (s) => {
        if (s.status !== 'active' || Number(c2b.transAmount) < Number(s.amount)) return undefined
        const now = Date.now()
        const base = s.paidThrough !== undefined && s.paidThrough + grace > now ? s.paidThrough : now
        return {
          ...s,
          paidThrough: Methods.addPeriod(new Date(base), s.periodCount, s.periodUnit).getTime(),
          lastTransactionId: c2b.transId,
        }
      })
    }
    return json({ ResultCode: 0, ResultDesc: 'Accepted' })
  }

  /**
   * Handles the method's routes. Returns `undefined` for paths it does not own,
   * so it can sit in front of any fetch-style router.
   */
  async function handle(req: Request): Promise<Response | undefined> {
    const { pathname } = new URL(req.url)
    if (!pathname.startsWith(`${basePath}/`)) return undefined
    const route = pathname.slice(basePath.length)
    try {
      if (req.method === 'POST' && route === '/initiate') return await initiate(req)
      if (req.method === 'GET' && route === '/status') return await status(req)
      if (req.method === 'POST' && route === `/callback/stk/${config.callbackToken}`) return await stkCallback(req)
      if (req.method === 'POST' && route === `/callback/ratiba/${config.callbackToken}`) return await ratibaCallback(req)
      if (req.method === 'POST' && route === `/callback/c2b/${config.callbackToken}`) return await c2bCallback(req)
    } catch (error) {
      log('route.error', { route, error: String(error) })
      return json({ error: 'bad_request' }, 400)
    }
    return undefined
  }

  return {
    charge,
    subscription,
    handle,
    /** URLs to register with Safaricom (the C2B confirmation URL is needed for Ratiba renewals). */
    urls,
    daraja,
  }
}
