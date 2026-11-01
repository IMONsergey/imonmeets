import {
  readFile,
  mkdir,
  rename,
  writeFile,
  statfs,
  lstat,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = {};
try {
  const r = await fetch("http://127.0.0.1:3540/api/health", {
    signal: AbortSignal.timeout(5000),
  });
  const body = await r.json();
  checks.api = { ok: r.ok && body.status === "ok" && body.database === true };
} catch {
  checks.api = { ok: false, reason: "API health request failed" };
}
checks.mediaSignaling = await new Promise((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port: 7880 });
  let complete = false;
  const done = (ok) => {
    if (complete) return;
    complete = true;
    socket.destroy();
    resolve({ ok, scope: "TCP signaling only; not a media call" });
  };
  socket.setTimeout(5000);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
});
try {
  const latest = JSON.parse(
    await readFile(path.join(root, "backups/latest.json"), "utf8"),
  );
  if (!/^imonmeets-\d{8}T\d{6}Z\.dump$/.test(latest.file))
    throw new Error("Invalid backup name");
  const dump = await lstat(path.join(root, "backups", latest.file));
  const ageSeconds = Math.round(
    (Date.now() - Date.parse(latest.createdAt)) / 1000,
  );
  checks.backup = {
    ok:
      dump.isFile() &&
      !dump.isSymbolicLink() &&
      dump.size > 0 &&
      dump.size === latest.bytes &&
      ageSeconds >= 0 &&
      ageSeconds < 7200,
    ageSeconds,
    scope: "local verified database dump",
  };
} catch {
  checks.backup = { ok: false, reason: "No successful backup manifest" };
}
try {
  const s = await statfs(root);
  const availableBytes = s.bavail * s.bsize;
  checks.disk = {
    ok: availableBytes > 5 * 1024 ** 3 && s.bavail / s.blocks > 0.1,
    freeGiB: +(availableBytes / 1024 ** 3).toFixed(2),
  };
} catch {
  checks.disk = { ok: false, reason: "Cannot inspect free disk space" };
}
const status = {
  checkedAt: new Date().toISOString(),
  ok: Object.values(checks).every((x) => x.ok),
  checks,
};
const state = path.join(root, "ops-state");
await mkdir(state, { recursive: true, mode: 0o700 });
await writeFile(
  path.join(state, "health.tmp"),
  JSON.stringify(status, null, 2) + "\n",
  { mode: 0o600 },
);
await rename(path.join(state, "health.tmp"), path.join(state, "health.json"));
console.log(JSON.stringify(status));
process.exitCode = status.ok ? 0 : 1;
