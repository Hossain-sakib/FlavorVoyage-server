const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createMediaRouter, imageType, MAX_BYTES } = require("../media-api");
test("Cloudinary upload accepts only authenticated dealer images and keeps secrets server-side", async (t) => {
  const app = express();
  let uploaded = 0;
  const auth = (req, res, next) => {
    if (!req.get("x-test-role"))
      return res.status(401).json({ message: "Sign in" });
    req.user = { id: "test", role: req.get("x-test-role") };
    next();
  };
  app.use(
    "/media",
    createMediaRouter({
      auth,
      uploadImage: async (file, type) => {
        uploaded++;
        return {
          url: "https://res.cloudinary.com/test/image/upload/example.png",
          type: type.mime,
          bytes: file.size,
        };
      },
    }),
  );
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ message: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/media`;
  async function post(bytes, role) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/png" }), "photo.png");
    const r = await fetch(base, {
      method: "POST",
      headers: role ? { "x-test-role": role } : {},
      body: form,
    });
    return { status: r.status, data: await r.json() };
  }
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  assert.equal((await post(png)).status, 401);
  assert.equal((await post(png, "retailer")).status, 403);
  assert.equal(
    (await post(Buffer.from("<svg onload='alert(1)'></svg>"), "supplier"))
      .status,
    400,
  );
  assert.equal(
    (await post(Buffer.alloc(MAX_BYTES + 1), "supplier")).status,
    400,
  );
  const saved = await post(png, "supplier");
  assert.equal(saved.status, 201);
  assert.equal(uploaded, 1);
  assert.equal(saved.data.type, "image/png");
  assert.equal(saved.data.secret, undefined);
  assert.equal(imageType(Buffer.from("not an image")), null);
});
