const PORTFOLIO_ORIGIN = "https://sakib-studio.netlify.app";
/** Preserve existing directives while applying the single permitted ancestor. */
function portfolioSecurityHeaders(headers = {}) {
  const result = { ...headers },
    policies = [];
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "content-security-policy") {
      policies.push(String(result[key] || ""));
      delete result[key];
    } else if (key.toLowerCase() === "x-frame-options") delete result[key];
  }
  const directives = policies
    .join(";")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value && !/^frame-ancestors(?:\s|$)/i.test(value));
  directives.push(`frame-ancestors ${PORTFOLIO_ORIGIN}`);
  result["Content-Security-Policy"] = directives.join("; ") + ";";
  return result;
}
module.exports = { PORTFOLIO_ORIGIN, portfolioSecurityHeaders };
