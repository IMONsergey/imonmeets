#!/usr/bin/env node
// Scoped certificate activation. This is invoked only by the explicit per-host
// hook after commissioning; importing it or generating candidates does nothing.
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { required, validateRenewalConfig } from "./edge-certificate-policy.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const publicEnvironment = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
function execute(argv, options = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024, env: publicEnvironment, ...options });
  required(!r.error && r.status === 0, "SCOPED_COMMAND_FAILED");
  return r.stdout;
}
export function validateCertificate(cert, key, domains, now = Date.now()) {
  try {
    const x509 = new X509Certificate(cert);
    required(now >= Date.parse(x509.validFrom) && now < Date.parse(x509.validTo), "CERTIFICATE_NOT_CURRENT");
    required(domains.every((d) => x509.checkHost(d, { wildcards: false }) === d), "CERTIFICATE_HOST_MISMATCH");
    const names = x509.subjectAltName?.split(", ").map((s) => s.startsWith("DNS:") ? s.slice(4) : "INVALID") || [];
    required(names.length === domains.length && [...names].sort().join() === [...domains].sort().join(), "CERTIFICATE_SAN_SET_MISMATCH");
    const actual = createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "der" });
    required(x509.publicKey.export({ type: "spki", format: "der" }).equals(actual), "CERTIFICATE_KEY_MISMATCH");
    return { certificateSha256: digest(cert), expiresAt: new Date(x509.validTo).toISOString() };
  } catch (e) {
    required(false, /^[A-Z][A-Z0-9_]+$/.test(e.code || "") ? e.code : "INVALID_CERTIFICATE_MATERIAL");
  }
}
async function privateFile(file, { key = false, noSymlink = true } = {}) {
  const handle = await fs.open(file, constants.O_RDONLY | (noSymlink ? constants.O_NOFOLLOW : 0));
  try {
    const s = await handle.stat();
    required(s.isFile() && s.size > 0 && s.size <= 256 * 1024 && s.uid === process.getuid() &&
      !(s.mode & (key ? 0o077 : 0o022)), "UNSAFE_PRIVATE_FILE");
    return { bytes: await handle.readFile(), uid: s.uid, gid: s.gid, mode: s.mode & 0o777 };
  } finally { await handle.close(); }
}
async function privateDirectory(dir) {
  const s = await fs.lstat(dir);
  required(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077), "UNSAFE_PRIVATE_DIRECTORY");
}
async function atomicFile(file, bytes, owner) {
  const temp = file + ".pending-" + randomUUID();
  try {
    const h = await fs.open(temp, "wx", 0o600);
    try {
      await h.writeFile(bytes);
      if (owner && process.getuid() === 0) await h.chown(owner.uid, owner.gid);
      await h.sync();
    } finally { await h.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
async function syncDirectory(dir) {
  const h = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await h.sync(); } finally { await h.close(); }
}
async function switchCurrent(store, target, published = () => {}, durableDirectory = syncDirectory) {
  const temp = path.join(store, ".current-" + randomUUID());
  try {
    await fs.symlink(target, temp);
    await fs.rename(temp, path.join(store, "current"));
    published(); // Publication has happened even if the following fsync fails.
    await durableDirectory(store);
  }
  finally { await fs.rm(temp, { force: true }); }
}
function composeCommand(c, args) {
  const r = c.runtime;
  return ["/usr/bin/docker", "compose", "--project-directory", r.projectDirectory,
    "--project-name", r.projectName, "--env-file", r.envFile,
    ...r.composeFiles.flatMap((f) => ["-f", f]), ...args];
}
function nginxTest(c) {
  return ["/usr/sbin/nginx", "-t", ...(c.role === "witness" ? ["-c", "/etc/imonmeets/edge-nginx/nginx.conf"] : [])];
}
function nginxReload(c) {
  return ["/usr/bin/systemctl", "reload", c.role === "main" ? "nginx.service" : "imonmeets-edge-nginx.service"];
}
async function turnFile(file) {
  // Existing TURN copies belong to the explicitly configured non-root service.
  const s = await fs.lstat(file);
  required(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= 256 * 1024 && !(s.mode & 0o077), "UNSAFE_TURN_FILE");
  return { bytes: await fs.readFile(file), uid: s.uid, gid: s.gid };
}
async function prepareTurn(c, snapshot, run, oldCertificate) {
  const r = c.runtime;
  await privateFile(r.envFile, { key: true });
  const dirStat = await fs.lstat(r.turnDirectory);
  required(dirStat.isDirectory() && !dirStat.isSymbolicLink() && !(dirStat.mode & 0o077), "UNSAFE_TURN_DIRECTORY");
  const source = path.join(r.codeDirectory, "prepare-turn.mjs");
  required(digest((await privateFile(source)).bytes) === c.prepareTurnSha256, "TURN_GENERATOR_CHANGED");
  const compose = JSON.parse(await run(composeCommand(c, ["config", "--format", "json"]),
    { env: { ...publicEnvironment, DOCKER_HOST: "unix:///var/run/docker.sock" } }));
  const service = compose.services?.turn;
  const mounts = service?.volumes?.filter((v) => v.target === "/run/imon-turn") || [];
  required(compose.name === r.projectName && mounts.length === 1 && mounts[0].type === "bind" &&
    mounts[0].source === r.turnDirectory && mounts[0].read_only === true && service.network_mode === "host", "TURN_COMPOSE_CONTEXT_MISMATCH");
  required(typeof service.user === "string" && /^\d+:\d+$/.test(service.user), "TURN_COMPOSE_USER_NOT_EXPLICIT");
  required(`${dirStat.uid}:${dirStat.gid}` === service.user, "TURN_DIRECTORY_OWNER_MISMATCH");
  const dockerEnv = { env: { ...publicEnvironment, DOCKER_HOST: "unix:///var/run/docker.sock" } };
  const id = (await run(composeCommand(c, ["ps", "--all", "--quiet", "turn"]), dockerEnv)).trim();
  required(/^[a-f0-9]{64}$/.test(id), "TURN_CONTAINER_NOT_UNIQUE");
  const containers = JSON.parse(await run(["/usr/bin/docker", "inspect", "--type", "container", id], dockerEnv));
  const actual = containers[0];
  const actualMounts = actual?.Mounts?.filter((m) => m.Destination === "/run/imon-turn") || [];
  required(containers.length === 1 && actual.Id === id && actual.State?.Running === true &&
    actual.Config?.Labels?.["com.docker.compose.project"] === r.projectName &&
    actual.Config?.Labels?.["com.docker.compose.service"] === "turn" &&
    actual.Config?.User === service.user && actual.HostConfig?.NetworkMode === "host" &&
    actualMounts.length === 1 && actualMounts[0].Type === "bind" && actualMounts[0].RW === false &&
    actualMounts[0].Source === await fs.realpath(r.turnDirectory), "TURN_RUNNING_CONTAINER_DRIFT");
  const original = {};
  for (const name of ["fullchain.pem", "privkey.pem", "turnserver.conf"]) original[name] = await turnFile(path.join(r.turnDirectory, name));
  required(Object.values(original).every((v) => `${v.uid}:${v.gid}` === service.user), "TURN_FILE_OWNER_MISMATCH");
  required(original["fullchain.pem"].bytes.equals(oldCertificate), "TURN_ACTIVE_CERTIFICATE_DRIFT");
  const dir = await fs.mkdtemp(path.join(snapshot, "turn-stage-"));
  await run([r.node, `--env-file=${r.envFile}`, source, "--cert-only", "--lineage", snapshot], {
    cwd: r.projectDirectory,
    env: { ...publicEnvironment, TURN_OUTPUT_DIR: dir, TURN_CERTIFICATE_DIR: snapshot },
  });
  required((await fs.readFile(path.join(dir, "turnserver.conf"))).equals(original["turnserver.conf"].bytes), "TURN_RUNTIME_CONFIGURATION_DRIFT");
  for (const name of ["fullchain.pem", "privkey.pem"]) {
    required((await fs.readFile(path.join(dir, name))).equals(await fs.readFile(path.join(snapshot, name))), "TURN_STAGED_CERTIFICATE_MISMATCH");
  }
  await fs.rm(dir, { recursive: true });
  return original;
}

export async function activateCertificate(value, {
  lineage, initial = false, run = execute, filesystemRoot = "/",
  durableDirectory = syncDirectory,
} = {}) {
  const c = validateRenewalConfig(value);
  if (!initial && lineage !== c.lineage) return { status: "SKIPPED_FOREIGN_LINEAGE" };
  // filesystemRoot is an in-process test fixture seam; no CLI/env override exists.
  const at = (p) => path.join(filesystemRoot, p);
  const store = at(c.store);
  const cert = await privateFile(path.join(at(c.lineage), "fullchain.pem"), { noSymlink: false });
  const key = await privateFile(path.join(at(c.lineage), "privkey.pem"), { key: true, noSymlink: false });
  const material = validateCertificate(cert.bytes, key.bytes, c.domains);
  if (initial) {
    await fs.mkdir(store, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
  }
  await privateDirectory(store);
  const lock = path.join(store, ".renew-lock");
  await fs.mkdir(lock, { mode: 0o700 }).catch(() => required(false, "RENEWAL_ALREADY_LOCKED"));
  let snapshot, previous, switched = false, reloaded = false, originalTurn, turnTouched = false, keepLock = false;
  const turnRestart = () => run(composeCommand(c, ["restart", "--timeout", "10", "turn"]),
    { env: { ...publicEnvironment, DOCKER_HOST: "unix:///var/run/docker.sock" } });
  try {
    try {
      previous = await fs.readlink(path.join(store, "current"));
      required(/^versions\/[a-f0-9-]{73}$/.test(previous), "UNSAFE_CURRENT_SNAPSHOT");
      await privateDirectory(path.join(store, previous));
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    required(initial ? !previous : !!previous, initial ? "INITIAL_SNAPSHOT_EXISTS" : "INITIAL_SNAPSHOT_REQUIRED");
    if (previous) {
      const activeCert = await privateFile(path.join(store, previous, "fullchain.pem"));
      const activeKey = await privateFile(path.join(store, previous, "privkey.pem"), { key: true });
      if (activeCert.bytes.equals(cert.bytes) && activeKey.bytes.equals(key.bytes)) {
        if (c.role === "main") {
          required((await turnFile(path.join(c.runtime.turnDirectory, "fullchain.pem"))).bytes.equals(cert.bytes) &&
            (await turnFile(path.join(c.runtime.turnDirectory, "privkey.pem"))).bytes.equals(key.bytes), "TURN_ACTIVE_CERTIFICATE_DRIFT");
        }
        return { status: "ACTIVE_CERTIFICATE_UNCHANGED", ...material, servicesChanged: false };
      }
    }
    const versions = path.join(store, "versions");
    await fs.mkdir(versions, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
    await privateDirectory(versions);
    const target = "versions/" + material.certificateSha256.slice(0, 36) + "-" + randomUUID();
    snapshot = path.join(store, target);
    await fs.mkdir(snapshot, { mode: 0o700 });
    await atomicFile(path.join(snapshot, "fullchain.pem"), cert.bytes);
    await atomicFile(path.join(snapshot, "privkey.pem"), key.bytes);
    await durableDirectory(snapshot);
    await durableDirectory(versions);
    if (!initial && c.role === "main") {
      originalTurn = await prepareTurn(c, snapshot, run, (await privateFile(path.join(store, previous, "fullchain.pem"))).bytes);
    }
    await switchCurrent(store, target, () => { switched = true; }, durableDirectory);
    if (initial) return { status: "INITIAL_SNAPSHOT_STAGED", ...material, servicesChanged: false };
    await run(nginxTest(c));
    if (c.role === "main") {
      turnTouched = true;
      for (const name of ["fullchain.pem", "privkey.pem"]) await atomicFile(path.join(c.runtime.turnDirectory, name), await fs.readFile(path.join(snapshot, name)), originalTurn[name]);
      await durableDirectory(c.runtime.turnDirectory);
    }
    reloaded = true; // A failed reload can have sent a signal; roll it back too.
    await run(nginxReload(c));
    if (c.role === "main") await turnRestart();
    return { status: "SCOPED_RENEWAL_ACTIVATED", ...material, servicesChanged: true };
  } catch (error) {
    let rollbackFailed = false;
    if (switched) {
      try {
        if (previous) await switchCurrent(store, previous, undefined, durableDirectory);
        else { await fs.unlink(path.join(store, "current")); await durableDirectory(store); }
        if (turnTouched) {
          for (const name of ["fullchain.pem", "privkey.pem"]) await atomicFile(path.join(c.runtime.turnDirectory, name), originalTurn[name].bytes, originalTurn[name]);
          await durableDirectory(c.runtime.turnDirectory);
        }
        if (reloaded) { await run(nginxTest(c)); await run(nginxReload(c)); }
        if (turnTouched) await turnRestart();
      } catch { rollbackFailed = true; }
    }
    if (snapshot && (!switched || !rollbackFailed)) await fs.rm(snapshot, { recursive: true, force: true }).catch(() => {});
    if (rollbackFailed) { keepLock = true; required(false, "RENEWAL_ROLLBACK_FAILED"); }
    throw error;
  } finally { if (!keepLock) await fs.rmdir(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    required(process.getuid() === 0, "ROOT_REQUIRED_FOR_ACTIVATION");
    const a = process.argv.slice(2);
    required(a[0] === "--config" && [2, 3].includes(a.length) && (a.length === 2 || ["--stage-initial", "--reconcile"].includes(a[2])), "INVALID_ARGUMENTS");
    const c = JSON.parse((await privateFile(a[1], { key: true })).bytes);
    const result = await activateCertificate(c, { lineage: a[2] === "--reconcile" ? c.lineage : process.env.RENEWED_LINEAGE, initial: a[2] === "--stage-initial" });
    process.stdout.write(JSON.stringify(result) + "\n");
  })().catch((e) => {
    process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(e.code || "") ? e.code : "CERTIFICATE_ACTIVATION_FAILED" }) + "\n");
    process.exitCode = 1;
  });
}
