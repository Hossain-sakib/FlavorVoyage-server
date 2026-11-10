const express = require("express");
const multer = require("multer");
const { randomUUID, createHash } = require("node:crypto");
const { isAdminIdentity } = require("./admin-api");
const MAX_BYTES = 3 * 1024 * 1024;
const httpError = (status, message) =>
  Object.assign(new Error(message), { status });
function cloudinaryConfig() {
  try {
    if (process.env.CLOUDINARY_URL) {
      const u = new URL(process.env.CLOUDINARY_URL);
      if (u.protocol !== "cloudinary:") return null;
      return {
        name: u.hostname,
        key: decodeURIComponent(u.username),
        secret: decodeURIComponent(u.password),
      };
    }
    const {
      CLOUDINARY_CLOUD_NAME: name,
      CLOUDINARY_API_KEY: key,
      CLOUDINARY_API_SECRET: secret,
    } = process.env;
    return name && key && secret ? { name, key, secret } : null;
  } catch {
    return null;
  }
}
function imageType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", ext: "png" };
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return { mime: "image/jpeg", ext: "jpg" };
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  return null;
}
async function uploadToCloudinary(file, type) {
  const config = cloudinaryConfig();
  if (
    !config ||
    !config.key ||
    !config.secret ||
    !/^[a-z0-9_-]+$/i.test(config.name)
  )
    throw httpError(
      503,
      "Image uploads are not configured yet. The site owner must set CLOUDINARY_URL in hosting settings.",
    );
  const params = {
    allowed_formats: "jpg,png,webp",
    folder: "flavorvoyage/products",
    public_id: randomUUID(),
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signed = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const data = new FormData();
  for (const [key, value] of Object.entries(params)) data.append(key, value);
  data.append("api_key", config.key);
  data.append(
    "signature",
    createHash("sha1")
      .update(signed + config.secret)
      .digest("hex"),
  );
  data.append(
    "file",
    new Blob([file.buffer], { type: type.mime }),
    `${params.public_id}.${type.ext}`,
  );
  let response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${config.name}/image/upload`,
      { method: "POST", body: data, signal: AbortSignal.timeout(20000) },
    );
  } catch {
    throw httpError(
      503,
      "Image storage could not be reached. Please try again.",
    );
  }
  const result = await response.json().catch(() => null);
  if (
    !response.ok ||
    !result?.secure_url?.startsWith(
      `https://res.cloudinary.com/${config.name}/image/upload/`,
    )
  )
    throw httpError(
      503,
      "Cloudinary could not save the image. Ask the site owner to verify the image-storage configuration.",
    );
  return {
    id: result.public_id,
    url: result.secure_url,
    type: type.mime,
    bytes: file.size,
  };
}
function createMediaRouter({
  auth,
  uploadImage = uploadToCloudinary,
  rateLimit = (req, res, next) => next(),
}) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 0 },
  });
  router.get("/status", auth, (req, res) =>
    res.json({
      configured: Boolean(cloudinaryConfig()),
      provider: "cloudinary",
      maxBytes: MAX_BYTES,
      types: ["image/jpeg", "image/png", "image/webp"],
    }),
  );
  router.post("/", auth, rateLimit, (req, res, next) => {
    if (
      req.user.role !== "supplier" &&
      !(isAdminIdentity(req.user) && req.authProvider === "google")
    )
      return next(
        httpError(
          403,
          "Only dealers and administrators can upload catalog images.",
        ),
      );
    upload.single("file")(req, res, async (error) => {
      if (error)
        return next(
          httpError(
            400,
            error.code === "LIMIT_FILE_SIZE"
              ? "Choose an image smaller than 3 MB."
              : "Upload one image file only.",
          ),
        );
      if (!req.file)
        return next(httpError(400, "Choose a JPEG, PNG or WebP image."));
      const type = imageType(req.file.buffer);
      if (!type)
        return next(
          httpError(
            400,
            "Only JPEG, PNG and WebP images are allowed. SVG and executable files are not accepted.",
          ),
        );
      try {
        res.status(201).json(await uploadImage(req.file, type));
      } catch (error) {
        next(
          error.status
            ? error
            : httpError(503, "Image upload failed. Please try again."),
        );
      }
    });
  });
  return router;
}
module.exports = { createMediaRouter, imageType, MAX_BYTES };
