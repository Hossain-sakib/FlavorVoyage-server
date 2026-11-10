const express = require("express");
const { randomUUID } = require("node:crypto");
const adminEmails = () =>
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
const isAdminIdentity = (user) =>
  Boolean(user?.firebaseUid && adminEmails().includes(user.email));
function createAdminRouter({
  auth,
  getState,
  transaction,
  fail,
  text,
  integer,
  publicUser,
}) {
  const router = express.Router();
  router.use(auth, (req, res, next) => {
    if (!isAdminIdentity(req.user) || req.authProvider !== "google")
      return res
        .status(403)
        .json({
          message:
            "Administrator access requires the authorized Google account.",
        });
    next();
  });
  function audit(user, action, target, fields = []) {
    const db = getState();
    db.auditLog ||= [];
    db.auditLog.push({
      id: randomUUID(),
      actorId: user.id,
      actorEmail: user.email,
      action,
      target,
      fields,
      createdAt: new Date().toISOString(),
    });
  }
  router.get("/data", (req, res) => {
    const db = getState();
    res.json({
      users: db.users.map((u) => ({
        ...publicUser(u),
        suspended: Boolean(u.suspended),
        orderCount: db.orders.filter(
          (o) => o.retailerId === u.id || o.supplierId === u.supplierId,
        ).length,
      })),
      products: db.products,
      suppliers: db.suppliers,
      orders: db.orders,
      quotes: db.quotes,
      content: db.content || {},
      notes: db.crmNotes || [],
      auditLog: (db.auditLog || []).slice(-100).reverse(),
      metrics: {
        users: db.users.length,
        products: db.products.filter((p) => p.active).length,
        activeOrders: db.orders.filter(
          (o) => !["cancelled", "delivered"].includes(o.status),
        ).length,
        totalOrderValue: db.orders
          .filter((o) => o.status !== "cancelled")
          .reduce((n, o) => n + o.total, 0),
      },
    });
  });
  router.patch("/products/:id", (req, res) => {
    const p = getState().products.find((p) => p.id === req.params.id);
    if (!p) fail(404, "Product not found.");
    const updates = {};
    for (const key of [
      "name",
      "description",
      "brand",
      "company",
      "flavor",
      "compositionNote",
      "preparationNote",
      "pack",
      "servingSize",
    ])
      if (req.body[key] !== undefined)
        updates[key] = text(
          req.body[key],
          key,
          key === "description" ? 1000 : 160,
        );
    for (const key of ["stock", "price", "moq"])
      if (req.body[key] !== undefined)
        updates[key] = integer(req.body[key], key, key === "stock" ? 0 : 1);
    if (req.body.active !== undefined) {
      if (typeof req.body.active !== "boolean")
        fail(400, "Active must be true or false.");
      updates.active = req.body.active;
    }
    if (req.body.image !== undefined) {
      if (
        typeof req.body.image !== "string" ||
        (req.body.image &&
          !/^https:\/\/res\.cloudinary\.com\//.test(req.body.image) &&
          !/^\/images\/drinks\/[a-z0-9.-]+$/.test(req.body.image))
      )
        fail(400, "Use an uploaded product image.");
      updates.image = req.body.image;
    }
    if (updates.servingSize) {
      updates.variantKey = updates.servingSize;
      updates.variantLabel = updates.servingSize;
    }
    if (!Object.keys(updates).length)
      fail(400, "No supported changes provided.");
    res.json(
      transaction(() => {
        Object.assign(p, updates);
        audit(req.user, "product.updated", p.id, Object.keys(updates));
        return p;
      }),
    );
  });
  router.patch("/suppliers/:id", (req, res) => {
    const s = getState().suppliers.find((s) => s.id === req.params.id);
    if (!s) fail(404, "Dealer not found.");
    const updates = {};
    for (const key of ["name", "location", "address", "description"])
      if (req.body[key] !== undefined)
        updates[key] = text(
          req.body[key],
          key,
          key === "description" ? 1000 : 500,
        );
    for (const key of ["latitude", "longitude"])
      if (req.body[key] !== undefined) {
        const value = Number(req.body[key]);
        const bound = key === "latitude" ? 90 : 180;
        if (!Number.isFinite(value) || value < -bound || value > bound)
          fail(400, "Enter valid coordinates.");
        updates[key] = value;
      }
    res.json(
      transaction(() => {
        Object.assign(s, updates);
        audit(req.user, "dealer.updated", s.id, Object.keys(updates));
        return s;
      }),
    );
  });
  router.patch("/orders/:id", (req, res) => {
    const db = getState(),
      o = db.orders.find((o) => o.id === req.params.id);
    if (!o) fail(404, "Order not found.");
    const allowed = {
      pending: ["confirmed", "cancelled"],
      confirmed: ["shipped", "cancelled"],
      shipped: ["delivered"],
    };
    if (!allowed[o.status]?.includes(req.body.status))
      fail(409, "This order transition is not allowed.");
    if (req.body.status === "cancelled" && o.paymentStatus === "paid")
      fail(409, "A paid order needs refund reconciliation first.");
    res.json(
      transaction(() => {
        o.history ||= [{ status: o.status, at: o.createdAt }];
        o.history.push({
          status: req.body.status,
          at: new Date().toISOString(),
        });
        o.status = req.body.status;
        o.updatedAt = new Date().toISOString();
        if (o.status === "cancelled")
          for (const item of o.items) {
            const p = db.products.find((p) => p.id === item.productId);
            if (p) p.stock += item.quantity;
          }
        audit(req.user, "order.status", o.id, ["status"]);
        return o;
      }),
    );
  });
  router.patch("/users/:id", (req, res) => {
    const u = getState().users.find((u) => u.id === req.params.id);
    if (!u) fail(404, "Account not found.");
    if (isAdminIdentity(u))
      fail(409, "An administrator cannot be suspended here.");
    if (typeof req.body.suspended !== "boolean")
      fail(400, "Choose an account status.");
    res.json(
      transaction(() => {
        u.suspended = req.body.suspended;
        audit(req.user, "account.status", u.id, ["suspended"]);
        return { id: u.id, suspended: u.suspended };
      }),
    );
  });
  router.post("/notes", (req, res) => {
    if (!getState().users.some((u) => u.id === req.body.userId))
      fail(404, "Contact not found.");
    const body = text(req.body.text, "Note", 2000);
    res.status(201).json(
      transaction(() => {
        const db = getState();
        db.crmNotes ||= [];
        const note = {
          id: randomUUID(),
          userId: req.body.userId,
          text: body,
          author: req.user.name,
          createdAt: new Date().toISOString(),
        };
        db.crmNotes.push(note);
        audit(req.user, "crm.note.created", note.userId);
        return note;
      }),
    );
  });
  router.patch("/content", (req, res) => {
    const content = { ...getState().content };
    for (const key of [
      "announcement",
      "aboutText",
      "contactEmail",
      "supportPhone",
      "footerText",
    ])
      if (req.body[key] !== undefined) {
        if (typeof req.body[key] !== "string" || req.body[key].length > 2000)
          fail(400, "Content fields must be text up to 2,000 characters.");
        content[key] = req.body[key].trim();
      }
    if (
      content.contactEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(content.contactEmail)
    )
      fail(400, "Enter a valid contact email.");
    res.json(
      transaction(() => {
        getState().content = content;
        audit(req.user, "cms.updated", "site", Object.keys(req.body));
        return content;
      }),
    );
  });
  return router;
}
module.exports = { createAdminRouter, isAdminIdentity };
