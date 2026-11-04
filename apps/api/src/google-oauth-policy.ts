const identityScopes = new Set(["openid", "email", "profile"]);

// Keep the consented permissions explicit even if provider defaults change.
export function googleOAuthProviderPolicy() {
  return {
    disableDefaultScope: true,
    scope: ["openid", "email", "profile"],
    includeGrantedScopes: false,
  };
}

// Applied to every POST through the auth bridge, including signin/link route
// variants. Other providers retain Better Auth's own validation.
export function googleOAuthRequestAllowed(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return true;
  const request = body as Record<string, unknown>;
  if (request.provider !== "google") return true;
  if (
    request.scopes !== undefined &&
    (!Array.isArray(request.scopes) ||
      request.scopes.length > 3 ||
      !request.scopes.every(
        (scope) => typeof scope === "string" && identityScopes.has(scope),
      ))
  )
    return false;
  // The product does not use extra Google authorization parameters. Refuse
  // include_granted_scopes/access_type and unknown future expansion inputs.
  if (request.additionalParams !== undefined) {
    const params = request.additionalParams;
    if (
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      Object.keys(params).length !== 0
    )
      return false;
  }
  return true;
}
