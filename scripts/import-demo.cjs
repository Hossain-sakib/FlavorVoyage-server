/** Explicit, idempotent content import. Never called by the production API. */
const { getStore } = require("@netlify/blobs");
const seed = require("../tools/demo/seed.cjs");
(async () => {
  if (!process.env.NETLIFY_AUTH_TOKEN)
    throw new Error(
      "Configure NETLIFY_AUTH_TOKEN before running the importer.",
    );
  const store = getStore({
    name: "flavor-voyage-workspace",
    siteID: "ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf",
    token: process.env.NETLIFY_AUTH_TOKEN,
    consistency: "strong",
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const stored = await store.getWithMetadata("workspace-v1", {
      type: "json",
      consistency: "strong",
    });
    if (!stored)
      throw new Error(
        "Existing workspace not found; refusing to replace it with demo data.",
      );
    const before = stored.data,
      db = structuredClone(before);
    seed.migrateCatalogue(db);
    if (process.env.BACKUP_FILE) {
      require("node:fs").writeFileSync(
        process.env.BACKUP_FILE,
        JSON.stringify(before),
        { mode: 0o600 },
      );
    }
    for (const previous of before.products) {
      const current = db.products.find((p) => p.id === previous.id);
      if (
        !current ||
        ["price", "stock", "moq", "supplierId"].some(
          (key) => current[key] !== previous[key],
        )
      )
        throw new Error("Import changed protected existing inventory fields.");
    }

    for (const key of [
      "users",
      "orders",
      "quotes",
      "conversations",
      "addresses",
      "sessions",
    ]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(db[key]))
        throw new Error(`Import unexpectedly changed ${key}.`);
    }
    const committed = await store.setJSON("workspace-v1", db, {
      onlyIfMatch: stored.etag,
    });
    if (committed.modified) {
      console.log(
        JSON.stringify({
          imported: true,
          before: before.products.length,
          after: db.products.length,
          suppliers: db.suppliers.length,
          sampleReviews: db.reviews.filter((r) => r.demo).length,
        }),
      );
      return;
    }
  }
  throw new Error("Concurrent changes prevented import. Try again later.");
})().catch((e) => {
  console.error(e.name, e.message);
  process.exitCode = 1;
});
