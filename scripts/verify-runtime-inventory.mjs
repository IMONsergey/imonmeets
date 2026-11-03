#!/usr/bin/env node
/**
 * Verify actual production npm dependencies against the image's lockfile.
 * npm 11.19 sbom rejects omitted dev edges even with --omit=dev. Keep the
 * installed inventory and lock-only CycloneDX separate instead of concealing it.
 * Full lock metadata is needed: omit=dev also drops installed workspace transitive
 * packages. Runtime SBOM components use validated physical identities and installed-tree edges.
 * Run in an immutable image without network. No install or source mutation.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = (name, version) => JSON.stringify([name, version]);

export function componentIdentity(component) {
  if (
    !record(component) ||
    typeof component.purl !== "string" ||
    !component.purl.startsWith("pkg:npm/") ||
    typeof component.version !== "string"
  )
    throw new Error("Malformed CycloneDX package identity");
  const coordinate = component.purl.slice(8).split(/[?#]/, 1)[0];
  const separator = coordinate.lastIndexOf("@");
  if (separator <= 0) throw new Error("Malformed npm package URL");
  let name, version;
  try {
    name = decodeURIComponent(coordinate.slice(0, separator));
    version = decodeURIComponent(coordinate.slice(separator + 1));
  } catch {
    throw new Error("Malformed npm package URL");
  }
  if (!name || version !== component.version)
    throw new Error("Inconsistent npm package URL");
  return identity(name, version);
}

export function deriveRuntimeSbom(sbom, verified) {
  const installed = new Set(
    verified.installedPackages.map((p) => identity(p.name, p.version)),
  );
  if (!installed.has(componentIdentity(sbom.metadata?.component)))
    throw new Error("Runtime SBOM root is not installed");
  const result = structuredClone(sbom);
  result.components = result.components.filter((c) =>
    installed.has(componentIdentity(c)),
  );
  const selected = [result.metadata.component, ...result.components];
  const refs = new Map();
  const identities = new Map();
  for (const component of selected) {
    const id = componentIdentity(component);
    const ref = component["bom-ref"];
    if (typeof ref !== "string" || !ref || refs.has(ref) || identities.has(id))
      throw new Error("Runtime SBOM references or identities are not unique");
    refs.set(ref, id);
    identities.set(id, ref);
  }
  if (
    !Array.isArray(verified.installedDependencies) ||
    verified.installedDependencies.length !== identities.size
  )
    throw new Error("Installed runtime dependency graph is incomplete");
  const emitted = new Set();
  result.dependencies = verified.installedDependencies
    .map((node) => {
      const id = identity(node.name, node.version);
      const ref = identities.get(id);
      if (!ref || emitted.has(id))
        throw new Error("Invalid installed graph node");
      emitted.add(id);
      return {
        ref,
        dependsOn: node.dependencies
          .map((dependency) => {
            const target = identities.get(
              identity(dependency.name, dependency.version),
            );
            if (!target)
              throw new Error("Installed graph dependency is missing");
            return target;
          })
          .sort(),
      };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));
  result.metadata.properties = [
    ...(result.metadata.properties ?? []),
    {
      name: "world.imon.inventory.scope",
      value:
        "Production npm tree matched to full lockfile metadata; graph derives only from installed npm ls edges",
    },
  ];
  return result;
}

export function verifyInstalledTree(tree, lock, sbom, { root } = {}) {
  if (
    !record(tree) ||
    !record(lock?.packages) ||
    lock.lockfileVersion !== 3 ||
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    tree.path !== root ||
    sbom?.bomFormat !== "CycloneDX" ||
    !Array.isArray(sbom.components) ||
    !sbom.components.length
  )
    throw new Error("Malformed installed-tree, lockfile or CycloneDX evidence");
  const packages = new Map();
  const omitted = new Map();
  const edges = new Map();
  let visited = 0;
  const walk = (node, parent, dependencyName, depth = 0) => {
    if (++visited > 50000 || depth > 128 || !record(node))
      throw new Error("Invalid or oversized dependency tree");
    if (Object.keys(node).length === 0) {
      if (
        !parent ||
        !(
          Object.hasOwn(parent.optionalDependencies ?? {}, dependencyName) ||
          parent.peerDependenciesMeta?.[dependencyName]?.optional === true
        )
      )
        throw new Error("A required dependency has no installed package");
      omitted.set(identity(parent.path, dependencyName), {
        parent: path.relative(root, parent.path),
        name: dependencyName,
      });
      return;
    }
    if (
      node.error ||
      node.missing ||
      node.invalid ||
      node.extraneous ||
      (Array.isArray(node.problems) && node.problems.length)
    )
      throw new Error("Installed dependency tree contains a package problem");
    if (
      typeof node.path !== "string" ||
      typeof node.name !== "string" ||
      !node.name ||
      typeof node.version !== "string" ||
      !node.version
    )
      throw new Error("Installed package identity is incomplete");
    const location = path.relative(root, node.path);
    if (
      path.isAbsolute(location) ||
      location === ".." ||
      location.startsWith("../")
    )
      throw new Error("Installed package escaped the image application root");
    let lockedLocation = location;
    let entry = lock.packages[lockedLocation];
    if (entry?.link) {
      if (
        typeof entry.resolved !== "string" ||
        path.isAbsolute(entry.resolved) ||
        path.normalize(entry.resolved).startsWith("..")
      )
        throw new Error("Invalid workspace lockfile target");
      lockedLocation = path.normalize(entry.resolved);
      entry = lock.packages[lockedLocation];
    }
    // Lock v3 omits names for ordinary packages; derive them from the exact
    // package location. An explicit name supports legitimate npm aliases.
    const marker = "node_modules/";
    const at = lockedLocation.lastIndexOf(marker);
    const locationName =
      at >= 0 ? lockedLocation.slice(at + marker.length) : null;
    const lockedName =
      entry?.name ?? (lockedLocation === "" ? lock.name : locationName);
    if (
      !entry ||
      entry.version !== node.version ||
      lockedName !== node.name ||
      (locationName && !/^(@[^/]+\/)?[^/]+$/.test(locationName))
    )
      throw new Error("Installed package does not match the exact lockfile");
    const previous = packages.get(location);
    if (
      previous &&
      (previous.name !== node.name || previous.version !== node.version)
    )
      throw new Error("Conflicting identities for one installed location");
    packages.set(location, {
      location,
      name: node.name,
      version: node.version,
    });
    if (node.dependencies !== undefined && !record(node.dependencies))
      throw new Error("Malformed dependency children");
    const id = identity(node.name, node.version);
    if (!edges.has(id)) edges.set(id, new Set());
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      const childId = walk(child, node, name, depth + 1);
      if (childId) edges.get(id).add(childId);
    }
    return id;
  };
  walk(tree);
  const components = new Set();
  for (const component of [sbom.metadata?.component, ...sbom.components].filter(
    Boolean,
  )) {
    components.add(componentIdentity(component));
  }
  for (const item of packages.values())
    if (!components.has(identity(item.name, item.version)))
      throw new Error(
        "An installed package is absent from lock-only CycloneDX",
      );
  return {
    installedPackages: [...packages.values()].sort((a, b) =>
      a.location.localeCompare(b.location),
    ),
    installedDependencies: [...edges]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, children]) => {
        const [name, version] = JSON.parse(id);
        return {
          name,
          version,
          dependencies: [...children].sort().map((child) => {
            const [name, version] = JSON.parse(child);
            return { name, version };
          }),
        };
      }),
    omittedOptionalDependencies: [...omitted.values()],
    installedLocations: packages.size,
    installedIdentities: new Set(
      [...packages.values()].map((p) => identity(p.name, p.version)),
    ).size,
    lockSbomComponents: sbom.components.length,
    scope:
      "Production dependency closure from installed npm tree and derived runtime CycloneDX, with separate full lock-only metadata; no file-integrity or OS scan or license approval",
  };
}

export function parseNpmResult(result, purpose) {
  if (result.error || result.status !== 0 || typeof result.stdout !== "string")
    throw new Error(
      purpose + " failed; runtime dependency evidence is not accepted",
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(purpose + " returned invalid JSON");
  }
}

export async function main(args = process.argv.slice(2)) {
  const outputIndex = args.indexOf("--output-dir");
  const commitIndex = args.indexOf("--expected-commit");
  const output = args[outputIndex + 1];
  const expectedCommit = args[commitIndex + 1];
  if (
    outputIndex < 0 ||
    commitIndex < 0 ||
    !output ||
    !path.isAbsolute(output) ||
    !/^[0-9a-f]{40}$/.test(expectedCommit ?? "") ||
    process.env.RELEASE_COMMIT !== expectedCommit
  )
    throw new Error(
      "Require absolute --output-dir and exact image --expected-commit",
    );
  const root = process.cwd();
  const run = (npmArgs) =>
    spawnSync("npm", ["--cache=/tmp/npm-cache", ...npmArgs], {
      cwd: root,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_ENV: "production",
        npm_config_ignore_scripts: "true",
      },
    });
  const actualResult = run(["ls", "--omit=dev", "--all", "--long", "--json"]);
  const actual = parseNpmResult(
    actualResult,
    "Installed npm dependency validation",
  );
  const lockRaw = await readFile(path.join(root, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockRaw);
  const sbomResult = run([
    "sbom",
    "--include=dev",
    "--package-lock-only",
    "--sbom-format=cyclonedx",
  ]);
  const sbom = parseNpmResult(sbomResult, "Lock-only CycloneDX generation");
  const verified = verifyInstalledTree(actual, lock, sbom, { root });
  const runtimeSbom =
    JSON.stringify(deriveRuntimeSbom(sbom, verified), null, 2) + "\n";
  // Refuse overwrite: the original failed attempt and every follow-up remain visible.
  await mkdir(output, { mode: 0o700 });
  const inventory = JSON.stringify(verified, null, 2) + "\n";
  const receipt = {
    schema: 1,
    sourceCommit: expectedCommit,
    checkedAt: new Date().toISOString(),
    verifierSourceSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    status: "PASS_RUNTIME_NPM_INVENTORY",
    installedLocations: verified.installedLocations,
    installedIdentities: verified.installedIdentities,
    lockSbomComponents: verified.lockSbomComponents,
    installedTreeSha256: hash(actualResult.stdout),
    lockfileSha256: hash(lockRaw),
    inventorySha256: hash(inventory),
    lockSbomSha256: hash(sbomResult.stdout),
    runtimeSbomSha256: hash(runtimeSbom),
    runtimeSbomComponents: JSON.parse(runtimeSbom).components.length,
    scope: verified.scope,
    productionChanges: false,
    deployed: false,
  };
  for (const [name, contents] of [
    ["installed-npm-tree.json", actualResult.stdout],
    ["installed-npm-inventory.json", inventory],
    ["dependency-lock-sbom.cdx.json", sbomResult.stdout],
    ["runtime-npm-sbom.cdx.json", runtimeSbom],
    ["inventory-receipt.json", JSON.stringify(receipt, null, 2) + "\n"],
  ])
    await writeFile(path.join(output, name), contents, {
      mode: 0o600,
      flag: "wx",
    });
  process.stdout.write(JSON.stringify(receipt) + "\n");
  return receipt;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
