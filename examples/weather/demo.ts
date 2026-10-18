/**
 * Mvua, end to end in one process: npm run example:weather
 */
import { randomBytes } from 'node:crypto'
import { inProcess } from '../shared/runtime.js'
import { runFleetAgent, runPlantingAgent } from './agents.js'
import { PORT, createMvua, createRuntimeForMvua } from './server.js'

const line = (s = '') => console.log(s)
const rt = createRuntimeForMvua({ quiet: true })
const fetch = inProcess(createMvua(rt))
const apiUrl = `http://localhost:${PORT}`

line(`Mvua weather demo (${rt.mode})`)
line()

line('── 1. Otieno, a farmer near Kisumu: "Should I plant beans this week?" ──')
await runPlantingAgent({ apiUrl, fetch, phone: '0722111222', agentToken: randomBytes(24).toString('hex') })
line()

line('── 2. A haulage dispatcher checks the Mombasa–Kisumu route every morning ──')
const dispatcher = { apiUrl, fetch, phone: '0733444555', agentToken: randomBytes(24).toString('hex') }
await runFleetAgent(dispatcher)
line()
line('── Afternoon: the dispatcher checks again. Daily plan active, so no prompt. ──')
await runFleetAgent(dispatcher)
