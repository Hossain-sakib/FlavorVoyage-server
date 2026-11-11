const express = require("express");

// Derive activity from owned records; never copy private records into a global feed.
function activityFor(db, user) {
  const owns = (record) =>
    user.role === "supplier"
      ? record.supplierId === user.supplierId
      : record.retailerId === user.id;
  const items = [];
  for (const order of db.orders.filter(owns)) {
    for (const event of order.history || [
      { status: order.status, at: order.createdAt },
    ]) {
      items.push({
        id: `order:${order.id}:${event.status}`,
        title: `Order ${order.reference || order.id.slice(0, 8)} · ${event.status}`,
        description: `${order.items?.length || 0} product lines. View the order for details.`,
        view: "orders",
        createdAt: event.at || order.createdAt,
      });
    }
  }
  for (const quote of (db.quotes || []).filter(owns)) {
    items.push({
      id: `quote:${quote.id}:${quote.status}:${quote.updatedAt || quote.createdAt}`,
      title: `Quote ${quote.reference || quote.id.slice(0, 8)} · ${quote.status}`,
      description: `${quote.items?.length || 0} product lines. Review your negotiation.`,
      view: "quotes",
      createdAt: quote.updatedAt || quote.createdAt,
    });
  }
  for (const thread of db.conversations || []) {
    if (
      user.role === "supplier"
        ? thread.supplierId !== user.supplierId
        : thread.buyerId !== user.id
    )
      continue;
    const incoming = thread.messages
      .filter((m) => m.senderId !== user.id)
      .slice(-20);
    for (const message of incoming)
      items.push({
        id: `message:${message.id}`,
        title: `Message from ${message.senderName || "your trading partner"}`,
        description: "Open your private conversation to read and reply.",
        view: "messages",
        conversationId: thread.id,
        createdAt: message.createdAt,
        alreadyRead: Boolean(message.readAt),
      });
  }
  const read = new Set(db.notificationReads?.[user.id] || []);
  return items
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 50)
    .map(({ alreadyRead, ...item }) => ({
      ...item,
      read: alreadyRead || read.has(item.id),
    }));
}
function createNotificationsRouter({ auth, getState, transaction }) {
  const router = express.Router();
  router.use(auth);
  router.get("/", (req, res) => res.json(activityFor(getState(), req.user)));
  router.post("/read", (req, res) => {
    const { ids } = req.body;
    if (
      !Array.isArray(ids) ||
      ids.length > 50 ||
      ids.some((id) => typeof id !== "string" || id.length > 180)
    )
      return res
        .status(400)
        .json({ message: "Provide up to 50 notification IDs." });
    const owned = new Set(
      activityFor(getState(), req.user).map((item) => item.id),
    );
    if (ids.some((id) => !owned.has(id)))
      return res.status(404).json({ message: "Notification not found." });
    res.json(
      transaction(() => {
        const db = getState();
        db.notificationReads ||= {};
        db.notificationReads[req.user.id] = [
          ...new Set([...(db.notificationReads[req.user.id] || []), ...ids]),
        ].slice(-500);
        return activityFor(db, req.user);
      }),
    );
  });
  return router;
}
module.exports = { createNotificationsRouter, activityFor };
