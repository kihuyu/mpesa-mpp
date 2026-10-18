/** Server-side records kept in the configured mppx Store. All values are JSON-safe. */

export type StkRecord = {
  kind: 'stk'
  challengeId: string
  amount: string
  recipient: string
  phone: string
  status: 'pending' | 'paid' | 'failed'
  mpesaReceiptNumber?: string
  reason?: string
  createdAt: number
  /** Set once a Credential referencing this payment has been redeemed. */
  consumedAt?: number
}

export type SubscriptionRecord = {
  kind: 'subscription'
  ref: string
  challengeId: string
  amount: string
  recipient: string
  periodCount: string
  periodUnit: 'day' | 'week' | 'month'
  phone: string
  /** Sent to Ratiba as AccountReference; comes back as BillRefNumber on renewals. */
  accountReference: string
  status: 'pending' | 'active' | 'failed'
  reason?: string
  createdAt: number
  activatedAt?: number
  /** Access is paid up to this instant (ms). */
  paidThrough?: number
  lastTransactionId?: string
  identity?: string
  expiresAt: number
}

export type InitRecord = { state: 'starting' } | { state: 'started'; id: string; kind: 'stk' | 'subscription' }

export const keys = {
  init: (challengeId: string) => `mpesa:init:${challengeId}`,
  stk: (checkoutRequestId: string) => `mpesa:stk:${checkoutRequestId}`,
  sub: (ref: string) => `mpesa:sub:${ref}`,
  account: (accountReference: string) => `mpesa:acct:${accountReference}`,
  identity: (identity: string) => `mpesa:identity:${identity}`,
  usedStk: (checkoutRequestId: string) => `mpesa:used:stk:${checkoutRequestId}`,
  usedTrans: (transId: string) => `mpesa:used:trans:${transId}`,
}
