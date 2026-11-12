# Production readiness and remaining limits

Implemented controls include server-side role/ownership checks, Google token
verification, Google-only admin authorization, hashed passwords and session tokens,
HttpOnly/SameSite cookies, origin checks, input bounds, file limits and type checks,
server-only Cloudinary secrets, conditional datastore writes, server-priced orders,
audit records, dependency checks, CI and browser workflow coverage.
Private daily/manual snapshots, checksum validation, restore drills, guarded operator
restore, hourly availability checks, admin health views, reports/CSV exports and
contact-linked CRM follow-ups are also implemented.

These checks are not a guarantee of zero vulnerabilities or a security certification.
Before real commercial operations:

1. Disable shared demo accounts and remove or archive sample stores, prices and feedback.
2. MongoDB support retains a revisioned single-document workspace. Split domains
   into collections and load-test the transactional model for expected volume.
   Add independent off-provider backups and a documented disaster-recovery
   ownership/retention policy; same-provider snapshots and a restore drill exist.
3. Add independent penetration testing, alerting, operational monitoring, abuse/rate
   controls at the edge, incident response and account-recovery procedures. Hourly
   GitHub availability checks and admin diagnostics are a baseline, not a full SLA.
4. Review legal/privacy requirements, vendor authorization, actual delivery terms,
   label accuracy, taxes, invoices, refunds and financial reconciliation.
5. Introduce accounting, warehouse movements, procurement, financial ledgers and
   reporting only with appropriate data models and domain review. The admin UI is
   an operations/CRM/CMS foundation, not a complete accounting ERP.
6. Validate Google consent with the owner's actual account and maintain administrator
   access recovery. A Google session is required after the admin allowlist is configured.
7. Verify SEO with Search Console and real traffic. Static HTML, metadata, canonical
   links, product schema, sitemap and crawler rules do not guarantee indexing or rank.
8. Rotate credentials shared outside the hosting secret store and follow least privilege.

Demo review stars are visible as sample content but excluded from real rating
averages. Structured data does not advertise dummy prices as real offers.
