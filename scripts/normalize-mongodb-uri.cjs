/** Repair URL encoding only; never display credentials or alter the decoded password. */
const { MongoClient } = require("mongodb");
(async () => {
  const endpoint =
    "https://api.netlify.com/api/v1/accounts/64e198e512dded32e7ff066a/env";
  const query = "?site_id=ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf";
  const headers = {
    Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(endpoint + query, { headers });
  if (!response.ok) throw Error("Hosting configuration could not be read.");
  const rows = await response.json();
  const row = rows.find((e) => e.key === "MONGODB_URI");
  const selected =
    row?.values.find((v) => v.context === "production") ||
    row?.values.find((v) => v.context === "all");
  if (!selected?.value) throw Error("Production MONGODB_URI is missing.");
  const uri = selected.value.trim(),
    start = uri.indexOf("://") + 3,
    end = uri.lastIndexOf("@");
  if (start < 3 || end <= start)
    throw Error("URI does not have the expected credential format.");
  const credentials = uri.slice(start, end),
    colon = credentials.indexOf(":");
  if (colon < 1) throw Error("Database username or password is missing.");
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const normalized =
    uri.slice(0, start) +
    encodeURIComponent(decode(credentials.slice(0, colon))) +
    ":" +
    encodeURIComponent(decode(credentials.slice(colon + 1))) +
    uri.slice(end);
  const client = new MongoClient(normalized);
  await client.close();
  if (normalized !== selected.value) {
    const body = {
      key: row.key,
      scopes: row.scopes,
      values: row.values.map((value) => ({
        context: value.context,
        ...(value.context_parameter
          ? { context_parameter: value.context_parameter }
          : {}),
        value: value === selected ? normalized : value.value,
      })),
    };
    if (row.is_secret !== undefined) body.is_secret = row.is_secret;
    const result = await fetch(endpoint + "/MONGODB_URI" + query, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!result.ok)
      throw Error(
        "Hosting configuration update failed with status " + result.status,
      );
  }
  console.log(
    JSON.stringify({
      uriValidated: true,
      credentialEncodingUpdated: normalized !== selected.value,
    }),
  );
})().catch(() => {
  console.error(
    "URI encoding could not be updated; no credential values were printed.",
  );
  process.exitCode = 1;
});
