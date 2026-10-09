# Endpoint file storage and deployment

## Audit and old failure

The old `POST /staff/summary-pdf` accepted a 20 MiB multipart PDF using Multer memory storage, then `src/shared/summary-files.ts` wrote it to `storage/summary-pdfs/<uuid>.pdf`. `Lecture.summaryUrl` held `/api/v1/summary-pdfs/<uuid>.pdf`, and the authenticated GET route later used `sendFile`. A Vercel guard deliberately returned `PDF_STORAGE_UNAVAILABLE_ON_VERCEL`: application files are not persistent writable storage and a 20 MiB upload also exceeds Function payload limits.

`POST /staff/receipt-image` returned inline Base64, persisted by `Expense.receiptImage`. `Material.url` and `Package.coverUrl` previously accepted external HTTPS URLs only; neither had an upload implementation. The frontend PDF/image upload widgets called those two multipart routes. No PDF generator, image upload middleware, static uploads middleware, `diskStorage`, persistent `/tmp`, or other runtime filesystem writes were found. `storage/material` contains legacy files even though current runtime code had no route writing it.

## Current architecture

- `src/storage/vercel-blob.provider.ts` is the only SDK integration. It selects the private/public store, issues limited presigned uploads, reads metadata/signatures, uploads server-generated buffers, deletes blobs and creates one-minute download URLs. OIDC credentials are read/refreshed by the SDK, never copied into application tokens.
- `src/storage/storage.service.ts` owns `stored_files`, preparation, completion, reference binding, authorization and cleanup. Business services use this abstraction.
- `stored_files` stores provider, pathname, Blob reference, original name, MIME type, size, uploader, purpose, scope, visibility, timestamps, state and transactional reference count. It contains no bytes, Base64 or local paths.
- Existing `Material.url`, `Lecture.summaryUrl` and `Expense.receiptImage` remain stable client-safe references such as `/api/v1/files/<ObjectId>.pdf`. That identifier points to the single metadata record; no duplicated provider metadata is added to each business model. Covers store the validated public Blob URL.
- Local development, preview and production all use Blob. There is no local storage fallback.

## Upload and access

1. An authenticated staff user calls `POST /api/v1/files/prepare` with `originalName`, `mimeType`, `size`, `purpose`, optional `scopeId`, and `editing`.
2. `summary` uses a PackageSubject scope; `material` uses a Lecture scope. Create/edit permission is checked server-side, plus publish permission for materials of published/scheduled lectures. Covers require Super Admin; receipts belong to their staff uploader.
3. The browser calls `/files/:id/upload` using the Blob SDK. The authenticated backend issues a presigned write restricted to the allocated random pathname, exact MIME and declared size, with a ten-minute expiry and no overwrite. No general store token reaches the browser.
4. The browser uploads bytes directly to Blob. Limits are 20 MiB for PDFs and 2 MiB for PNG/JPEG/WebP. SVG/HTML are not accepted.
5. `/files/:id/complete` checks uploader ownership and token age, then reads actual Blob metadata and a short signature prefix. Only verified metadata becomes `ready`; forged signatures/types/sizes are rejected and cleanup is attempted. The UI reports upload errors, disables the uploader while busy, and enables business-record saving only after completion.
6. Saving the lecture/material/expense/package binds the file and increments its references inside the same MongoDB transaction. Existing entity IDs and relationships remain unchanged.

Private PDFs, lecture images and receipts go into the **private store**. Only package covers go into the **public store**. `GET /api/v1/files/:id.ext` authenticates first. Students must have active PackageAccess and satisfy the existing Package → PackageSubject → Subject → published Lecture checks. Staff must have `content:view` in the assigned scope. Super Admin can read all relevant files. Unbound upload previews are restricted to their uploader (and scoped staff view permission). Receipt reads are limited to their owner/Super Admin.

Private access returns a no-store redirect to a signed Blob GET URL valid for one minute, so a 20 MiB PDF never passes through the Express response body. The signed URL is a temporary bearer capability: access already issued can remain usable until expiry. Permanent private Blob URLs are never returned in the frontend's file response.

Existing authored external HTTPS material links remain supported and are not copied automatically from arbitrary hosts. Their remote host controls visibility; upload them into private Blob if they need protected access. New uploaded files always use the managed file references. New Base64/local/object-URL persistence is rejected. Legacy inline PDF display is retained temporarily for old records pending migration, not for new uploads.

## Summary generation

There is no PDF generator in the current repository. Uploaded summaries now follow the same Blob path as materials. Future code generating a PDF buffer should call `uploadFile(user, bytes, { purpose: "summary", scopeId: packageSubjectId, mimeType: "application/pdf", originalName: "summary.pdf" })`, then bind the returned reference when saving the lecture. This helper uploads and verifies in memory; it never writes to disk. Old local summary URLs return `FILE_REUPLOAD_REQUIRED` until their records are migrated.

## Replace/delete and abandoned uploads

Reference counts change transactionally with their business records. On replacement, the new file is bound and MongoDB commits before old-file cleanup begins. Shared files are retained. Unused draft material/lecture deletion and expense deletion release their references, then clean up zero-reference blobs. A failed cleanup leaves a `deleting` record for retry; business data stays saved and no active referenced file is deleted.

Abandoned uploads and ready-but-unsaved files older than 24 hours can be cleaned using:

```sh
npm run storage:cleanup
npm run storage:cleanup -- --apply
```

The first command is dry-run. The second retries `deleting` rows and removes old zero-reference uploads. Run it periodically from a trusted maintenance environment; no public cleanup endpoint is exposed. Pending rows have no TTL deletion because metadata must remain until Blob cleanup succeeds.

## Exact Vercel setup

1. Open the **backend** project `endpoint-back` → Storage → Create Storage → Blob. Create a **Private** store for educational files and receipts.
2. Create a second **Public** Blob store for package covers.
3. In each store's Projects tab, connect **endpoint-back** for **Production, Preview and Development**. Use separate preview stores/databases if previews must be isolated from production.
4. In backend Environment Variables, set `BLOB_PRIVATE_STORE_ID` to the private store ID and `BLOB_PUBLIC_STORE_ID` to the public store ID for the matching environments. The provider passes the appropriate store ID explicitly, so the SDK's default `BLOB_STORE_ID` cannot select the wrong store. Vercel supplies/rotates `VERCEL_OIDC_TOKEN`; do not manually create or expose it.
5. Keep the existing `MONGODB_URI`, `COOKIE_SECRET`, `NODE_ENV=production`, `FRONTEND_URL=https://endpoint-sage-three.vercel.app`, and cookie configuration. MongoDB must support transactions. No JWT secret is used by this application.
6. Deploy the updated backend repository. Keep Framework **Express**, build `npm run build`, Node **22.x**, and the output override unset (see `DEPLOYMENT.md`). Do not restore the deleted `api/index.ts` or add an uploads folder.
7. Deploy the updated frontend. Keep `VITE_API_URL=/api/v1` and the API proxy rewrite ahead of the SPA fallback. Never put Blob credentials in frontend environment variables. Local Vite uses its existing `/api` proxy.
8. Check `https://endpoint-sage-three.vercel.app/api/v1/health` returns JSON. Log in as authorized staff, upload a PDF over 4.5 MB and save the lecture. Refresh, open it and verify access as a Student with Package Access; verify another Student is denied. Upload a material image, receipt and cover; save, refresh and check rendering. The upload bytes should go to Blob directly in Network.

### Local/CI credentials and existing file migration

For local runs, add **server-only** `BLOB_PRIVATE_READ_WRITE_TOKEN` and `BLOB_PUBLIC_READ_WRITE_TOKEN` to ignored `BackEnd/.env`, using each store's read-write credential. They are supported fallback credentials outside Vercel. Alternatively use connected-store OIDC with Vercel CLI credentials and environment pull; the SDK refreshes managed OIDC. This application loads `.env` through dotenv, so pull into `.env` (`vercel env pull .env`) or export the pulled variables in your process. Set both custom store IDs when using OIDC.

From `BackEnd`, with `MONGODB_URI` pointing at the intended existing database and both store credentials configured:

```sh
npm run migrate:storage
npm run migrate:storage -- --apply
# If legacy files live under a different explicitly selected root:
npm run migrate:storage -- --legacy-root C:/path/to/old/backend
npm run migrate:storage -- --apply --legacy-root C:/path/to/old/backend
```

Dry-run is the default. Migration recognizes local Windows/file paths, uploads/public/storage/summary paths, localhost URLs and supported inline PDF/image data. Local reads are restricted to the selected root including symlink resolution. It never fetches arbitrary remote URLs. It validates bytes, uploads to the matching store, transactionally replaces the existing field with the new reference and preserves entity IDs. Missing, invalid or unsafe references are logged as requiring manual re-upload or retry; they are never silently deleted. Old local files are preserved even after successful migration. Rerunning skips already migrated references.

Read-only audit of the configured `test` database found these two recoverable lecture summaries:

| Lecture ID | Size | Result |
| --- | ---: | --- |
| `6ac8e6accc60f2e4823de5e0` | 4,704,200 bytes | Local PDF exists, ready to migrate |
| `6ac8e82b7feefe10f52f5c1b` | 9,698,642 bytes | Local PDF exists, ready to migrate |

Three additional files under `storage/material` / `storage/summary-pdfs` were unreferenced and preserved. No referenced missing file was found in that audit. Real Blob migration was not run because this workspace has no Blob store credentials; no production account settings or deployments were modified.

## Validation scope and limitations

Final verification on 2026-10-09:

- Backend: 61 tests passed across 7 files; build, typecheck and lint passed.
- Frontend: 19 Chromium browser tests passed; TypeScript/Vite production build and lint passed.
- Vercel CLI 62.7.0: isolated production build passed with Node 22 and the Express entrypoint. Importing the packaged handler and requesting `/health` and `/api/v1/health` returned HTTP 200.
- Dependency installation completed without reported vulnerabilities.
- Real Blob credentials were unavailable. No live Blob upload, applied migration, remote deployment or account configuration is claimed.

### Changed implementation files

Backend storage lives in `src/storage/storage.service.ts` and `src/storage/vercel-blob.provider.ts`. API routes, domain models/validation, content, finance and package services bind and authorize these references. The old `src/shared/summary-files.ts` disk implementation was removed. Maintenance commands are `scripts/migrate-storage.ts` and `scripts/cleanup-storage.ts`. Configuration changes are in `.env.example`, `.gitignore`, package manifests and `DEPLOYMENT.md`.

Frontend changes cover `src/services/storage.ts`, PDF/image upload widgets, form upload contexts, lecture/material/package forms, protected PDF/image rendering and Arabic/English upload errors. Vite and browser-test tooling use the same-origin API proxy. Backend storage/provider tests and frontend storage browser tests cover the new behavior; existing fixtures/assertions were updated for the current academic and accordion UI.

Backend integration tests use real, isolated MongoDB test databases and mock only the external Blob transport. Browser tests likewise exercise real business API/database logic with a test-only Blob transport; they do not prove availability or credentials of your real stores. Provider unit tests check OIDC selection, key/type/size limits and one-minute download signing. A real upload/download smoke test is required after connecting the stores and deploying.

The remaining intentional filesystem operations are read-only in the one-time migration and test/document tooling. Runtime storage has no `writeFile`, `mkdir`, `createWriteStream`, disk-serving middleware, persistent `/tmp`, or fake upload folders. Scheduled lecture publication and global auth rate limiting remain the separate deployment considerations documented in `DEPLOYMENT.md`.

Official SDK references: [Blob SDK and OIDC](https://vercel.com/docs/vercel-blob/using-blob-sdk), [direct client uploads](https://vercel.com/docs/vercel-blob/client-upload).
