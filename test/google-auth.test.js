const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
} = require("jose");
const { createGoogleVerifier, PROJECT_ID } = require("../google-auth");
async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-google-key",
    alg: "RS256",
  };
  const verify = createGoogleVerifier({
    keySet: createLocalJWKSet({ keys: [jwk] }),
  });
  const token = async (
    overrides = {},
    audience = PROJECT_ID,
    expires = "1h",
    key = privateKey,
  ) =>
    new SignJWT({
      email: "google@example.test",
      email_verified: true,
      name: "Google buyer",
      firebase: { sign_in_provider: "google.com" },
      auth_time: Math.floor(Date.now() / 1000),
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setSubject("google-uid-1")
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(key);
  return { verify, token };
}
test("Google identity verifies signature, project, expiry, provider and verified email", async () => {
  const { verify, token } = await fixture();
  const identity = await verify(await token());
  assert.equal(identity.uid, "google-uid-1");
  assert.equal(identity.email, "google@example.test");
  await assert.rejects(verify(await token({}, "other-project")));
  await assert.rejects(verify(await token({}, PROJECT_ID, "-1m")));
  await assert.rejects(verify(await token({ email_verified: false })));
  await assert.rejects(
    verify(await token({ firebase: { sign_in_provider: "password" } })),
  );
  await assert.rejects(
    verify(await token({ auth_time: Date.now() / 1000 + 500 })),
  );
  const wrong = await generateKeyPair("RS256");
  await assert.rejects(
    verify(await token({}, PROJECT_ID, "1h", wrong.privateKey)),
  );
  await assert.rejects(verify("not-a-google-token"));
});
