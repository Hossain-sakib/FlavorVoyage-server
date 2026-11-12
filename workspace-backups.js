const { createHash, randomUUID } = require("node:crypto");
const DAY = 86400000;
const checksum = (data) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
function validateWorkspace(data) {
  if (!data || typeof data !== "object") throw Error("Invalid workspace.");
  for (const key of ["products", "suppliers", "users", "orders"])
    if (
      !Array.isArray(data[key]) ||
      data[key].some((item) => !item || typeof item.id !== "string") ||
      new Set(data[key].map((item) => item.id)).size !== data[key].length
    )
      throw Error(`Invalid ${key} collection.`);
  if (
    data.products.some(
      (p) =>
        !Number.isSafeInteger(p.stock) ||
        p.stock < 0 ||
        !Number.isSafeInteger(p.price) ||
        p.price <= 0,
    )
  )
    throw Error("Invalid inventory values.");
  return data;
}
function packWorkspace(state, now = new Date()) {
  const data = structuredClone(validateWorkspace(state));
  // Restores must require fresh login; never preserve active authentication tokens.
  delete data.sessions;
  delete data.attempts;
  return {
    version: 1,
    createdAt: now.toISOString(),
    checksum: checksum(data),
    data,
  };
}
function unpackWorkspace(snapshot) {
  if (snapshot?.version !== 1 || checksum(snapshot.data) !== snapshot.checksum)
    throw Error("Backup integrity check failed.");
  const data = structuredClone(validateWorkspace(snapshot.data));
  delete data.sessions;
  delete data.attempts;
  return data;
}
async function saveSnapshot(
  store,
  state,
  { daily = false, now = new Date() } = {},
) {
  const key = daily
    ? `daily/${now.toISOString().slice(0, 10)}`
    : `manual/${now.toISOString()}-${randomUUID()}`;
  if (daily && (await store.getMetadata(key))) return { key, created: false };
  const snapshot = packWorkspace(state, now);
  const result = await store.setJSON(key, snapshot, { onlyIfNew: true });
  if (daily && result.modified) {
    // Daily snapshots have a bounded 30-day retention; manual snapshots are retained.
    const listing = await store.list({ prefix: "daily/" });
    for (const blob of listing.blobs) {
      const date = blob.key.slice(6);
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Date.parse(date) < now.getTime() - 30 * DAY
      )
        await store.delete(blob.key);
    }
  }
  return {
    key,
    createdAt: snapshot.createdAt,
    checksum: snapshot.checksum,
    created: result.modified,
  };
}
async function snapshotStatus(store) {
  const rows = [];
  for (const prefix of ["daily/", "manual/"]) {
    const result = await store.list({ prefix });
    rows.push(
      ...result.blobs.map((b) => ({
        key: b.key,
        date: b.key.slice(prefix.length, prefix.length + 10),
      })),
    );
  }
  return {
    enabled: true,
    count: rows.length,
    latest: rows.sort((a, b) => b.date.localeCompare(a.date))[0] || null,
    dailyRetentionDays: 30,
    sessionsIncluded: false,
  };
}
module.exports = {
  validateWorkspace,
  packWorkspace,
  unpackWorkspace,
  saveSnapshot,
  snapshotStatus,
};
