/**
 * Two agents using Mvua, showing the two ways to pay:
 *
 *  - planting: a farmer near Kisumu asks "Should I plant beans this week?"
 *              One forecast is enough, so it pays KES 5 once (STK Push).
 *  - fleet:    a haulage dispatcher checks every town on the Mombasa–Nairobi–Kisumu
 *              route each morning. That's many forecasts a day, so it takes the
 *              KES 20/day plan (Ratiba) and never prompts again.
 *
 * Run against a running server:
 *   npm run example:weather:agent -- planting
 *   npm run example:weather:agent -- fleet
 */
import { randomBytes } from 'node:crypto'
import { Mppx, mpesa } from '../../src/client/index.js'
import { cheapestOffer } from '../shared/choose.js'
import { isMain } from '../shared/runtime.js'
import { type Forecast, PORT } from './server.js'

type AgentOptions = {
  apiUrl: string
  phone: string
  agentToken: string
  fetch?: typeof globalThis.fetch
  pollIntervalMs?: number
  say?: (line: string) => void
}

function paidClient(o: AgentOptions, who: string, callsPerDay: number) {
  const say = o.say ?? console.log
  const baseFetch = o.fetch ?? globalThis.fetch
  const withToken: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-agent-token', o.agentToken)
    return baseFetch(input, { ...init, headers })
  }
  const { fetch: paidFetch } = Mppx.create({
    methods: [
      ...mpesa({
        phone: o.phone,
        maxChargeAmount: 10,
        maxSubscriptionAmount: 50,
        pollIntervalMs: o.pollIntervalMs ?? 1000,
        fetch: baseFetch,
        onPrompt: () => say(`🤖 ${who}, please approve the M-Pesa prompt on your phone.`),
      }),
    ],
    orderChallenges: cheapestOffer({ callsPerDay, say }),
    polyfill: false,
    fetch: withToken,
  })
  return async (place: string, days: number) => {
    const res = await paidFetch(`${o.apiUrl}/forecast?place=${place}&days=${days}`)
    if (!res.ok) throw new Error(`Mvua returned ${res.status}: ${await res.text()}`)
    return (await res.json()) as Forecast
  }
}

const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-KE', { weekday: 'short', timeZone: 'UTC' })

/** "Should I plant beans this week?" for a farm near Kisumu. */
export async function runPlantingAgent(o: AgentOptions) {
  const say = o.say ?? console.log
  const forecast = paidClient(o, 'Otieno', 1)
  const f = await forecast('Kisumu', 7)

  say(` 7-day forecast for Kisumu (${f.source}):`)
  for (const d of f.days) say(`     ${weekday(d.date)}  ${d.minC}–${d.maxC}°C  rain ${d.rainMm}mm (${d.rainChancePct}%)`)

  // Beans want moist soil for germination: look for 3 consecutive days totalling 20mm+.
  let best: { start: string; total: number } | undefined
  for (let i = 0; i + 3 <= f.days.length; i++) {
    const total = f.days.slice(i, i + 3).reduce((s, d) => s + d.rainMm, 0)
    if (total >= 20 && (!best || total > best.total)) best = { start: f.days[i]!.date, total: Math.round(total) }
  }
  say(
    best
      ? ` Plant on ${weekday(best.start)}: about ${best.total}mm of rain is expected over the following 3 days.`
      : ' Hold off: no 3-day stretch this week brings 20mm of rain. Check again next week.',
  )
  return { plantOn: best?.start }
}

export const ROUTE = ['Mombasa', 'Voi', 'Mtito', 'Machakos', 'Nairobi', 'Nakuru', 'Kisumu'] as const

/** Morning route check for a haulage dispatcher. */
export async function runFleetAgent(o: AgentOptions) {
  const say = o.say ?? console.log
  // 7 towns checked morning and afternoon.
  const forecast = paidClient(o, 'Dispatcher', ROUTE.length * 2)
  const warnings: string[] = []
  let source = ''
  for (const town of ROUTE) {
    const f = await forecast(town, 2)
    source = f.source
    const today = f.days[0]!
    const flag = today.rainMm >= 15 ? ' heavy rain' : today.rainMm >= 5 ? 'showers' : 'clear'
    if (today.rainMm >= 15) warnings.push(town)
    say(`     ${town.padEnd(9)} ${String(today.rainMm).padStart(5)}mm  ${flag}`)
  }
  say(` Route check done (${source}). ${warnings.length ? `Slow down and allow extra time near: ${warnings.join(', ')}.` : 'No heavy rain on the route today.'}`)
  return { warnings }
}

if (isMain(import.meta.url)) {
  const which = process.argv[2] ?? 'planting'
  const o: AgentOptions = {
    apiUrl: process.env.API_URL || `http://localhost:${PORT}`,
    phone: process.env.MPESA_PHONE || '254708374149', // Daraja sandbox test number
    agentToken: process.env.AGENT_TOKEN || randomBytes(24).toString('hex'),
  }
  if (which === 'fleet') await runFleetAgent(o)
  else await runPlantingAgent(o)
}
