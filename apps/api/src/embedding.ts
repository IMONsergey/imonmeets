/** Exact origins only: this value is emitted into a CSP response header. */
export function parseEmbedAllowedOrigins(
  value = "",
  production = false,
): string[] {
  if (!value.trim()) return [];
  const values = value.split(",").map((origin) => origin.trim());
  if (values.length > 20)
    throw new Error("EMBED_ALLOWED_ORIGINS accepts at most 20 exact origins");
  const origins = values.map((value) => {
    try {
      if (!value || value.length > 255 || /[\s*]/.test(value))
        throw new Error();
      const url = new URL(value);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        url.hostname,
      );
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !(
          url.protocol === "https:" ||
          (!production && url.protocol === "http:" && loopback)
        )
      )
        throw new Error();
      return url.origin;
    } catch {
      // Do not reflect untrusted header syntax in an operational error.
      throw new Error(
        "EMBED_ALLOWED_ORIGINS must contain exact HTTPS origins without paths or wildcards (loopback HTTP is development-only)",
      );
    }
  });
  return [...new Set(origins)];
}

export function isEmbedPath(path: string): boolean {
  return /^\/embed\/[A-Za-z0-9_-]{16,128}\/?$/.test(path);
}

export function framePolicy(path: string, allowedOrigins: readonly string[]) {
  const enabled = isEmbedPath(path) && allowedOrigins.length > 0;
  return {
    enabled,
    policy: `frame-ancestors ${enabled ? allowedOrigins.join(" ") : "'none'"}; object-src 'none'; base-uri 'self'`,
  };
}
