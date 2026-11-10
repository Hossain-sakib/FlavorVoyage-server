const { getStore, setEnvironmentContext } = require("@netlify/blobs");
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
  return createCloudHandler({
    store,
    origin,
    requireExistingStore: true,
    demo: process.env.ENABLE_DEMO === "true",
  })(event, context);
};
