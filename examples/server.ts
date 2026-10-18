/**
 * Example API that sells:
 *   GET /premium  — KES 10 per call (STK Push charge)
 *   GET /plan     — KES 500 per month (Ratiba subscription), keyed by the x-api-key header
 *
 * Run against the Daraja sandbox:
 *   DARAJA_CONSUMER_KEY=... DARAJA_CONSUMER_SECRET=... \
 *   DARAJA_SHORTCODE=174379 DARAJA_PASSKEY=... \
 *   MPP_SECRET_KEY=$(openssl rand -base64 32) \
 *   PUBLIC_URL=https://<your-tunnel>.ngrok.app CALLBACK_TOKEN=$(openssl rand -hex 16) \
 *   npm run example:server
 *
 * Safaricom must be able to reach PUBLIC_URL for callbacks, so use a tunnel locally.
 */
import { createServer } from 'node:http'
import { NodeListener } from 'mppx/server'
import { Mppx, Store, mpesa } from '../src/server/index.js'

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var ${name}`)
  return v
}

const secretKey = env('MPP_SECRET_KEY')

const m = mpesa({
  daraja: {
    environment: (process.env.DARAJA_ENV as 'sandbox' | 'production') || 'sandbox',
    consumerKey: env('DARAJA_CONSUMER_KEY'),
    consumerSecret: env('DARAJA_CONSUMER_SECRET'),
    shortcode: env('DARAJA_SHORTCODE'),
    passkey: env('DARAJA_PASSKEY'),
  },
  // Use Store.redis / Store.upstash / Store.cloudflare in production: state must survive restarts.
  store: Store.memory(),
  secretKey,
  publicUrl: env('PUBLIC_URL'),
  callbackToken: env('CALLBACK_TOKEN'),
  identify: ({ headers }) => headers.get('x-api-key') ?? undefined,
  log: (event, data) => console.log(`[mpesa] ${event}`, data ?? ''),
})

const mppx = Mppx.create({ methods: [m.charge, m.subscription], secretKey })

// STK prompts take a while; give clients 10 minutes to finish paying.
const expires = () => new Date(Date.now() + 10 * 60_000)

async function app(req: Request): Promise<Response> {
  const handled = await m.handle(req)
  if (handled) return handled

  const { pathname } = new URL(req.url)
  if (pathname === '/premium') {
    const r = await mppx.mpesa.charge({ amount: '10', description: 'Premium call', expires: expires() })(req)
    if (r.status === 402) return r.challenge
    return r.withReceipt(Response.json({ data: 'premium content' }))
  }
  if (pathname === '/plan') {
    const r = await mppx.mpesa.subscription({
      amount: '500',
      periodCount: '1',
      periodUnit: 'month',
      description: 'Pro plan',
      expires: expires(),
    })(req)
    if (r.status === 402) return r.challenge
    return r.withReceipt(Response.json({ data: 'plan content' }))
  }
  return new Response('Not found', { status: 404 })
}

const port = Number(process.env.PORT || 3000)
createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host}`), {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  })
  await NodeListener.sendResponse(res, await app(request))
}).listen(port, () => {
  console.log(`Listening on :${port}`)
  console.log('Register this C2B confirmation URL on your Paybill so Ratiba renewals are seen:')
  console.log(`  ${m.urls.c2bConfirmation}`)
})
