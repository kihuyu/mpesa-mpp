/**
 * Soko Bei, end to end in one process: npm run example:soko
 *
 * Runs the API, assistant and a pretend Safaricom together, and narrates.
 */
import { randomBytes } from 'node:crypto'
import { inProcess } from '../shared/runtime.js'
import { runSokoAgent } from './agent.js'
import { PLAN, PORT, createRuntimeForSoko, createSokoBei } from './server.js'

const line = (s = '') => console.log(s)
const rt = createRuntimeForSoko({ quiet: true })
const app = createSokoBei(rt)
const fetch = inProcess(app)
const apiUrl = `http://localhost:${PORT}`
const agentToken = randomBytes(24).toString('hex')
const phone = '0712345678'

line(`Soko Bei demo (${rt.mode})`)
line('"Where should I sell my 40 bags of maize this week?"')
line()

line('── Monday: first question ──')
const first = await runSokoAgent({ apiUrl, phone, agentToken, fetch })
line()

line('── Wednesday: she asks again. The plan is active, so no prompt. ──')
await runSokoAgent({ apiUrl, phone, agentToken, fetch })
line()

if (rt.simulator && first.subscriptionId) {
  line('── Next Monday: Ratiba renews the plan by itself ──')
  const status = async () =>
    ((await (await fetch(`${apiUrl}/mpesa/status?id=${first.subscriptionId}`)).json()) as { paidThrough?: string }).paidThrough
  line(`   Paid up to: ${await status()}`)
  await rt.simulator.collectRenewal(rt.m.urls.c2bConfirmation, first.subscriptionId, PLAN.amount, rt.shortcode)
  line(`   Paid up to: ${await status()}  (one more week)`)
  line()
}

line('If the standing order is cancelled on *334#, no renewal arrives. When the paid week runs out,')
line('the assistant gets a 402 again and asks whether she wants to renew or pay per report.')
