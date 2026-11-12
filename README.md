# FlavorVoyage API

Express API for beverage products and pack variants, dealer discovery, case orders,
negotiated quotes, private messaging, reviews, saved addresses and administration.
Node 24 is required. The sibling client is `FlavorVoyage---client`.

## Modules

- `app.js`: application wiring and marketplace endpoints; no product seed imports.
- `catalog-schema.js`: category vocabulary only, no products or prices.
- `google-auth.js`: Firebase Google JWT signature, issuer, audience, expiry and provider verification.
- `admin-api.js`: Google-only administrator authorization, catalog/dealer/order controls,
  account suspension, CRM notes, plain-text CMS fields and audit records.
- `media-api.js`: authenticated image validation and server-signed Cloudinary uploads.
- `netlify-handler.js`: isolated request state and optimistic conditional commits.
- `functions/api.js`: Netlify adapter and datastore context.
- `tools/demo`: explicit import/test fixtures, never loaded by the deployed API.
- `scripts/import-demo.cjs`: idempotent operator import that preserves accounts,
  orders, conversations, addresses and sessions. Requires hosting credentials.

## Data and concurrency

The hosted API supports MongoDB and Netlify Blobs via a versioned workspace adapter.
`DATABASE_DRIVER` selects the active provider; `/api/health` reports it. Products are not served from a hardcoded frontend array or runtime
JSON fixture. Production fails closed if the workspace is missing. Every successful
mutation commits using the version read before validation, retrying a concurrent
conflict. Checkout validates current case prices, minimum quantities and stock;
client-submitted prices are ignored. Orders from separate dealers are split.

MongoDB uses an atomic, majority-acknowledged `workspace_state` document with
a numeric revision. Conditional replacement preserves checkout concurrency. This
retains a single-document model and MongoDB's 16 MB document limit; collection-level
modeling and load testing are required before substantial commercial scale. See `PRODUCTION_READINESS.md`.

## Accounts and authorization

Customers/retailers and dealers have separate operations. Messages and addresses
are participant-owned. Google tokens are verified against public Firebase signing
keys and exchanged for an HttpOnly, SameSite session. Existing password accounts
must explicitly link Google after signing in; they are not merged by email alone.

`ADMIN_EMAILS` is a server-side email allowlist. An administrator must also have a
verified Google identity and a Google-authenticated session. Password sessions and
frontend claims cannot grant administrator permissions. Suspended accounts stop
receiving authenticated access. Administrative writes are audited.

`ENABLE_DEMO=true` enables intentionally shared Cosmobit demo dealer inboxes.
Never put real customer information into a shared demo inbox. Disable demo access
before accepting real business data.

## Image storage

Cloudinary credentials are kept in hosting settings. Configure `CLOUDINARY_URL`
or the three separate Cloudinary variables listed in `.env.example`. The API
accepts one JPEG, PNG or WebP image up to 3 MB from a dealer/admin, checks file
signatures and sends a signed upload directly to Cloudinary. API secrets never go
to the browser. SVG/executable uploads and arbitrary client upload parameters are rejected.

MongoDB GridFS is not used. The current catalog originally used static images;
public uploaded image URLs can be stored on product records without changing the UI.

## Commands

- `npm ci`: install pinned dependencies.
- `npm test`: identity, authorization, storage, concurrency, stock, quote and message tests.
- `npm run build:netlify`: compile the API function.
- `npm start`: run the optional local file adapter. An uninitialized database is empty.
- `node --use-env-proxy scripts/import-demo.cjs`: explicit authorized demo import
  when an execution environment requires its configured proxy.

Never commit `.env`, `.data`, `.netlify`, credentials or private workspace exports.
Do not run a demo importer automatically during application startup or deployment.

In-app notifications are derived from the signed-in account's order history,
quote activity and incoming messages. `GET /api/notifications` returns the latest
50 events; `POST /api/notifications/read` accepts owned notification IDs only.
Read state persists with the workspace and is limited to 500 IDs per account.
This is an in-app feed, not a push, SMS or email delivery service.

## Reports, follow-ups and operational recovery

Verified Google administrators can use Reports for date-filtered order activity,
dealer/product summaries and CSV exports of orders, inventory and contacts. Report
boundaries use Asia/Dhaka. Demo orders are excluded by default. Exported contact
fields are explicitly selected; credentials, password hashes and sessions are never
included. CSV cells neutralize spreadsheet formula prefixes.

Follow-ups adds private contact-linked tasks with due dates, overdue/open/completed
views and audited completion/reopening. Operations shows datastore checks and
backup status and can create manual private snapshots.

`flavor-voyage-backups` is a separate, private Netlify Blobs store. Before the first
workspace write of each UTC day, the adapter saves a checksummed snapshot; daily
snapshots are retained for 30 days. Manual snapshots are retained until an operator
removes them. Backup failure prevents the pending workspace write. Snapshots omit
active sessions and login-rate counters, but contain private account records and
must never be made public. This protects against application mistakes, not loss
of the hosting account; an off-provider backup policy remains a production task.

Operator commands, using the configured hosting credential:

- `node --use-env-proxy scripts/workspace-backup.cjs create`
- `node --use-env-proxy scripts/workspace-backup.cjs list`
- `node --use-env-proxy scripts/workspace-backup.cjs verify SNAPSHOT_KEY`
- `node --use-env-proxy scripts/workspace-backup.cjs drill SNAPSHOT_KEY`
- `node --use-env-proxy scripts/workspace-backup.cjs restore SNAPSHOT_KEY EXPECTED_ETAG`

A drill writes and reads an isolated temporary recovery record, verifies conditional
writes for MongoDB, and removes that temporary record. It never changes the live workspace. Restore is operator-only,
requires the exact current ETag shown by `list`, preserves a pre-restore snapshot,
and uses a conditional write to reject concurrent changes. MongoDB recovery requires
a paused workspace and runs via a one-use hosting-operator capability. Use `missing` as the
expected version only when the workspace is absent. Everyone must sign in again
after a restore. Restore is destructive: review the selected snapshot and affected
orders first; do not restore during active ordering.

The Live availability GitHub workflow runs hourly and can be started manually.
It checks public availability, datastore-backed listings, image-host references,
sitemap and private-endpoint protection. It logs only health/count metadata.
GitHub workflow status supplies a basic availability signal; independent external
alerting and incident response are still required before real commercial traffic.

## Controlled MongoDB cutover

`MONGODB_URI` stays in hosting secrets; the browser never receives it. Use the
`probe` action in `scripts/database-operation.cjs` against a draft to validate the
actual hosting network. The HTTP operator route accepts only a short-lived,
single-use capability issued through the private Netlify control store by an
authenticated hosting operator. A wrong origin, expired token, reused token or
unknown action is rejected. It returns only status/count metadata.

For the first cutover: publish the migration-aware adapter in Blobs mode; pause
writes; allow in-flight writes to drain; copy via the operator script; verify a
full-state checksum; then set `DATABASE_DRIVER=mongodb` and publish a verified
deploy. Resume writes only after the canonical site's health and product counts
match. Existing unrelated MongoDB data is never overwritten. Keep the previous
Blobs workspace as a rollback reference; after MongoDB accepts new writes, do not
simply switch back to that stale copy. A reverse migration must copy and verify
current data under another write pause.

Operator commands: `database-operation.cjs probe [DRAFT_URL]`, `pause`, `copy`,
`status`, and `resume` (run with `node --use-env-proxy` in a proxied environment).
`set-database-driver.cjs` updates the provider setting; a redeploy is required.
The backup CLI detects the active provider and uses the hosting network for MongoDB
backup, drill, status and guarded restore operations. Never run a live restore as
a test; use a drill.
