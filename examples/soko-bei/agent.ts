/**
 * Task: "Where should I sell 40 bags of maize this week?"
 *
 * It checks every market, takes off the cost of trucking a bag there from
 * Eldoret, and recommends the best one. Because it will keep checking prices
 * all week, it chooses the weekly plan over paying per report.
 *
 * Run against a running server:  npm run example:soko:agent
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Receipt } from 'mppx'
import { Mppx, mpesa } from '../../src/client/index.js'
import { cheapestOffer } from '../shared/choose.js'
import { isMain } from '../shared/runtime.js'
import { MARKETS, PORT } from './server.js'

/** Rough cost (KES) to move one 90kg bag from Eldoret to each market. Illustrative. */
const TRANSPORT_FROM_ELDORET: Record<string, number> = { Eldoret: 0, Kitale: 90, Nakuru: 160, Nairobi: 320, Kisumu: 210 }

export type SokoAgentOptions = {
  apiUrl: string
  phone: string
  /** Secret that identifies this agent to Soko Bei, so the weekly plan is recognised. */
  agentToken: string
  bags?: number
  fetch?: typeof globalThis.fetch
  pollIntervalMs?: number
  say?: (line: string) => void
}

type PriceReport = { market: string; priceKes: number; change7dKes: number; unit: string }

export async function runSokoAgent(o: SokoAgentOptions) {
  const say = o.say ?? console.log
  const bags = o.bags ?? 40
  const baseFetch = o.fetch ?? globalThis.fetch

  // Every request carries the agent's token; the M-Pesa client handles any 402.
  const withToken: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-agent-token', o.agentToken)
    return baseFetch(input, { ...init, headers })
  }

  const { fetch: paidFetch } = Mppx.create({
    methods: [
      ...mpesa({
        phone: o.phone,
        maxChargeAmount: 20, // never more than KES 20 for one report
        maxSubscriptionAmount: 200, // never more than KES 200 per period
        pollIntervalMs: o.pollIntervalMs ?? 1000,
        fetch: baseFetch,
        onPrompt: () => say('please approve the M-Pesa prompt on your phone.'),
      }),
    ],
    // 5 markets checked about twice a day.
    orderChallenges: cheapestOffer({ callsPerDay: MARKETS.length * 2, say }),
    polyfill: false,
    fetch: withToken,
  })

  let subscriptionId: string | undefined
  const reports: PriceReport[] = []
  for (const market of MARKETS) {
    const res = await paidFetch(`${o.apiUrl}/prices?crop=maize&market=${market}`)
    if (!res.ok) throw new Error(`Soko Bei returned ${res.status}: ${await res.text()}`)
    const receiptHeader = res.headers.get('payment-receipt')
    if (receiptHeader) {
      const receipt = Receipt.fromResponse(res)
      if (receipt.subscriptionId) subscriptionId = receipt.subscriptionId
    }
    reports.push((await res.json()) as PriceReport)
  }

  const ranked = reports
    .map((r) => ({ ...r, transport: TRANSPORT_FROM_ELDORET[r.market] ?? 0, net: r.priceKes - (TRANSPORT_FROM_ELDORET[r.market] ?? 0) }))
    .sort((a, b) => b.net - a.net)

  say('Maize, per 90kg bag (sample data):')
  for (const r of ranked) {
    const trend = r.change7dKes === 0 ? 'flat' : `${r.change7dKes > 0 ? '+' : ''}${r.change7dKes} this week`
    say(`     ${r.market.padEnd(8)} KES ${r.priceKes.toLocaleString()}  (${trend}), minus transport ${r.transport} = KES ${r.net.toLocaleString()}`)
  }
  const best = ranked[0]!
  const home = ranked.find((r) => r.market === 'Eldoret')!
  const gain = (best.net - home.net) * bags
  say(
    best.market === 'Eldoret'
      ? `Sell in Eldoret: no other market beats it once transport is paid.`
      : `Sell in ${best.market}: about KES ${gain.toLocaleString()} more for ${bags} bags than selling in Eldoret.`,
  )
  return { best: best.market, subscriptionId, reports: ranked }
}

if (isMain(import.meta.url)) {
  // Keep the token between runs so the weekly plan is recognised next time.
  const tokenFile = new URL('./.agent-token', import.meta.url)
  const agentToken = existsSync(tokenFile)
    ? readFileSync(tokenFile, 'utf8').trim()
    : (() => {
        const t = randomBytes(24).toString('hex')
        writeFileSync(tokenFile, t)
        return t
      })()

  await runSokoAgent({
    apiUrl: process.env.API_URL || `http://localhost:${PORT}`,
    phone: process.env.MPESA_PHONE || '254708374149', // Daraja sandbox test number
    agentToken,
  })
}
