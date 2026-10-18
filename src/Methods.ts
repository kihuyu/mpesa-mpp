/**
 * Shared `mpesa` method definitions for the Machine Payments Protocol.
 *
 * Two intents are defined:
 *
 * - `charge`        — one-shot payment collected with an STK Push (Lipa na M-Pesa Online).
 * - `subscription`  — recurring payment backed by an M-Pesa Ratiba standing order.
 *
 * M-Pesa can only be debited by the merchant (the server) after the customer
 * approves on their phone, so both intents use the same pattern: the client
 * hands the server a phone number via `methodDetails.initiateUrl`, the server
 * asks Safaricom to prompt the customer, and the client polls
 * `methodDetails.statusUrl` until the payment (or standing order) is confirmed.
 * The Credential then references the server-side record, which the server
 * re-checks against the original Challenge before issuing a Receipt.
 */
import { Method, z } from 'mppx'

export const METHOD_NAME = 'mpesa' as const

/** Whole Kenyan shillings. M-Pesa does not support fractional amounts. */
const kesAmount = () =>
  z.string().check(z.regex(/^[1-9]\d*$/, 'M-Pesa amounts must be whole shillings (e.g. "50")'))

const shortcodeType = z.optional(z.enum(['paybill', 'till']))

/** Fields every `mpesa` challenge carries so clients know where to start payment. */
const baseMethodDetails = {
  /** POST `{ challenge, phone }` here to trigger the customer prompt. */
  initiateUrl: z.string(),
  /** GET `?id=<ref>` here to poll payment status. */
  statusUrl: z.string(),
  /** Whether `recipient` is a Paybill or a Buy Goods till. Defaults to paybill. */
  shortcodeType,
}

// ---------------------------------------------------------------------------
// charge (STK Push)
// ---------------------------------------------------------------------------

export const charge = Method.from({
  intent: 'charge',
  name: METHOD_NAME,
  schema: {
    credential: {
      payload: z.object({
        /** Safaricom `CheckoutRequestID` returned by the STK Push. */
        checkoutRequestId: z.string(),
      }),
    },
    request: z.object({
      amount: kesAmount(),
      currency: z.literal('KES'),
      /** Paybill or till number that receives the funds. */
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      methodDetails: z.object(baseMethodDetails),
    }),
  },
})

// ---------------------------------------------------------------------------
// subscription (Ratiba standing order)
// ---------------------------------------------------------------------------

export const periodUnits = ['day', 'week', 'month'] as const
export type PeriodUnit = (typeof periodUnits)[number]

export const subscription = Method.from({
  intent: 'subscription',
  name: METHOD_NAME,
  schema: {
    credential: {
      payload: z.object({
        /** Server-issued reference for the standing order created for this Challenge. */
        standingOrderRef: z.string(),
      }),
    },
    request: z.object({
      amount: kesAmount(),
      currency: z.literal('KES'),
      periodCount: z.string().check(z.regex(/^[1-9]\d*$/)),
      periodUnit: z.enum(periodUnits),
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      /** RFC 3339 end of the recurring authorization. Maps to the Ratiba EndDate. */
      subscriptionExpires: z.optional(z.string()),
      methodDetails: z.object(baseMethodDetails),
    }),
  },
})

// ---------------------------------------------------------------------------
// Ratiba frequency mapping
// ---------------------------------------------------------------------------

/**
 * Ratiba frequency codes:
 * 1 One Off, 2 Daily, 3 Weekly, 4 Monthly, 5 Bi-Monthly, 6 Quarterly, 7 Half Year, 8 Yearly.
 */
export const RatibaFrequency = {
  oneOff: '1',
  daily: '2',
  weekly: '3',
  monthly: '4',
  biMonthly: '5',
  quarterly: '6',
  halfYear: '7',
  yearly: '8',
} as const

/**
 * Maps an MPP billing period to a Ratiba frequency code.
 *
 * The subscription intent requires methods to reject periods they cannot
 * represent exactly, so anything Ratiba has no code for (e.g. every 2 weeks)
 * throws instead of being rounded.
 */
export function toRatibaFrequency(periodCount: string | number, periodUnit: PeriodUnit): string {
  const count = Number(periodCount)
  const key = `${count}:${periodUnit}`
  const map: Record<string, string> = {
    '1:day': RatibaFrequency.daily,
    '1:week': RatibaFrequency.weekly,
    '1:month': RatibaFrequency.monthly,
    '2:month': RatibaFrequency.biMonthly,
    '3:month': RatibaFrequency.quarterly,
    '6:month': RatibaFrequency.halfYear,
    '12:month': RatibaFrequency.yearly,
  }
  const code = map[key]
  if (!code)
    throw new Error(
      `M-Pesa Ratiba cannot represent a billing period of ${count} ${periodUnit}(s). ` +
        'Supported: 1 day, 1 week, 1/2/3/6/12 months.',
    )
  return code
}

/** Adds one billing period to a date (calendar-aware for months). */
export function addPeriod(from: Date, periodCount: string | number, periodUnit: PeriodUnit): Date {
  const n = Number(periodCount)
  const d = new Date(from.getTime())
  if (periodUnit === 'day') d.setUTCDate(d.getUTCDate() + n)
  else if (periodUnit === 'week') d.setUTCDate(d.getUTCDate() + 7 * n)
  else d.setUTCMonth(d.getUTCMonth() + n)
  return d
}
