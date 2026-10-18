import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Challenge } from 'mppx'
import * as client from '../src/client/index.js'
import { addPeriod, normalizePhone, toRatibaFrequency } from '../src/index.js'
import { Callbacks } from '../src/server/index.js'
import { keys, type SubscriptionRecord } from '../src/server/State.js'
import { ORIGIN, TOKEN, createHarness } from './harness.js'

describe('helpers', () => {
  it('normalizes Safaricom numbers', () => {
    assert.equal(normalizePhone('0712345678'), '254712345678')
    assert.equal(normalizePhone('+254 712 345 678'), '254712345678')
    assert.equal(normalizePhone('0110345678'), '254110345678')
    assert.throws(() => normalizePhone('12345'))
  })

  it('maps periods to Ratiba frequencies and rejects unrepresentable ones', () => {
    assert.equal(toRatibaFrequency('1', 'day'), '2')
    assert.equal(toRatibaFrequency('1', 'week'), '3')
    assert.equal(toRatibaFrequency('1', 'month'), '4')
    assert.equal(toRatibaFrequency('3', 'month'), '6')
    assert.equal(toRatibaFrequency('12', 'month'), '8')
    assert.throws(() => toRatibaFrequency('2', 'week'), /cannot represent/)
  })

  it('adds calendar months', () => {
    assert.equal(addPeriod(new Date('2026-01-15T00:00:00Z'), '1', 'month').toISOString(), '2026-02-15T00:00:00.000Z')
  })

  it('parses Ratiba callbacks with either key casing', () => {
    const ok = Callbacks.parseRatibaCallback({
      ResponseHeader: { responseCode: '0' },
      ResponseBody: { ResponseData: [{ Name: 'TransactionID', Value: 'SC8F2IQMH5' }, { Name: 'responseCode', Value: '0' }, { Name: 'Status', Value: 'OKAY' }] },
    })
    assert.equal(ok.ok, true)
    const bad = Callbacks.parseRatibaCallback({
      responseHeader: { responseCode: '1037' },
      responseBody: { responseData: [{ name: 'TransactionID', value: '0000000000' }, { name: 'responseCode', value: '1037' }] },
    })
    assert.equal(bad.ok, false)
  })
})

describe('charge (STK Push)', () => {
  it('pays a 402 end to end and returns an M-Pesa receipt', async () => {
    const h = createHarness()
    const c = h.makeClient()
    const res = await c.fetch(`${ORIGIN}/premium`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { data: 'premium content' })
    const receipt = h.receiptOf(res)
    assert.equal(receipt.method, 'mpesa')
    assert.equal(receipt.reference, 'QK1ABCDEF')
    assert.equal(c.prompts.length, 1)
    // The STK Push used the challenge's amount and the normalized phone.
    assert.equal(h.state.stkPushes[0].Amount, '10')
    assert.equal(h.state.stkPushes[0].PartyA, '254712345678')
    assert.equal(h.state.stkPushes[0].CallBackURL, `${ORIGIN}/mpesa/callback/stk/${TOKEN}`)
  })

  it('rejects a replayed credential', async () => {
    const h = createHarness()
    const first = await h.appFetch(`${ORIGIN}/premium`)
    assert.equal(first.status, 402)
    const challenge = Challenge.fromResponse(first)
    const method = client.charge({ phone: '0712345678', pollIntervalMs: 10, fetch: h.appFetch })
    const credential = await method.createCredential({ challenge: challenge as any })
    const header = Challenge.credentialHeader(challenge)

    const ok = await h.appFetch(`${ORIGIN}/premium`, { headers: { [header]: `Payment ${credential.replace(/^Payment\s+/, '')}` } })
    assert.equal(ok.status, 200)
    const replay = await h.appFetch(`${ORIGIN}/premium`, { headers: { [header]: `Payment ${credential.replace(/^Payment\s+/, '')}` } })
    assert.notEqual(replay.status, 200)
  })

  it('fails when the customer cancels the prompt', async () => {
    const h = createHarness()
    h.state.scenario = 'cancel'
    const c = h.makeClient()
    await assert.rejects(c.fetch(`${ORIGIN}/premium`), /cancelled by user/)
  })

  it('fails when Safaricom reports a different amount', async () => {
    const h = createHarness()
    h.state.scenario = 'wrongAmount'
    const c = h.makeClient()
    await assert.rejects(c.fetch(`${ORIGIN}/premium`), /amount mismatch/)
  })

  it('recovers a lost callback with STK Push Query', async () => {
    const h = createHarness()
    h.state.scenario = 'silent'
    const c = h.makeClient()
    const res = await c.fetch(`${ORIGIN}/premium`)
    assert.equal(res.status, 200)
    assert.match(h.receiptOf(res).reference, /^ws_CO_/)
  })

  it('enforces the client spend cap before prompting anyone', async () => {
    const h = createHarness()
    const c = h.makeClient({ maxChargeAmount: 5 })
    await assert.rejects(c.fetch(`${ORIGIN}/premium`), /maxChargeAmount/)
    assert.equal(h.state.stkPushes.length, 0)
  })

  it('refuses challenges this server did not issue', async () => {
    const h = createHarness()
    const first = await h.appFetch(`${ORIGIN}/premium`)
    const challenge = Challenge.fromResponse(first)
    const forged = { ...challenge, request: { ...challenge.request, amount: '1' } }
    const res = await h.appFetch(`${ORIGIN}/mpesa/initiate`, {
      method: 'POST',
      body: JSON.stringify({ challenge: Challenge.serialize(forged as any), phone: '0712345678' }),
    })
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as any).error, 'challenge_not_issued_here')
    assert.equal(h.state.stkPushes.length, 0)
  })

  it('only sends one STK Push per challenge', async () => {
    const h = createHarness()
    const challenge = Challenge.fromResponse(await h.appFetch(`${ORIGIN}/premium`))
    const body = JSON.stringify({ challenge: Challenge.serialize(challenge), phone: '0712345678' })
    const [a, b] = await Promise.all([
      h.appFetch(`${ORIGIN}/mpesa/initiate`, { method: 'POST', body }),
      h.appFetch(`${ORIGIN}/mpesa/initiate`, { method: 'POST', body }),
    ])
    for (const r of [a, b]) assert.ok([200, 409].includes(r.status), `unexpected status ${r.status}`)
    const again = await h.appFetch(`${ORIGIN}/mpesa/initiate`, { method: 'POST', body })
    assert.equal(again.status, 200)
    assert.equal(h.state.stkPushes.length, 1)
  })
})

describe('subscription (Ratiba)', () => {
  it('activates via a standing order, then reuses it without new prompts', async () => {
    const h = createHarness()
    const c = h.makeClient()
    const res = await c.fetch(`${ORIGIN}/plan`, { headers: { 'x-user': 'alice' } })
    assert.equal(res.status, 200)
    const receipt = h.receiptOf(res)
    assert.ok(receipt.subscriptionId)
    assert.equal(receipt.reference, 'SC8F2IQMH5')

    const order = h.state.standingOrders[0]
    assert.equal(order.Frequency, '4')
    assert.equal(order.Amount, '500')
    assert.equal(order.TransactionType, 'Standing Order Customer Pay Bill')
    assert.equal(order.AccountReference, receipt.subscriptionId)

    // Later request from the same customer: no 402, no new standing order.
    const again = await h.appFetch(`${ORIGIN}/plan`, { headers: { 'x-user': 'alice' } })
    assert.equal(again.status, 200)
    assert.equal(h.state.standingOrders.length, 1)

    // A different customer still gets a 402.
    const bob = await h.appFetch(`${ORIGIN}/plan`, { headers: { 'x-user': 'bob' } })
    assert.equal(bob.status, 402)
  })

  it('lapses after the period and renews from the C2B confirmation', async () => {
    const h = createHarness()
    const c = h.makeClient()
    const res = await c.fetch(`${ORIGIN}/plan`, { headers: { 'x-user': 'alice' } })
    const ref = h.receiptOf(res).subscriptionId!

    // Jump past the paid period plus grace.
    const rec = (await h.store.get(keys.sub(ref))) as SubscriptionRecord
    await h.store.put(keys.sub(ref), { ...rec, paidThrough: Date.now() - 2 * 24 * 60 * 60 * 1000 })
    const lapsed = await h.appFetch(`${ORIGIN}/plan`, { headers: { 'x-user': 'alice' } })
    assert.equal(lapsed.status, 402)

    // Ratiba collects the next instalment; it arrives on the Paybill's C2B confirmation URL.
    const c2b = (transId: string) =>
      h.appFetch(`${ORIGIN}/mpesa/callback/c2b/${TOKEN}`, {
        method: 'POST',
        body: JSON.stringify({ TransactionType: 'Pay Bill', TransID: transId, TransAmount: '500.00', BusinessShortCode: '174379', BillRefNumber: ref }),
      })
    await c2b('SK1RENEW01')
    const renewed = await h.appFetch(`${ORIGIN}/plan`, { headers: { 'x-user': 'alice' } })
    assert.equal(renewed.status, 200)

    // A duplicated confirmation does not extend twice.
    const before = ((await h.store.get(keys.sub(ref))) as SubscriptionRecord).paidThrough
    await c2b('SK1RENEW01')
    const after = ((await h.store.get(keys.sub(ref))) as SubscriptionRecord).paidThrough
    assert.equal(after, before)
  })

  it('fails cleanly when the customer declines the standing order', async () => {
    const h = createHarness()
    h.state.ratibaScenario = 'decline'
    const c = h.makeClient()
    await assert.rejects(c.fetch(`${ORIGIN}/plan`, { headers: { 'x-user': 'alice' } }), /payment failed/)
  })

  it('enforces the subscription spend cap', async () => {
    const h = createHarness()
    const c = h.makeClient({ maxSubscriptionAmount: 100 })
    await assert.rejects(c.fetch(`${ORIGIN}/plan`), /maxSubscriptionAmount/)
    assert.equal(h.state.standingOrders.length, 0)
  })

  it('refuses to issue a challenge for a period Ratiba cannot represent', async () => {
    const h = createHarness()
    await assert.rejects(
      h.mppx.mpesa.subscription({ amount: '500', periodCount: '2', periodUnit: 'week' })(new Request(`${ORIGIN}/x`)),
      /cannot represent/,
    )
  })
})
