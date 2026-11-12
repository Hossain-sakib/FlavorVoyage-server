/** One-use hosting-operator migration capability. Not a user/admin role bypass. */
const { createHash, timingSafeEqual, randomUUID } = require("node:crypto");
const { getMongoStore } = require("./mongo-store");
const {
  saveSnapshot,
  validateWorkspace,
  unpackWorkspace,
  snapshotStatus,
} = require("./workspace-backups");
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function databaseOperator(
  event,
  {
    control,
    source,
    backups,
    origin,
    activeDriver = "netlify-blobs",
    mongo = getMongoStore,
  },
) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  const reply = (statusCode, data) => ({
    statusCode,
    headers,
    body: JSON.stringify(data),
  });
  try {
    const stored = await control.getWithMetadata("database-operation", {
      type: "json",
      consistency: "strong",
    });
    const token = (
      event.headers?.authorization ||
      event.headers?.Authorization ||
      ""
    ).replace(/^Bearer /, "");
    const provided = Buffer.from(hash(token)),
      expected = Buffer.from(stored?.data.tokenHash || "");
    if (
      event.httpMethod !== "POST" ||
      (event.headers?.origin || event.headers?.Origin) !== origin ||
      !stored ||
      stored.data.used ||
      !Number.isFinite(stored.data.expiresAt) ||
      stored.data.expiresAt <= Date.now() ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      return reply(404, { message: "Endpoint not found." });
    const consumed = await control.setJSON(
      "database-operation",
      { ...stored.data, used: true },
      { onlyIfMatch: stored.etag },
    );
    if (!consumed.modified)
      return reply(404, { message: "Endpoint not found." });
    const target = await mongo();
    if (stored.data.action === "probe") {
      const current = await target.getWithMetadata("workspace-v1");
      return reply(200, {
        connected: true,
        targetInitialized: Boolean(current),
      });
    }
    const action = stored.data.action;
    if (["status", "backup", "drill", "restore"].includes(action)) {
      if (activeDriver !== "mongodb")
        return reply(409, { message: "MongoDB is not the active datastore." });
      const current = await target.getWithMetadata("workspace-v1");
      if (action === "status")
        return reply(200, {
          ...(await snapshotStatus(backups)),
          workspaceEtag: current?.etag || "missing",
        });
      if (action === "backup") {
        if (!current) return reply(409, { message: "Workspace is missing." });
        return reply(201, await saveSnapshot(backups, current.data));
      }
      if (!/^(daily|manual)\//.test(stored.data.backupKey || ""))
        return reply(400, { message: "Choose a private snapshot key." });
      const restored = unpackWorkspace(
        await backups.get(stored.data.backupKey, { type: "json" }),
      );
      if (action === "drill") {
        const key = "restore-drill-" + randomUUID();
        try {
          await target.setJSON(key, restored, { onlyIfNew: true });
          const checked = await target.getWithMetadata(key);
          const accepted = await target.setJSON(key, restored, {
            onlyIfMatch: checked.etag,
          });
          const stale = await target.setJSON(key, restored, {
            onlyIfMatch: checked.etag,
          });
          if (!accepted.modified || stale.modified)
            throw Error("Conditional write verification failed.");
          if (
            !checked ||
            hash(JSON.stringify(checked.data)) !==
              hash(JSON.stringify(restored))
          )
            throw Error("Restore drill failed.");
        } finally {
          await target.deleteTemporary(key);
        }
        return reply(200, {
          verified: true,
          liveWorkspaceChanged: false,
          conditionalWritesVerified: true,
          sessionsRestored: false,
          products: restored.products.length,
          orders: restored.orders.length,
        });
      }
      const pause = await control.get("write-pause", {
        type: "json",
        consistency: "strong",
      });
      if (!pause?.paused)
        return reply(409, { message: "Pause writes before restoring." });
      if (stored.data.expectedEtag !== (current?.etag || "missing"))
        return reply(409, {
          message: "The workspace revision changed. Restore refused.",
        });
      if (current) await saveSnapshot(backups, current.data);
      restored.auditLog ||= [];
      restored.auditLog.push({
        id: randomUUID(),
        actorId: "hosting-operator",
        actorEmail: "",
        action: "workspace.restored",
        target: stored.data.backupKey,
        fields: [],
        createdAt: new Date().toISOString(),
      });
      const committed = await target.setJSON(
        "workspace-v1",
        restored,
        current ? { onlyIfMatch: current.etag } : { onlyIfNew: true },
      );
      if (!committed.modified)
        return reply(409, { message: "Concurrent change: restore refused." });
      return reply(200, { restored: true, sessionsRestored: false });
    }
    if (activeDriver === "mongodb")
      return reply(409, {
        message:
          "The target is already active. Copying from the old datastore is disabled.",
      });
    if (stored.data.action !== "copy")
      return reply(400, { message: "Unsupported operation." });
    const pause = await control.get("write-pause", {
      type: "json",
      consistency: "strong",
    });
    if (!pause?.paused)
      return reply(409, { message: "Pause workspace writes before copying." });
    const current = await source.getWithMetadata("workspace-v1", {
      type: "json",
      consistency: "strong",
    });
    if (!current)
      return reply(409, { message: "Source workspace is missing." });
    validateWorkspace(current.data);
    const existing = await target.getWithMetadata("workspace-v1");
    const digest = hash(JSON.stringify(current.data));
    if (existing && hash(JSON.stringify(existing.data)) !== digest)
      return reply(409, {
        message:
          "MongoDB already contains a different workspace. No data was overwritten.",
      });
    await saveSnapshot(backups, current.data);
    if (!existing) {
      const copied = await target.setJSON("workspace-v1", current.data, {
        onlyIfNew: true,
      });
      if (!copied.modified)
        return reply(409, {
          message:
            "MongoDB changed concurrently. Retry with a new operator capability.",
        });
    }
    const verified = await target.getWithMetadata("workspace-v1");
    if (!verified || hash(JSON.stringify(verified.data)) !== digest)
      throw Error("Migration verification failed.");
    const sourceAfter = await source.getWithMetadata("workspace-v1", {
      type: "json",
      consistency: "strong",
    });
    if (sourceAfter?.etag !== current.etag)
      return reply(409, {
        message:
          "The source changed during verification. Storage has not been switched.",
      });
    await control.setJSON("migration-last", {
      sourceEtag: current.etag,
      targetEtag: verified.etag,
      checksum: digest,
      verifiedAt: new Date().toISOString(),
      products: verified.data.products.length,
      orders: verified.data.orders.length,
    });
    return reply(200, {
      copied: true,
      verified: true,
      products: verified.data.products.length,
      orders: verified.data.orders.length,
      checksum: digest,
    });
  } catch (error) {
    console.error("Database operator failed:", error.name);
    return reply(503, {
      message: "Database connection or migration failed.",
      errorType: error.name,
      code: error.code || null,
    });
  }
}
module.exports = { databaseOperator };
