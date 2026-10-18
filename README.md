# mpesa-mpp

An **M-Pesa payment method for the [Machine Payments Protocol](https://mpp.dev)** (MPP), built on the `mppx` SDK.

| Intent | M-Pesa product | Customer approves | Best for |
| --- | --- | --- | --- |
| `charge` | STK Push (Lipa na M-Pesa Online) | Every payment | One-off purchases, human-supervised agents |
| `subscription` | Ratiba standing order | Once | Agents with recurring API access |

## How it works

M-Pesa can only be debited by the merchant, after the customer enters their PIN. So unlike
crypto methods, the client cannot "pay and bring proof" on its own. Instead:

```
Client                          Your API (mpesa method)                 Safaricom
  │ GET /premium ───────────────►│                                         │
  │◄── 402  WWW-Authenticate: Payment method="mpesa" … initiateUrl ───────│
  │ POST initiateUrl {challenge, phone} ──►│ verify HMAC, STK Push / Ratiba ─►│ 📱 prompt
  │                                        │◄────────── callback (receipt) ──│
  │ GET statusUrl?id=… (poll) ────────────►│ "paid" / "active"               │
  │ GET /premium  Authorization: Payment {checkoutRequestId | standingOrderRef}
  │                                        │ broadcast(): re-check record vs challenge,
  │◄── 200  Payment-Receipt (M-Pesa receipt no.) │ claim it once
```

The server never trusts the client's payload alone: every Credential points at a server-side
record created for *that* Challenge, and the amount, recipient and period are compared again.

## Install

```bash
npm i mpesa-mpp mppx
```

## Server

```ts
import { Mppx, Store, mpesa } from 'mpesa-mpp/server'

const m = mpesa({
  daraja: { environment: 'sandbox', consumerKey, consumerSecret, shortcode: '174379', passkey },
  store: Store.redis(redis),                    // durable + atomic
  secretKey: process.env.MPP_SECRET_KEY!,       // same as Mppx.create
  publicUrl: 'https://api.example.com',         // must be reachable by Safaricom
  callbackToken: process.env.CALLBACK_TOKEN!,   // secret path segment; callbacks are unsigned
  identify: ({ headers }) => headers.get('x-api-key') ?? undefined, // for subscriptions
})

const mppx = Mppx.create({ methods: [m.charge, m.subscription], secretKey: process.env.MPP_SECRET_KEY! })

async function app(req: Request) {
  const handled = await m.handle(req)          // /mpesa/initiate, /mpesa/status, /mpesa/callback/*
  if (handled) return handled

  const r = await mppx.mpesa.charge({ amount: '10', expires: new Date(Date.now() + 600_000) })(req)
  // or: mppx.mpesa.subscription({ amount: '500', periodCount: '1', periodUnit: 'month' })(req)
  if (r.status === 402) return r.challenge
  return r.withReceipt(Response.json({ data: '…' }))
}
```

Give challenges a generous `expires` (10 minutes in the example): people take time to find their phone.

## Client / agent

```ts
import { Mppx, mpesa } from 'mpesa-mpp/client'

const { fetch } = Mppx.create({
  methods: [...mpesa({
    phone: '0712345678',
    maxChargeAmount: 50,          // spend caps, checked before anyone is prompted
    maxSubscriptionAmount: 1000,
    onPrompt: ({ message }) => notifyHuman(message),
  })],
  polyfill: false,
})

await fetch('https://api.example.com/premium')
```

## Wire format

**charge request** (`methodDetails` holds the M-Pesa-specific fields):

```json
{ "amount": "10", "currency": "KES", "recipient": "174379",
  "methodDetails": { "initiateUrl": "…/mpesa/initiate", "statusUrl": "…/mpesa/status", "shortcodeType": "paybill" } }
```

Credential payload: `{ "checkoutRequestId": "ws_CO_…" }`.  Receipt `reference`: the M-Pesa receipt number.

**subscription request**: adds `periodCount`, `periodUnit` (`day` | `week` | `month`) and optional
`subscriptionExpires` (becomes the Ratiba end date). Credential payload: `{ "standingOrderRef": "…" }`.
Receipt carries `subscriptionId`.

Supported periods are exactly what Ratiba offers: 1 day, 1 week, 1, 2, 3, 6 or 12 months.
Anything else is rejected before a Challenge is issued, as the subscription intent requires.

Amounts are whole shillings; `"10.50"` is rejected by the schema.

## Subscriptions in detail

1. First request → 402 → customer approves the Ratiba standing order → Ratiba callback marks it
   `active` and the first period paid → Credential redeemed → identity bound to the subscription.
2. Later requests from the same identity are let through by the `authorize` hook while the
   period is paid (plus `gracePeriodMs`, default 1 day). No new prompt.
3. Ratiba collects each renewal into your Paybill. Those arrive on the **C2B confirmation URL**
   (`m.urls.c2bConfirmation`), matched by `BillRefNumber` (the 12-char reference we set as
   `AccountReference`), and extend `paidThrough`. Duplicate confirmations are ignored.
4. If the customer cancels on their phone or a collection fails for low balance, no renewal
   arrives, the period runs out, and the API returns 402 again.

**Register the C2B confirmation URL on your Paybill**, or renewals will never be seen.
Use a Paybill rather than a till for subscriptions: tills don't return an account reference.


## Examples

Two runnable services that sell data to AI agents, with no Safaricom account needed to try them:

```bash
npm run example:soko       # crop prices: weekly Ratiba plan, reuse, automatic renewal
npm run example:weather    # forecasts: the agent picks pay-per-call or a daily plan
```

## Testing with real sandbox credentials

`npm run sandbox:check` tests your Daraja keys step by step (OAuth, a KES 1 STK Push and, with `-- --ratiba`, a standing order) and records Safaricom's raw callbacks.
## Development

```bash
npm install
npm test          # 23 tests: the SDK against a fake Daraja, plus both examples end to end
npm run typecheck
npm run build
```

`examples/server.ts` and `examples/client.ts` are a minimal setup for the real Daraja sandbox
(you'll need a public tunnel such as ngrok for callbacks).
