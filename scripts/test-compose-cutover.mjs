import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkComposeCutover } from "./check-compose-cutover.mjs";

const image = "sha256:" + "1".repeat(64);
const otherImage = "sha256:" + "2".repeat(64);
const commit = "a".repeat(40);
const privateMarker = "private-value-must-not-appear-in-results-0123456789";
const expected = { expectedAppImage: image, expectedCommit: commit };

function fixture() {
  const environment = {
    NODE_ENV: "production",
    RELEASE_COMMIT: commit,
    RELEASE_IMAGE_DIGEST: image,
    APP_URL: "https://meets.example.test",
    DATABASE_URL:
      "postgres://fixture:private-database-password@db:5432/imonmeets",
    EMAIL_PROVIDER: "resend",
    EMAIL_DELIVERY_MODE: "external",
    RESEND_API_KEY: privateMarker,
    SMTP_FROM: "IMON <private-sender@example.test>",
    EMAILS_PER_DAY: "45",
    EMAILS_PER_WORKSPACE_DAY: "45",
    EMAILS_PER_30D_BUCKET: "1000",
    DELETION_JOURNAL_KEY: privateMarker,
    DELETION_WITNESS_URL: "https://private-witness.example.test/receiver",
    DELETION_WITNESS_TOKEN: privateMarker,
    DELETION_WITNESS_PUBLIC_KEY: "private-placeholder-pem-value",
    // Compose resolves inherited entries to strings or null, not a dotenv array.
    UNUSED_OPTIONAL_VALUE: null,
  };
  return {
    name: "imonmeets-fixture",
    services: {
      app: {
        image,
        environment: {
          ...environment,
          DELETION_JOURNAL_DIR: "/var/lib/imonmeets/deletion-journal",
        },
        volumes: [
          {
            type: "bind",
            source: "/private/operator/journal",
            target: "/var/lib/imonmeets/deletion-journal",
            // Installed Compose omits create_host_path:false in normalized JSON.
            bind: {},
          },
        ],
        build: { context: "/private/checkout" },
      },
      migrate: {
        image,
        environment: { ...environment, DELETION_JOURNAL_DIR: "" },
        command: ["node", "apps/api/dist/migrate.js"],
      },
    },
  };
}

function codes(result) {
  return result.failures.map((failure) => failure.code);
}

test("rejects a stale runtime override even when migrate still uses the accepted image", () => {
  const input = fixture();
  input.services.app.image = otherImage;
  const result = checkComposeCutover(input, expected);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("IMAGE_MISMATCH"));
});

test("accepts normalized Compose and does not invent a migrate journal mount requirement", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const result = checkComposeCutover(input, expected);
  assert.equal(result.ok, true);
  assert.equal(result.sourceMetadataVerified, false);
  assert.equal(result.deployed, false);
  assert.equal(result.productionChanges, false);
  assert.equal(JSON.stringify(input), before);
});

test("requires both app and migrate to use exact immutable references", () => {
  for (const service of ["app", "migrate"]) {
    for (const value of [otherImage, "imonmeets-app:latest", "", null]) {
      const input = fixture();
      input.services[service].image = value;
      assert.equal(checkComposeCutover(input, expected).ok, false);
    }
  }
  assert.equal(
    checkComposeCutover(fixture(), { expectedAppImage: "app:latest" }).ok,
    false,
  );
});

test("rejects mismatched source and image identity declarations in either service", () => {
  for (const service of ["app", "migrate"]) {
    for (const [key, value] of [
      ["RELEASE_COMMIT", "b".repeat(40)],
      ["RELEASE_IMAGE_DIGEST", otherImage],
    ]) {
      const input = fixture();
      input.services[service].environment[key] = value;
      assert.equal(checkComposeCutover(input, expected).ok, false);
    }
  }
});

test("requires production mode without pretending that the static gate proves public443", () => {
  const input = fixture();
  input.services.app.environment.APP_URL = "https://meets.example.test:8443";
  input.services.migrate.environment.APP_URL =
    "https://meets.example.test:8443";
  assert.equal(checkComposeCutover(input, expected).ok, true);
  input.services.app.environment.NODE_ENV = "development";
  assert.equal(checkComposeCutover(input, expected).ok, false);
});

test("catches lost or captured Resend configuration in either merged service", () => {
  const cases = [
    ["RESEND_API_KEY", ""],
    ["RESEND_API_KEY", "   "],
    ["RESEND_API_KEY", null],
    ["SMTP_FROM", ""],
    ["EMAIL_PROVIDER", "smtp"],
    ["EMAIL_DELIVERY_MODE", "capture"],
  ];
  for (const service of ["app", "migrate"]) {
    for (const [key, value] of cases) {
      const input = fixture();
      input.services[service].environment[key] = value;
      assert.equal(checkComposeCutover(input, expected).ok, false);
    }
  }
});

test("applies actual loadConfig Resend defaults and rejects Compose quota defaults that exceed Free limits", () => {
  const input = fixture();
  for (const service of Object.values(input.services)) {
    delete service.environment.EMAILS_PER_DAY;
    delete service.environment.EMAILS_PER_WORKSPACE_DAY;
    delete service.environment.EMAILS_PER_30D_BUCKET;
  }
  assert.equal(checkComposeCutover(input, expected).ok, true);
  for (const [key, value] of [
    ["EMAILS_PER_DAY", "500"],
    ["EMAILS_PER_WORKSPACE_DAY", "100"],
    ["EMAILS_PER_30D_BUCKET", "15000"],
    ["EMAILS_PER_DAY", "0"],
    ["EMAILS_PER_DAY", "2.5"],
  ]) {
    const candidate = structuredClone(input);
    candidate.services.app.environment[key] = value;
    assert.equal(checkComposeCutover(candidate, expected).ok, false);
  }
});

test("detects divergent mail or application origin overlays without printing values", () => {
  for (const key of [
    "RESEND_API_KEY",
    "SMTP_FROM",
    "APP_URL",
    "DATABASE_URL",
  ]) {
    const input = fixture();
    input.services.migrate.environment[key] += "different";
    const result = checkComposeCutover(input, expected);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("SERVICE_CONFIGURATION_MISMATCH"));
  }
});

test("requires a writable explicitly existing bind at the app journal path", () => {
  const mutations = [
    (service) => {
      delete service.volumes;
    },
    (service) => {
      service.volumes[0].bind.create_host_path = true;
    },
    (service) => {
      service.volumes[0].bind.create_host_path = "false";
    },
    (service) => {
      service.volumes[0].read_only = true;
    },
    (service) => {
      service.volumes[0].type = "volume";
    },
    (service) => {
      service.volumes[0].source = "./relative";
    },
    (service) => {
      service.volumes[0].source = "/";
    },
    (service) => {
      service.volumes[0].target = "/other";
    },
    (service) => {
      service.volumes.push({ ...service.volumes[0] });
    },
    (service) => {
      service.volumes.push({
        type: "bind",
        source: "/tmp/other",
        target: service.environment.DELETION_JOURNAL_DIR + "/metadata.json",
        bind: {},
      });
    },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input.services.app);
    assert.equal(checkComposeCutover(input, expected).ok, false);
  }
  const input = fixture();
  input.services.app.volumes[0].bind.create_host_path = false;
  input.services.app.volumes[0].read_only = false;
  assert.equal(checkComposeCutover(input, expected).ok, true);
});

test("checks journal and receiver presence but does not claim enrollment or independent host acceptance", () => {
  for (const [key, value] of [
    ["DELETION_JOURNAL_KEY", "short"],
    ["DELETION_WITNESS_TOKEN", "short"],
    ["DELETION_WITNESS_URL", "http://witness.example.test"],
    ["DELETION_WITNESS_PUBLIC_KEY", ""],
    ["DELETION_JOURNAL_DIR", "/"],
  ]) {
    const input = fixture();
    input.services.app.environment[key] = value;
    assert.equal(checkComposeCutover(input, expected).ok, false);
  }
  const result = checkComposeCutover(fixture(), expected);
  assert.equal(result.runtimeAccepted, false);
});

test("rejects a tmpfs overlay that would hide the persistent journal or its contents", () => {
  for (const suffix of ["", "/metadata.json"]) {
    const input = fixture();
    input.services.app.tmpfs = [
      input.services.app.environment.DELETION_JOURNAL_DIR + suffix + ":size=8m",
    ];
    assert.equal(checkComposeCutover(input, expected).ok, false);
  }
});

function inspect() {
  return [
    {
      Id: image,
      RepoDigests: ["registry.example.test/imonmeets@sha256:" + "3".repeat(64)],
      Config: {
        Labels: { "org.opencontainers.image.revision": commit },
        Env: ["NODE_ENV=production", "RELEASE_COMMIT=" + commit],
      },
    },
  ];
}

test("binds supplied real Docker image metadata to image and source without trusting a Compose label", () => {
  const input = fixture();
  input.services.app.labels = { "org.opencontainers.image.revision": commit };
  assert.equal(
    checkComposeCutover(input, { ...expected, imageInspect: inspect() })
      .sourceMetadataVerified,
    true,
  );
  for (const mutate of [
    (data) => {
      data[0].Id = otherImage;
    },
    (data) => {
      data[0].Config.Labels["org.opencontainers.image.revision"] = "b".repeat(
        40,
      );
    },
    (data) => {
      data[0].Config.Env[1] = "RELEASE_COMMIT=" + "b".repeat(40);
    },
  ]) {
    const data = inspect();
    mutate(data);
    assert.equal(
      checkComposeCutover(input, { ...expected, imageInspect: data }).ok,
      false,
    );
  }
});

test("does not confuse a registry manifest digest with the Docker image ID", () => {
  const input = fixture();
  const metadata = inspect();
  const reference = metadata[0].RepoDigests[0];
  input.services.app.image = input.services.migrate.image = reference;
  const options = {
    ...expected,
    expectedAppImage: reference,
    imageInspect: metadata,
  };
  assert.equal(checkComposeCutover(input, options).ok, true);
  delete options.imageInspect;
  assert.equal(checkComposeCutover(input, options).ok, false);
  options.imageInspect = metadata;
  input.services.app.environment.RELEASE_IMAGE_DIGEST =
    "sha256:" + "3".repeat(64);
  assert.equal(checkComposeCutover(input, options).ok, false);
});

test("malformed rendered input and malformed metadata fail closed", () => {
  for (const input of [
    null,
    [],
    {},
    { services: [] },
    { services: { app: {}, migrate: null } },
  ]) {
    assert.equal(checkComposeCutover(input, expected).ok, false);
  }
  const input = fixture();
  input.services.app.environment = ["RESEND_API_KEY=" + privateMarker];
  assert.equal(checkComposeCutover(input, expected).ok, false);
  assert.equal(
    checkComposeCutover(fixture(), { ...expected, imageInspect: {} }).ok,
    false,
  );
});

test("returns only fixed diagnostic codes and never serializes raw configuration", () => {
  const input = fixture();
  input.services.app.image = privateMarker;
  input.services.app.environment.APP_URL = privateMarker;
  input.services.app.environment.RESEND_API_KEY = "";
  const output = JSON.stringify(checkComposeCutover(input, expected));
  for (const forbidden of [
    privateMarker,
    "private-sender",
    "private-witness",
    "/private/operator",
    "/private/checkout",
  ])
    assert.equal(output.includes(forbidden), false);
});

const executable = fileURLToPath(
  new URL("./check-compose-cutover.mjs", import.meta.url),
);
function cli(args) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
}

test("CLI reads an explicit bounded JSON file, exits by verdict and never modifies it", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "imon-compose-preflight-"));
  const file = path.join(folder, "compose.json");
  try {
    const contents = JSON.stringify(fixture());
    await writeFile(file, contents, { mode: 0o600 });
    const args = [
      "--compose",
      file,
      "--expected-image",
      image,
      "--expected-commit",
      commit,
    ];
    const result = cli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(await readFile(file, "utf8"), contents);
    await writeFile(file, '{"secret":"' + privateMarker + '",invalid');
    const invalid = cli(args);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).ok, false);
    assert.equal(
      (invalid.stdout + invalid.stderr).includes(privateMarker),
      false,
    );
    await writeFile(file, "x".repeat(4 * 1024 * 1024 + 1));
    assert.equal(cli(args).status, 1);
    const link = path.join(folder, "linked.json");
    await symlink(file, link);
    assert.equal(cli(["--compose", link, "--expected-image", image]).status, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
