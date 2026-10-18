/**
 * Soko Bei — a (fictional) crop market price API, paid with M-Pesa.
 *
 *   GET /                         free: what's on sale and what it costs
 *   GET /prices?crop=&market=     paid: KES 10 per report, or KES 150/week (Ratiba)
 *
 * Prices are generated sample data, not real market prices.
 *
 * Run on its own:  npm run example:soko:server
 */
import { createRuntime, isMain, serve, type App } from '../shared/runtime.js'

export const PORT = Number(process.env.PORT || 3001)

export const MARKETS = ['Eldoret', 'Kitale', 'Nakuru', 'Nairobi', 'Kisumu'] as const
const CROPS = {
  maize: { unit: '90kg bag', base: 4100 },
  beans: { unit: '90kg bag', base: 11500 },
  potatoes: { unit: '50kg bag', base: 2600 },
} as const
type Crop = keyof typeof CROPS

const MARKET_SKEW: Record<string, number> = { Eldoret: -0.06, Kitale: -0.09, Nakuru: 0.01, Nairobi: 0.07, Kisumu: 0.04 }

export const PLAN = { amount: '150', periodCount: '1', periodUnit: 'week' } as const
export const REPORT_PRICE = '10'

/** Deterministic pseudo-random wobble per crop/market/day, so numbers are stable within a day. */
function wobble(seed: string) {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return ((h >>> 0) % 1000) / 1000 - 0.5 // -0.5 .. 0.5
}

function priceOn(crop: Crop, market: string, date: Date) {
  const day = date.toISOString().slice(0, 10)
  const base = CROPS[crop].base * (1 + (MARKET_SKEW[market] ?? 0))
  return Math.round((base * (1 + 0.04 * wobble(`${crop}|${market}|${day}`))) / 10) * 10
}

export function createSokoBei(rt: ReturnType<typeof createRuntime>): App {
  const app: App = async (req) => {
    const handled = await rt.m.handle(req)
    if (handled) return handled

    const url = new URL(req.url)

    if (url.pathname === '/') {
      return Response.json({
        service: 'Soko Bei',
        description: 'Daily wholesale crop prices from Kenyan markets (sample data)',
        crops: Object.keys(CROPS),
        markets: MARKETS,
        pricing: {
          report: `KES ${REPORT_PRICE} per price report (M-Pesa STK Push)`,
          plan: `KES ${PLAN.amount} per week, unlimited reports (M-Pesa Ratiba standing order)`,
        },
        paidEndpoint: '/prices?crop=maize&market=Eldoret',
        identity: 'Send a stable secret in x-agent-token so a weekly plan is recognised on later calls.',
      })
    }

    if (url.pathname === '/prices') {
      const crop = (url.searchParams.get('crop') ?? 'maize') as Crop
      const market = url.searchParams.get('market') ?? 'Eldoret'
      if (!(crop in CROPS)) return Response.json({ error: `Unknown crop. Try: ${Object.keys(CROPS).join(', ')}` }, { status: 400 })
      if (!MARKETS.includes(market as (typeof MARKETS)[number]))
        return Response.json({ error: `Unknown market. Try: ${MARKETS.join(', ')}` }, { status: 400 })

      // Validate before charging, then offer both ways to pay in one 402.
      const expires = new Date(Date.now() + 10 * 60_000)
      const result = await rt.mppx.compose(
        ['mpesa/subscription', { ...PLAN, description: 'Soko Bei weekly', expires }],
        ['mpesa/charge', { amount: REPORT_PRICE, description: `${crop} price report`, expires }],
      )(req)
      if (result.status === 402) return result.challenge

      const today = new Date()
      const weekAgo = new Date(today.getTime() - 7 * 86_400_000)
      const price = priceOn(crop, market, today)
      const before = priceOn(crop, market, weekAgo)
      return result.withReceipt(
        Response.json({
          crop,
          market,
          unit: CROPS[crop].unit,
          priceKes: price,
          change7dKes: price - before,
          date: today.toISOString().slice(0, 10),
          source: 'sample data',
        }),
      )
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  rt.attach(app)
  return app
}

export function createRuntimeForSoko(options: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  return createRuntime({
    port: PORT,
    accountReference: 'SOKOBEI',
    identify: ({ headers }) => headers.get('x-agent-token') ?? undefined,
    ...options,
  })
}

if (isMain(import.meta.url)) {
  const rt = createRuntimeForSoko()
  const app = createSokoBei(rt)
  serve(app, PORT, [
    `Mode: ${rt.mode}${rt.mode === 'simulated' ? ' (pretend Safaricom approves every prompt)' : ''}`,
    `Try:  curl -i "http://localhost:${PORT}/prices?crop=maize&market=Eldoret"`,
    `Or run the agent:  npm run example:soko:agent`,
  ])
}
