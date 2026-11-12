const { operatorMongoClient } = require("./mongo-client.cjs");
const { hostingEnv } = require("./hosting-env.cjs");
(async () => {
  const env = await hostingEnv();
  if (!env.MONGODB_URI)
    throw Error(
      "MONGODB_URI is missing from production hosting configuration.",
    );
  const client = await operatorMongoClient(env);
  try {
    await client.connect();
    await client.db(env.MONGODB_DB || undefined).command({ ping: 1 });
    console.log(JSON.stringify({ connected: true }));
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(
    JSON.stringify({
      connected: false,
      errorType: error.name,
      code: error.code || null,
    }),
  );
  process.exitCode = 1;
});
