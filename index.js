require("dotenv").config();
const path = require("node:path");
const { createApp } = require("./app");
const production = process.env.NODE_ENV === "production";
if (
  production &&
  (!process.env.DATA_FILE || !process.env.APP_ORIGIN?.startsWith("https://"))
) {
  throw new Error(
    "Production requires a persistent DATA_FILE path and an HTTPS APP_ORIGIN. Use a single long-running server; serverless deployment is not supported by the local-file adapter.",
  );
}
const app = createApp({
  dataFile:
    process.env.DATA_FILE || path.join(__dirname, ".data", "store.json"),
  demo: !production && process.env.ENABLE_DEMO !== "false",
  secure: production,
  origin: process.env.APP_ORIGIN || "http://localhost:5173",
});
if (require.main === module)
  app.listen(process.env.PORT || 5002, "0.0.0.0", () =>
    console.log(`FlavorVoyage API listening on ${process.env.PORT || 5002}`),
  );
module.exports = app;
