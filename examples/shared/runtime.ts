/**
 * Shared wiring for the examples.
 *
 * - With Daraja env vars set (see .env.example), it talks to the real Safaricom sandbox.
 * - Without them, it uses the pretend Safaricom in ./simulator.ts, so everything runs offline.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { NodeListener } from 'mppx/server'
import { Mppx, Store, mpesa, type MpesaServerConfig } from '../../src/server/index.js'
import { createSimulator, type SimulatorOptions } from './simulator.js'

export type App = (req: Request) => Promise<Response>

export function createRuntime(options: {
  port: number
  identify?: MpesaServerConfig['identify']
  accountReference?: string
  quiet?: boolean
  simulator?: SimulatorOptions
}) {
  const real = Boolean(process.env.DARAJA_CONSUMER_KEY)
  if (real && !process.env.PUBLIC_URL?.startsWith('https://'))
    throw new Error(
      'Daraja keys found in .env, but PUBLIC_URL is not an https URL. Safaricom must reach your callbacks: ' +
        `start a tunnel (e.g. \`ngrok http ${options.port}\`) and set PUBLIC_URL to its https address. ` +
        'Or remove DARAJA_CONSUMER_KEY to use the simulator.',
    )
  const simulator = real ? undefined : createSimulator(options.simulator)
  const secretKey = process.env.MPP_SECRET_KEY || randomBytes(32).toString('base64')
  const shortcode = process.env.DARAJA_SHORTCODE || '174379'

  const store = Store.memory()
  const m = mpesa({
    daraja: {
      environment: (process.env.DARAJA_ENV as 'sandbox' | 'production') || 'sandbox',
      consumerKey: process.env.DARAJA_CONSUMER_KEY || 'simulated',
      consumerSecret: process.env.DARAJA_CONSUMER_SECRET || 'simulated',
      shortcode,
      passkey: process.env.DARAJA_PASSKEY || 'simulated',
      ...(simulator ? { fetch: simulator.fetch, baseUrl: 'https://simulated.safaricom.local' } : {}),
    },
    // Swap for Store.redis / Store.upstash in production.
    store,
    secretKey,
    publicUrl: process.env.PUBLIC_URL || `http://localhost:${options.port}`,
    callbackToken: process.env.CALLBACK_TOKEN || randomBytes(16).toString('hex'),
    identify: options.identify,
    accountReference: options.accountReference,
    stkQueryAfterMs: 30_000,
    log: options.quiet ? undefined : (event, data) => console.log(`   [server] ${event}`, data?.resultDesc ?? data?.status ?? ''),
  })

  const mppx = Mppx.create({ methods: [m.charge, m.subscription], secretKey, realm: `localhost:${options.port}` })

  return {
    m,
    mppx,
    store,
    shortcode,
    simulator,
    mode: real ? ('daraja-sandbox' as const) : ('simulated' as const),
    /** Call once the app exists, so the simulator can deliver callbacks to it. */
    attach(app: App) {
      simulator?.attach(app)
    },
  }
}

/** Serves a fetch-style app over Node's http module. */
export function serve(app: App, port: number, banner: string[] = []) {
  createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host}`), {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' || chunks.length === 0 ? undefined : Buffer.concat(chunks),
    })
    try {
      await NodeListener.sendResponse(res, await app(request))
    } catch (error) {
      console.error(error)
      await NodeListener.sendResponse(res, Response.json({ error: 'internal_error' }, { status: 500 }))
    }
  }).listen(port, () => {
    console.log(`Listening on http://localhost:${port}`)
    for (const line of banner) console.log(line)
  })
}

/** Routes fetch calls straight into an app, with no network (used by the demos). */
export function inProcess(app: App): typeof globalThis.fetch {
  return async (input, init) => app(input instanceof Request ? input : new Request(String(input), init))
}

/** True when this module is the script node was asked to run. */
export function isMain(metaUrl: string) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
