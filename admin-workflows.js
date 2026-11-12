const { randomUUID } = require("node:crypto");
const DAY = 86400000;
function dayBounds(value, label) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value || "") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    const e = Error(`Choose a valid ${label} date.`);
    e.status = 400;
    throw e;
  }
  return Date.parse(`${value}T00:00:00+06:00`);
}
function reportFor(db, query = {}, now = Date.now()) {
  const end =
    query.to || new Date(now + 6 * 3600000).toISOString().slice(0, 10);
  const start =
    query.from ||
    new Date(now - 29 * DAY + 6 * 3600000).toISOString().slice(0, 10);
  const from = dayBounds(start, "start"),
    until = dayBounds(end, "end") + DAY;
  if (until <= from || until - from > 366 * DAY) {
    const e = Error("Choose a date range of up to 366 days.");
    e.status = 400;
    throw e;
  }
  const includeDemo = query.includeDemo === "true";
  const sample = (o) =>
    db.users.some((u) => u.id === o.retailerId && u.demo) ||
    db.suppliers.some((s) => s.id === o.supplierId && s.demoShop);
  const orders = db.orders.filter(
    (o) =>
      Date.parse(o.createdAt) >= from &&
      Date.parse(o.createdAt) < until &&
      (includeDemo || !sample(o)),
  );
  const active = orders.filter((o) => o.status !== "cancelled");
  const daily = [],
    dealers = new Map(),
    products = new Map();
  for (let date = from; date < until; date += DAY) {
    const rows = active.filter(
      (o) =>
        Date.parse(o.createdAt) >= date && Date.parse(o.createdAt) < date + DAY,
    );
    daily.push({
      date: new Date(date + 6 * 3600000).toISOString().slice(0, 10),
      orders: rows.length,
      value: rows.reduce((n, o) => n + o.total, 0),
    });
  }
  for (const order of active) {
    const group = dealers.get(order.supplierId) || {
      id: order.supplierId,
      name: order.supplierName || "Dealer",
      orders: 0,
      value: 0,
    };
    group.orders++;
    group.value += order.total;
    dealers.set(group.id, group);
    for (const line of order.items || []) {
      const product = products.get(line.productId) || {
        id: line.productId,
        name: line.name,
        cases: 0,
        value: 0,
      };
      product.cases += line.quantity;
      product.value += line.quantity * line.price;
      products.set(product.id, product);
    }
  }
  return {
    from: start,
    to: end,
    timezone: "Asia/Dhaka",
    includeDemo,
    summary: {
      orders: orders.length,
      orderValue: active.reduce((n, o) => n + o.total, 0),
      deliveredValue: active
        .filter((o) => o.status === "delivered")
        .reduce((n, o) => n + o.total, 0),
      openOrders: active.filter((o) => o.status !== "delivered").length,
      cancelled: orders.length - active.length,
      cases: active.reduce(
        (n, o) => n + (o.items || []).reduce((v, l) => v + l.quantity, 0),
        0,
      ),
    },
    daily,
    dealers: [...dealers.values()].sort((a, b) => b.value - a.value),
    products: [...products.values()]
      .sort((a, b) => b.cases - a.cases)
      .slice(0, 20),
    orders,
  };
}
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function csv(rows) {
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
function registerAdminWorkflows({
  router,
  getState,
  transaction,
  fail,
  text,
  audit,
  operations,
  demo,
  storageLabel,
}) {
  router.get("/reports", (req, res) => {
    const { orders, ...report } = reportFor(getState(), req.query);
    res.json(report);
  });
  router.get("/exports/:type", (req, res) => {
    const db = getState();
    let rows;
    if (req.params.type === "orders")
      rows = [
        [
          "Reference",
          "Created",
          "Buyer",
          "Dealer",
          "Status",
          "Cases",
          "Order value (BDT)",
        ],
        ...reportFor(db, req.query).orders.map((o) => [
          o.reference,
          o.createdAt,
          o.retailerName,
          o.supplierName,
          o.status,
          (o.items || []).reduce((n, l) => n + l.quantity, 0),
          o.total,
        ]),
      ];
    else if (req.params.type === "inventory")
      rows = [
        [
          "ID",
          "Product",
          "Company",
          "Pack",
          "Dealer",
          "Stock (cases)",
          "Minimum cases",
          "Case price (BDT)",
          "Active",
        ],
        ...db.products.map((p) => [
          p.id,
          p.name,
          p.company || p.brand,
          p.pack,
          db.suppliers.find((s) => s.id === p.supplierId)?.name,
          p.stock,
          p.moq,
          p.price,
          p.active,
        ]),
      ];
    else if (req.params.type === "contacts")
      rows = [
        ["Business", "Name", "Email", "Role", "Suspended"],
        ...db.users
          .filter((u) => !u.demo)
          .map((u) => [
            u.business,
            u.name,
            u.email,
            u.role,
            Boolean(u.suspended),
          ]),
      ];
    else return fail(404, "Choose orders, inventory or contacts.");
    res
      .type("text/csv")
      .attachment(`flavorvoyage-${req.params.type}.csv`)
      .send(csv(rows));
  });
  router.get("/tasks", (req, res) => res.json(getState().crmTasks || []));
  router.post("/tasks", (req, res) => {
    const title = text(req.body.title, "Task title", 200),
      note = req.body.note ? text(req.body.note, "Task note", 2000) : "";
    dayBounds(req.body.dueDate, "due");
    const userId = req.body.userId || "";
    if (userId && !getState().users.some((u) => u.id === userId))
      fail(404, "Contact not found.");
    res.status(201).json(
      transaction(() => {
        const db = getState();
        db.crmTasks ||= [];
        if (db.crmTasks.length >= 10000) fail(409, "Task limit reached.");
        const task = {
          id: randomUUID(),
          title,
          note,
          userId,
          dueDate: req.body.dueDate,
          status: "open",
          author: req.user.name,
          createdAt: new Date().toISOString(),
        };
        db.crmTasks.push(task);
        audit(req.user, "crm.task.created", task.id);
        return task;
      }),
    );
  });
  router.patch("/tasks/:id", (req, res) => {
    const task = (getState().crmTasks || []).find(
      (t) => t.id === req.params.id,
    );
    if (!task) fail(404, "Task not found.");
    if (!["open", "done"].includes(req.body.status))
      fail(400, "Choose open or done.");
    res.json(
      transaction(() => {
        task.status = req.body.status;
        task.updatedAt = new Date().toISOString();
        audit(req.user, "crm.task.status", task.id, ["status"]);
        return task;
      }),
    );
  });
  router.get("/operations", async (req, res, next) => {
    try {
      const db = getState();
      const backups = operations
        ? await operations.status()
        : { enabled: false };
      res.json({
        checkedAt: new Date().toISOString(),
        storage: storageLabel || "local-file",
        demoEnabled: demo,
        paymentsEnabled: false,
        backups,
        checks: [
          { label: "Workspace available", ok: true },
          {
            label: "Unique listing IDs",
            ok:
              new Set(db.products.map((p) => p.id)).size === db.products.length,
          },
          {
            label: "Inventory values valid",
            ok: db.products.every(
              (p) =>
                Number.isSafeInteger(p.stock) &&
                p.stock >= 0 &&
                Number.isSafeInteger(p.price) &&
                p.price > 0,
            ),
          },
          {
            label: "Active listings have images",
            ok: db.products
              .filter((p) => p.active)
              .every((p) => Boolean(p.image)),
          },
          { label: "Private backups configured", ok: backups.enabled },
        ],
      });
    } catch (e) {
      next(e);
    }
  });
  router.post("/backups", async (req, res, next) => {
    try {
      if (!operations)
        return fail(503, "Backups are only available on the hosted adapter.");
      const result = await operations.create(getState());
      transaction(() =>
        audit(req.user, "workspace.backup.created", result.key),
      );
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });
}
module.exports = { registerAdminWorkflows, reportFor, csv, dayBounds };
