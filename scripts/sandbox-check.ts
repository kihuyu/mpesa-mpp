/**
 * Daraja sandbox check: npm run sandbox:check [-- --ratiba]
 *
 * Tests your sandbox credentials step by step, using the same Daraja client
 * as the SDK:
 *   1. OAuth token
 *   2. STK Push for KES 1 to MPESA_PHONE, then STK Push Query until it settles
 *   3. (with --ratiba) a KES 1 daily Ratiba standing order
 *
 * If PUBLIC_URL is set (a tunnel to CALLBACK_PORT, e.g. `ngrok http 3010`), it also
 * listens for Safaricom's callbacks and saves every raw body to
 * sandbox-callbacks.jsonl, plus a copy with phone numbers masked that is safe to share.
 *
 * Sandbox only: no real money moves.
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Daraja, DarajaError, normalizePhone } from '../src/daraja/Daraja.js'
import { parseRatibaCallback, parseStkCallback } from '../src/daraja/Callbacks.js'

const args = new Set(process.argv.slice(2))
const withRatiba = args.has('--ratiba')
const env = process.env
const PORT = Number(env.CALLBACK_PORT || 3010)
const RAW_FILE = 'sandbox-callbacks.jsonl'
const MASKED_FILE = 'sandbox-callbacks.masked.jsonl'

const ok = (s: string) => console.log(`OK ${s}`)
const bad = (s: string) => console.log(`BAD ${s}`)
const info = (s: string) => console.log(`     ${s}`)
const step = (s: string) => console.log(`\nSTEP ${s}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

step('Checking .env')
const missing = ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE', 'DARAJA_PASSKEY', 'MPESA_PHONE'].filter((k) => !env[k])
if (missing.length) {
  bad(`Missing: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`)
  process.exit(1)
}
let phone: string
try {
  phone = normalizePhone(env.MPESA_PHONE!)
} catch {
  bad(`MPESA_PHONE "${env.MPESA_PHONE}" isn't a Safaricom number (use 07XXXXXXXX or 2547XXXXXXXX).`)
  process.exit(1)
}
const publicUrl = env.PUBLIC_URL?.replace(/\/$/, '')
if (publicUrl && !publicUrl.startsWith('https://')) {
  bad('PUBLIC_URL must be https:// (Safaricom rejects plain http callback URLs).')
  process.exit(1)
}
ok(`Shortcode ${env.DARAJA_SHORTCODE}, phone ${mask(phone)}, environment ${env.DARAJA_ENV || "sandbox"}`)
info(publicUrl ? `Callbacks: ${publicUrl} → localhost:${PORT}` : 'PUBLIC_URL not set: callbacks will not reach you, so this relies on STK Push Query.')

const daraja = new Daraja({
  environment: (env.DARAJA_ENV as "sandbox" | "production") || "sandbox",
  consumerKey: env.DARAJA_CONSUMER_KEY!,
  consumerSecret: env.DARAJA_CONSUMER_SECRET!,
  shortcode: env.DARAJA_SHORTCODE!,
  passkey: env.DARAJA_PASSKEY!,
  ...(env.DARAJA_BASE_URL ? { baseUrl: env.DARAJA_BASE_URL } : {}), // for testing this script
})
if (daraja.config.environment === 'production') {
  bad('DARAJA_ENV=production. This script is for the sandbox only.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Callback listener
// ---------------------------------------------------------------------------

type Received = { path: string; body: unknown }
const received: Received[] = []
const server = publicUrl
  ? createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {}
      const entry = { at: new Date().toISOString(), path: req.url, body }
      appendFileSync(RAW_FILE, `${JSON.stringify(entry)}\n`)
      appendFileSync(MASKED_FILE, `${JSON.stringify(entry).replace(/2547\d{8}|2541\d{8}/g, (m) => mask(m))}\n`)
      received.push({ path: req.url ?? '', body })
      info(`📨 callback received on ${req.url}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }))
    }).listen(PORT)
  : undefined

const callbackBase = publicUrl ?? 'https://example.com'
async function waitForCallback(pathPrefix: string, ms: number) {
  if (!publicUrl) return undefined
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = received.find((r) => r.path.startsWith(pathPrefix))
    if (hit) return hit
    await sleep(1000)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 1. OAuth
// ---------------------------------------------------------------------------

const results: Record<string, boolean | 'skipped'> = {}

step('1. OAuth token')
try {
  await daraja.accessToken()
  ok('Got an access token')
  results.oauth = true
} catch (e) {
  results.oauth = false
  const status = e instanceof DarajaError ? e.status : undefined
  bad(`OAuth failed${status ? ` (HTTP ${status})` : ''}: ${(e as Error).message}`)
  if (status === 400 || status === 401) info('Check DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET (copy them again from your Daraja app).')
  else info('Check your internet connection, or whether the Daraja sandbox is down.')
  finish()
}

// ---------------------------------------------------------------------------
// 2. STK Push
// ---------------------------------------------------------------------------

step(`2. STK Push: KES 1 to ${mask(phone)}`)
let checkoutRequestId: string | undefined
try {
  const push = await daraja.stkPush({
    phone,
    amount: '1',
    accountReference: 'MPPTEST',
    description: 'MPP test',
    callbackUrl: `${callbackBase}/cb/stk`,
  })
  checkoutRequestId = push.CheckoutRequestID
  ok(`Accepted: ${push.CustomerMessage ?? push.ResponseDescription}`)
  info(`CheckoutRequestID ${checkoutRequestId}`)
  info('A prompt should appear on the phone. Enter your M-PESA PIN (sandbox: no money moves).')
} catch (e) {
  results.stkPush = false
  bad(`STK Push failed: ${(e as Error).message}`)
  explain(e)
}

if (checkoutRequestId) {
  let settled: { code: string; desc: string } | undefined
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !settled) {
    await sleep(5000)
    const cb = received.find((r) => r.path.startsWith('/cb/stk'))
    if (cb) {
      try {
        const parsed = parseStkCallback(cb.body)
        settled = { code: String(parsed.resultCode), desc: `${parsed.resultDesc} (from callback, receipt ${parsed.mpesaReceiptNumber ?? 'n/a'})` }
        break
      } catch (e) {
        bad(`Callback arrived but the SDK could not parse it: ${(e as Error).message}. See ${RAW_FILE}.`)
      }
    }
    try {
      const q = await daraja.stkQuery(checkoutRequestId)
      if (q.ResultCode !== undefined) settled = { code: String(q.ResultCode), desc: `${q.ResultDesc} (from STK Push Query)` }
      else info('…still waiting')
    } catch {
      info('…still processing') // Daraja answers "being processed" with an HTTP error
    }
  }
  if (!settled) {
    results.stkPush = false
    bad('No result within 2 minutes. Did the prompt arrive on the phone?')
  } else if (settled.code === '0') {
    results.stkPush = true
    ok(`Paid: ${settled.desc}`)
  } else {
    results.stkPush = false
    bad(`Not paid. ResultCode ${settled.code}: ${settled.desc}`)
    const hints: Record<string, string> = {
      '1032': 'The prompt was cancelled on the phone.',
      '1037': 'The phone could not be reached (off, or no network). Try again.',
      '2001': 'Wrong PIN entered.',
      '1': 'Insufficient balance (sandbox test accounts sometimes report this).',
    }
    if (hints[settled.code]) info(hints[settled.code]!)
  }
  if (publicUrl && settled) {
    const cb = await waitForCallback('/cb/stk', 10_000)
    info(cb ? 'STK callback reached your tunnel ✓' : 'No STK callback reached your tunnel. Check PUBLIC_URL / ngrok.')
    results.stkCallback = Boolean(cb)
  }
}

// ---------------------------------------------------------------------------
// 3. Ratiba
// ---------------------------------------------------------------------------

if (!withRatiba) {
  results.ratiba = 'skipped'
} else {
  step(`3. Ratiba: KES 1 daily standing order for ${mask(phone)}`)
  const ref = `MPP${Date.now().toString(36).toUpperCase()}`.slice(0, 12)
  try {
    const now = new Date()
    const res = await daraja.createStandingOrder({
      name: `MPP check ${ref}`,
      startDate: now,
      endDate: new Date(now.getTime() + 2 * 86_400_000),
      phone,
      amount: '1',
      frequency: '2',
      accountReference: ref,
      description: 'MPP test',
      callbackUrl: `${callbackBase}/cb/ratiba?ref=${ref}`,
    })
    ok(`Accepted: ${res.ResponseBody?.responseDescription ?? res.ResponseHeader?.responseDescription ?? JSON.stringify(res)}`)
    info('Approve the standing order on the phone.')
    appendFileSync(RAW_FILE, `${JSON.stringify({ at: new Date().toISOString(), path: 'ratiba-create-response', body: res })}\n`)
    if (publicUrl) {
      const cb = await waitForCallback('/cb/ratiba', 180_000)
      if (!cb) {
        results.ratiba = false
        bad('No Ratiba callback within 3 minutes.')
      } else {
        const parsed = parseRatibaCallback(cb.body)
        results.ratiba = parsed.ok
        if (parsed.ok) ok(`Standing order active. TransactionID ${parsed.transactionId}`)
        else bad(`Ratiba reported failure: responseCode ${parsed.responseCode}, status ${parsed.status ?? 'n/a'}, ${parsed.description ?? ''}`)
        info(`Raw callback saved to ${RAW_FILE} (check its shape against src/daraja/Callbacks.ts).`)
      }
    } else {
      results.ratiba = 'skipped'
      info('Set PUBLIC_URL to see whether the standing order was approved: Ratiba has no query endpoint.')
    }
  } catch (e) {
    results.ratiba = false
    bad(`Ratiba request failed: ${(e as Error).message}`)
    explain(e)
    info('If the error mentions access or the product, add the M-Pesa Ratiba API to your app on the Daraja portal.')
  }
}

finish()

// ---------------------------------------------------------------------------

function finish(): never {
  console.log('\n── Summary ──')
  for (const [k, v] of Object.entries(results)) console.log(`  ${v === true ? 'TRUE' : v === 'skipped' ? 'SKIPPED ' : 'CANCELLED'} ${k}`)
  if (received.length) console.log(`\nRaw callbacks: ${RAW_FILE}\nShareable (phones masked): ${MASKED_FILE}`)
  server?.close()
  process.exit(Object.values(results).includes(false) ? 1 : 0)
}

function explain(e: unknown) {
  if (!(e instanceof DarajaError)) return
  const body = e.body as { errorCode?: string; errorMessage?: string } | undefined
  if (body?.errorMessage) info(`Daraja says: ${body.errorCode ?? ''} ${body.errorMessage}`)
  if (body?.errorMessage?.toLowerCase().includes('password'))
    info('Check DARAJA_PASSKEY matches DARAJA_SHORTCODE (the sandbox passkey for 174379 is on the Daraja "Lipa na M-Pesa" test page).')
  if (body?.errorMessage?.toLowerCase().includes('callback')) info('Daraja rejected the callback URL. Use an https PUBLIC_URL.')
}

function mask(p: string) {
  return `${p.slice(0, 5)}***${p.slice(-3)}`
}
