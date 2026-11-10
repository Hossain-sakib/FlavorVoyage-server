const serverless = require("serverless-http");
const { createApp } = require("./app");

// A single versioned document is intentionally used for this low-volume test app.
// Every write includes the ETag read before validation, so concurrent invocations
// cannot oversell stock, lose orders, or overwrite another session's changes.
function createCloudHandler({
  store,
  origin,
  demo = false,
  verifyGoogleToken,
  initialState,
  requireExistingStore = false,
}) {
  return async function handler(event, context = {}) {
    context.callbackWaitsForEmptyEventLoop = false;
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };
    try {
      const request = {
        ...event,
        path:
          (event.path || "/").replace(
            /^\/\.netlify\/functions\/api(?=\/|$)/,
            "",
          ) || "/api/health",
      };
      for (let attempt = 0; attempt < 4; attempt++) {
        const stored = await store.getWithMetadata("workspace-v1", {
          type: "json",
          consistency: "strong",
        });
        if (!stored && requireExistingStore)
          return {
            statusCode: 503,
            headers,
            body: JSON.stringify({
              message:
                "The workspace database is unavailable. Contact site support.",
            }),
          };
        const app = createApp({
          initialState: stored?.data || initialState,
          verifyGoogleToken,
          origin,
          secure: true,
          demo,
          storageLabel: "netlify-blobs",
          trustedNetlifyProxy: true,
        });
        const before = stored ? JSON.stringify(stored.data) : null;
        const response = await serverless(app)(request, context);
        const next = app.exportState();
        // Read-only requests need no write. Initial seeding is committed once.
        if (stored && JSON.stringify(next) === before) return response;
        const committed = await store.setJSON(
          "workspace-v1",
          next,
          stored ? { onlyIfMatch: stored.etag } : { onlyIfNew: true },
        );
        if (committed.modified) return response;
        // Re-run validation against the winning version, including stock and ownership.
      }
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          message:
            "Your workspace changed during this request. Please refresh and try again.",
        }),
      };
    } catch (error) {
      console.error("Workspace storage request failed:", error.name);
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          message:
            "Workspace storage is temporarily unavailable. Please try again.",
        }),
      };
    }
  };
}
module.exports = { createCloudHandler };
