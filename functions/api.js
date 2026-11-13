const { portfolioSecurityHeaders } = require("../security-headers");
const { getStore, setEnvironmentContext } = require("@netlify/blobs");
const { getMongoStore } = require("../mongo-store");
const { databaseOperator } = require("../database-operator");
const { createCloudHandler } = require("../netlify-handler");

exports.handler = async (event, context) => {
  // The Lambda payload supplies both cached and uncached URLs. Preserve both:
  // the SDK's legacy connectLambda helper currently drops url_uncached.
  if (event.blobs) {
    const blobs = JSON.parse(
      Buffer.from(event.blobs, "base64").toString("utf8"),
    );
    setEnvironmentContext({
      siteID: event.headers["x-nf-site-id"],
      deployID: event.headers["x-nf-deploy-id"],
      edgeURL: blobs.url,
      uncachedEdgeURL: blobs.url_uncached,
      primaryRegion: blobs.primary_region,
      token: blobs.token,
    });
  }
  const store = getStore({
    name: "flavor-voyage-workspace",
    consistency: "strong",
  });
  const origin = process.env.APP_ORIGIN || "https://flavor-voyage.netlify.app";
  const backups = getStore({
    name: "flavor-voyage-backups",
    consistency: "strong",
  });
  const control = getStore({
    name: "flavor-voyage-controls",
    consistency: "strong",
  });
  if ((event.path || "").endsWith("/api/operator/database"))
    return databaseOperator(event, {
      control,
      source: store,
      backups,
      origin,
      activeDriver: process.env.DATABASE_DRIVER || "netlify-blobs",
    });
  const storageLabel =
    process.env.DATABASE_DRIVER === "mongodb" ? "mongodb" : "netlify-blobs";
  let workspace;
  try {
    workspace = storageLabel === "mongodb" ? await getMongoStore() : store;
  } catch (error) {
    console.error("Workspace connection failed:", error.name);
    return {
      statusCode: 503,
      headers: portfolioSecurityHeaders({
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      }),
      body: JSON.stringify({
        message: "The workspace database is temporarily unavailable.",
      }),
    };
  }
  return createCloudHandler({
    store: workspace,
    storageLabel,
    migrationControlStore: control,
    backupStore: backups,
    origin,
    requireExistingStore: true,
    demo: process.env.ENABLE_DEMO === "true",
  })(event, context);
};
