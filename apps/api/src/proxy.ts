import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

type ProxyRequest = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
};

export function proxySecretMatches(
  request: ProxyRequest,
  configuredSecret: string | undefined,
) {
  if (!configuredSecret) return false;
  const supplied = request.headers["x-imon-proxy-secret"];
  if (typeof supplied !== "string") return false;
  const expected = Buffer.from(configuredSecret);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function clientIp(
  request: ProxyRequest,
  configuredSecret: string | undefined,
) {
  // Vercel external rewrites overwrite X-Forwarded-For with the visitor IP.
  // Authenticate that proxy before considering the header. Never accept a chain,
  // port, zone identifier or alternate user-controlled forwarding header.
  if (proxySecretMatches(request, configuredSecret)) {
    const forwarded = request.headers["x-forwarded-for"];
    if (
      typeof forwarded === "string" &&
      !forwarded.includes("%") &&
      isIP(forwarded)
    )
      return forwarded;
  }
  return request.ip;
}
