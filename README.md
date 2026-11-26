# Reconcile Desk

Reconcile invoice and payment CSVs in the browser. Review split payments, overpayments, unpaid invoices, unmatched payments, and currency mismatches. The example inputs in `public/` are fictional.

## Try the app

Use Node.js 22.12 or later.

    npm ci
    npm test
    npm run dev

Open the address printed by Vite. Review the example, or import the two example CSV files through the form. The example has six invoices, seven payments, two exactly matched invoices, and five exceptions.

| Input | CSV columns |
| --- | --- |
| Invoices | `invoice_id,currency,amount_due` |
| Payments | `payment_id,invoice_id,currency,amount_received` |

The app supports USD and KRW. It calculates totals in integer minor units and flags duplicate identifiers or invalid rows so they can be corrected before review.

## Enable AI review

Create a Firebase web app in a Spark project. Set up Firebase AI Logic with the Gemini Developer API, register the app with App Check, and provide the public client configuration documented in `.env.example` through a local `.env` file. Restart Vite after changing the configuration.

Select **Prioritize on device** in a Chrome environment that supports the built-in model. The app also has an explicit **Allow cloud fallback** action, available with App Check configured. That action first tries the on-device route and may ask a cloud model if the local model is unavailable. The input preview lists exactly which exception categories and counts go into the prompt. Invoice IDs, payment IDs, currencies and amounts stay in the browser.

The verified exception table and rules-based review memo remain available when AI is unavailable. When AI returns a valid priority order, the result identifies the inference route used.

See [Firebase hybrid inference for web](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) and [Gemini Developer API pricing in Firebase](https://firebase.google.com/docs/ai-logic/pricing?api=dev).

## Project notes

This project uses JavaScript, Vite, Papa Parse, Firebase AI Logic, and Firebase App Check. OpenAI Codex assisted with implementation and testing.

See [LICENSE](LICENSE) for the Apache 2.0 license.
