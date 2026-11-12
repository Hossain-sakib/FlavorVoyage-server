// Update only exact image-path matches after an authorized image-storage import.
const fs = require("node:fs");
const { getStore } = require("@netlify/blobs");
(async () => {
  const map = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
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
    if (!stored) throw Error("Workspace not found.");
    const db = structuredClone(stored.data);
    let count = 0;
    for (const [rows, field] of [
      [db.products, "image"],
      [db.suppliers, "coverImage"],
    ])
      for (const row of rows)
        if (map[row[field]]) {
          row[field] = map[row[field]];
          count++;
        }
    const result = await store.setJSON("workspace-v1", db, {
      onlyIfMatch: stored.etag,
    });
    if (result.modified) {
      console.log(
        JSON.stringify({
          updatedImageFields: count,
          totalProducts: db.products.length,
        }),
      );
      return;
    }
  }
  throw Error("Concurrent workspace changes prevented the image update.");
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
