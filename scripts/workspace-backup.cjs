/** Private operator tool. Never prints workspace contents or credentials. */
const { getStore } = require("@netlify/blobs");
const {
  saveSnapshot,
  snapshotStatus,
  unpackWorkspace,
} = require("../workspace-backups");
(async () => {
  if (!process.env.NETLIFY_AUTH_TOKEN)
    throw Error("NETLIFY_AUTH_TOKEN is required.");
  const options = {
    siteID: "ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf",
    token: process.env.NETLIFY_AUTH_TOKEN,
    consistency: "strong",
  };
  const live = getStore({ ...options, name: "flavor-voyage-workspace" });
  const backups = getStore({ ...options, name: "flavor-voyage-backups" });
  const [command, key, expectedEtag] = process.argv.slice(2);
  const { hostingEnv } = require("./hosting-env.cjs");
  const env = await hostingEnv();
  if (
    env.DATABASE_DRIVER === "mongodb" &&
    ["create", "list", "drill", "restore"].includes(command)
  ) {
    const { runDatabaseOperation } = require("./database-operation.cjs");
    console.log(
      JSON.stringify(
        await runDatabaseOperation(
          {
            create: "backup",
            list: "status",
            drill: "drill",
            restore: "restore",
          }[command],
          { backupKey: key, expectedEtag },
        ),
      ),
    );
    return;
  }
  const current = await live.getWithMetadata("workspace-v1", { type: "json" });
  if (command === "list")
    return console.log(
      JSON.stringify({
        ...(await snapshotStatus(backups)),
        workspaceEtag: current?.etag || "missing",
      }),
    );
  if (!current && command === "create") throw Error("Workspace is missing.");
  if (command === "create")
    return console.log(
      JSON.stringify(await saveSnapshot(backups, current.data)),
    );
  if (
    !["verify", "drill", "restore"].includes(command) ||
    !/^(daily|manual)\//.test(key || "")
  )
    throw Error(
      "Use create, list, verify KEY, drill KEY, or restore KEY EXPECTED_ETAG.",
    );
  const snapshot = await backups.get(key, { type: "json" });
  const restored = unpackWorkspace(snapshot);
  if (command === "restore") {
    if (!expectedEtag || expectedEtag !== (current?.etag || "missing"))
      throw Error(
        "Expected ETag must match the current workspace version. Inspect privately before restoring.",
      );
    if (current) await saveSnapshot(backups, current.data);
    const result = await live.setJSON("workspace-v1", restored, {
      ...(current ? { onlyIfMatch: current.etag } : { onlyIfNew: true }),
    });
    if (!result.modified) throw Error("Concurrent change: restore refused.");
  } else if (command === "drill") {
    const drill = `restore-drills/${Date.now()}`;
    await backups.setJSON(drill, restored, { onlyIfNew: true });
    const roundtrip = await backups.get(drill, { type: "json" });
    if (JSON.stringify(roundtrip) !== JSON.stringify(restored))
      throw Error("Restore drill roundtrip failed.");
    await backups.delete(drill);
  }
  console.log(
    JSON.stringify({
      command,
      verified: true,
      products: restored.products.length,
      orders: restored.orders.length,
      sessionsRestored: false,
    }),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
