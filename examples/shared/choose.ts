/**
 * How an agent decides between a pay-per-call offer and a subscription when a
 * 402 offers both. It estimates how many calls it will make in one billing
 * period and takes whichever is cheaper.
 */
import type { Challenge } from 'mppx'

const DAYS: Record<string, number> = { day: 1, week: 7, month: 30 }

type Candidate = { challenge: Challenge.Challenge<Record<string, unknown>> }

export function cheapestOffer(options: { callsPerDay: number; say?: (line: string) => void }) {
  return <c extends Candidate>(candidates: readonly c[]): c[] => {
    const priced = candidates.map((c) => {
      const r = c.challenge.request as { amount: string; periodCount?: string; periodUnit?: string }
      if (c.challenge.intent === 'subscription') {
        const days = Number(r.periodCount ?? 1) * (DAYS[r.periodUnit ?? 'day'] ?? 1)
        return { c, days, cost: Number(r.amount), label: `KES ${r.amount} per ${plural(r.periodCount, r.periodUnit)}` }
      }
      return { c, days: 0, cost: Number(r.amount), label: `KES ${r.amount} per call` }
    })

    const plan = priced.find((p) => p.c.challenge.intent === 'subscription')
    const perCall = priced.find((p) => p.c.challenge.intent === 'charge')
    if (!plan || !perCall) return [...candidates]

    const calls = Math.ceil(options.callsPerDay * plan.days)
    const payAsYouGo = calls * perCall.cost
    const pickPlan = plan.cost < payAsYouGo
    options.say?.(
      ` Offers: ${perCall.label}, or ${plan.label}. I expect ~${calls} call(s) in that period ` +
        `(KES ${payAsYouGo} pay-as-you-go vs KES ${plan.cost}), so I'll take the ${pickPlan ? 'plan' : 'per-call price'}.`,
    )
    return pickPlan ? [plan.c, perCall.c] : [perCall.c, plan.c]
  }
}

function plural(count = '1', unit = 'day') {
  return count === '1' ? unit : `${count} ${unit}s`
}
