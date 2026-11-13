const { test } = require("node:test");
const assert = require("node:assert/strict");
const { portfolioSecurityHeaders } = require("../security-headers");
const { createApp } = require("../app");
test("framing overrides preserve other directives and security headers without a conflicting XFO", () => {
  const headers = portfolioSecurityHeaders({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://apis.google.com; frame-ancestors 'none'; upgrade-insecure-requests",
    "x-frame-options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000",
  });
  assert.equal(
    headers["Content-Security-Policy"],
    "default-src 'self'; script-src 'self' https://apis.google.com; upgrade-insecure-requests; frame-ancestors https://sakib-studio.netlify.app;",
  );
  assert.ok(
    !Object.keys(headers).some(
      (key) => key.toLowerCase() === "x-frame-options",
    ),
  );
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Strict-Transport-Security"], "max-age=31536000");
});
test("API success and authentication errors carry the portfolio-only framing policy", async (t) => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const path of ["/api/health", "/api/admin/data"]) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
    );
    assert.equal(
      response.headers.get("content-security-policy"),
      "frame-ancestors https://sakib-studio.netlify.app;",
    );
    assert.equal(response.headers.get("x-frame-options"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  const malformed = await fetch(
    `http://127.0.0.1:${server.address().port}/api/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    },
  );
  assert.equal(malformed.status, 400);
  assert.equal(
    malformed.headers.get("content-security-policy"),
    "frame-ancestors https://sakib-studio.netlify.app;",
  );
  assert.equal(malformed.headers.get("x-content-type-options"), "nosniff");
});
