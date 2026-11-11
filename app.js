const express = require("express");
const { createNotificationsRouter } = require("./notifications-api");
const {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const catalogSchema = require("./catalog-schema");
const { createMediaRouter } = require("./media-api");
const {
  createAdminRouter,
  isAdminIdentity,
  isAdminEmail,
} = require("./admin-api");
const { verifyGoogleToken: defaultGoogleVerifier } = require("./google-auth");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicUser = (
  { id, name, business, email, role, supplierId, firebaseUid, passwordHash },
  authProvider,
) => ({
  id,
  name,
  business,
  email,
  role,
  supplierId,
  isAdmin: authProvider === "google" && isAdminIdentity({ email, firebaseUid }),
  googleLinked: Boolean(firebaseUid),
  hasPassword: Boolean(passwordHash),
});
const passwordHash = (password, salt) =>
  scryptSync(password, salt, 64).toString("hex");
const fail = (status, message) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};
const text = (value, label, max = 160) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail(400, `${label} is required (up to ${max} characters).`);
  return value.trim();
};
const integer = (value, label, min = 1, max = 1000000) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(400, `${label} must be a whole number between ${min} and ${max}.`);
  return value;
};
function createApp({
  dataFile,
  verifyGoogleToken = defaultGoogleVerifier,
  initialState,
  storageLabel,
  trustedNetlifyProxy = false,
  demo = false,
  secure = false,
  origin = "http://localhost:5173",
} = {}) {
  let db = initialState
    ? structuredClone(initialState)
    : dataFile && fs.existsSync(dataFile)
      ? JSON.parse(fs.readFileSync(dataFile, "utf8"))
      : {
          suppliers: [],
          products: [],
          users: [],
          orders: [],
        };
  db.quotes ||= [];
  db.conversations ||= [];
  db.reviews ||= [];
  db.addresses ||= [];
  const sessions = new Map(db.sessions || []);
  const attempts = new Map(db.attempts || []);
  delete db.sessions;
  delete db.attempts;
  function persist() {
    if (!dataFile) return;
    fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${dataFile}.tmp`, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(`${dataFile}.tmp`, dataFile);
  }
  // All mutations are synchronous and commit atomically in this single-process store.
  function transaction(fn) {
    const previous = structuredClone(db);
    try {
      const result = fn();
      persist();
      return result;
    } catch (error) {
      db = previous;
      throw error;
    }
  }
  function session(res, user, authProvider = "password") {
    if (user.suspended)
      fail(403, "This account is suspended. Contact site support.");
    const token = randomBytes(32).toString("hex");
    sessions.set(hash(token), {
      userId: user.id,
      authProvider,
      expires: Date.now() + 86400000,
    });
    res.cookie("fv_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure,
      maxAge: 86400000,
      path: "/",
    });
    return publicUser(user, authProvider);
  }
  const allowedOrigins = new Set([origin]);
  if (!secure && origin === "http://localhost:5173")
    allowedOrigins.add("http://127.0.0.1:5173");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    // Same-origin requests go through Vite/reverse proxy. Reject cross-site mutations.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.get("sec-fetch-site") === "cross-site" ||
        (req.get("origin") && !allowedOrigins.has(req.get("origin"))) ||
        (secure && !req.get("origin"))
      )
        return res
          .status(403)
          .json({ message: "Request origin is not allowed." });
    }
    const token = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("fv_session="))
      ?.slice(11);
    const record = token && sessions.get(hash(token));
    if (record && record.expires > Date.now()) {
      req.user = db.users.find((x) => x.id === record.userId && !x.suspended);
      req.authProvider = record.authProvider;
    }
    if (record && record.expires <= Date.now()) sessions.delete(hash(token));
    next();
  });
  const auth = (req, res, next) => {
    if (!req.user)
      return res.status(401).json({ message: "Please sign in to continue." });
    next();
  };
  const role = (expected) => (req, res, next) => {
    if (req.user.role !== expected)
      return res
        .status(403)
        .json({ message: `This action is for ${expected}s.` });
    next();
  };
  const rateLimit = (req, res, next) => {
    const key = trustedNetlifyProxy
      ? req.headers["x-nf-client-connection-ip"] || req.ip
      : req.ip;
    let entry = attempts.get(key);
    if (!entry || entry.until < Date.now()) {
      entry = { count: 0, until: Date.now() + 600000 };
      attempts.set(key, entry);
    }
    if (++entry.count > 30)
      return res
        .status(429)
        .json({ message: "Too many attempts. Try again in 10 minutes." });
    if (attempts.size > 10000)
      for (const [k, v] of attempts)
        if (v.until < Date.now()) attempts.delete(k);
    next();
  };
  app.use(
    "/api/notifications",
    createNotificationsRouter({ auth, getState: () => db, transaction }),
  );
  app.get("/api/health", (req, res) =>
    res.json({
      status: "ok",
      currency: "BDT",
      storage: storageLabel || (dataFile ? "local-file" : "memory"),
      demo,
      onlinePayments: false,
    }),
  );
  app.get("/api/session", (req, res) =>
    res.json({
      user: req.user ? publicUser(req.user, req.authProvider) : null,
      demo,

      onlinePayments: false,
    }),
  );
  app.post("/api/auth/register", rateLimit, (req, res) => {
    const name = text(req.body.name, "Name");
    const business = text(req.body.business, "Business name");
    const email = text(req.body.email, "Email").toLowerCase();
    if (isAdminEmail(email))
      fail(409, "Use Continue with Google for the administrator account.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fail(400, "Enter a valid email address.");
    const password = text(req.body.password, "Password", 128);
    if (password.length < 10)
      fail(400, "Use a password with at least 10 characters.");
    if (!["retailer", "supplier"].includes(req.body.role))
      fail(400, "Choose retailer or supplier.");
    if (db.users.some((u) => u.email === email))
      fail(409, "An account with this email already exists.");
    const user = transaction(() => {
      const salt = randomBytes(16).toString("hex");
      const user = {
        id: randomUUID(),
        name,
        business,
        email,
        role: req.body.role,
        salt,
        passwordHash: passwordHash(password, salt),
      };
      if (user.role === "supplier") {
        user.supplierId = randomUUID();
        db.suppliers.push({
          id: user.supplierId,
          name: business,
          location: text(req.body.location || "Bangladesh", "Location"),
          initials: business.slice(0, 2).toUpperCase(),
          color: "#e8f1d9",
          description: "Independent wholesale supplier.",
          ...coordinates(req.body),
          categories: [],
        });
      }
      db.users.push(user);
      return user;
    });
    res.status(201).json({ user: session(res, user) });
  });
  app.post("/api/auth/login", rateLimit, (req, res) => {
    const email = text(req.body.email, "Email").toLowerCase();
    const password = text(req.body.password, "Password", 128);
    const user = db.users.find((u) => u.email === email && !u.demo);
    const salt = user?.salt || "authentication-timing-placeholder";
    const candidate = Buffer.from(passwordHash(password, salt), "hex");
    if (
      !user?.passwordHash ||
      !timingSafeEqual(candidate, Buffer.from(user.passwordHash, "hex"))
    )
      fail(401, "Email or password is incorrect.");
    res.json({ user: session(res, user) });
  });
  app.post("/api/auth/google", rateLimit, async (req, res, next) => {
    try {
      const token = text(req.body.idToken, "Google ID token", 10000);
      let identity;
      try {
        identity = await verifyGoogleToken(token);
      } catch (error) {
        if (
          error.code?.startsWith("ERR_J") ||
          error.code === "INVALID_GOOGLE_IDENTITY"
        )
          fail(401, "Google sign-in could not be verified. Please try again.");
        fail(
          503,
          "Google sign-in is temporarily unavailable. Please try again.",
        );
      }
      const linked = db.users.find((u) => u.firebaseUid === identity.uid);
      const existing = db.users.find(
        (u) => u.email === identity.email && !u.demo,
      );
      if (req.body.link === true) {
        if (!req.user || req.user.demo)
          fail(401, "Sign in to your account before linking Google.");
        if (req.user.email !== identity.email)
          fail(
            409,
            "Choose the Google account with the same email as your current account.",
          );
        if (linked && linked.id !== req.user.id)
          fail(
            409,
            "This Google account is already linked to another account.",
          );
        if (req.user.firebaseUid && req.user.firebaseUid !== identity.uid)
          fail(409, "A different Google account is already linked.");
        const user = transaction(() => {
          req.user.firebaseUid = identity.uid;
          return req.user;
        });
        return res.json({ user: session(res, user, "google") });
      }
      if (linked) return res.json({ user: session(res, linked, "google") });
      if (existing)
        fail(
          409,
          "This email already has an account. Sign in with your password, then link Google from your account settings.",
        );
      const selectedRole = req.body.role || "retailer";
      if (!["retailer", "supplier"].includes(selectedRole))
        fail(400, "Choose customer/retailer or dealer.");
      const name = text(
        identity.name?.trim() || identity.email.split("@")[0],
        "Name",
      );
      const business = text(req.body.business || name, "Name / shop name");
      const user = transaction(() => {
        const created = {
          id: randomUUID(),
          name,
          business,
          email: identity.email,
          role: selectedRole,
          firebaseUid: identity.uid,
        };
        if (created.role === "supplier") {
          created.supplierId = randomUUID();
          db.suppliers.push({
            id: created.supplierId,
            name: business,
            location: text(req.body.location || "Bangladesh", "Location"),
            initials: business.slice(0, 2).toUpperCase(),
            color: "#e8f1d9",
            description: "Independent wholesale supplier.",
            categories: [],
          });
        }
        db.users.push(created);
        return created;
      });
      res.status(201).json({ user: session(res, user, "google") });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/auth/demo", rateLimit, (req, res) => {
    if (!demo) fail(404, "Demo accounts are disabled.");
    if (!["retailer", "supplier"].includes(req.body.role))
      fail(400, "Choose a role.");
    // A separate business per demo browser session keeps private orders isolated.
    const user = transaction(() => {
      const user = {
        id: randomUUID(),
        name: "Demo user",
        business:
          req.body.role === "retailer"
            ? "Your neighborhood store"
            : "Your wholesale business",
        role: req.body.role,
        demo: true,
      };
      if (user.role === "supplier") {
        const demoShop =
          req.body.supplierId &&
          db.suppliers.find((s) => s.id === req.body.supplierId && s.demoShop);
        if (req.body.supplierId && !demoShop) fail(400, "Choose a demo shop.");
        if (demoShop) {
          user.supplierId = demoShop.id;
          user.business = demoShop.name;
        } else {
          user.supplierId = randomUUID();
          db.suppliers.push({
            initials: "DB",
            color: "#f8e5d6",
            categories: [],
            location: "Bangladesh",
            description: "Isolated demonstration business.",
            id: user.supplierId,
            name: user.business,
          });
          db.products.push(
            ...structuredClone(
              db.products.filter((p) => p.active && !p.catalogOnly).slice(0, 2),
            ).map((p) => ({
              ...p,
              id: randomUUID(),
              supplierId: user.supplierId,
              familyId: p.familyId || p.id,
              catalogOnly: true,
              demoListing: true,
            })),
          );
        }
      }
      db.users.push(user);
      return user;
    });
    res.json({ user: session(res, user) });
  });
  app.post("/api/auth/logout", (req, res) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("fv_session="))
      ?.slice(11);
    if (token) sessions.delete(hash(token));
    res.clearCookie("fv_session", {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure,
    });
    res.json({ ok: true });
  });
  function coordinates(body) {
    if (body.latitude == null && body.longitude == null) return {};
    const latitude = Number(body.latitude),
      longitude = Number(body.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180 ||
      body.latitude == null ||
      body.longitude == null ||
      body.latitude === "" ||
      body.longitude === ""
    )
      fail(400, "Enter valid latitude and longitude.");
    return { latitude, longitude };
  }
  function distance(a, b) {
    const rad = (n) => (n * Math.PI) / 180;
    const h =
      Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
      Math.cos(rad(a.latitude)) *
        Math.cos(rad(b.latitude)) *
        Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
    return (
      Math.round(
        6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h))) * 10,
      ) / 10
    );
  }
  app.get("/api/suppliers", (req, res) => {
    const point = coordinates(req.query);
    let result = db.suppliers
      .filter(
        (s) =>
          s.id === req.user?.supplierId ||
          db.products.some(
            (p) =>
              p.supplierId === s.id &&
              p.active &&
              catalogSchema.categories.includes(p.category),
          ),
      )
      .map((s) => ({
        ...s,
        productCount: db.products.filter(
          (p) =>
            p.supplierId === s.id &&
            p.active &&
            catalogSchema.categories.includes(p.category),
        ).length,
        distanceKm:
          point.latitude != null &&
          Number.isFinite(s.latitude) &&
          Number.isFinite(s.longitude)
            ? distance(point, s)
            : null,
      }));
    if (point.latitude != null)
      result.sort(
        (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
      );
    res.json(result);
  });
  app.patch("/api/supplier-profile", auth, role("supplier"), (req, res) => {
    const fields = {
      location: text(req.body.location, "Area"),
      address: text(req.body.address, "Address", 500),
      ...coordinates(req.body),
    };
    res.json(
      transaction(() =>
        Object.assign(
          db.suppliers.find((s) => s.id === req.user.supplierId),
          fields,
        ),
      ),
    );
  });
  app.get("/api/products", (req, res) => {
    let products = db.products.filter(
      (p) => p.active && catalogSchema.categories.includes(p.category),
    );
    if (req.query.q)
      products = products.filter((p) =>
        `${p.name} ${p.brand} ${p.category}`
          .toLowerCase()
          .includes(String(req.query.q).toLowerCase()),
      );
    if (req.query.category)
      products = products.filter((p) => p.category === req.query.category);
    if (req.query.supplier)
      products = products.filter((p) => p.supplierId === req.query.supplier);
    res.json(products);
  });
  app.get("/api/inventory", auth, role("supplier"), (req, res) =>
    res.json(db.products.filter((p) => p.supplierId === req.user.supplierId)),
  );
  const categories = catalogSchema.categories;
  function productFields(body) {
    const category = text(body.category, "Category");
    if (!categories.includes(category))
      fail(400, "Choose a supported category.");
    const parent = body.familyId
      ? db.products.find((p) => p.id === body.familyId)
      : null;
    if (body.familyId && (!parent || parent.category !== category))
      fail(400, "Choose a product family in the same category.");
    const servingSize = body.servingSize
      ? text(body.servingSize, "Unit size", 100)
      : "";
    return {
      familyId: parent ? parent.familyId || parent.id : null,
      servingSize,
      variantKey: servingSize || text(body.pack, "Pack size"),
      variantLabel: servingSize || text(body.pack, "Pack size"),
      name: text(body.name, "Product name"),
      brand: text(body.brand, "Brand"),
      category,
      price: integer(body.price, "Price"),
      moq: integer(body.moq, "Minimum order", 1, 10000),
      stock: integer(body.stock, "Stock", 0),
      pack: text(body.pack, "Pack size"),
      description: text(body.description || body.name, "Description", 1000),
      image:
        typeof body.image === "string" &&
        (/^\/api\/media\/[a-f0-9]{24}$/.test(body.image) ||
          /^\/images\/drinks\/[a-z0-9.-]+$/.test(body.image) ||
          /^https:\/\/[^\s]+$/.test(body.image))
          ? body.image
          : "",
      illustration: {
        "Soft drinks": "mojo",
        "Fruit drinks": "frooto",
        "Energy drinks": "speed",
        Water: "mum",
        "Dairy & lassi": "lassi",
        "Tea & coffee": "ispahani",
        "Malt drinks": "horlicks",
        "Drink mixes": "tang-orange",
        "Traditional sips": "laban",
      }[category],
    };
  }
  app.post("/api/products", auth, role("supplier"), (req, res) => {
    const fields = productFields(req.body);
    const product = transaction(() => {
      const p = {
        ...fields,
        id: randomUUID(),
        supplierId: req.user.supplierId,
        active: req.body.active !== false,
        catalogOnly: Boolean(fields.familyId),
        badge: "New arrival",
      };
      db.products.push(p);
      return p;
    });
    res.status(201).json(product);
  });
  app.patch("/api/products/:id", auth, role("supplier"), (req, res) => {
    const p = db.products.find(
      (p) => p.id === req.params.id && p.supplierId === req.user.supplierId,
    );
    if (!p) fail(404, "Product not found.");
    const fields = productFields({ ...p, ...req.body });
    if (req.body.active !== undefined && typeof req.body.active !== "boolean")
      fail(400, "Active must be true or false.");
    res.json(
      transaction(() => {
        Object.assign(p, fields, {
          active: req.body.active ?? p.active,
          catalogOnly: Boolean(fields.familyId && fields.familyId !== p.id),
        });
        return p;
      }),
    );
  });
  app.get("/api/orders", auth, (req, res) =>
    res.json(
      db.orders
        .filter((o) =>
          req.user.role === "supplier"
            ? o.supplierId === req.user.supplierId
            : o.retailerId === req.user.id,
        )
        .map(({ idempotencyKey, ...o }) => o)
        .reverse(),
    ),
  );
  app.post("/api/orders", auth, role("retailer"), (req, res) => {
    const key = text(req.get("Idempotency-Key"), "Checkout reference", 100);
    const existing = db.orders.filter(
      (o) => o.retailerId === req.user.id && o.idempotencyKey === key,
    );
    if (existing.length) return res.json({ orders: existing });
    const address = text(req.body.address, "Delivery address", 500);
    const phone = text(req.body.phone, "Phone number", 30);
    if (!/^[+\d\s()-]{7,30}$/.test(phone))
      fail(400, "Enter a valid phone number.");
    if (
      !Array.isArray(req.body.items) ||
      !req.body.items.length ||
      req.body.items.length > 100
    )
      fail(400, "Add between 1 and 100 products.");
    const seen = new Set();
    const lines = req.body.items.map((item) => {
      if (seen.has(item.productId)) fail(400, "Duplicate product in order.");
      seen.add(item.productId);
      const p = db.products.find(
        (p) =>
          p.id === item.productId &&
          p.active &&
          catalogSchema.categories.includes(p.category),
      );
      if (!p)
        fail(400, "A product is no longer available. Refresh your order.");
      integer(item.quantity, "Quantity", p.moq, p.stock);
      return {
        productId: p.id,
        name: p.name,
        pack: p.pack,
        price: p.price,
        quantity: item.quantity,
        supplierId: p.supplierId,
      };
    });
    const orders = transaction(() => {
      const groups = Map.groupBy(lines, (l) => l.supplierId);
      const result = [];
      for (const [supplierId, items] of groups) {
        const order = {
          id: randomUUID(),
          reference: `FV-${randomBytes(4).toString("hex").toUpperCase()}`,
          retailerId: req.user.id,
          retailerName: req.user.business,
          supplierId,
          supplierName: db.suppliers.find((s) => s.id === supplierId).name,
          items,
          total: items.reduce((sum, l) => sum + l.price * l.quantity, 0),
          status: "pending",
          address,
          phone,
          createdAt: new Date().toISOString(),
          idempotencyKey: key,
        };
        for (const line of items)
          db.products.find((p) => p.id === line.productId).stock -=
            line.quantity;
        db.orders.push(order);
        result.push(order);
      }
      return result;
    });
    res.status(201).json({ orders });
  });
  app.patch("/api/orders/:id", auth, (req, res) => {
    const order = db.orders.find(
      (o) =>
        o.id === req.params.id &&
        (req.user.role === "supplier"
          ? o.supplierId === req.user.supplierId
          : o.retailerId === req.user.id),
    );
    if (!order) fail(404, "Order not found.");
    const allowed =
      req.user.role === "supplier"
        ? {
            pending: ["confirmed", "cancelled"],
            confirmed: ["shipped", "cancelled"],
            shipped: ["delivered"],
          }
        : { pending: ["cancelled"] };
    if (req.body.status === "cancelled" && order.paymentStatus === "paid")
      fail(
        409,
        "Paid orders require manual refund reconciliation before cancellation.",
      );
    if (!allowed[order.status]?.includes(req.body.status))
      fail(409, "This order status change is not allowed.");
    res.json(
      transaction(() => {
        order.history ||= [{ status: order.status, at: order.createdAt }];
        order.history.push({
          status: req.body.status,
          at: new Date().toISOString(),
        });
        order.status = req.body.status;
        order.updatedAt = new Date().toISOString();
        if (order.status === "cancelled")
          for (const l of order.items)
            db.products.find((p) => p.id === l.productId).stock += l.quantity;
        return order;
      }),
    );
  });

  app.get("/api/quotes", auth, (req, res) =>
    res.json(
      db.quotes
        .filter((q) =>
          req.user.role === "supplier"
            ? q.supplierId === req.user.supplierId
            : q.retailerId === req.user.id,
        )
        .slice()
        .reverse(),
    ),
  );
  app.post("/api/quotes", auth, role("retailer"), (req, res) => {
    if (
      !Array.isArray(req.body.items) ||
      !req.body.items.length ||
      req.body.items.length > 100
    )
      fail(400, "Choose up to 100 products.");
    const note = text(req.body.note, "Request details", 1000);
    const seen = new Set();
    const lines = req.body.items.map((l) => {
      if (seen.has(l.productId)) fail(400, "Duplicate product.");
      seen.add(l.productId);
      const p = db.products.find(
        (p) =>
          p.id === l.productId &&
          p.active &&
          catalogSchema.categories.includes(p.category),
      );
      if (!p) fail(400, "Product not available.");
      integer(l.quantity, "Quantity", p.moq, 100000);
      return {
        productId: p.id,
        name: p.name,
        pack: p.pack,
        quantity: l.quantity,
        price: p.price,
        supplierId: p.supplierId,
      };
    });
    res.status(201).json(
      transaction(() => {
        const result = [];
        for (const [supplierId, items] of Map.groupBy(
          lines,
          (l) => l.supplierId,
        )) {
          const quote = {
            id: randomUUID(),
            reference: `RFQ-${randomBytes(3).toString("hex").toUpperCase()}`,
            retailerId: req.user.id,
            retailerName: req.user.business,
            supplierId,
            supplierName: db.suppliers.find((s) => s.id === supplierId).name,
            items,
            note,
            status: "requested",
            createdAt: new Date().toISOString(),
          };
          db.quotes.push(quote);
          result.push(quote);
        }
        return { quotes: result };
      }),
    );
  });
  app.patch("/api/quotes/:id", auth, (req, res) => {
    const q = db.quotes.find(
      (q) =>
        q.id === req.params.id &&
        (req.user.role === "supplier"
          ? q.supplierId === req.user.supplierId
          : q.retailerId === req.user.id),
    );
    if (!q) fail(404, "Quote not found.");
    if (!["requested", "offered"].includes(q.status))
      fail(409, "This quote is already closed.");
    if (req.user.role === "supplier") {
      if (req.body.status === "declined")
        return res.json(
          transaction(() => {
            q.status = "declined";
            q.updatedAt = new Date().toISOString();
            return q;
          }),
        );
      if (
        req.body.status !== "offered" ||
        !Array.isArray(req.body.prices) ||
        req.body.prices.length !== q.items.length
      )
        fail(400, "Provide a unit price for every line.");
      req.body.prices.forEach((p) => integer(p, "Offered unit price"));
      return res.json(
        transaction(() => {
          q.items.forEach((l, i) => {
            l.price = req.body.prices[i];
          });
          q.status = "offered";
          q.updatedAt = new Date().toISOString();
          q.supplierNote = text(
            req.body.note ||
              "Offer valid for 7 days, subject to stock availability.",
            "Offer details",
            1000,
          );
          q.expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
          return q;
        }),
      );
    }
    if (req.body.status === "cancelled")
      return res.json(
        transaction(() => {
          q.status = "cancelled";
          q.updatedAt = new Date().toISOString();
          return q;
        }),
      );
    if (
      q.status !== "offered" ||
      req.body.status !== "accepted" ||
      Date.parse(q.expiresAt) < Date.now()
    )
      fail(409, "A current supplier offer is required.");
    const address = text(req.body.address, "Delivery address", 500);
    const phone = text(req.body.phone, "Phone number", 30);
    if (!/^[+\d\s()-]{7,30}$/.test(phone))
      fail(400, "Enter a valid phone number.");
    for (const l of q.items) {
      const p = db.products.find(
        (p) =>
          p.id === l.productId &&
          p.active &&
          catalogSchema.categories.includes(p.category),
      );
      if (!p || p.stock < l.quantity)
        fail(409, `${l.name} is no longer available in that quantity.`);
    }
    res.json(
      transaction(() => {
        const order = {
          id: randomUUID(),
          reference: `FV-${randomBytes(4).toString("hex").toUpperCase()}`,
          quoteId: q.id,
          retailerId: q.retailerId,
          retailerName: q.retailerName,
          supplierId: q.supplierId,
          supplierName: q.supplierName,
          items: structuredClone(q.items),
          total: q.items.reduce((n, l) => n + l.price * l.quantity, 0),
          address,
          phone,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        for (const l of q.items)
          db.products.find((p) => p.id === l.productId).stock -= l.quantity;
        db.orders.push(order);
        q.status = "accepted";
        q.updatedAt = new Date().toISOString();
        q.orderId = order.id;
        return { quote: q, order };
      }),
    );
  });
  app.get("/api/products/:id/reviews", (req, res) => {
    const product = db.products.find((p) => p.id === req.params.id && p.active);
    if (!product) fail(404, "Product not found.");
    const familyId = product.familyId || product.id;
    const reviews = db.reviews
      .filter((r) => r.familyId === familyId)
      .map(({ buyerId, ...review }) => ({
        ...review,
        mine: buyerId === req.user?.id,
      }));
    const real = reviews.filter((r) => !r.demo);
    res.json({
      reviews: reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      count: real.length,
      demoCount: reviews.length - real.length,
      average: real.length
        ? Math.round(
            (real.reduce((n, r) => n + r.rating, 0) / real.length) * 10,
          ) / 10
        : null,
    });
  });
  app.post("/api/products/:id/reviews", auth, role("retailer"), (req, res) => {
    const product = db.products.find((p) => p.id === req.params.id && p.active);
    if (!product) fail(404, "Product not found.");
    const familyId = product.familyId || product.id;
    const rating = integer(req.body.rating, "Rating", 1, 5);
    const comment = text(req.body.comment, "Review", 1000);
    const verifiedPurchase = db.orders.some(
      (o) =>
        o.retailerId === req.user.id &&
        o.status === "delivered" &&
        o.items.some((l) => {
          const p = db.products.find((p) => p.id === l.productId);
          return p && (p.familyId || p.id) === familyId;
        }),
    );
    res.json(
      transaction(() => {
        let review = db.reviews.find(
          (r) => r.familyId === familyId && r.buyerId === req.user.id,
        );
        if (!review) {
          review = {
            id: randomUUID(),
            familyId,
            buyerId: req.user.id,
            createdAt: new Date().toISOString(),
          };
          db.reviews.push(review);
        }
        Object.assign(review, {
          rating,
          comment,
          author: req.user.name,
          demo: Boolean(req.user.demo),
          verifiedPurchase,
          updatedAt: new Date().toISOString(),
        });
        const { buyerId, ...visible } = review;
        return { ...visible, mine: true };
      }),
    );
  });
  app.get("/api/addresses", auth, role("retailer"), (req, res) =>
    res.json(
      db.addresses
        .filter((a) => a.buyerId === req.user.id)
        .map(({ buyerId, ...a }) => a),
    ),
  );
  app.post("/api/addresses", auth, role("retailer"), (req, res) => {
    const label = text(req.body.label, "Address label", 60),
      address = text(req.body.address, "Address", 500),
      phone = text(req.body.phone, "Phone", 30);
    if (!/^[+0-9 ()-]{7,30}$/.test(phone))
      fail(400, "Enter a valid phone number.");
    const owned = db.addresses.filter((a) => a.buyerId === req.user.id);
    if (owned.length >= 5)
      fail(
        400,
        "You can save up to five addresses. Remove one before adding another.",
      );
    res.status(201).json(
      transaction(() => {
        const a = {
          id: randomUUID(),
          buyerId: req.user.id,
          label,
          address,
          phone,
        };
        db.addresses.push(a);
        const { buyerId, ...visible } = a;
        return visible;
      }),
    );
  });
  app.delete("/api/addresses/:id", auth, role("retailer"), (req, res) => {
    const a = db.addresses.find(
      (a) => a.id === req.params.id && a.buyerId === req.user.id,
    );
    if (!a) fail(404, "Address not found.");
    res.json(
      transaction(() => {
        db.addresses = db.addresses.filter((x) => x.id !== a.id);
        return { ok: true };
      }),
    );
  });
  const canReadConversation = (thread, user) =>
    user.role === "supplier"
      ? thread.supplierId === user.supplierId
      : thread.buyerId === user.id;
  const summary = (thread, user) => ({
    ...thread,
    unread: thread.messages.filter(
      (m) => m.senderRole !== user.role && !m.readAt,
    ).length,
  });
  app.get("/api/conversations", auth, (req, res) => {
    res.json(
      db.conversations
        .filter((t) => canReadConversation(t, req.user))
        .map((t) => summary(t, req.user))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  });
  app.post("/api/conversations", auth, role("retailer"), (req, res) => {
    const dealer = db.suppliers.find((s) => s.id === req.body.supplierId);
    if (!dealer) fail(404, "Dealer not found.");
    res.json(
      transaction(() => {
        let thread = db.conversations.find(
          (t) => t.supplierId === dealer.id && t.buyerId === req.user.id,
        );
        if (!thread) {
          thread = {
            id: randomUUID(),
            supplierId: dealer.id,
            supplierName: dealer.name,
            buyerId: req.user.id,
            buyerName: req.user.business || req.user.name,
            demoShop: Boolean(dealer.demoShop),
            messages: [],
            updatedAt: new Date().toISOString(),
          };
          db.conversations.push(thread);
        }
        return summary(thread, req.user);
      }),
    );
  });
  app.post("/api/conversations/:id/messages", auth, (req, res) => {
    const thread = db.conversations.find(
      (t) => t.id === req.params.id && canReadConversation(t, req.user),
    );
    if (!thread) fail(404, "Conversation not found.");
    if (
      thread.messages.filter(
        (m) =>
          m.senderId === req.user.id &&
          Date.parse(m.createdAt) > Date.now() - 60000,
      ).length >= 30
    )
      fail(429, "Please wait a minute before sending more messages.");
    const body = text(req.body.text, "Message", 2000);
    const clientId = text(req.body.clientId, "Message ID", 100);
    res.json(
      transaction(() => {
        if (
          !thread.messages.some(
            (m) => m.clientId === clientId && m.senderId === req.user.id,
          )
        ) {
          const now = new Date().toISOString();
          thread.messages.push({
            id: randomUUID(),
            clientId,
            text: body,
            senderId: req.user.id,
            senderRole: req.user.role,
            senderName: req.user.name,
            createdAt: now,
          });
          thread.updatedAt = now;
        }
        return summary(thread, req.user);
      }),
    );
  });
  app.post("/api/conversations/:id/read", auth, (req, res) => {
    const thread = db.conversations.find(
      (t) => t.id === req.params.id && canReadConversation(t, req.user),
    );
    if (!thread) fail(404, "Conversation not found.");
    res.json(
      transaction(() => {
        for (const m of thread.messages)
          if (m.senderRole !== req.user.role && !m.readAt)
            m.readAt = new Date().toISOString();
        return summary(thread, req.user);
      }),
    );
  });
  app.get("/api/site-content", (req, res) => res.json(db.content || {}));
  app.use("/api/media", createMediaRouter({ auth, rateLimit }));
  app.use(
    "/api/admin",
    createAdminRouter({
      auth,
      getState: () => db,
      transaction,
      fail,
      text,
      integer,
      publicUser,
      productFields,
    }),
  );
  app.use("/api", (req, res) =>
    res.status(404).json({ message: "Endpoint not found." }),
  );
  app.use((error, req, res, next) => {
    if (!error.status) console.error(error.message);
    res.status(error.status || 500).json({
      message: error.status
        ? error.message
        : "Something went wrong. Please try again.",
    });
  });
  // Private adapter hook, never an HTTP endpoint. Session tokens are stored hashed.
  app.exportState = () => {
    for (const [key, value] of sessions)
      if (value.expires <= Date.now()) sessions.delete(key);
    for (const [key, value] of attempts)
      if (value.until <= Date.now()) attempts.delete(key);
    return {
      ...structuredClone(db),
      sessions: [...sessions],
      attempts: [...attempts],
    };
  };
  return app;
}
module.exports = { createApp };
