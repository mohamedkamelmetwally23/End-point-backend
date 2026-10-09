# Backend deployment: local Node and Vercel Functions

The API was already split correctly: `src/app.ts` constructs/exports the Express app; `src/server.ts` connects MongoDB, starts the listener, initializes models, and runs the scheduled-publication interval. No Vercel config/function entrypoint existed. The reported missing `public` error means the deployment expected static output after TypeScript compilation; compiling a backend does not create a static site. The remote dashboard has not been accessed or changed here.

## Vercel project settings

| Setting | Value |
| --- | --- |
| Root Directory | Repository root if `package.json`, `src`, `api`, and `vercel.json` are at the root of End-point-backend; `BackEnd` when deploying this entire workspace repository |
| Framework Preset | Other |
| Build Command | `npm run build` |
| Output Directory | Clear/unset the override; do not enter `public`, `dist`, or `build` |
| Install Command | `npm install` |
| Node.js | 22.x (matches local validation) |

`vercel.json` explicitly sets framework/output directory to null, keeps the TypeScript build, and rewrites all paths to the single `/api/index` function. It has no legacy `builds` or v1 configuration. The function uses the existing app and preserves the original request URLs: `/api/v1/auth/login`, `/api/v1/student/packages`, etc. Do not append another `/api` prefix. `GET /health` and the existing `GET /api/v1/health` are lightweight liveness checks and do not connect/query MongoDB in the Vercel handler; they do not prove database readiness.

Vercel compiles `api/index.ts` with its TypeScript runtime. `tsconfig.json` includes it for `npm run typecheck`. The unchanged `npm run build` compiles the traditional server under `src` to `dist`; `npm start` still runs `dist/server.js`. The function entrypoint never imports `server.ts`, starts a listener, or starts an interval.

## Environment variables

Set in both Production and Preview as applicable; do not commit `.env` or secrets.

| Variable | Configuration |
| --- | --- |
| `MONGODB_URI` | Required. Existing canonical MongoDB URI, explicitly including the intended database name. Use Atlas or a reachable replica set because writes use transactions. Configure database network access for the deployment. |
| `COOKIE_SECRET` | Required. Strong random secret, at least 32 characters. Keep stable across function instances. |
| `NODE_ENV` | `production` |
| `FRONTEND_URL` | Exact frontend origin, e.g. `https://your-frontend.vercel.app`, with no path/trailing slash. Required for functioning production CORS and origin checks; localhost remains the development default. |
| `COOKIE_SAME_SITE` | `none` for cross-site frontend/backend origins over HTTPS; `lax` for local/same-site deployments. Default remains `lax`. Production cookies are Secure and HttpOnly. Browser third-party-cookie policy can still require a same-site custom domain or frontend proxy. |
| `WHATSAPP_NUMBER` | Optional digits including country code; required only for the paid purchase CTA. |
| `PORT` | Optional; used only by the traditional server, default 4000. Vercel manages its own listener. |

There is no JWT secret: authentication uses database sessions and signed cookies. `INITIAL_ADMIN_EMAIL`/`INITIAL_ADMIN_PASSWORD` are bootstrap-only and are not deployment/runtime requirements. Deploying does not seed/reset the database.

CORS retains an exact configured origin and `credentials: true`; it never uses a wildcard. Frontend requests must include credentials. If calling the backend directly, set frontend `VITE_API_URL=https://your-backend.vercel.app/api/v1` before building the frontend.

## MongoDB connection reuse

`src/shared/database.ts` shares an in-flight connection promise, reuses an established connection in a warm instance, clears failed attempts, and resets the cache on disconnect. `api/index.ts` connects before forwarding database-backed requests. Database connection failure returns a generic 503 without exposing connection details. Connections are not disconnected after each request. The local server and database scripts continue using the same helper.

## Remaining deployment blockers and runtime differences

**Persistent PDF storage is a blocker for upload/download feature parity.** `src/shared/summary-files.ts` writes new summary files under `storage/summary-pdfs`. Routes `POST /api/v1/staff/summary-pdf` and `GET /api/v1/summary-pdfs/:filename` in `src/modules/api/routes.ts` depend on that disk. Vercel does not provide persistent writable application storage. Under `VERCEL=1`, these routes explicitly return `503 PDF_STORAGE_UNAVAILABLE_ON_VERCEL` rather than pretending a temporary write is durable. Local uploads remain available. Existing external HTTPS PDF links and legacy inline summaries do not depend on these disk routes. No storage provider was configured or introduced, and no existing files were moved/deleted.

Additionally, the 20 MiB PDF upload cannot pass through a Vercel Function: the platform caps request/response payloads at 4.5 MB. Increasing Multer limits or using `/tmp` cannot solve either persistence or the inbound request limit. Persistent storage plus direct uploads must be configured separately before this PDF workflow can run on Vercel.

**Scheduled publication:** `src/server.ts` publishes due lectures at startup and every 15 seconds locally. That file intentionally never runs in Vercel Functions. A real external scheduler/worker invoking the existing `publishScheduled` service through an appropriately authenticated integration is required for automatic publication on Vercel. No cron plan, schedule, new public worker endpoint, or provider was invented. Scheduled lectures remain scheduled until a publisher runs.

**Rate limiting:** the auth-attempt map in `src/app.ts` is per process/function instance. It is preserved, but cannot enforce a global limit across serverless replicas or cold starts. Use shared rate limiting/infrastructure if a deployment-wide limit is required. Actual user/session/device/access state resides in MongoDB.

No WebSockets or other long-running workers were found. Local shutdown hooks and the interval remain confined to the traditional server.

## Validation and commands

```text
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run dev
# Or after building:
npm start
```

Check `http://localhost:4000/health` (or the configured local port) and `/api/v1/health`. The deployment tests import both app and function without a listener, exercise health/CORS/routing/database failure, verify explicit storage blocking, and test cached/concurrent/retried MongoDB connections without network dependence. Real database tests use separate generated test databases.

Official references:
- [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Node.js function runtime and TypeScript](https://vercel.com/docs/functions/runtimes/node-js)
- [Function payload limits](https://vercel.com/docs/functions/limitations)
- [Filesystem limitations](https://vercel.com/docs/functions/runtimes)

The repository changes have not been published or deployed to a Vercel account. A successful local build is not proof of a remote deployment; clear the dashboard override, configure environment variables, redeploy, and check both health/API routes.

Local runtime smoke check: `node --import tsx scripts/verify-local-runtime.ts` after building. It imports the compiled app in a separate process, verifies that process exits without a listener, starts the traditional server on temporary port 4401, checks both health routes, and stops the process. This executes normal server startup, including the existing scheduled-publication service; use the intended local database configuration.

Validation performed locally: `npm install` completed with zero reported vulnerabilities; `npm run build`, `npm run typecheck`, and `npm run lint` passed. The compiled app import exited without a listener. A temporary traditional server returned HTTP 200 for `/health` with `{ "ok": true }` and for `/api/v1/health` with `{ "data": { "status": "ok" } }`. All seven deployment/connection-specific tests passed. No Vercel account credentials/dashboard were used and no live deployment was attempted.

Final full-suite result: `npm test` passed all **49 tests across 5 files** after correcting the new negative-route assertion to expect 404 for the invalid duplicated prefix. No remaining test failures in the final run.
