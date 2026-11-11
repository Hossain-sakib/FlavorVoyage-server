const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../app");
async function start(t, options) {
  const server = createApp({
    initialState:
      options?.dataFile && fs.existsSync(options.dataFile)
        ? undefined
        : require("../tools/demo/state.cjs")(),
    ...options,
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (
    route,
    { body, method = body ? "POST" : "GET", cookie, key, headers = {} } = {},
  ) => {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const result = await response.json().catch(() => null);
    return {
      status: response.status,
      data: result,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      headers: response.headers,
    };
  };
}
async function register(call, role, email = `${role}@test.example`) {
  const response = await call("/auth/register", {
    body: {
      name: role,
      business: `${role} business`,
      email,
      password: "Strong-password-123",
      role,
      location: "Dhaka",
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.user.passwordHash, undefined);
  return response;
}
test("wholesale lifecycle: isolation, MOQ, quote negotiation, stock and order transitions", async (t) => {
  const call = await start(t);
  const retailer = await register(call, "retailer");
  const other = await register(call, "retailer", "other@test.example");
  const supplier = await register(call, "supplier");
  const rival = await register(call, "supplier", "rival@test.example");
  const productBody = {
    name: "Wholesale rice",
    brand: "Farm",
    category: "Soft drinks",
    price: 100,
    moq: 5,
    stock: 20,
    pack: "10 kg",
    description: "Good rice",
  };
  assert.equal(
    (await call("/products", { body: productBody, cookie: retailer.cookie }))
      .status,
    403,
  );
  const product = await call("/products", {
    body: productBody,
    cookie: supplier.cookie,
  });
  assert.equal(product.status, 201);
  const productId = product.data.id;
  assert.equal(
    (
      await call(`/products/${productId}`, {
        method: "PATCH",
        body: { price: 1 },
        cookie: rival.cookie,
      })
    ).status,
    404,
  );
  const checkout = {
    address: "Shop 12, Dhaka",
    phone: "+8801700000000",
    items: [{ productId, quantity: 5 }],
  };
  assert.equal(
    (await call("/orders", { body: checkout, key: "anon" })).status,
    401,
  );
  assert.equal(
    (
      await call("/orders", {
        body: { ...checkout, items: [{ productId, quantity: 4 }] },
        key: "low",
        cookie: retailer.cookie,
      })
    ).status,
    400,
  );
  const order = await call("/orders", {
    body: checkout,
    key: "direct-1",
    cookie: retailer.cookie,
  });
  assert.equal(order.status, 201);
  assert.equal(order.data.orders[0].total, 500);
  assert.equal(
    (
      await call("/orders", {
        body: checkout,
        key: "direct-1",
        cookie: retailer.cookie,
      })
    ).data.orders[0].id,
    order.data.orders[0].id,
  );
  assert.equal(
    (await call("/orders", { cookie: other.cookie })).data.length,
    0,
  );
  assert.equal(
    (await call("/orders", { cookie: rival.cookie })).data.length,
    0,
  );
  const id = order.data.orders[0].id;
  assert.equal(
    (
      await call(`/orders/${id}`, {
        method: "PATCH",
        body: { status: "confirmed" },
        cookie: retailer.cookie,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/orders/${id}`, {
        method: "PATCH",
        body: { status: "cancelled" },
        cookie: other.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(`/orders/${id}`, {
        method: "PATCH",
        body: { status: "confirmed" },
        cookie: supplier.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/orders/${id}`, {
        method: "PATCH",
        body: { status: "cancelled" },
        cookie: supplier.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("/inventory", { cookie: supplier.cookie })).data[0].stock,
    20,
  );
  assert.equal(
    (
      await call(`/orders/${id}`, {
        method: "PATCH",
        body: { status: "cancelled" },
        cookie: supplier.cookie,
      })
    ).status,
    409,
  );
  const quote = await call("/quotes", {
    body: { items: checkout.items, note: "Can we negotiate?" },
    cookie: retailer.cookie,
  });
  assert.equal(quote.status, 201);
  const qid = quote.data.quotes[0].id;
  assert.equal(
    (await call("/quotes", { cookie: other.cookie })).data.length,
    0,
  );
  assert.equal(
    (
      await call(`/quotes/${qid}`, {
        method: "PATCH",
        body: { status: "offered", prices: [80] },
        cookie: rival.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(`/quotes/${qid}`, {
        method: "PATCH",
        body: { status: "offered", prices: [80] },
        cookie: supplier.cookie,
      })
    ).status,
    200,
  );
  const accepted = await call(`/quotes/${qid}`, {
    method: "PATCH",
    body: {
      status: "accepted",
      address: checkout.address,
      phone: checkout.phone,
    },
    cookie: retailer.cookie,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.order.total, 400);
  assert.equal(
    (await call("/inventory", { cookie: supplier.cookie })).data[0].stock,
    15,
  );
  assert.equal(
    (
      await call(`/quotes/${qid}`, {
        method: "PATCH",
        body: {
          status: "accepted",
          address: checkout.address,
          phone: checkout.phone,
        },
        cookie: retailer.cookie,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/orders", {
        body: { ...checkout, items: [{ productId, quantity: 16 }] },
        key: "oversell",
        cookie: retailer.cookie,
      })
    ).status,
    400,
  );
});
test("account sessions, passwords, origin checks, demo isolation, and persistence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fv-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, "store.json");
  const call = await start(t, { dataFile, demo: true });
  const account = await register(call, "retailer");
  assert.equal(
    (await call("/session", { cookie: account.cookie })).data.user.email,
    "retailer@test.example",
  );
  assert.equal(
    (
      await call("/auth/login", {
        body: { email: "retailer@test.example", password: "wrong" },
      })
    ).status,
    401,
  );
  const login = await call("/auth/login", {
    body: { email: "retailer@test.example", password: "Strong-password-123" },
  });
  assert.equal(login.status, 200);
  assert.equal(
    (
      await call("/auth/logout", {
        cookie: login.cookie,
        body: {},
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/auth/logout", { cookie: login.cookie, body: {} })).status,
    200,
  );
  assert.equal(
    (await call("/session", { cookie: login.cookie })).data.user,
    null,
  );
  const rootsBeforeDemo = (await call("/products")).data.filter(
    (p) => !p.catalogOnly,
  ).length;
  const demo1 = await call("/auth/demo", { body: { role: "supplier" } });
  const demo2 = await call("/auth/demo", { body: { role: "supplier" } });
  assert.notEqual(demo1.data.user.supplierId, demo2.data.user.supplierId);
  const afterDemo = (await call("/products")).data;
  assert.equal(afterDemo.filter((p) => !p.catalogOnly).length, rootsBeforeDemo);
  assert.ok(
    afterDemo
      .filter((p) => p.supplierId === demo1.data.user.supplierId)
      .every((p) => p.catalogOnly && p.demoListing && p.familyId),
  );
  assert.ok(fs.readFileSync(dataFile, "utf8").includes("passwordHash"));
  assert.ok(!fs.readFileSync(dataFile, "utf8").includes("Strong-password-123"));
  const restored = await start(t, { dataFile });
  assert.equal(
    (
      await restored("/auth/login", {
        body: {
          email: "retailer@test.example",
          password: "Strong-password-123",
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await restored("/auth/demo", { body: { role: "retailer" } })).status,
    404,
  );
});
test("multi-supplier orders are split, server-priced, atomic, and idempotent", async (t) => {
  const call = await start(t);
  const retailer = await register(call, "retailer");
  const products = (await call("/products")).data;
  const body = {
    address: "Dhaka",
    phone: "01700000000",
    items: [
      { productId: products[0].id, quantity: products[0].moq, price: 1 },
      { productId: products[2].id, quantity: products[2].moq, price: 1 },
    ],
  };
  const result = await call("/orders", {
    body,
    key: "multi",
    cookie: retailer.cookie,
  });
  assert.equal(result.data.orders.length, 2);
  assert.equal(
    result.data.orders.reduce((n, o) => n + o.total, 0),
    products[0].price * products[0].moq + products[2].price * products[2].moq,
  );
  assert.equal(
    (await call("/orders", { body, key: "multi", cookie: retailer.cookie }))
      .data.orders.length,
    2,
  );
  const bad = {
    ...body,
    items: [
      { productId: products[0].id, quantity: 5 },
      { productId: products[2].id, quantity: 999999 },
    ],
  };
  assert.equal(
    (await call("/orders", { body: bad, key: "bad", cookie: retailer.cookie }))
      .status,
    400,
  );
  const remaining = (await call("/products")).data.find(
    (p) => p.id === products[0].id,
  );
  assert.equal(remaining.stock, products[0].stock - products[0].moq);
});
test("orders can be fulfilled without payment; gateway routes are unavailable", async (t) => {
  const call = await start(t);
  const retailer = await register(call, "retailer");
  const supplier = await register(call, "supplier");
  const product = await call("/products", {
    cookie: supplier.cookie,
    body: {
      name: "Rice",
      brand: "Farm",
      category: "Soft drinks",
      price: 100,
      moq: 1,
      stock: 10,
      pack: "10 kg",
    },
  });
  const result = await call("/orders", {
    cookie: retailer.cookie,
    key: "no-payment",
    body: {
      address: "Dhaka",
      phone: "01700000000",
      items: [{ productId: product.data.id, quantity: 2 }],
    },
  });
  assert.equal(result.status, 201);
  const order = result.data.orders[0];
  assert.equal(order.payment, undefined);
  assert.equal(order.paymentStatus, undefined);
  for (const status of ["confirmed", "shipped", "delivered"]) {
    const changed = await call(`/orders/${order.id}`, {
      method: "PATCH",
      cookie: supplier.cookie,
      body: { status },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.status, status);
  }
  assert.equal(
    (
      await call(`/orders/${order.id}/pay`, {
        cookie: retailer.cookie,
        body: {},
      })
    ).status,
    404,
  );
  assert.equal(
    (await call("/payments/ipn", { body: { val_id: "fake" } })).status,
    404,
  );
});
