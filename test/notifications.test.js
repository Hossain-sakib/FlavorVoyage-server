const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
test("notification feed isolates accounts and persists read state across API instances", async (t) => {
  let app = createApp();
  let server;
  async function start() {
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
  }
  await start();
  t.after(() => new Promise((r) => server.close(r)));
  async function call(route, cookie, body) {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api${route}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return {
      status: res.status,
      data: await res.json(),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  }
  assert.equal((await call("/notifications")).status, 401);
  const a = await call("/auth/register", null, {
    name: "Buyer A",
    business: "Shop A",
    email: "a@example.com",
    password: "Strong-password-123",
    role: "retailer",
  });
  const b = await call("/auth/register", null, {
    name: "Buyer B",
    business: "Shop B",
    email: "b@example.com",
    password: "Strong-password-123",
    role: "retailer",
  });
  const state = app.exportState();
  state.orders.push({
    id: "a-order",
    retailerId: a.data.user.id,
    supplierId: "dealer",
    reference: "ORD-A",
    items: [],
    status: "confirmed",
    createdAt: new Date().toISOString(),
    history: [
      { status: "pending", at: new Date().toISOString() },
      { status: "confirmed", at: new Date().toISOString() },
    ],
  });
  state.conversations.push({
    id: "private-thread",
    buyerId: a.data.user.id,
    supplierId: "dealer",
    messages: [
      {
        id: "m1",
        senderId: "dealer-user",
        senderName: "Dealer",
        createdAt: new Date().toISOString(),
        text: "Private message",
      },
    ],
  });
  await new Promise((r) => server.close(r));
  app = createApp({ initialState: state });
  await start();
  const feed = (await call("/notifications", a.cookie)).data;
  assert.equal(feed.length, 3);
  assert.ok(feed.every((n) => !n.read));
  assert.ok(!JSON.stringify(feed).includes("Private message"));
  assert.deepEqual((await call("/notifications", b.cookie)).data, []);
  assert.equal(
    (await call("/notifications/read", b.cookie, { ids: [feed[0].id] })).status,
    404,
  );
  assert.equal(
    (
      await call("/notifications/read", a.cookie, {
        ids: feed.map((n) => n.id),
      })
    ).status,
    200,
  );
  const saved = app.exportState();
  await new Promise((r) => server.close(r));
  app = createApp({ initialState: saved });
  await start();
  assert.ok((await call("/notifications", a.cookie)).data.every((n) => n.read));
  assert.equal(
    (await call("/notifications/read", a.cookie, { ids: "all" })).status,
    400,
  );
});

test("a revised quote offer creates a new unread event", () => {
  const { activityFor } = require("../notifications-api");
  const user = { id: "buyer", role: "retailer" };
  const quote = {
    id: "quote",
    retailerId: user.id,
    status: "offered",
    createdAt: "2026-11-11T06:00:00Z",
    updatedAt: "2026-11-11T07:00:00Z",
  };
  const db = { orders: [], quotes: [quote], conversations: [] };
  const [first] = activityFor(db, user);
  db.notificationReads = { buyer: [first.id] };
  assert.equal(activityFor(db, user)[0].read, true);
  quote.updatedAt = "2026-11-11T08:00:00Z";
  assert.equal(activityFor(db, user)[0].read, false);
});
