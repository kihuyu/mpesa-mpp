/**
 * Minimal Safaricom Daraja client covering what the `mpesa` MPP method needs:
 * OAuth, STK Push, STK Push Query and Ratiba (standing orders).
 *
 * Server-side only: it holds the consumer secret and passkey.
 */

export type Environment = 'sandbox' | 'production'

export type DarajaConfig = {
  environment: Environment
  consumerKey: string
  consumerSecret: string
  /** Business short code used for STK Push (the Paybill, or the store number for tills). */
  shortcode: string
  /** Lipa na M-Pesa Online passkey for `shortcode`. */
  passkey: string
  /** Override the base URL (tests). */
  baseUrl?: string
  /** Inject a fetch implementation (tests). */
  fetch?: typeof globalThis.fetch
}

const BASE_URLS: Record<Environment, string> = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
}

export class DarajaError extends Error {
  override name = 'DarajaError'
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

/** Normalizes 07xx / 01xx / +254 / 254 numbers to the 2547XXXXXXXX form Daraja expects. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[^\d]/g, '')
  let phone = digits
  if (/^0[17]\d{8}$/.test(digits)) phone = `254${digits.slice(1)}`
  else if (/^[17]\d{8}$/.test(digits)) phone = `254${digits}`
  if (!/^254[17]\d{8}$/.test(phone)) throw new Error(`Not a valid Safaricom number: ${input}`)
  return phone
}

/** Daraja timestamps are East Africa Time (UTC+3), formatted yyyyMMddHHmmss. */
export function darajaTimestamp(now = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    eat.getUTCFullYear() +
    p(eat.getUTCMonth() + 1) +
    p(eat.getUTCDate()) +
    p(eat.getUTCHours()) +
    p(eat.getUTCMinutes()) +
    p(eat.getUTCSeconds())
  )
}

/** Ratiba dates are yyyymmdd in EAT. */
export function darajaDate(date: Date): string {
  return darajaTimestamp(date).slice(0, 8)
}

export type StkPushParameters = {
  phone: string
  amount: string
  /** Paybill or till receiving funds. Defaults to the configured shortcode. */
  partyB?: string
  shortcodeType?: 'paybill' | 'till'
  /** Max 12 chars. Shown to the customer on the prompt. */
  accountReference: string
  /** Max 13 chars. */
  description: string
  callbackUrl: string
}

export type StkPushResult = {
  MerchantRequestID: string
  CheckoutRequestID: string
  ResponseCode: string
  ResponseDescription: string
  CustomerMessage?: string
}

export type StkQueryResult = {
  ResponseCode: string
  ResponseDescription: string
  MerchantRequestID?: string
  CheckoutRequestID: string
  /** "0" = paid. Absent or non-zero while pending/failed. */
  ResultCode?: string
  ResultDesc?: string
}

export type StandingOrderParameters = {
  /** Must be unique per customer. */
  name: string
  startDate: Date
  endDate: Date
  phone: string
  amount: string
  frequency: string
  /** Paybill or till receiving funds. Defaults to the configured shortcode. */
  receiver?: string
  shortcodeType?: 'paybill' | 'till'
  /** Max 12 alphanumeric chars. Comes back as BillRefNumber on renewals. */
  accountReference: string
  /** Max 13 chars. */
  description: string
  callbackUrl: string
}

export type StandingOrderResult = {
  ResponseHeader?: { responseRefID?: string; responseCode?: string; responseDescription?: string }
  ResponseBody?: { responseCode?: string; responseDescription?: string }
}

export class Daraja {
  readonly baseUrl: string
  private readonly fetchFn: typeof globalThis.fetch
  private token?: { value: string; expiresAt: number }

  constructor(readonly config: DarajaConfig) {
    this.baseUrl = config.baseUrl ?? BASE_URLS[config.environment]
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** OAuth client-credentials token, cached until shortly before expiry. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value
    const basic = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString('base64')
    const res = await this.fetchFn(`${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
    })
    const body = (await res.json().catch(() => undefined)) as
      | { access_token?: string; expires_in?: string | number }
      | undefined
    if (!res.ok || !body?.access_token) throw new DarajaError('Daraja OAuth failed', res.status, body)
    const ttl = Number(body.expires_in ?? 3599) * 1000
    this.token = { value: body.access_token, expiresAt: Date.now() + ttl - 60_000 }
    return body.access_token
  }

  private password(timestamp: string): string {
    return Buffer.from(`${this.config.shortcode}${this.config.passkey}${timestamp}`).toString('base64')
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.accessToken()
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => undefined)) as T | undefined
    if (!res.ok || json === undefined) throw new DarajaError(`Daraja ${path} failed (${res.status})`, res.status, json)
    return json
  }

  /** Lipa na M-Pesa Online: prompts the customer to approve with their PIN. */
  async stkPush(p: StkPushParameters): Promise<StkPushResult> {
    const timestamp = darajaTimestamp()
    const result = await this.post<StkPushResult>('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.config.shortcode,
      Password: this.password(timestamp),
      Timestamp: timestamp,
      TransactionType: p.shortcodeType === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: p.amount,
      PartyA: normalizePhone(p.phone),
      PartyB: p.partyB ?? this.config.shortcode,
      PhoneNumber: normalizePhone(p.phone),
      CallBackURL: p.callbackUrl,
      AccountReference: p.accountReference.slice(0, 12),
      TransactionDesc: p.description.slice(0, 13),
    })
    if (result.ResponseCode !== '0')
      throw new DarajaError(`STK Push rejected: ${result.ResponseDescription}`, undefined, result)
    return result
  }

  /** Checks an STK Push when the callback is late or lost. Does not return the receipt number. */
  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const timestamp = darajaTimestamp()
    return this.post<StkQueryResult>('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: this.config.shortcode,
      Password: this.password(timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    })
  }

  /** M-Pesa Ratiba: asks the customer to approve a standing order. */
  async createStandingOrder(p: StandingOrderParameters): Promise<StandingOrderResult> {
    const result = await this.post<StandingOrderResult>('/standingorder/v1/createStandingOrderExternal', {
      StandingOrderName: p.name,
      StartDate: darajaDate(p.startDate),
      EndDate: darajaDate(p.endDate),
      BusinessShortCode: p.receiver ?? this.config.shortcode,
      TransactionType:
        p.shortcodeType === 'till' ? 'Standing Order Customer Pay Marchant' : 'Standing Order Customer Pay Bill',
      ReceiverPartyIdentifierType: p.shortcodeType === 'till' ? '2' : '4',
      Amount: p.amount,
      PartyA: normalizePhone(p.phone),
      CallBackURL: p.callbackUrl,
      AccountReference: p.accountReference.slice(0, 12),
      TransactionDesc: p.description.slice(0, 13),
      Frequency: p.frequency,
    })
    const code = result.ResponseBody?.responseCode ?? result.ResponseHeader?.responseCode
    if (code !== undefined && code !== '200')
      throw new DarajaError(
        `Ratiba request rejected: ${result.ResponseBody?.responseDescription ?? result.ResponseHeader?.responseDescription}`,
        undefined,
        result,
      )
    return result
  }
}
