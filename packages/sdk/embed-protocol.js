// Shared by the parent SDK and the guest frame. Only these fields cross origins.
export const EMBED_PROTOCOL = "imon-meets";
export const EMBED_VERSION = 1;
export const EMBED_STATES = Object.freeze([
  "prejoin",
  "waiting",
  "connecting",
  "joined",
  "reconnecting",
  "left",
]);
export const EMBED_ERRORS = Object.freeze([
  "CONNECTION_ERROR",
  "REQUEST_FAILED",
  "INITIALIZATION_FAILED",
]);
export function exactOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      url.hostname.includes("*") ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function validChannel(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
export function frameParameters(hash) {
  if (typeof hash !== "string" || hash.length > 4096) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if ([...params.keys()].length !== 2) return null;
  const origin = exactOrigin(params.get("origin"));
  const channel = params.get("channel");
  return origin && validChannel(channel) ? { origin, channel } : null;
}
function envelope(data, channel) {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.protocol === EMBED_PROTOCOL &&
    data.version === EMBED_VERSION &&
    validChannel(channel) &&
    data.channel === channel
  );
}
export function frameEvent(data, channel) {
  if (!envelope(data, channel)) return null;
  if (data.type === "ready") return { type: "ready" };
  if (data.type === "state" && EMBED_STATES.includes(data.state))
    return { type: "state", state: data.state };
  if (data.type === "error" && EMBED_ERRORS.includes(data.code))
    return { type: "error", code: data.code };
  return null;
}
export function parentCommand(data, channel) {
  if (!envelope(data, channel)) return null;
  if (data.type === "leave") return { type: "leave" };
  if (
    data.type === "configure" &&
    (data.name === undefined ||
      (typeof data.name === "string" && data.name.trim().length <= 80))
  )
    return { type: "configure", name: data.name?.trim() ?? "" };
  return null;
}
export function packet(channel, body) {
  return { protocol: EMBED_PROTOCOL, version: EMBED_VERSION, channel, ...body };
}
