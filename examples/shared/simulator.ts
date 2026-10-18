/**
 * A pretend Safaricom for the examples, so they run with no Daraja credentials.
 *
 * It answers the Daraja endpoints the SDK calls (OAuth, STK Push, STK Query,
 * Ratiba) and, after a short delay, "approves" on the customer's behalf by
 * posting the same callbacks Safaricom would send.
 *
 */

export type SimulatorOptions = {
  /** How long the pretend customer takes to enter their PIN. @default 1200 */
  approveAfterMs?: number
  /** Printed when a prompt "appears" on the phone. */
  onPhone?: (line: string) => void
}

export function createSimulator(options: SimulatorOptions = {}) {
  const delay = options.approveAfterMs ?? 1200
  const say = options.onPhone ?? ((line) => console.log(line))
  let deliverTo: ((req: Request) => Promise<Response>) | undefined
  let counter = 0

  const post = (url: string, body: unknown) =>
    setTimeout(() => {
      void deliverTo?.(
        new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      )
    }, delay)

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined

    if (url.pathname === '/oauth/v1/generate') return Response.json({ access_token: 'simulated', expires_in: '3599' })

    if (url.pathname === '/mpesa/stkpush/v1/processrequest') {
      const n = ++counter
      const id = `ws_CO_SIM${n}`
      say(`${mask(body.PhoneNumber)} sees: "Pay KES ${body.Amount} to ${body.PartyB}? Enter M-PESA PIN"`)
      setTimeout(() => say(`${mask(body.PhoneNumber)} enters PIN ✓`), delay - 100)
      post(body.CallBackURL, {
        Body: {
          stkCallback: {
            MerchantRequestID: `SIM-${n}`,
            CheckoutRequestID: id,
            ResultCode: 0,
            ResultDesc: 'The service request is processed successfully.',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: Number(body.Amount) },
                { Name: 'MpesaReceiptNumber', Value: receiptNo(n) },
                { Name: 'PhoneNumber', Value: Number(body.PhoneNumber) },
              ],
            },
          },
        },
      })
      return Response.json({
        MerchantRequestID: `SIM-${n}`,
        CheckoutRequestID: id,
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing',
      })
    }

    if (url.pathname === '/mpesa/stkpushquery/v1/query')
      return Response.json({ ResponseCode: '0', ResponseDescription: 'ok', CheckoutRequestID: body.CheckoutRequestID, ResultCode: '0', ResultDesc: 'Processed' })

    if (url.pathname === '/standingorder/v1/createStandingOrderExternal') {
      const n = ++counter
      const freq: Record<string, string> = { '2': 'daily', '3': 'weekly', '4': 'monthly', '5': 'every 2 months', '6': 'quarterly', '7': 'every 6 months', '8': 'yearly' }
      say(` ${mask(body.PartyA)} sees: "M-PESA Ratiba: pay KES ${body.Amount} ${freq[body.Frequency] ?? ''} to ${body.BusinessShortCode}? Enter PIN"`)
      setTimeout(() => say(`${mask(body.PartyA)} enters PIN ✓ (standing order created)`), delay - 100)
      post(body.CallBackURL, {
        responseHeader: { responseRefID: `SIM-${n}`, responseCode: '0', responseDescription: 'The service request is processed successfully' },
        responseBody: {
          responseData: [
            { name: 'TransactionID', value: receiptNo(n) },
            { name: 'responseCode', value: '0' },
            { name: 'Status', value: 'OKAY' },
            { name: 'Msisdn', value: mask(body.PartyA) },
          ],
        },
      })
      return Response.json({
        ResponseHeader: { responseRefID: `SIM-${n}`, responseCode: '200', responseDescription: 'Request accepted for processing' },
        ResponseBody: { responseDescription: 'Request accepted for processing', responseCode: '200' },
      })
    }

    return new Response('simulator: unknown endpoint', { status: 404 })
  }

  return {
    fetch,
    /** Where callbacks are delivered (your app's fetch handler). */
    attach(app: (req: Request) => Promise<Response>) {
      deliverTo = app
    },
    /**
     * Pretends Ratiba has collected the next instalment, by posting the C2B
     * confirmation Safaricom sends to the Paybill's confirmation URL.
     */
    async collectRenewal(c2bConfirmationUrl: string, standingOrderRef: string, amount: string, shortcode: string) {
      const n = ++counter
      say(`Ratiba collects KES ${amount} automatically (no prompt)`)
      return deliverTo?.(
        new Request(c2bConfirmationUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            TransactionType: 'Pay Bill',
            TransID: receiptNo(n),
            TransAmount: `${amount}.00`,
            BusinessShortCode: shortcode,
            BillRefNumber: standingOrderRef,
          }),
        }),
      )
    },
  }
}

function receiptNo(n: number) {
  return `SIM${String(n).padStart(4, '0')}XYZ`
}

function mask(phone: string | number) {
  const s = String(phone)
  return `${s.slice(0, 5)}***${s.slice(-3)}`
}
