import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveRuntimeSbom,
  verifyInstalledTree,
  parseNpmResult,
} from "./verify-runtime-inventory.mjs";

function fixture() {
  const f = {
    tree: {
      name: "app",
      version: "1.0.0",
      path: "/app",
      dependencies: {
        "@org/api": {
          name: "@org/api",
          version: "1.0.0",
          path: "/app/node_modules/@org/api",
          devDependencies: { typescript: "5.9.3" },
          peerDependenciesMeta: { "optional-db": { optional: true } },
          dependencies: {
            "optional-db": {},
            dep: {
              name: "dep",
              version: "2.0.0",
              path: "/app/node_modules/dep",
            },
          },
        },
      },
    },
    lock: {
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0" },
        "node_modules/@org/api": { link: true, resolved: "apps/api" },
        "apps/api": { name: "@org/api", version: "1.0.0" },
        "node_modules/dep": { version: "2.0.0" },
      },
    },
    sbom: {
      bomFormat: "CycloneDX",
      metadata: { component: { name: "app", version: "1.0.0" } },
      components: [
        { group: "@org", name: "api", version: "1.0.0" },
        { name: "dep", version: "2.0.0" },
      ],
    },
  };
  const all = [f.sbom.metadata.component, ...f.sbom.components];
  for (const c of all) {
    const name = c.group ? c.group + "/" + c.name : c.name;
    c.purl =
      "pkg:npm/" +
      encodeURIComponent(name).replaceAll("%2F", "/") +
      "@" +
      c.version;
    c["bom-ref"] = name + "@" + c.version;
  }
  f.sbom.dependencies = all.map((c) => ({ ref: c["bom-ref"], dependsOn: [] }));
  return f;
}
function check(f) {
  return verifyInstalledTree(f.tree, f.lock, f.sbom, { root: "/app" });
}

test("validates physical production packages without requiring omitted development packages", () => {
  const result = check(fixture());
  assert.equal(result.installedLocations, 3);
  assert.equal(result.installedIdentities, 3);
  assert.equal(result.omittedOptionalDependencies.length, 1);
  assert.match(result.scope, /separate full lock-only/);
});
test("an empty required dependency must fail", () => {
  const f = fixture();
  f.tree.dependencies["@org/api"].dependencies.dep = {};
  assert.throws(() => check(f), /required dependency/);
});
test("npm failures are not reclassified as successful lockfile inventory", () => {
  assert.throws(
    () => parseNpmResult({ status: 1, stdout: "{}" }, "npm ls"),
    /not accepted/,
  );
  assert.throws(
    () => parseNpmResult({ status: 0, stdout: "not json" }, "npm ls"),
    /invalid JSON/,
  );
  assert.throws(
    () =>
      parseNpmResult(
        { status: null, error: new Error("timeout"), stdout: "{}" },
        "npm ls",
      ),
    /not accepted/,
  );
});
for (const flag of ["missing", "invalid", "extraneous"]) {
  test("rejects installed " + flag + " packages", () => {
    const f = fixture();
    f.tree.dependencies["@org/api"].dependencies.dep[flag] = true;
    assert.throws(() => check(f), /package problem/);
  });
}
test("rejects nested npm problems", () => {
  const f = fixture();
  f.tree.dependencies["@org/api"].problems = ["missing required dep"];
  assert.throws(() => check(f), /package problem/);
});
test("rejects a semver-compatible version that differs from the exact lock", () => {
  const f = fixture();
  f.tree.dependencies["@org/api"].dependencies.dep.version = "2.0.1";
  assert.throws(() => check(f), /exact lockfile/);
});
test("rejects packages outside the application root", () => {
  const f = fixture();
  f.tree.dependencies["@org/api"].dependencies.dep.path =
    "/app-other/node_modules/dep";
  assert.throws(() => check(f), /escaped/);
});
test("rejects an escaped workspace link", () => {
  const f = fixture();
  f.lock.packages["node_modules/@org/api"].resolved = "../private";
  assert.throws(() => check(f), /workspace lockfile/);
});
test("rejects an installed dependency absent from the CycloneDX inventory", () => {
  const f = fixture();
  f.sbom.components.pop();
  assert.throws(() => check(f), /absent from/);
});
test("distinguishes optional lock-only metadata from actual installation", () => {
  const f = fixture();
  f.sbom.components.push({
    name: "optional-platform",
    version: "1.0.0",
    purl: "pkg:npm/optional-platform@1.0.0",
    "bom-ref": "optional-platform@1.0.0",
  });
  const result = check(f);
  assert.equal(result.installedLocations, 3);
  assert.equal(result.lockSbomComponents, 3);
});
test("rejects a missing or malformed evidence document", () => {
  for (const mutate of [
    (f) => {
      f.lock.packages = null;
    },
    (f) => {
      f.tree.path = "/other";
    },
    (f) => {
      f.sbom.components = [];
    },
    (f) => {
      f.tree.dependencies = [];
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => check(f));
  }
});

test("workspace display names do not replace canonical purl identity", () => {
  const f = fixture();
  f.sbom.metadata.component.name = "app-directory";
  f.sbom.components[0].name = "api-directory";
  assert.equal(check(f).installedLocations, 3);
});
test("runtime CycloneDX excludes uninstalled lock components and graph edges", () => {
  const f = fixture();
  const extra = {
    name: "dev-only",
    version: "1.0.0",
    purl: "pkg:npm/dev-only@1.0.0",
    "bom-ref": "dev-only@1.0.0",
  };
  f.sbom.components.push(extra);
  f.sbom.dependencies.push({ ref: extra["bom-ref"], dependsOn: [] });
  f.sbom.dependencies[0].dependsOn.push(extra["bom-ref"]);
  const result = deriveRuntimeSbom(f.sbom, check(f));
  assert.equal(result.components.length, 2);
  assert.equal(result.dependencies.length, 3);
  assert.deepEqual(
    result.dependencies.find((d) => d.ref === "app@1.0.0").dependsOn,
    ["@org/api@1.0.0"],
  );
  assert.equal(f.sbom.components.length, 3);
});
test("malformed npm purl cannot be accepted using its display name", () => {
  const f = fixture();
  f.sbom.components[0].purl = "pkg:npm/%ZZ@1.0.0";
  assert.throws(() => check(f), /Malformed npm/);
});

test("rejects an installed name swapped to a lock-only package of the same version", () => {
  const f = fixture();
  f.tree.dependencies["@org/api"].dependencies.dep.name = "dev-only";
  f.sbom.components.push({
    name: "dev-only",
    version: "2.0.0",
    purl: "pkg:npm/dev-only@2.0.0",
    "bom-ref": "dev-only@2.0.0",
  });
  assert.throws(() => check(f), /exact lockfile/);
});
test("runtime graph comes from installed edges even when full-lock graph is empty", () => {
  const f = fixture();
  f.sbom.dependencies = [];
  const result = deriveRuntimeSbom(f.sbom, check(f));
  assert.deepEqual(result.dependencies, [
    { ref: "@org/api@1.0.0", dependsOn: ["dep@2.0.0"] },
    { ref: "app@1.0.0", dependsOn: ["@org/api@1.0.0"] },
    { ref: "dep@2.0.0", dependsOn: [] },
  ]);
});
test("runtime graph omits dev edges between installed packages", () => {
  const f = fixture();
  f.sbom.dependencies[0].dependsOn = ["dep@2.0.0"];
  const result = deriveRuntimeSbom(f.sbom, check(f));
  assert.deepEqual(
    result.dependencies.find((d) => d.ref === "app@1.0.0").dependsOn,
    ["@org/api@1.0.0"],
  );
});
test("canonical name in an npm alias lock entry remains supported", () => {
  const f = fixture();
  const child = f.tree.dependencies["@org/api"].dependencies.dep;
  child.path = "/app/node_modules/alias";
  delete f.lock.packages["node_modules/dep"];
  f.lock.packages["node_modules/alias"] = { name: "dep", version: "2.0.0" };
  assert.equal(check(f).installedLocations, 3);
});
test("a scoped name is derived from its exact node_modules location", () => {
  const f = fixture();
  const child = f.tree.dependencies["@org/api"].dependencies.dep;
  child.path = "/app/node_modules/@vendor/dep";
  child.name = "@vendor/dep";
  delete f.lock.packages["node_modules/dep"];
  f.lock.packages["node_modules/@vendor/dep"] = { version: "2.0.0" };
  Object.assign(f.sbom.components[1], {
    purl: "pkg:npm/%40vendor/dep@2.0.0",
    "bom-ref": "@vendor/dep@2.0.0",
  });
  assert.equal(check(f).installedLocations, 3);
});
