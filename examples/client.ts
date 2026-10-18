/**
 * Example agent/client that pays with M-Pesa.
 *
 *   API_URL=http://localhost:3000 MPESA_PHONE=0712345678 npm run example:client
 *
 * The phone owner gets an STK prompt (or a Ratiba approval) and approves it with their PIN.
 */
import { Mppx, mpesa } from '../src/client/index.js'

const api = process.env.API_URL || 'http://localhost:3000'

const { fetch } = Mppx.create({
  methods: [
    ...mpesa({
      phone: process.env.MPESA_PHONE || '254708374149', // Daraja sandbox test number
      maxChargeAmount: 50, // never pay more than KES 50 for one call
      maxSubscriptionAmount: 1000, // never subscribe to more than KES 1,000 per period
      onPrompt: ({ message }) => console.log(` ${message}`),
    }),
  ],
  polyfill: false,
})

const res = await fetch(`${api}/premium`)
console.log(res.status, await res.json())
console.log('Payment-Receipt:', res.headers.get('payment-receipt'))
