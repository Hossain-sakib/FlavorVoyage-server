const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  packWorkspace,
  unpackWorkspace,
  saveSnapshot,
  snapshotStatus,
} = require("../workspace-backups");
const { reportFor, csv } = require("../admin-workflows");
const { createApp } = require("../app");
class Store {
  map = new Map();
  async getMetadata(key) {
    return this.map.has(key) ? {} : null;
  }
  async setJSON(key, value, { onlyIfNew } = {}) {
    if (onlyIfNew && this.map.has(key)) return { modified: false };
    this.map.set(key, structuredClone(value));
    return { modified: true };
  }
  async list({ prefix }) {
    return {
      blobs: [...this.map.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
    };
  }
  async delete(key) {
    this.map.delete(key);
  }
}
const state = () => ({
  products: [
    {
      id: "product",
      price: 100,
      stock: 20,
      moq: 1,
      active: true,
      image: "https://res.cloudinary.com/example.png",
    },
  ],
  suppliers: [{ id: "dealer", name: "Dealer" }],
  users: [{ id: "buyer", name: "Buyer" }],
  orders: [],
  sessions: [["hashed-session", { userId: "buyer" }]],
  attempts: [["ip", {}]],
});
test("backup integrity, authentication invalidation, idempotency and retention are enforced", async () => {
  const db = state();
  const packed = packWorkspace(db);
  const restored = unpackWorkspace(packed);
  assert.equal(restored.sessions, undefined);
  assert.equal(restored.attempts, undefined);
  assert.deepEqual(restored.products, db.products);
  packed.data.products[0].stock = 999;
  assert.throws(() => unpackWorkspace(packed), /integrity/);
  const store = new Store();
  await saveSnapshot(store, db, {
    daily: true,
    now: new Date("2026-09-01T06:00:00Z"),
  });
  const one = await saveSnapshot(store, db, {
    daily: true,
    now: new Date("2026-11-11T06:00:00Z"),
  });
  assert.equal(one.created, true);
  assert.equal(
    (
      await saveSnapshot(store, db, {
        daily: true,
        now: new Date("2026-11-11T08:00:00Z"),
      })
    ).created,
    false,
  );
  assert.equal(store.map.has("daily/2026-09-01"), false);
  await saveSnapshot(store, db, { now: new Date("2026-11-11T08:00:00Z") });
  assert.equal((await snapshotStatus(store)).count, 2);
  assert.throws(
    () => packWorkspace({ ...db, products: [...db.products, ...db.products] }),
    /products/,
  );
});
test("reports respect Bangladesh date boundaries and demo/cancellation filtering; CSV is formula-safe", () => {
  const db = state();
  db.users.push({ id: "sample", demo: true });
  const order = (id, date, total, status = "delivered", buyer = "buyer") => ({
    id,
    createdAt: date,
    total,
    status,
    retailerId: buyer,
    supplierId: "dealer",
    supplierName: "Dealer",
    items: [
      {
        productId: "product",
        name: "Drink",
        price: 100,
        quantity: total / 100,
      },
    ],
  });
  db.orders = [
    order("before", "2026-11-10T17:59:59Z", 100),
    order("inside", "2026-11-10T18:00:00Z", 200),
    order("cancelled", "2026-11-11T05:00:00Z", 300, "cancelled"),
    order("demo", "2026-11-11T05:00:00Z", 400, "pending", "sample"),
    order("after", "2026-11-11T18:00:00Z", 500),
  ];
  const report = reportFor(db, { from: "2026-11-11", to: "2026-11-11" });
  assert.equal(report.summary.orders, 2);
  assert.equal(report.summary.orderValue, 200);
  assert.equal(report.summary.cases, 2);
  assert.equal(report.summary.cancelled, 1);
  assert.equal(
    reportFor(db, { from: "2026-11-11", to: "2026-11-11", includeDemo: "true" })
      .summary.orderValue,
    600,
  );
  assert.throws(
    () => reportFor(db, { from: "2026-02-30", to: "2026-11-11" }),
    /valid/,
  );
  assert.throws(
    () => reportFor(db, { from: "2020-01-01", to: "2026-11-11" }),
    /366/,
  );
  assert.ok(
    csv([["=SUM(A1)", "  +cmd", "normal", 'a"b']]).includes('"\'=SUM(A1)"'),
  );
  assert.ok(csv([['a"b']]).includes('"a""b"'));
});
test("reports, exports, tasks and backup controls require a verified Google administrator and audit mutations", async (t) => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "owner@example.com";
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  });
  const db = state();
  db.users.push({
    id: "admin",
    name: "Owner",
    email: "owner@example.com",
    firebaseUid: "firebase-owner",
    business: "Admin",
    role: "retailer",
  });
  db.sessions = [["token", {}]];
  const { createHash } = require("node:crypto");
  db.sessions = [
    [
      createHash("sha256").update("secret-session").digest("hex"),
      { userId: "admin", authProvider: "google", expires: Date.now() + 60000 },
    ],
  ];
  const app = createApp({
    initialState: db,
    operations: {
      status: async () => ({ enabled: true, count: 1 }),
      create: async () => ({ key: "manual/example", created: true }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  async function request(path, body, authenticated = true, method) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin${path}`,
      {
        method: method || (body ? "POST" : "GET"),
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { Cookie: "fv_session=secret-session" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: response.status, text: await response.text() };
  }
  for (const route of [
    "/reports",
    "/exports/contacts",
    "/tasks",
    "/operations",
  ])
    assert.equal((await request(route, null, false)).status, 401);
  assert.equal((await request("/reports")).status, 200);
  assert.equal((await request("/operations")).status, 200);
  const exported = await request("/exports/contacts");
  assert.equal(exported.status, 200);
  assert.ok(!exported.text.includes("firebase-owner"));
  assert.ok(!exported.text.includes("sessions"));
  const task = JSON.parse(
    (
      await request("/tasks", {
        title: "Call customer",
        dueDate: "2026-11-20",
        userId: "buyer",
      })
    ).text,
  );
  assert.equal(task.status, "open");
  assert.equal(
    (await request("/tasks/" + task.id, { status: "done" }, true, "PATCH"))
      .status,
    200,
  );
  assert.equal(
    (await request("/tasks", { title: "Invalid", dueDate: "2026-02-30" }))
      .status,
    400,
  );
  assert.equal((await request("/backups", {})).status, 201);
  assert.ok(
    app
      .exportState()
      .auditLog.some((a) => a.action === "workspace.backup.created"),
  );
});
