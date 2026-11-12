const { getStore } = require("@netlify/blobs");
const { randomBytes, createHash } = require("node:crypto");
async function runDatabaseOperation(
  action,
  {
    target = "https://flavor-voyage.netlify.app",
    backupKey,
    expectedEtag,
  } = {},
) {
  const parsed = new URL(target);
  if (
    parsed.protocol !== "https:" ||
    !(
      parsed.hostname === "flavor-voyage.netlify.app" ||
      parsed.hostname.endsWith("--flavor-voyage.netlify.app")
    )
  )
    throw Error("Use the FlavorVoyage production or draft URL.");
  const control = getStore({
    name: "flavor-voyage-controls",
    siteID: "ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf",
    token: process.env.NETLIFY_AUTH_TOKEN,
    consistency: "strong",
  });
  if (["pause", "resume"].includes(action)) {
    const health = await fetch(target + "/api/health");
    const result = await health.json();
    if (!result.migrationReady)
      throw Error("Deploy the migration-aware adapter first.");
    await control.setJSON("write-pause", {
      paused: action === "pause",
      updatedAt: new Date().toISOString(),
    });
    return { writesPaused: action === "pause" };
  }
  if (
    !["probe", "copy", "status", "backup", "drill", "restore"].includes(action)
  )
    throw Error("Unsupported operator operation.");
  if (["copy", "restore"].includes(action)) {
    const pause = await control.get("write-pause", { type: "json" });
    if (!pause?.paused) throw Error("Pause workspace writes first.");
    const delay = Math.max(
      0,
      30000 - (Date.now() - Date.parse(pause.updatedAt)),
    );
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const token = randomBytes(32).toString("hex");
  await control.setJSON("database-operation", {
    action,
    ...(backupKey ? { backupKey } : {}),
    ...(expectedEtag ? { expectedEtag } : {}),
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: Date.now() + 600000,
    used: false,
  });
  const response = await fetch(target + "/api/operator/database", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Origin: "https://flavor-voyage.netlify.app",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      `Database operation failed (${response.status}): ${result.message || "Please check hosting logs."}`,
    );
  return { status: response.status, ...result };
}
module.exports = { runDatabaseOperation };
if (require.main === module)
  runDatabaseOperation(process.argv[2], { target: process.argv[3] })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        error.message.includes("mongodb://") ||
          error.message.includes("mongodb+srv://")
          ? "Database operation failed."
          : error.message,
      );
      process.exitCode = 1;
    });
