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

The deployed API reads its catalog and all application records from the Netlify
Blobs workspace. Products are not served from a hardcoded frontend array or runtime
JSON fixture. Production fails closed if the workspace is missing. Every successful
mutation commits using the version read before validation, retrying a concurrent
conflict. Checkout validates current case prices, minimum quantities and stock;
client-submitted prices are ignored. Orders from separate dealers are split.

The single workspace document is appropriate for this small deployment, not a
large ERP database. A transactional database, backup/restore policy and monitoring
are required before substantial commercial scale. See `PRODUCTION_READINESS.md`.

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
