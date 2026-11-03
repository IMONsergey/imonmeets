import { isIP } from "node:net";
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { readFile, writeFile, mkdir, chmod, chown } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const ip = process.env.LIVEKIT_PUBLIC_IP;
const ingress443 = process.env.TURN_INGRESS_443 === "true";
const domain = ingress443
  ? process.env.TURN_PUBLIC_HOST
  : process.env.PUBLIC_MEDIA_HOST;
const advertisedTlsPort = ingress443 ? 443 : 5349;
const secret = process.env.TURN_SHARED_SECRET;
const certName =
  process.env.TLS_CERT_NAME ||
  (ingress443 ? "imonmeets-commercial" : "imonmeets-preview");
if (
  process.env.TURN_INGRESS_443 &&
  !["true", "false"].includes(process.env.TURN_INGRESS_443)
)
  throw new Error("TURN_INGRESS_443 must be true or false");
if (isIP(ip || "") !== 4) throw new Error("LIVEKIT_PUBLIC_IP must be IPv4");
if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain || ""))
  throw new Error("The selected TURN hostname is invalid");
if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret || ""))
  throw new Error("Set a random TURN_SHARED_SECRET (32+ base64url characters)");
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(certName))
  throw new Error("Invalid certificate name");
const uid = Number(process.env.TURN_UID || 1000);
const gid = Number(process.env.TURN_GID || 1000);
if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1)
  throw new Error("TURN_UID/TURN_GID must be positive numeric IDs");
const lineage =
  process.env.TURN_CERTIFICATE_DIR || "/etc/letsencrypt/live/" + certName;
if (!path.isAbsolute(lineage))
  throw new Error("TURN_CERTIFICATE_DIR must be absolute");
const requested = process.argv.indexOf("--lineage");
if (requested >= 0 && process.argv[requested + 1] !== lineage) process.exit(0);
const cert = await readFile(path.join(lineage, "fullchain.pem"));
const key = await readFile(path.join(lineage, "privkey.pem"));
const x509 = new X509Certificate(cert);
if (
  Date.now() < Date.parse(x509.validFrom) ||
  Date.now() >= Date.parse(x509.validTo)
)
  throw new Error("TLS certificate is not currently valid");
if (!x509.checkHost(domain))
  throw new Error("TLS certificate does not cover the media hostname");
if (
  !Buffer.from(x509.publicKey.export({ type: "spki", format: "pem" })).equals(
    Buffer.from(
      createPublicKey(createPrivateKey(key)).export({
        type: "spki",
        format: "pem",
      }),
    ),
  )
)
  throw new Error("TLS private key does not match certificate");
const dir = path.resolve(
  process.env.TURN_OUTPUT_DIR || path.join(root, "deploy/turn-private"),
);
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
if (process.getuid?.() === 0) await chown(dir, uid, gid);
else if (process.getuid?.() !== uid || process.getgid?.() !== gid)
  throw new Error("Run as TURN_UID/TURN_GID or root to prepare private files");
async function save(name, contents) {
  const destination = path.join(dir, name);
  await writeFile(destination, contents, { mode: 0o600 });
  await chmod(destination, 0o600);
  if (process.getuid?.() === 0) await chown(destination, uid, gid);
}
await save("fullchain.pem", cert);
await save("privkey.pem", key);
const config =
  [
    "listening-port=3478",
    "tls-listening-port=5349",
    "listening-ip=" + (ingress443 ? "127.0.0.1" : ip),
    "relay-ip=" + ip,
    "min-port=49160",
    "max-port=49259",
    "fingerprint",
    "use-auth-secret",
    "static-auth-secret=" + secret,
    "realm=" + domain,
    "server-name=" + domain,
    "cert=/run/imon-turn/fullchain.pem",
    "pkey=/run/imon-turn/privkey.pem",
    "no-cli",
    "no-tcp",
    "no-tcp-relay",
    "no-dtls",
    "no-tlsv1",
    "no-tlsv1_1",
    "no-multicast-peers",
    "denied-peer-ip=0.0.0.0-255.255.255.255",
    "denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "allowed-peer-ip=" + ip,
    "user-quota=4",
    "total-quota=100",
    "max-bps=4000000",
    "bps-capacity=50000000",
    "stale-nonce=600",
    "max-allocate-lifetime=600",
    "log-file=stdout",
    "simple-log",
    "pidfile=/tmp/turnserver.pid",
    "userdb=/var/lib/coturn/turndb",
    "relay-threads=2",
  ].join("\n") + "\n";
await save("turnserver.conf", config);
if (!process.argv.includes("--cert-only")) {
  const base = await readFile(
    process.env.LIVEKIT_PUBLIC_CONFIG ||
      path.join(root, "deploy/livekit.public.yaml"),
    "utf8",
  );
  const marker = "  udp_port: 7882\n";
  if (base.split(marker).length !== 2)
    throw new Error("Regenerate public media config before enabling TURN");
  const turns =
    marker +
    "  turn_servers:\n" +
    "    - host: " +
    domain +
    "\n      port: " +
    advertisedTlsPort +
    "\n      protocol: tls\n      secret: " +
    secret +
    "\n      ttl: 86400\n" +
    (ingress443
      ? ""
      : "    - host: " +
        domain +
        "\n      port: 3478\n      protocol: udp\n      secret: " +
        secret +
        "\n      ttl: 86400\n");
  await save("livekit.yaml", base.replace(marker, turns));
}
console.log(
  "Prepared private TURN configuration and matching TLS material. No secrets printed.",
);
