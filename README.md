# StocksApp report backend

Private Vercel Node.js API for Abhi Coin weekly paper reports. MongoDB stores each account/week under a deterministic unique key. Retried uploads are idempotent; older revisions and edits to published contracts or completed fills are rejected. No Upstox credentials, real broker orders, or scheduled trading worker are required here.

## Deploy on Vercel

1. Import this folder as a new project. Framework: **Other**, Node.js **24.x**. No build command or output directory is needed. Vercel discovers `api/health.mjs` and `api/reports.mjs`.
2. Set environment variables **MONGODB_URI**, **MONGODB_DB** (for example `stocksapp`), and **REPORT_API_TOKEN**. Generate a token locally with `npm run token` and keep it private. MongoDB credentials must never go in the mobile app or git.
3. Permit the deployment to reach your MongoDB cluster, using your Atlas network policy. Deploy. `/api/health` checks the function is running; it deliberately does not claim the database is connected.
4. In the mobile app Settings, enter the `https://your-project.vercel.app` origin and the same report token. Save and sync. The Dashboard shows whether uploads were acknowledged by MongoDB. Leave these settings blank until deployment; local reports continue working.

The report token is for this private deployment. All holders can access reports; this is not a multi-tenant public authentication system. Use one device as the writer for its account ID. Vercel deployment protection must allow the mobile API request; the API itself requires its bearer token.

## Local checks

Run `npm ci`, `npm test`. Copy `.env.example` to `.env`, fill values, then `npm start`. Local server binds to localhost. Node tests exercise real HTTP requests against the handler with a memory test repository; an actual MongoDB connection requires your URI and is not covered by those tests.

## API

- `GET /api/health`: unauthenticated process health.
- `PUT /api/reports?account=DEVICE_ID&week=YYYY-MM-DD`: authenticated validated weekly payload, with monotonic revision. Returns `{week, revision, summary}` only after persistence.
- `GET /api/reports?account=DEVICE_ID&week=YYYY-MM-DD`: complete saved report.
- `GET /api/reports?account=DEVICE_ID`: up to 52 report summaries, newest first. Pass `before=YYYY-MM-DD` from `nextBefore` for older pages.

Use `Authorization: Bearer REPORT_API_TOKEN`. Error codes: 400 invalid payload, 401 authentication failure, 409 revision/history conflict, 413 oversized payload, 503 database unavailable. No request bodies, tokens or database exception text are logged. Requests are limited to 256 KB. Reports have no expiry/TTL. Database backups and retention are managed in Atlas.

## Meaning of returns

The backend recomputes percentages and closed-trade statistics from the submitted paper ledger; these are **device simulations**, not independent verification of broker fills. Top-ups are removed from profit. Weekly return is `(last observed equity - opening equity - top-ups) / (opening equity + top-ups)`. This simple contributed-capital return is not time-weighted. A 30% goal is metadata, never a promised result. Monitoring gaps remain flagged. Historical weekly balances use the last observed valuation; no unobserved Friday closing price is invented.

The phone monitors paper positions while active and through permitted Android jobs. Vercel stores reports on request; deploying this API does not create an always-running trading engine. Reinstalling the phone app clears its local trading ledger; MongoDB reports remain readable through the API, but automatic account restoration/multi-device trading is not implemented.

Implementation references: [Vercel Node.js functions](https://vercel.com/docs/functions/runtimes/node-js), [MongoDB connection options](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/), [Upstox option contract listing](https://upstox.com/developer/api-documentation/get-option-contracts/).
