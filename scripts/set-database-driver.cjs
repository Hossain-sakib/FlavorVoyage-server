/** Activate only after a paused, checksummed migration has been verified. */
(async () => {
  const driver = process.argv[2];
  if (!["mongodb", "netlify-blobs"].includes(driver))
    throw Error("Choose mongodb or netlify-blobs.");
  const base =
      "https://api.netlify.com/api/v1/accounts/64e198e512dded32e7ff066a/env",
    query = "?site_id=ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf";
  const headers = {
    Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(base + query, { headers });
  if (!response.ok) throw Error("Hosting configuration unavailable.");
  const rows = await response.json();
  const existing = rows.find((row) => row.key === "DATABASE_DRIVER");
  const body = {
    key: "DATABASE_DRIVER",
    values: [{ context: "all", value: driver }],
  };
  const result = await fetch(
    base + (existing ? "/DATABASE_DRIVER" : "") + query,
    {
      method: existing ? "PUT" : "POST",
      headers,
      body: JSON.stringify(existing ? body : [body]),
    },
  );
  if (!result.ok)
    throw Error("Unable to set database driver (HTTP " + result.status + ").");
  console.log(
    JSON.stringify({ configuredDriver: driver, redeployRequired: true }),
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
