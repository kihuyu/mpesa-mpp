# Examples

Two small fictional services that sell data to AI agents and get paid with M-Pesa. Both
run **with no Safaricom account**: by default a pretend Safaricom (`shared/simulator.ts`)
shows the phone prompts in your terminal and approves them. Add Daraja sandbox keys to
`.env` to use the real sandbox instead (see `../.env.example`).

| Example | What's sold | Per call | Plan | Shows |
| --- | --- | --- | --- | --- |
| [Soko Bei](./soko-bei) | Crop market prices | KES 10 | KES 150/week | Weekly Ratiba plan, reuse with no prompt, automatic renewal |
| [Mvua](./weather) | Weather forecasts | KES 5 | KES 20/day | The agent picks per-call or the plan depending on how much it will use |

## Run the demos (one command each)

```bash
npm install
npm run example:soko       # Wanjiku's assistant finds the best market for 40 bags of maize
npm run example:weather    # a farmer pays once; a haulage dispatcher takes the daily plan
```

## Run server and agent separately

```bash
npm run example:soko:server                 # terminal 1
npm run example:soko:agent                  # terminal 2

npm run example:weather:server              # terminal 1
npm run example:weather:agent -- planting   # terminal 2 (or: fleet)
```

Or look at the raw 402 yourself:

```bash
curl -i "http://localhost:3001/prices?crop=maize&market=Eldoret"
```

The `WWW-Authenticate` header carries two `mpesa` challenges, a `subscription` and a
`charge`. The client's `orderChallenges` hook (`shared/choose.ts`) picks the cheaper one for
the usage it expects.

## Against the real Daraja sandbox

1. Copy `../.env.example` to `../.env` and fill in your sandbox keys.
2. Start a tunnel so Safaricom can reach your callbacks, e.g. `ngrok http 3001`, and set
   `PUBLIC_URL` to the tunnel URL.
3. Run the server and agent in separate terminals as above. Prompts go to `MPESA_PHONE`.

Sandbox caveats: Ratiba may not be enabled on the shared sandbox shortcode, and renewals
can't be triggered on demand. The simulator's `collectRenewal()` stands in for that in
the demo.

## How the pieces fit

```
examples/
├── shared/
│   ├── runtime.ts     # builds the mpesa method + Mppx; picks simulator or real Daraja
│   ├── simulator.ts   # pretend Safaricom: answers Daraja calls, posts callbacks
│   └── choose.ts      # agent logic: per-call vs plan, based on expected usage
├── soko-bei/
│   ├── server.ts      # GET /prices — compose(subscription weekly, charge)
│   ├── agent.ts       # compares 5 markets net of transport, recommends one
│   └── demo.ts        # Monday → Wednesday → Ratiba renewal, narrated
└── weather/
    ├── server.ts      # GET /forecast — compose(charge, subscription daily); Open-Meteo data
    ├── agents.ts      # planting advice (pays once) and a route check (daily plan)
    └── demo.ts
```

Things to notice in the code:

- **Validate before charging.** Both servers reject unknown crops, markets and places with a
  400 *before* creating a 402, so nobody pays for a bad request.
- **Identity for plans.** Agents send a secret `x-agent-token` header. The server's `identify`
  hook binds the plan to it, so later calls skip the 402. Treat the token like a password:
  anyone who has it can use the plan.
- **Spend caps.** Each agent sets `maxChargeAmount` and `maxSubscriptionAmount`, which are
  checked before anyone's phone is prompted.

Market prices in Soko Bei are generated sample data. Mvua uses real Open-Meteo forecasts when
the server can reach the internet, and says `"source": "simulated"` when it can't.
