/** Operator DNS fallback for managed workspaces; TLS verification stays enabled. */
const { MongoClient } = require("mongodb");
async function dnsRecords(name, type) {
  const response = await fetch(
    "https://dns.google/resolve?" + new URLSearchParams({ name, type }),
  );
  if (!response.ok) throw Error("DNS lookup failed.");
  const result = await response.json();
  if (result.Status !== 0) throw Error("Atlas DNS record is unavailable.");
  return result.Answer || [];
}
async function operatorMongoClient(env) {
  const uri = env.MONGODB_URI;
  if (!uri) throw Error("MONGODB_URI is missing.");
  const options = {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 8000,
    maxPoolSize: 2,
  };
  let client = new MongoClient(uri, options);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    if (!["ENOTFOUND", "ESERVFAIL", "ETIMEOUT"].includes(error.code))
      throw error;
  }
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb+srv:")
    throw Error("DNS fallback requires an Atlas SRV connection.");
  const srv = (await dnsRecords("_mongodb._tcp." + parsed.hostname, "SRV"))
    .filter((r) => r.type === 33)
    .map((r) => r.data.trim().split(/\s+/));
  if (
    !srv.length ||
    srv.some((parts) => !parts[3].replace(/\.$/, "").endsWith(".mongodb.net"))
  )
    throw Error("Unexpected Atlas SRV records.");
  const query = new URLSearchParams(parsed.search);
  for (const row of (await dnsRecords(parsed.hostname, "TXT")).filter(
    (r) => r.type === 16,
  ))
    for (const [key, value] of new URLSearchParams(
      row.data.replaceAll('"', ""),
    ))
      if (!query.has(key)) query.set(key, value);
  query.set("tls", "true");
  const hosts = srv
    .map((parts) => parts[3].replace(/\.$/, "") + ":" + parts[2])
    .join(",");
  const standard = `mongodb://${parsed.username}:${parsed.password}@${hosts}${parsed.pathname}?${query}`;
  const lookup = (hostname, lookupOptions, callback) => {
    dnsRecords(hostname, "A")
      .then((rows) => {
        const addresses = rows
          .filter((r) => r.type === 1)
          .map((r) => ({ address: r.data, family: 4 }));
        if (!addresses.length) throw Error("No Atlas address found.");
        if (lookupOptions?.all) callback(null, addresses);
        else callback(null, addresses[0].address, 4);
      })
      .catch(callback);
  };
  client = new MongoClient(standard, { ...options, lookup });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
module.exports = { operatorMongoClient };
