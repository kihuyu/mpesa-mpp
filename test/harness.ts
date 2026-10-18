/**
 * In-process test harness: a fake Daraja, an MPP-protected API using the
 * `mpesa` method, and a client whose fetch is routed straight to that API.
 */
import { Receipt } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Store, mpesa } from '../src/server/index.js'
import * as client from '../src/client/index.js'

export type Scenario = 'approve' | 'cancel' | 'wrongAmount' | 'silent'

export const SECRET = 'test-secret-key-0123456789-abcdefghij'
export const ORIGIN = 'https://api.test'
export const TOKEN = 'cbtoken_0123456789abcdef'

export function createHarness() {
  const state = {
    scenario: 'approve' as Scenario,
    ratibaScenario: 'approve' as 'approve' | 'decline',
    stkPushes: [] as any[],
    standingOrders: [] as any[],
    checkoutCounter: 0,
  }
  const store = Store.memory()

  // Forward-declared so the fake Daraja can deliver callbacks to the app.
  let app: (req: Request) => Promise<Response>

  const deliver = (url: string, body: unknown, delay = 20) =>
    setTimeout(() => {
      void app(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
    }, delay)

  const darajaFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (url.pathname === '/oauth/v1/generate') return Response.json({ access_token: 'tok', expires_in: '3599' })

    if (url.pathname === '/mpesa/stkpush/v1/processrequest') {
      state.stkPushes.push(body)
      const id = `ws_CO_${++state.checkoutCounter}`
      const amount = state.scenario === 'wrongAmount' ? String(Number(body.Amount) - 1) : body.Amount
      if (state.scenario === 'approve' || state.scenario === 'wrongAmount')
        deliver(body.CallBackURL, {
          Body: {
            stkCallback: {
              MerchantRequestID: 'm1',
              CheckoutRequestID: id,
              ResultCode: 0,
              ResultDesc: 'The service request is processed successfully.',
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: Number(amount) },
                  { Name: 'MpesaReceiptNumber', Value: `QK${state.checkoutCounter}ABCDEF` },
                  { Name: 'TransactionDate', Value: 20261011203000 },
                  { Name: 'PhoneNumber', Value: Number(body.PhoneNumber) },
                ],
              },
            },
          },
        })
      if (state.scenario === 'cancel')
        deliver(body.CallBackURL, {
          Body: { stkCallback: { MerchantRequestID: 'm1', CheckoutRequestID: id, ResultCode: 1032, ResultDesc: 'Request cancelled by user' } },
        })
      return Response.json({
        MerchantRequestID: 'm1',
        CheckoutRequestID: id,
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing',
      })
    }

    if (url.pathname === '/mpesa/stkpushquery/v1/query') {
      // "silent" = callback lost but customer paid; the query is the fallback.
      return Response.json({ ResponseCode: '0', ResponseDescription: 'ok', CheckoutRequestID: body.CheckoutRequestID, ResultCode: '0', ResultDesc: 'Processed' })
    }

    if (url.pathname === '/standingorder/v1/createStandingOrderExternal') {
      state.standingOrders.push(body)
      const ok = state.ratibaScenario === 'approve'
      deliver(body.CallBackURL, {
        responseHeader: { responseRefID: 'r1', requestRefID: 'q1', responseCode: ok ? '0' : '1037', responseDescription: ok ? 'The service request is processed successfully' : 'Error' },
        responseBody: {
          responseData: [
            { name: 'TransactionID', value: ok ? 'SC8F2IQMH5' : '0000000000' },
            { name: 'responseCode', value: ok ? '0' : '1037' },
            { name: 'Status', value: ok ? 'OKAY' : 'ERROR' },
            { name: 'Msisdn', value: '254******867' },
          ],
        },
      })
      return Response.json({
        ResponseHeader: { responseRefID: 'r1', responseCode: '200', responseDescription: 'Request accepted for processing' },
        ResponseBody: { responseDescription: 'Request accepted for processing', responseCode: '200' },
      })
    }
    return new Response('not found', { status: 404 })
  }

  const m = mpesa({
    daraja: { environment: 'sandbox', consumerKey: 'k', consumerSecret: 's', shortcode: '174379', passkey: 'pk', fetch: darajaFetch },
    store,
    secretKey: SECRET,
    publicUrl: ORIGIN,
    callbackToken: TOKEN,
    identify: ({ headers }) => headers.get('x-user') ?? undefined,
    stkQueryAfterMs: 50,
  })

  const mppx = Mppx.create({ methods: [m.charge, m.subscription], secretKey: SECRET, realm: 'api.test' })

  app = async (req) => {
    const handled = await m.handle(req)
    if (handled) return handled
    const { pathname } = new URL(req.url)
    if (pathname === '/premium') {
      const r = await mppx.mpesa.charge({ amount: '10', description: 'Premium call', expires: new Date(Date.now() + 10 * 60_000) })(req)
      if (r.status === 402) return r.challenge
      return r.withReceipt(Response.json({ data: 'premium content' }))
    }
    if (pathname === '/plan') {
      const r = await mppx.mpesa.subscription({ amount: '500', periodCount: '1', periodUnit: 'month', expires: new Date(Date.now() + 10 * 60_000) })(req)
      if (r.status === 402) return r.challenge
      return r.withReceipt(Response.json({ data: 'plan content' }))
    }
    return new Response('not found', { status: 404 })
  }

  const appFetch: typeof fetch = async (input, init) => app(input instanceof Request ? input : new Request(String(input), init))

  function makeClient(opts: Partial<client.MpesaClientParameters> = {}) {
    const prompts: string[] = []
    const params: client.MpesaClientParameters = {
      phone: '0712345678',
      pollIntervalMs: 10,
      timeoutMs: 3000,
      fetch: appFetch,
      onPrompt: ({ message }) => prompts.push(message),
      ...opts,
    }
    const c = ClientMppx.create({ methods: [...client.mpesa(params)], polyfill: false, fetch: appFetch })
    return { fetch: c.fetch, prompts }
  }

  return { state, store, m, mppx, app, appFetch, makeClient, receiptOf: (r: Response) => Receipt.fromResponse(r) }
}
