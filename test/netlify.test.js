const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCloudHandler } = require("../netlify-handler");

class MemoryBlobStore {
  value = null;
  version = 0;
  async getWithMetadata() {
    return this.value
      ? { data: structuredClone(this.value), etag: String(this.version) }
      : null;
  }
  async setJSON(key, value, condition) {
    if (
      condition.onlyIfNew
        ? this.value !== null
        : condition.onlyIfMatch !== String(this.version)
    )
      return { modified: false };
    this.value = structuredClone(value);
    this.version++;
    return { modified: true, etag: String(this.version) };
  }
}
async function call(
  store,
  path,
  {
    method = "GET",
    body,
    cookie,
    key,
    origin = "https://flavor-voyage.netlify.app",
    verifyGoogleToken,
  } = {},
) {
  // A new handler/app for every call simulates separate serverless invocations.
  const handler = createCloudHandler({
    store,
    initialState: require("../tools/demo/state.cjs")(),
    verifyGoogleToken,
    origin: "https://flavor-voyage.netlify.app",
  });
  const response = await handler({
    path: "/.netlify/functions/api/api" + path.split("?")[0],
    queryStringParameters: Object.fromEntries(
      new URLSearchParams(path.split("?")[1] || ""),
    ),
    httpMethod: method,
    headers: {
      "content-type": "application/json",
      origin,
      "x-nf-client-connection-ip": "192.0.2.10",
      ...(cookie ? { cookie } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : null,
    isBase64Encoded: false,
    requestContext: { identity: { sourceIp: "192.0.2.10" } },
  });
  const single =
    response.headers?.["set-cookie"] || response.headers?.["Set-Cookie"];
  const cookies =
    response.multiValueHeaders?.["set-cookie"] ||
    response.multiValueHeaders?.["Set-Cookie"] ||
    (single ? [single] : []);
  return {
    status: response.statusCode,
    data: JSON.parse(response.body),
    cookie: cookies[0]?.split(";")[0],
    response,
  };
}
async function register(store, role) {
  const result = await call(store, "/auth/register", {
    method: "POST",
    body: {
      name: role,
      email: role + "@example.test",
      business: role + " shop",
      role,
      password: "Strong-password-123",
    },
  });
  assert.equal(result.status, 201);
  assert.ok(result.cookie);
  return result;
}

test("Netlify sessions, login, logout and private orders survive separate invocations", async () => {
  const store = new MemoryBlobStore();
  const user = await register(store, "retailer");
  assert.equal(
    (await call(store, "/session", { cookie: user.cookie })).data.user.id,
    user.data.user.id,
  );
  assert.equal((await call(store, "/health")).data.storage, "netlify-blobs");
  assert.equal((await call(store, "/session")).data.user, null);
  const login = await call(store, "/auth/login", {
    method: "POST",
    body: { email: "retailer@example.test", password: "Strong-password-123" },
  });
  assert.equal(login.status, 200);
  assert.equal(
    (await call(store, "/session", { cookie: login.cookie })).data.user.id,
    user.data.user.id,
  );
  assert.equal(
    (
      await call(store, "/auth/logout", {
        method: "POST",
        body: {},
        cookie: login.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(store, "/session", { cookie: login.cookie })).data.user,
    null,
  );
  assert.equal((await call(store, "/orders")).status, 401);
  const rejected = await call(store, "/auth/logout", {
    method: "POST",
    body: {},
    cookie: user.cookie,
    origin: "https://evil.example",
  });
  assert.equal(rejected.status, 403);
});

test("Netlify conditional writes prevent concurrent overselling and replayed checkout", async () => {
  const store = new MemoryBlobStore();
  const supplier = await register(store, "supplier");
  const retailer = await register(store, "retailer");
  const p = await call(store, "/products", {
    method: "POST",
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
  assert.equal(p.status, 201);
  const body = {
    items: [{ productId: p.data.id, quantity: 7 }],
    address: "Dhaka",
    phone: "01700000000",
  };
  const results = await Promise.all(
    ["checkout-a", "checkout-b"].map((key) =>
      call(store, "/orders", {
        method: "POST",
        cookie: retailer.cookie,
        key,
        body,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  const winner = results.findIndex((r) => r.status === 201);
  const replay = await call(store, "/orders", {
    method: "POST",
    cookie: retailer.cookie,
    key: winner === 0 ? "checkout-a" : "checkout-b",
    body,
  });
  assert.equal(replay.data.orders[0].id, results[winner].data.orders[0].id);
  assert.equal(store.value.products.find((x) => x.id === p.data.id).stock, 3);
  assert.equal(store.value.orders.length, 1);
  assert.equal(
    (await call(store, "/orders", { cookie: supplier.cookie })).data.length,
    1,
  );
});

test("Netlify storage failure does not return a successful mutation or login cookie", async () => {
  const store = {
    getWithMetadata: async () => {
      throw new Error("storage offline");
    },
  };
  const result = await call(store, "/auth/login", { method: "POST", body: {} });
  assert.equal(result.status, 503);
  assert.equal(result.cookie, undefined);
});

test("explicit demo import preserves existing accounts, orders and custom inventory", async () => {
  const store = new MemoryBlobStore();
  store.value = {
    suppliers: [{ id: "s-green", name: "Old sample" }],
    products: [
      {
        id: "p-rice",
        supplierId: "s-green",
        name: "Old sample rice",
        active: true,
        stock: 6,
      },
      {
        id: "customer-product",
        supplierId: "real-supplier",
        name: "Customer product",
        active: true,
        stock: 20,
      },
    ],
    users: [{ id: "existing-user", name: "Existing account" }],
    orders: [
      {
        id: "historic-order",
        retailerId: "existing-user",
        items: [{ productId: "p-rice", quantity: 2 }],
      },
    ],
    quotes: [],
    sessions: [],
    attempts: [],
  };
  require("../tools/demo/seed.cjs").migrateCatalogue(store.value);
  store.version = 1;
  assert.equal((await call(store, "/health")).status, 200);
  assert.equal(store.value.catalogVersion, 2);
  assert.equal(
    store.value.products.find((p) => p.id === "p-rice").active,
    false,
  );
  assert.equal(
    store.value.products.find((p) => p.id === "customer-product").stock,
    20,
  );
  assert.equal(store.value.users[0].id, "existing-user");
  assert.equal(store.value.orders[0].items[0].productId, "p-rice");
  assert.equal(
    store.value.products.filter((p) => p.id.startsWith("bd-") && !p.catalogOnly)
      .length,
    56,
  );
  const version = store.version;
  await call(store, "/health");
  assert.equal(store.version, version);
});

test("photo migration persists once and preserves catalog edits and commerce data", async () => {
  const store = new MemoryBlobStore();
  await call(store, "/products");
  delete store.value.catalogPhotoVersion;
  const missing = store.value.products.find((p) => p.id === "bd-mojo");
  delete missing.image;
  missing.stock = 37;
  missing.price = 123;
  const custom = store.value.products.find((p) => p.id === "bd-clemon");
  custom.image = "https://example.test/supplier-photo.jpg";
  const before = structuredClone(store.value);
  require("../tools/demo/seed.cjs").migrateCatalogue(store.value);
  await call(store, "/products");
  assert.equal(
    store.value.products.find((p) => p.id === missing.id).image,
    "/images/drinks/mojo-photo.png",
  );
  before.products.find((p) => p.id === missing.id).image =
    "/images/drinks/mojo-photo.png";
  before.catalogPhotoVersion = 1;
  assert.deepEqual(store.value, before);
  const version = store.version;
  await call(store, "/products");
  assert.equal(store.version, version);
});

test("nearest dealers and demo variant migration preserve existing inventory", async () => {
  const store = new MemoryBlobStore();
  const near = await call(
    store,
    "/suppliers?latitude=23.7461&longitude=90.3742",
  );
  assert.equal(near.status, 200);
  assert.equal(near.data[0].id, "s-cosmobit-dhaka");
  assert.equal(near.data[0].distanceKm, 0);
  assert.equal(
    (await call(store, "/suppliers?latitude=200&longitude=90")).status,
    400,
  );
  assert.equal((await call(store, "/suppliers?latitude=23")).status, 400);
  const variants = (await call(store, "/products?supplier=s-cosmobit-dhaka"))
    .data;
  assert.ok(variants.length >= 13);
  assert.equal(
    new Set(
      variants.filter((p) => p.familyId === "bd-mojo").map((p) => p.variantKey),
    ).size,
    2,
  );
  const before = structuredClone(store.value);
  delete store.value.marketplaceVersion;
  store.value.products.find((p) => p.id === "bd-mojo").stock = 17;
  const count = store.value.products.length;
  require("../tools/demo/seed.cjs").migrateCatalogue(store.value);
  await call(store, "/health");
  assert.equal(store.value.products.length, count);
  assert.equal(store.value.products.find((p) => p.id === "bd-mojo").stock, 17);
  assert.deepEqual(store.value.users, before.users);
  assert.deepEqual(store.value.orders, before.orders);
});

test("buyer/dealer messaging persists, isolates participants, deduplicates sends and tracks reads", async () => {
  const store = new MemoryBlobStore();
  const buyer = await register(store, "retailer");
  const dealer = await register(store, "supplier");
  const other = await call(store, "/auth/register", {
    method: "POST",
    body: {
      name: "Other",
      business: "Other buyer",
      role: "retailer",
      email: "other@example.test",
      password: "Strong-password-123",
    },
  });
  const unrelatedDealer = await call(store, "/auth/register", {
    method: "POST",
    body: {
      name: "Unrelated dealer",
      business: "Another shop",
      role: "supplier",
      email: "unrelated-dealer@example.test",
      password: "Strong-password-123",
    },
  });
  const supplierId = dealer.data.user.supplierId;
  const started = await call(store, "/conversations", {
    method: "POST",
    cookie: buyer.cookie,
    body: { supplierId },
  });
  assert.equal(started.status, 200);
  const id = started.data.id;
  assert.equal(
    (
      await call(store, "/conversations", {
        method: "POST",
        cookie: buyer.cookie,
        body: { supplierId },
      })
    ).data.id,
    id,
  );
  assert.equal((await call(store, "/conversations")).status, 401);
  const body = {
    text: "Do you deliver 500 ml cases?",
    clientId: "buyer-message-1",
  };
  assert.equal(
    (
      await call(store, `/conversations/${id}/messages`, {
        method: "POST",
        cookie: buyer.cookie,
        body,
      })
    ).status,
    200,
  );
  await call(store, `/conversations/${id}/messages`, {
    method: "POST",
    cookie: buyer.cookie,
    body,
  });
  assert.equal(
    (await call(store, "/conversations", { cookie: dealer.cookie })).data[0]
      .unread,
    1,
  );
  assert.equal(
    (await call(store, "/conversations", { cookie: other.cookie })).data.length,
    0,
  );
  assert.equal(
    (await call(store, "/conversations", { cookie: unrelatedDealer.cookie }))
      .data.length,
    0,
  );
  assert.equal(
    (
      await call(store, `/conversations/${id}/messages`, {
        method: "POST",
        cookie: unrelatedDealer.cookie,
        body,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(store, `/conversations/${id}/messages`, {
        method: "POST",
        cookie: other.cookie,
        body,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(store, `/conversations/${id}/read`, {
        method: "POST",
        cookie: other.cookie,
        body: {},
      })
    ).status,
    404,
  );
  const read = await call(store, `/conversations/${id}/read`, {
    method: "POST",
    cookie: dealer.cookie,
    body: {},
  });
  assert.equal(read.data.messages.length, 1);
  assert.equal(read.data.unread, 0);
  assert.ok(read.data.messages[0].readAt);
  assert.equal(
    (
      await call(store, `/conversations/${id}/messages`, {
        method: "POST",
        cookie: dealer.cookie,
        body: {
          text: "Yes, please share the delivery area.",
          clientId: "dealer-reply-1",
        },
      })
    ).status,
    200,
  );
  const inbox = await call(store, "/conversations", { cookie: buyer.cookie });
  assert.equal(inbox.data[0].unread, 1);
  assert.equal(inbox.data[0].messages[1].senderRole, "supplier");
  assert.equal(
    (
      await call(store, `/conversations/${id}/messages`, {
        method: "POST",
        cookie: buyer.cookie,
        body: { text: " ", clientId: "blank" },
      })
    ).status,
    400,
  );
  const profile = await call(store, "/supplier-profile", {
    method: "PATCH",
    cookie: dealer.cookie,
    body: {
      location: "Dhaka",
      address: "Demo address",
      latitude: 23.7,
      longitude: 90.4,
    },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.latitude, 23.7);
  assert.equal(
    (
      await call(store, "/supplier-profile", {
        method: "PATCH",
        cookie: buyer.cookie,
        body: {},
      })
    ).status,
    403,
  );
});

test("dealers manage pack variants without mixing their inventory or checkout price", async () => {
  const store = new MemoryBlobStore();
  const dealer = await register(store, "supplier");
  const buyer = await register(store, "retailer");
  const saved = await call(store, "/products", {
    method: "POST",
    cookie: dealer.cookie,
    body: {
      name: "Mojo Cola",
      brand: "Mojo",
      category: "Soft drinks",
      familyId: "bd-mojo",
      servingSize: "1 litre",
      pack: "6 × 1 litre",
      price: 555,
      stock: 20,
      moq: 2,
      image: "/images/drinks/mojo-photo.png",
    },
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.variantKey, "1 litre");
  assert.equal(saved.data.familyId, "bd-mojo");
  const changed = await call(store, `/products/${saved.data.id}`, {
    method: "PATCH",
    cookie: dealer.cookie,
    body: { price: 600 },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.variantKey, "1 litre");
  assert.equal(changed.data.stock, 20);
  const ordered = await call(store, "/orders", {
    method: "POST",
    cookie: buyer.cookie,
    key: "variant-checkout",
    body: {
      address: "Demo address, Dhaka",
      phone: "01700000000",
      items: [{ productId: saved.data.id, quantity: 2, price: 1 }],
    },
  });
  assert.equal(ordered.status, 201);
  assert.equal(ordered.data.orders[0].total, 1200);
  assert.equal(ordered.data.orders[0].items[0].pack, "6 × 1 litre");
  assert.equal(ordered.data.orders[0].supplierId, dealer.data.user.supplierId);
});

test("Google signup persists one identity, preserves dealer role and supports explicit password-account linking", async () => {
  const {
    generateKeyPair,
    exportJWK,
    createLocalJWKSet,
    SignJWT,
  } = require("jose");
  const { createGoogleVerifier, PROJECT_ID } = require("../google-auth");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const verifyGoogleToken = createGoogleVerifier({
    keySet: createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: "test" }],
    }),
  });
  const token = (email, sub) =>
    new SignJWT({
      email,
      email_verified: true,
      name: "Google User",
      firebase: { sign_in_provider: "google.com" },
      auth_time: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject(sub)
      .setAudience(PROJECT_ID)
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  const store = new MemoryBlobStore();
  const idToken = await token("google-dealer@example.test", "google-dealer");
  const first = await call(store, "/auth/google", {
    method: "POST",
    verifyGoogleToken,
    body: {
      idToken,
      role: "supplier",
      business: "Google Drinks",
      location: "Dhaka",
    },
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.user.role, "supplier");
  assert.equal(first.data.user.googleLinked, true);
  assert.equal(first.data.user.hasPassword, false);
  assert.ok(first.cookie);
  const again = await call(store, "/auth/google", {
    method: "POST",
    verifyGoogleToken,
    body: { idToken, role: "retailer" },
  });
  assert.equal(again.data.user.id, first.data.user.id);
  assert.equal(again.data.user.role, "supplier");
  assert.equal(store.value.users.length, 1);
  assert.equal(
    (await call(store, "/session", { cookie: again.cookie })).data.user.id,
    first.data.user.id,
  );
  assert.equal(
    (
      await call(store, "/auth/login", {
        method: "POST",
        body: { email: "google-dealer@example.test", password: "any-password" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(store, "/auth/google", {
        method: "POST",
        verifyGoogleToken,
        body: { idToken: "invalid" },
      })
    ).status,
    401,
  );
  const local = await register(store, "retailer");
  const localToken = await token("retailer@example.test", "linked-retailer");
  assert.equal(
    (
      await call(store, "/auth/google", {
        method: "POST",
        verifyGoogleToken,
        body: { idToken: localToken },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(store, "/auth/google", {
        method: "POST",
        verifyGoogleToken,
        body: { idToken: localToken, link: true },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(store, "/auth/google", {
        method: "POST",
        verifyGoogleToken,
        cookie: local.cookie,
        body: { idToken, link: true },
      })
    ).status,
    409,
  );
  const linked = await call(store, "/auth/google", {
    method: "POST",
    verifyGoogleToken,
    cookie: local.cookie,
    body: { idToken: localToken, link: true },
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.user.id, local.data.user.id);
  assert.equal(linked.data.user.hasPassword, true);
  const logged = await call(store, "/auth/google", {
    method: "POST",
    verifyGoogleToken,
    body: { idToken: localToken },
  });
  assert.equal(logged.data.user.id, local.data.user.id);
  assert.equal(
    (
      await call(store, "/auth/login", {
        method: "POST",
        body: {
          email: "retailer@example.test",
          password: "Strong-password-123",
        },
      })
    ).status,
    200,
  );
});

test("administration requires the authorized Google session and audits catalog and CMS edits", async () => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "admin@example.test";
  try {
    const store = new MemoryBlobStore();
    assert.equal((await call(store, "/admin/data")).status, 401);
    const reserved = await call(store, "/auth/register", {
      method: "POST",
      body: {
        name: "Blocked",
        business: "Blocked",
        email: "admin@example.test",
        role: "retailer",
        password: "Strong-password-123",
      },
    });
    assert.equal(reserved.status, 409);
    // A legacy password account can still explicitly link Google after allowlisting.
    process.env.ADMIN_EMAILS = "";
    const account = await call(store, "/auth/register", {
      method: "POST",
      body: {
        name: "Owner",
        business: "Owner",
        email: "admin@example.test",
        role: "retailer",
        password: "Strong-password-123",
      },
    });
    process.env.ADMIN_EMAILS = "admin@example.test";
    assert.equal(
      (await call(store, "/admin/data", { cookie: account.cookie })).status,
      403,
    );
    const verifyGoogleToken = async () => ({
      uid: "verified-admin",
      email: "admin@example.test",
      name: "Owner",
    });
    const linked = await call(store, "/auth/google", {
      method: "POST",
      cookie: account.cookie,
      verifyGoogleToken,
      body: { idToken: "verified-test", link: true },
    });
    assert.equal(linked.data.user.isAdmin, true);
    const passwordAgain = await call(store, "/auth/login", {
      method: "POST",
      body: { email: "admin@example.test", password: "Strong-password-123" },
    });
    assert.equal(passwordAgain.data.user.isAdmin, false);
    assert.equal(
      (await call(store, "/admin/data", { cookie: passwordAgain.cookie }))
        .status,
      403,
    );
    const admin = await call(store, "/admin/data", { cookie: linked.cookie });
    assert.equal(admin.status, 200);
    assert.equal(admin.data.users[0].passwordHash, undefined);
    assert.equal(admin.data.users[0].firebaseUid, undefined);
    const newProduct = await call(store, "/admin/products", {
      method: "POST",
      cookie: linked.cookie,
      body: {
        name: "Admin-created drink",
        brand: "Sample brand",
        company: "Sample company",
        category: "Soft drinks",
        supplierId: "s-cosmobit-dhaka",
        price: 600,
        stock: 30,
        moq: 2,
        pack: "12 × 500 ml",
        servingSize: "500 ml",
        compositionNote: "Check the physical pack.",
      },
    });
    assert.equal(newProduct.status, 201);
    assert.equal(newProduct.data.name, "Admin-created drink");
    assert.equal(newProduct.data.company, "Sample company");
    assert.ok(
      (await call(store, "/products")).data.some(
        (p) => p.id === newProduct.data.id,
      ),
    );
    const p = store.value.products[0];
    assert.equal(
      (
        await call(store, `/admin/products/${p.id}`, {
          method: "PATCH",
          cookie: linked.cookie,
          body: { price: 777, stock: 33 },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(store, `/admin/products/${p.id}`, {
          method: "PATCH",
          cookie: linked.cookie,
          body: { price: -1 },
        })
      ).status,
      400,
    );
    await call(store, "/admin/content", {
      method: "PATCH",
      cookie: linked.cookie,
      body: { announcement: "A safe plain-text announcement" },
    });
    assert.equal(
      (await call(store, "/site-content")).data.announcement,
      "A safe plain-text announcement",
    );
    const audited = await call(store, "/admin/data", { cookie: linked.cookie });
    assert.ok(
      audited.data.auditLog.some((a) => a.action === "product.updated"),
    );
    assert.ok(audited.data.auditLog.some((a) => a.action === "cms.updated"));
    assert.equal(
      (
        await call(store, `/admin/users/${linked.data.user.id}`, {
          method: "PATCH",
          cookie: linked.cookie,
          body: { suspended: true },
        })
      ).status,
      409,
    );
  } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
});

test("addresses are private and demo feedback never inflates real ratings", async () => {
  const store = new MemoryBlobStore();
  const buyer = await register(store, "retailer");
  const other = await register(store, "supplier");
  const saved = await call(store, "/addresses", {
    method: "POST",
    cookie: buyer.cookie,
    body: {
      label: "Shop",
      address: "Demo address, Dhaka",
      phone: "01700000000",
    },
  });
  assert.equal(saved.status, 201);
  assert.equal(
    (await call(store, "/addresses", { cookie: buyer.cookie })).data.length,
    1,
  );
  assert.equal(
    (await call(store, "/addresses", { cookie: other.cookie })).status,
    403,
  );
  const initial = await call(store, "/products/bd-mojo/reviews");
  assert.equal(initial.data.count, 0);
  assert.equal(initial.data.average, null);
  assert.ok(initial.data.demoCount > 0);
  assert.equal(
    (
      await call(store, "/products/bd-mojo/reviews", {
        method: "POST",
        cookie: buyer.cookie,
        body: { rating: 4, comment: "Helpful product listing." },
      })
    ).status,
    200,
  );
  let reviews = (await call(store, "/products/bd-mojo/reviews")).data;
  assert.equal(reviews.average, 4);
  assert.equal(reviews.count, 1);
  assert.equal(reviews.reviews[0].buyerId, undefined);
  await call(store, "/products/bd-mojo/reviews", {
    method: "POST",
    cookie: buyer.cookie,
    body: { rating: 5, comment: "Updated experience." },
  });
  reviews = (await call(store, "/products/bd-mojo/reviews")).data;
  assert.equal(reviews.count, 1);
  assert.equal(reviews.average, 5);
  assert.equal(
    (
      await call(store, "/products/bd-mojo/reviews", {
        method: "POST",
        cookie: other.cookie,
        body: { rating: 5, comment: "No dealer self-rating." },
      })
    ).status,
    403,
  );
});

test("production refuses to silently recreate a missing workspace", async () => {
  const store = new MemoryBlobStore();
  const handler = createCloudHandler({
    store,
    requireExistingStore: true,
    origin: "https://flavor-voyage.netlify.app",
  });
  const response = await handler({
    path: "/.netlify/functions/api/api/products",
    httpMethod: "GET",
    headers: {},
    body: null,
    isBase64Encoded: false,
  });
  assert.equal(response.statusCode, 503);
  assert.equal(store.value, null);
});
