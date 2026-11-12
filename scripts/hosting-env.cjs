/** Private operator configuration; values are never printed. */
async function hostingEnv() {
  if (!process.env.NETLIFY_AUTH_TOKEN)
    throw Error("NETLIFY_AUTH_TOKEN is required.");
  const response = await fetch(
    "https://api.netlify.com/api/v1/accounts/64e198e512dded32e7ff066a/env?site_id=ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf",
    { headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}` } },
  );
  if (!response.ok) throw Error("Unable to read hosting configuration.");
  const rows = await response.json();
  return Object.fromEntries(
    rows.map((row) => [
      row.key,
      (
        row.values.find((v) => v.context === "production") ||
        row.values.find((v) => v.context === "all")
      )?.value,
    ]),
  );
}
module.exports = { hostingEnv };
