import { Challenge, Credential, Method } from 'mppx'
import * as Methods from '../Methods.js'

export type MpesaClientParameters = {
  /** M-Pesa number to prompt (07xx..., 2547..., +2547...). */
  phone: string | ((challenge: Challenge.Challenge) => string | Promise<string>)
  /**
   * Called once Safaricom has sent the prompt, so the agent or app can tell the
   * human to approve it on their phone.
   */
  onPrompt?: (info: { message: string; challenge: Challenge.Challenge; id: string }) => void
  /** Refuse any single charge above this many KES. Strongly recommended for agents. */
  maxChargeAmount?: number
  /** Refuse subscriptions costing more than this many KES per billing period. */
  maxSubscriptionAmount?: number
  /** Poll interval for the status URL. @default 2000 */
  pollIntervalMs?: number
  /** Give up after this long. @default 120000 (charge), 300000 (subscription) */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

type StatusBody = { status?: string; reason?: string; error?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pay(
  challenge: Challenge.Challenge,
  details: { initiateUrl: string; statusUrl: string },
  doneStatus: 'paid' | 'active',
  parameters: MpesaClientParameters,
  defaultTimeout: number,
): Promise<string> {
  const fetchFn = parameters.fetch ?? globalThis.fetch.bind(globalThis)
  const phone = typeof parameters.phone === 'function' ? await parameters.phone(challenge) : parameters.phone

  const res = await fetchFn(details.initiateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: Challenge.serialize(challenge), phone }),
  })
  const started = (await res.json().catch(() => ({}))) as { id?: string; message?: string; error?: string }
  if (!res.ok || !started.id)
    throw new Error(`M-Pesa initiate failed: ${started.error ?? res.status}${started.message ? ` (${started.message})` : ''}`)

  parameters.onPrompt?.({ message: started.message ?? 'Approve the M-Pesa prompt on your phone', challenge, id: started.id })

  const deadline = Date.now() + (parameters.timeoutMs ?? defaultTimeout)
  const interval = parameters.pollIntervalMs ?? 2000
  const url = new URL(details.statusUrl)
  url.searchParams.set('id', started.id)

  while (Date.now() < deadline) {
    await sleep(interval)
    const s = await fetchFn(url)
    const body = (await s.json().catch(() => ({}))) as StatusBody
    if (body.status === doneStatus) return started.id
    if (body.status === 'failed') throw new Error(`M-Pesa payment failed: ${body.reason ?? 'unknown reason'}`)
  }
  throw new Error('Timed out waiting for M-Pesa approval')
}

/** Client side of `mpesa` charge: STK Push, then poll until paid. */
export function charge(parameters: MpesaClientParameters) {
  return Method.toClient(Methods.charge, {
    async createCredential({ challenge }) {
      const amount = Number(challenge.request.amount)
      if (parameters.maxChargeAmount !== undefined && amount > parameters.maxChargeAmount)
        throw new Error(`Refusing M-Pesa charge of KES ${amount}: above maxChargeAmount (${parameters.maxChargeAmount})`)
      const id = await pay(challenge, challenge.request.methodDetails, 'paid', parameters, 120_000)
      return Credential.serialize(Credential.from({ challenge, payload: { checkoutRequestId: id } }))
    },
  })
}

/** Client side of `mpesa` subscription: Ratiba standing order, then poll until active. */
export function subscription(parameters: MpesaClientParameters) {
  return Method.toClient(Methods.subscription, {
    async createCredential({ challenge }) {
      const amount = Number(challenge.request.amount)
      if (parameters.maxSubscriptionAmount !== undefined && amount > parameters.maxSubscriptionAmount)
        throw new Error(
          `Refusing M-Pesa subscription of KES ${amount} per ${challenge.request.periodCount} ${challenge.request.periodUnit}: ` +
            `above maxSubscriptionAmount (${parameters.maxSubscriptionAmount})`,
        )
      const id = await pay(challenge, challenge.request.methodDetails, 'active', parameters, 300_000)
      return Credential.serialize(Credential.from({ challenge, payload: { standingOrderRef: id } }))
    },
  })
}

/** Both intents with the same settings. */
export function mpesa(parameters: MpesaClientParameters) {
  return [charge(parameters), subscription(parameters)] as const
}
