/**
 * Mvua — a (fictional) weather API for Kenyan towns, paid with M-Pesa.
 *
 *   GET /                              free: places and prices
 *   GET /forecast?place=Kisumu&days=7  paid: KES 5 per forecast, or KES 20/day (Ratiba daily plan)
 *
 * Forecasts come from Open-Meteo (free, no key) when the server can reach it,
 * otherwise from a built-in simulated forecast. The response says which.
 *
 * Run on its own:  npm run example:weather:server
 */
import { createRuntime, isMain, serve, type App } from '../shared/runtime.js'

export const PORT = Number(process.env.PORT || 3002)

export const PLACES: Record<string, { lat: number; lon: number }> = {
  Nairobi: { lat: -1.2864, lon: 36.8172 },
  Mombasa: { lat: -4.0435, lon: 39.6682 },
  Kisumu: { lat: -0.0917, lon: 34.768 },
  Nakuru: { lat: -0.3031, lon: 36.08 },
  Eldoret: { lat: 0.5143, lon: 35.2698 },
  Kitale: { lat: 1.0157, lon: 35.0062 },
  Meru: { lat: 0.0463, lon: 37.6559 },
  Garissa: { lat: -0.4532, lon: 39.646 },
  Voi: { lat: -3.3961, lon: 38.5561 },
  Mtito: { lat: -2.6833, lon: 38.1667 },
  Machakos: { lat: -1.5177, lon: 37.2634 },
}

export const PER_FORECAST = '5'
export const DAILY_PLAN = { amount: '20', periodCount: '1', periodUnit: 'day' } as const

export type ForecastDay = { date: string; minC: number; maxC: number; rainMm: number; rainChancePct: number }
export type Forecast = { place: string; days: ForecastDay[]; source: 'open-meteo' | 'simulated' }

async function openMeteo(place: string, days: number): Promise<Forecast> {
  const { lat, lon } = PLACES[place]!
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(lat))
  url.searchParams.set('longitude', String(lon))
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max')
  url.searchParams.set('timezone', 'Africa/Nairobi')
  url.searchParams.set('forecast_days', String(days))
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`open-meteo ${res.status}`)
  const d = ((await res.json()) as { daily: Record<string, Array<number | string | null>> }).daily
  const col = (k: string) => d[k] ?? []
  return {
    place,
    source: 'open-meteo',
    days: col('time').map((date, i) => ({
      date: String(date),
      minC: Number(col('temperature_2m_min')[i] ?? 0),
      maxC: Number(col('temperature_2m_max')[i] ?? 0),
      rainMm: Number(col('precipitation_sum')[i] ?? 0),
      rainChancePct: Number(col('precipitation_probability_max')[i] ?? 0),
    })),
  }
}

/** Stable, plausible-looking fake forecast for offline runs. */
function simulated(place: string, days: number): Forecast {
  const seed = [...place].reduce((a, c) => a + c.charCodeAt(0), 0)
  const coastal = ['Mombasa', 'Voi', 'Garissa', 'Mtito'].includes(place)
  const wet = ['Kisumu', 'Kitale', 'Eldoret', 'Meru'].includes(place)
  return {
    place,
    source: 'simulated',
    days: Array.from({ length: days }, (_, i) => {
      const date = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)
      const r = Math.abs(Math.sin(seed * 7.13 + i * 1.91))
      const rainMm = Math.round((wet ? 4 + r * 22 : coastal ? r * 9 : 1 + r * 14) * 10) / 10
      const base = coastal ? 30 : place === 'Nairobi' ? 24 : 26
      return { date, minC: Math.round(base - 9 - r * 2), maxC: Math.round(base + r * 3), rainMm, rainChancePct: Math.min(95, Math.round(rainMm * 4 + 10)) }
    }),
  }
}

export async function getForecast(place: string, days: number): Promise<Forecast> {
  if (process.env.WEATHER_SOURCE !== 'simulated') {
    try {
      return await openMeteo(place, days)
    } catch {
      // No network, or Open-Meteo is down: fall through to simulated data.
    }
  }
  return simulated(place, days)
}

export function createMvua(rt: ReturnType<typeof createRuntime>): App {
  const app: App = async (req) => {
    const handled = await rt.m.handle(req)
    if (handled) return handled
    const url = new URL(req.url)

    if (url.pathname === '/') {
      return Response.json({
        service: 'Mvua',
        description: 'Daily weather forecasts for Kenyan towns',
        places: Object.keys(PLACES),
        pricing: {
          forecast: `KES ${PER_FORECAST} per forecast (M-Pesa STK Push)`,
          plan: `KES ${DAILY_PLAN.amount} per day, unlimited forecasts (M-Pesa Ratiba daily standing order)`,
        },
        paidEndpoint: '/forecast?place=Kisumu&days=7',
        identity: 'Send a stable secret in x-agent-token so a daily plan is recognised on later calls.',
      })
    }

    if (url.pathname === '/forecast') {
      const place = url.searchParams.get('place') ?? ''
      const days = Math.min(16, Math.max(1, Number(url.searchParams.get('days') ?? 7) || 7))
      if (!PLACES[place]) return Response.json({ error: `Unknown place. Try: ${Object.keys(PLACES).join(', ')}` }, { status: 400 })

      const expires = new Date(Date.now() + 10 * 60_000)
      const result = await rt.mppx.compose(
        ['mpesa/charge', { amount: PER_FORECAST, description: `Forecast ${place}`, expires }],
        ['mpesa/subscription', { ...DAILY_PLAN, description: 'Mvua daily', expires }],
      )(req)
      if (result.status === 402) return result.challenge
      return result.withReceipt(Response.json(await getForecast(place, days)))
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  rt.attach(app)
  return app
}

export function createRuntimeForMvua(options: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  return createRuntime({
    port: PORT,
    accountReference: 'MVUA',
    identify: ({ headers }) => headers.get('x-agent-token') ?? undefined,
    ...options,
  })
}

if (isMain(import.meta.url)) {
  const rt = createRuntimeForMvua()
  const app = createMvua(rt)
  serve(app, PORT, [
    `Mode: ${rt.mode}${rt.mode === 'simulated' ? ' (pretend Safaricom approves every prompt)' : ''}`,
    `Try:  curl -i "http://localhost:${PORT}/forecast?place=Kisumu&days=7"`,
    'Or run an agent:  npm run example:weather:agent -- planting   (or: fleet)',
  ])
}
