# Backend deployment: local Node and Vercel Functions

The API was already split correctly: `src/app.ts` constructs/exports the Express app; `src/server.ts` connects MongoDB, starts the listener, initializes models, and runs the scheduled-publication interval. No Vercel config/function entrypoint existed. The reported missing `public` error means the deployment expected static output after TypeScript compilation; compiling a backend does not create a static site. The remote dashboard has not been accessed or changed here.

## Vercel project settings

| Setting | Value |
| --- | --- |
| Root Directory | Repository root if `package.json`, `src`, and `vercel.json` are at the root of End-point-backend; `BackEnd` when deploying this entire workspace repository |
| Framework Preset | Express |
| Build Command | `npm run build` |
| Output Directory | Clear/unset the override; do not enter `public`, `dist`, or `build` |
| Install Command | `npm ci --include=dev` |
| Node.js | 22.x (matches local validation) |

`vercel.json` explicitly selects `framework: "express"` and keeps the TypeScript build. The output-directory override is explicitly reset to null; no static output directory or rewrite is configured. The previous `framework: null` / `outputDirectory: null` configuration still selected the static Other build path in CLI 62.7.0 and failed expecting `public`; null was not a reliable fix. Native Express uses the default-exported `src/app.ts` and preserves the original request URLs: `/api/v1/auth/login`, `/api/v1/student/packages`, etc. Do not append another `/api` prefix. `GET /health` and the existing `GET /api/v1/health` are lightweight liveness checks and do not connect/query MongoDB in the Vercel handler; they do not prove database readiness.

Vercel bundles `src/app.ts` using its native Express framework support. The previous `api/index.ts` was removed: keeping that directory alongside native Express caused Vercel to reserve `/api/*` for file-based functions and generate a 404 before the Express catch-all, which would break this API's `/api/v1/*` routes. The only Vercel entry is the default-exported app; no listener or interval starts during import. The unchanged `npm run build` compiles the traditional server under `src` to `dist`; `npm start` still runs `dist/server.js`. The native app entrypoint never imports `server.ts`, starts a listener, or starts an interval.

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

`src/shared/database.ts` shares an in-flight connection promise, reuses an established connection in a warm instance, clears failed attempts, and resets the cache on disconnect. The shared app connects before database-backed requests when `VERCEL=1`; health and CORS preflight bypass the connection. The local server still connects before listening. Database connection failure returns a generic 503 without exposing connection details. Connections are not disconnected after each request. The local server and database scripts continue using the same helper.

## Remaining deployment blockers and runtime differences

**File storage:** PDF summaries, educational files, receipt images and covers now use Vercel Blob in every environment. Large uploads go directly from the browser to Blob using constrained presigned uploads; protected downloads redirect to a one-minute signed URL after backend authorization, avoiding Function payload limits in both directions. There is no persistent local filesystem dependency. Follow [STORAGE.md](STORAGE.md) to connect separate private/public stores and migrate existing files. Storage is unavailable until those stores/credentials are configured; there is no disk fallback.

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

Check `http://localhost:4000/health` (or the configured local port) and `/api/v1/health`. The deployment tests import both app and function without a listener, exercise health/CORS/routing/database failure, verify Blob upload/download permissions and metadata, and test cached/concurrent/retried MongoDB connections without network dependence. Real database tests use separate generated test databases.

Official references:
- [Native Express deployment](https://vercel.com/docs/frameworks/backend/express)
- [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Node.js function runtime and TypeScript](https://vercel.com/docs/functions/runtimes/node-js)
- [Function payload limits](https://vercel.com/docs/functions/limitations)
- [Filesystem limitations](https://vercel.com/docs/functions/runtimes)

The repository changes have not been published or deployed to a Vercel account. A successful local build is not proof of a remote deployment; clear the dashboard override, configure environment variables, redeploy, and check both health/API routes.

Local runtime smoke check: `node --import tsx scripts/verify-local-runtime.ts` after building. It imports the compiled app in a separate process, verifies that process exits without a listener, starts the traditional server on temporary port 4401, checks both health routes, and stops the process. This executes normal server startup, including the existing scheduled-publication service; use the intended local database configuration.

Validation performed locally: `npm install` completed with zero reported vulnerabilities; `npm run build`, `npm run typecheck`, and `npm run lint` passed. The compiled app import exited without a listener. A temporary traditional server returned HTTP 200 for `/health` with `{ "ok": true }` and for `/api/v1/health` with `{ "data": { "status": "ok" } }`. All seven deployment/connection-specific tests passed. No Vercel account credentials/dashboard were used and no live deployment was attempted.

Full-suite baseline before the native Express follow-up: `npm test` passed all **49 tests across 5 files** after correcting the new negative-route assertion to expect 404 for the invalid duplicated prefix. No remaining test failures in the final run.


## Follow-up: CLI 62.7.0 static-output failure

The failing deployed commit was confirmed to be present locally (`5d38f7f`). This was not a missing push. The original `framework: null` selected Other and still expected `public` after compilation. The fix selects the supported native Express framework, exports the shared app as default, and moves the serverless-only cached connection gate into the shared app. The local server stays unchanged. Helmet default imports are normalized across ESM/CJS for Vercel's TypeScript bundler without removing any security middleware; tests assert its response headers.

Clear any explicit `public` Output Directory override in the dashboard and use Framework Preset Express. Keep the existing build/install commands. `outputDirectory: null` in the native Express configuration also resets the legacy project override. No static directory is created and the repository is not served as static output.


Follow-up validation: `vercel build` using **CLI 62.7.0** completed successfully in an isolated local checkout with synthetic project settings (including a legacy dashboard `outputDirectory: "public"` overridden by the repository configuration). It produced `.vercel/output/functions/index.func` with handler `src/app.js`, runtime `nodejs22.x`, and native Express catch-all routing. The packaged function itself returned 200 from both health routes with Helmet security headers; the generated routing config has no reserved `/api/*` 404. `npm run build`, `npm run typecheck`, `npm run lint`, the 7 serverless/connection tests, and the local traditional-server smoke check passed after the follow-up. This was a local CLI build only: no account was linked, no Vercel dashboard was changed, and no deployment was published.
