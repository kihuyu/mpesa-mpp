import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inProcess } from '../examples/shared/runtime.js'
import { runSokoAgent } from '../examples/soko-bei/agent.js'
import { PLAN, createRuntimeForSoko, createSokoBei } from '../examples/soko-bei/server.js'
import { runFleetAgent, runPlantingAgent } from '../examples/weather/agents.js'
import { createMvua, createRuntimeForMvua } from '../examples/weather/server.js'

process.env.WEATHER_SOURCE = 'simulated'

const quiet = { quiet: true, simulator: { approveAfterMs: 30, onPhone: () => {} } }

function recorder() {
  const lines: string[] = []
  return { lines, say: (l: string) => lines.push(l) }
}

describe('example: Soko Bei', () => {
  it('free catalogue is reachable without paying', async () => {
    const rt = createRuntimeForSoko(quiet)
    const res = await inProcess(createSokoBei(rt))('http://localhost:3001/')
    assert.equal(res.status, 200)
  })

  it('offers both intents in one 402', async () => {
    const rt = createRuntimeForSoko(quiet)
    const res = await inProcess(createSokoBei(rt))('http://localhost:3001/prices?crop=maize&market=Kitale')
    assert.equal(res.status, 402)
    const header = res.headers.get('www-authenticate') ?? ''
    assert.match(header, /intent="subscription"/)
    assert.match(header, /intent="charge"/)
  })

  it('subscribes once, reuses the plan, then renews from Ratiba', async () => {
    const rt = createRuntimeForSoko(quiet)
    const fetch = inProcess(createSokoBei(rt))
    const opts = { apiUrl: 'http://localhost:3001', phone: '0712345678', agentToken: 'tok-wanjiku', fetch, pollIntervalMs: 10 }

    const a = recorder()
    const first = await runSokoAgent({ ...opts, say: a.say })
    assert.ok(first.subscriptionId)
    assert.ok(a.lines.some((l) => l.includes("I'll take the plan")))
    assert.equal(a.lines.filter((l) => l.includes('approve the M-Pesa prompt')).length, 1)

    const b = recorder()
    await runSokoAgent({ ...opts, say: b.say })
    assert.equal(b.lines.filter((l) => l.includes('approve')).length, 0, 'no prompt while the plan is active')

    const status = async () =>
      Date.parse(((await (await fetch(`http://localhost:3001/mpesa/status?id=${first.subscriptionId}`)).json()) as any).paidThrough)
    const before = await status()
    await rt.simulator!.collectRenewal(rt.m.urls.c2bConfirmation, first.subscriptionId!, PLAN.amount, rt.shortcode)
    assert.equal((await status()) - before, 7 * 86_400_000)
  })

  it('rejects unknown markets before asking for payment', async () => {
    const rt = createRuntimeForSoko(quiet)
    const res = await inProcess(createSokoBei(rt))('http://localhost:3001/prices?crop=maize&market=Atlantis')
    assert.equal(res.status, 400)
  })
})

describe('example: Mvua weather', () => {
  it('planting agent pays once per forecast', async () => {
    const rt = createRuntimeForMvua(quiet)
    const fetch = inProcess(createMvua(rt))
    const r = recorder()
    await runPlantingAgent({ apiUrl: 'http://localhost:3002', phone: '0722111222', agentToken: 't1', fetch, pollIntervalMs: 10, say: r.say })
    assert.ok(r.lines.some((l) => l.includes('per-call price')))
    assert.ok(r.lines.some((l) => /Plant on|Hold off/.test(l)))
  })

  it('fleet agent takes the daily plan and is not prompted again', async () => {
    const rt = createRuntimeForMvua(quiet)
    const fetch = inProcess(createMvua(rt))
    const opts = { apiUrl: 'http://localhost:3002', phone: '0733444555', agentToken: 't2', fetch, pollIntervalMs: 10 }
    const a = recorder()
    await runFleetAgent({ ...opts, say: a.say })
    assert.ok(a.lines.some((l) => l.includes("I'll take the plan")))
    assert.equal(a.lines.filter((l) => l.includes('approve')).length, 1)
    const b = recorder()
    await runFleetAgent({ ...opts, say: b.say })
    assert.equal(b.lines.filter((l) => l.includes('approve')).length, 0)
  })
})
