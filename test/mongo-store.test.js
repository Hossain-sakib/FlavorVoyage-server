const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mongoStoreFromCollection } = require("../mongo-store");
const { databaseOperator } = require("../database-operator");
const { createCloudHandler } = require("../netlify-handler");
const { createHash } = require("node:crypto");
class Collection {
  docs = new Map();
  async deleteOne({ _id }) {
    this.docs.delete(_id);
  }
  async findOne({ _id }) {
    return structuredClone(this.docs.get(_id) || null);
  }
  async insertOne(doc) {
    if (this.docs.has(doc._id)) {
      const e = Error("Duplicate");
      e.code = 11000;
      throw e;
    }
    this.docs.set(doc._id, structuredClone(doc));
  }
  async replaceOne(filter, doc) {
    if (this.docs.get(filter._id)?.revision !== filter.revision)
      return { modifiedCount: 0 };
    this.docs.set(doc._id, structuredClone(doc));
    return { modifiedCount: 1 };
  }
}
class Store {
  docs = new Map();
  version = 0;
  async get(key) {
    return structuredClone(this.docs.get(key)?.data || null);
  }
  async getWithMetadata(key) {
    return structuredClone(this.docs.get(key) || null);
  }
  async getMetadata(key) {
    return this.docs.has(key) ? {} : null;
  }
  async setJSON(key, data, options = {}) {
    const old = this.docs.get(key);
    if (
      (options.onlyIfNew && old) ||
      (options.onlyIfMatch && old?.etag !== options.onlyIfMatch)
    )
      return { modified: false };
    this.docs.set(key, {
      data: structuredClone(data),
      etag: String(++this.version),
    });
    return { modified: true };
  }
  async list({ prefix }) {
    return {
      blobs: [...this.docs.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key })),
    };
  }
  async delete(key) {
    this.docs.delete(key);
  }
}
const db = () => ({
  users: [],
  products: [{ id: "p1", price: 100, stock: 10 }],
  suppliers: [],
  orders: [],
  sessions: [],
  attempts: [],
  quotes: [],
  conversations: [],
  reviews: [],
  addresses: [],
});
test("Mongo workspace creation and compare-and-set writes reject duplicate/stale revisions", async () => {
  const collection = new Collection(),
    store = mongoStoreFromCollection(collection);
  assert.equal(await store.getWithMetadata("workspace-v1"), null);
  assert.equal(
    (await store.setJSON("workspace-v1", db(), { onlyIfNew: true })).modified,
    true,
  );
  assert.equal(
    (await store.setJSON("workspace-v1", db(), { onlyIfNew: true })).modified,
    false,
  );
  const first = await store.getWithMetadata("workspace-v1");
  first.data.products[0].stock = 9;
  const updates = await Promise.all([
    store.setJSON("workspace-v1", first.data, { onlyIfMatch: first.etag }),
    store.setJSON("workspace-v1", db(), { onlyIfMatch: first.etag }),
  ]);
  assert.equal(updates.filter((x) => x.modified).length, 1);
  assert.equal(
    (await store.getWithMetadata("workspace-v1")).data.products[0].stock,
    9,
  );
});
test("operator capability is origin-bound, expiring and single-use; copying requires a write pause", async () => {
  const control = new Store(),
    source = new Store(),
    backups = new Store(),
    target = mongoStoreFromCollection(new Collection());
  await source.setJSON("workspace-v1", db());
  const token = "random-operator-token";
  const issue = (action) =>
    control.setJSON("database-operation", {
      action,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 60000,
      used: false,
    });
  const event = {
    httpMethod: "POST",
    headers: {
      origin: "https://flavor-voyage.netlify.app",
      authorization: "Bearer " + token,
    },
  };
  const execute = (request = event) =>
    databaseOperator(request, {
      control,
      source,
      backups,
      origin: "https://flavor-voyage.netlify.app",
      mongo: async () => target,
    });
  await issue("probe");
  assert.equal(
    (
      await execute({
        ...event,
        headers: { ...event.headers, authorization: "Bearer bad" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await execute({
        ...event,
        headers: { ...event.headers, origin: "https://bad.example" },
      })
    ).statusCode,
    404,
  );
  assert.equal((await execute()).statusCode, 200);
  assert.equal((await execute()).statusCode, 404);
  await issue("copy");
  assert.equal((await execute()).statusCode, 409);
  assert.equal(await target.getWithMetadata("workspace-v1"), null);
  await control.setJSON("write-pause", { paused: true });
  await issue("copy");
  const copied = await execute();
  assert.equal(copied.statusCode, 200);
  assert.equal(JSON.parse(copied.body).verified, true);
  assert.deepEqual((await target.getWithMetadata("workspace-v1")).data, db());
  assert.equal(backups.docs.size, 1);
  await issue("copy");
  const changed = db();
  changed.products[0].stock = 4;
  await source.setJSON("workspace-v1", changed);
  assert.equal((await execute()).statusCode, 409);
  assert.equal(
    (await target.getWithMetadata("workspace-v1")).data.products[0].stock,
    10,
  );
});
test("cutover maintenance blocks writes while preserving browsing and workspace state", async () => {
  const store = new Store(),
    control = new Store();
  await store.setJSON("workspace-v1", db());
  await control.setJSON("write-pause", { paused: true });
  const before = structuredClone(store.docs);
  const handler = createCloudHandler({
    store,
    migrationControlStore: control,
    storageLabel: "mongodb",
    origin: "https://flavor-voyage.netlify.app",
    requireExistingStore: true,
  });
  const read = await handler({
    path: "/api/health",
    httpMethod: "GET",
    headers: {},
  });
  assert.equal(read.statusCode, 200);
  assert.equal(JSON.parse(read.body).writePaused, true);
  assert.equal(JSON.parse(read.body).storage, "mongodb");
  const write = await handler({
    path: "/api/auth/register",
    httpMethod: "POST",
    headers: {},
    body: "{}",
  });
  assert.equal(write.statusCode, 503);
  assert.equal(write.headers["Retry-After"], "60");
  assert.deepEqual(store.docs, before);
});

test("Mongo recovery drills do not replace live data; restore requires pause and exact revision", async () => {
  const collection = new Collection(),
    target = mongoStoreFromCollection(collection),
    control = new Store(),
    source = new Store(),
    backups = new Store();
  await target.setJSON("workspace-v1", db(), { onlyIfNew: true });
  const token = "operator-recovery-token";
  const invoke = async (action, extra = {}) => {
    await control.setJSON("database-operation", {
      action,
      ...extra,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 60000,
      used: false,
    });
    return databaseOperator(
      {
        httpMethod: "POST",
        headers: {
          origin: "https://flavor-voyage.netlify.app",
          authorization: "Bearer " + token,
        },
      },
      {
        control,
        source,
        backups,
        origin: "https://flavor-voyage.netlify.app",
        activeDriver: "mongodb",
        mongo: async () => target,
      },
    );
  };
  const created = await invoke("backup");
  assert.equal(created.statusCode, 201);
  const key = JSON.parse(created.body).key;
  const before = await target.getWithMetadata("workspace-v1");
  before.data.products[0].stock = 4;
  await target.setJSON("workspace-v1", before.data, {
    onlyIfMatch: before.etag,
  });
  assert.equal(
    (await invoke("restore", { backupKey: key, expectedEtag: "2" })).statusCode,
    409,
  );
  assert.equal((await invoke("drill", { backupKey: key })).statusCode, 200);
  assert.equal(collection.docs.size, 1);
  assert.equal(
    (await target.getWithMetadata("workspace-v1")).data.products[0].stock,
    4,
  );
  await control.setJSON("write-pause", { paused: true });
  assert.equal(
    (await invoke("restore", { backupKey: key, expectedEtag: "1" })).statusCode,
    409,
  );
  assert.equal(
    (await invoke("restore", { backupKey: key, expectedEtag: "2" })).statusCode,
    200,
  );
  const restored = await target.getWithMetadata("workspace-v1");
  assert.equal(restored.data.products[0].stock, 10);
  assert.equal(restored.data.sessions, undefined);
  assert.ok(
    restored.data.auditLog.some((row) => row.action === "workspace.restored"),
  );
  await assert.rejects(target.deleteTemporary("workspace-v1"));
});
