const { createRemoteJWKSet, jwtVerify } = require("jose");
const PROJECT_ID = "flavour-voyage";
const googleKeys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);
function createGoogleVerifier({
  keySet = googleKeys,
  projectId = PROJECT_ID,
} = {}) {
  return async function verifyGoogleToken(token) {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "auth_time"],
      maxTokenAge: "1h",
      clockTolerance: 5,
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 128 ||
      !Number.isFinite(payload.auth_time) ||
      payload.auth_time > Date.now() / 1000 + 5 ||
      payload.email_verified !== true ||
      typeof payload.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
      payload.firebase?.sign_in_provider !== "google.com"
    ) {
      const error = new Error("A verified Google account is required.");
      error.code = "INVALID_GOOGLE_IDENTITY";
      throw error;
    }
    return {
      uid: payload.sub,
      email: payload.email.toLowerCase(),
      name: typeof payload.name === "string" ? payload.name.slice(0, 160) : "",
    };
  };
}
module.exports = {
  createGoogleVerifier,
  verifyGoogleToken: createGoogleVerifier(),
  PROJECT_ID,
};
