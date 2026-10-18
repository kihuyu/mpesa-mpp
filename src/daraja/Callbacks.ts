/**
 * Parsers for the Daraja callbacks the `mpesa` method listens to.
 *
 * Daraja callbacks are not signed. The server routes only accept them on a
 * secret URL path.
 */

export type StkCallback = {
  checkoutRequestId: string
  merchantRequestId: string
  resultCode: number
  resultDesc: string
  amount?: string
  mpesaReceiptNumber?: string
  phone?: string
  transactionDate?: string
}

/** Parses `{ Body: { stkCallback: { ... } } }`. */
export function parseStkCallback(body: unknown): StkCallback {
  const cb = (body as any)?.Body?.stkCallback
  if (!cb?.CheckoutRequestID) throw new Error('Not an STK callback')
  const items: Array<{ Name: string; Value?: unknown }> = cb.CallbackMetadata?.Item ?? []
  const get = (name: string) => {
    const v = items.find((i) => i.Name === name)?.Value
    return v === undefined || v === null ? undefined : String(v)
  }
  return {
    checkoutRequestId: String(cb.CheckoutRequestID),
    merchantRequestId: String(cb.MerchantRequestID ?? ''),
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc ?? ''),
    amount: get('Amount'),
    mpesaReceiptNumber: get('MpesaReceiptNumber'),
    phone: get('PhoneNumber'),
    transactionDate: get('TransactionDate'),
  }
}

export type RatibaCallback = {
  ok: boolean
  responseCode: string
  status?: string
  transactionId?: string
  responseRefId?: string
  description?: string
}

/** Parses the Ratiba standing-order result callback. */
export function parseRatibaCallback(body: unknown): RatibaCallback {
  const b = body as any
  const header = b?.responseHeader ?? b?.ResponseHeader ?? {}
  const resBody = b?.responseBody ?? b?.ResponseBody ?? {}
  const data: Array<Record<string, unknown>> = resBody.responseData ?? resBody.ResponseData ?? []
  const get = (name: string) => {
    const lower = name.toLowerCase()
    const item = data.find((i) => String(i.Name ?? i.name ?? '').toLowerCase() === lower)
    const v = item?.Value ?? item?.value
    return v === undefined || v === null ? undefined : String(v)
  }
  const responseCode = get('responseCode') ?? get('ResultCode') ?? String(header.responseCode ?? '')
  const transactionId = get('TransactionID')
  const status = get('Status')
  const ok =
    responseCode === '0' &&
    (status === undefined || status.toUpperCase() === 'OKAY') &&
    transactionId !== undefined &&
    !/^0+$/.test(transactionId)
  return {
    ok,
    responseCode,
    status,
    transactionId,
    responseRefId: header.responseRefID ?? header.responseRefId,
    description: header.responseDescription ?? header.ResultDesc,
  }
}

export type C2BConfirmation = {
  transId: string
  transAmount: string
  shortcode: string
  billRefNumber: string
  transTime?: string
  msisdn?: string
}

/** Parses a C2B confirmation (how Ratiba renewals reach a Paybill). */
export function parseC2BConfirmation(body: unknown): C2BConfirmation {
  const b = body as any
  if (!b?.TransID) throw new Error('Not a C2B confirmation')
  return {
    transId: String(b.TransID),
    transAmount: String(b.TransAmount),
    shortcode: String(b.BusinessShortCode ?? ''),
    billRefNumber: String(b.BillRefNumber ?? ''),
    transTime: b.TransTime ? String(b.TransTime) : undefined,
    msisdn: b.MSISDN ? String(b.MSISDN) : undefined,
  }
}
