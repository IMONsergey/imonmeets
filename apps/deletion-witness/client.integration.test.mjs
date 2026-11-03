import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createServer, request } from "node:https";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initializeWitnessStorage,
  createWitnessStore,
  createWitnessServer,
  digest,
} from "./server.mjs";
import {
  initializeDeletionJournal,
  openDeletionJournal,
} from "../api/dist/deletion-journal.js";
import { inspectDeletionJournal } from "../../scripts/check-deletion-journal.mjs";

test(
  "actual journal client and receiver agree over verified TLS, recover pending delivery and reject an incomplete restore",
  { timeout: 30_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "imon-deletion-tls-"));
    await fs.chmod(root, 0o700);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const receiverDirectory = path.join(root, "receiver");
    await fs.mkdir(receiverDirectory, { mode: 0o700 });
    const config = {
      directory: path.join(root, "application"),
      key: "synthetic-journal-key-for-isolated-tls-test-20261103",
      required: true,
      witnessUrl: "",
      witnessToken: "synthetic-receiver-token-for-isolated-tls-test-20261103",
      witnessPublicKey: "",
    };
    await initializeDeletionJournal(config);
    const genesisRaw = await fs.readFile(
      path.join(config.directory, "metadata.json"),
      "utf8",
    );
    const genesis = JSON.parse(genesisRaw);
    const pair = generateKeyPairSync("ed25519");
    const receiverConfig = {
      directory: receiverDirectory,
      journalId: genesis.body.journalId,
      genesisSha256: digest(genesis),
      genesis,
      journalKey: config.key,
      signingKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    };
    await initializeWitnessStorage(receiverConfig);
    const store = await createWitnessStore(receiverConfig);
    const certPath = path.join(root, "tls-cert.pem"),
      keyPath = path.join(root, "tls-key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=isolated-deletion-test",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore", timeout: 10_000 },
    );
    const cert = await fs.readFile(certPath),
      tlsKey = await fs.readFile(keyPath);
    const protocolServer = createWitnessServer(store, config.witnessToken);
    const handler = protocolServer.listeners("request")[0];
    let unavailable = false;
    const tlsServer = createServer({ key: tlsKey, cert }, (req, res) => {
      if (unavailable) {
        res.writeHead(503);
        res.end();
        req.resume();
        return;
      }
      handler(req, res);
    });
    tlsServer.listen(0, "127.0.0.1");
    await once(tlsServer, "listening");
    t.after(async () => {
      tlsServer.closeAllConnections();
      await new Promise((resolve) => tlsServer.close(resolve));
    });
    config.witnessUrl = "https://127.0.0.1:" + tlsServer.address().port;
    config.witnessPublicKey = pair.publicKey.export({
      type: "spki",
      format: "pem",
    });
    // Pin only this fixture certificate. Hostname verification and TLS remain on.
    const verifiedFetch = (url, init) =>
      new Promise((resolve, reject) => {
        const req = request(
          url,
          {
            method: init.method,
            headers: init.headers,
            signal: init.signal,
            ca: cert,
          },
          (res) => {
            resolve(
              new Response(Readable.toWeb(res), {
                status: res.statusCode,
                headers: res.headers,
              }),
            );
          },
        );
        req.once("error", reject);
        req.end(init.body);
      });
    const journal = await openDeletionJournal(config, verifiedFetch);
    assert.ok(journal);
    assert.equal(
      await journal.verifyIndependentCheckpoint(await journal.snapshot(), {
        recoverPending: false,
      }),
      true,
    );
    const first = await journal.recordAuthorizedIntent({
      actorId: "synthetic_user",
      target: { kind: "account", accountId: "synthetic_user" },
    });
    assert.equal(first.independentlyAcknowledged, true);
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(receiverDirectory, first.body.id + ".intent.json"),
          "utf8",
        ),
      ).body.id,
      first.body.id,
    );
    await journal.markCommitted(first);

    unavailable = true;
    const secondTarget = {
      actorId: "synthetic_user",
      target: { kind: "workspace", workspaceId: randomUUID() },
    };
    await assert.rejects(journal.recordAuthorizedIntent(secondTarget));
    const afterFailure = await journal.snapshot();
    assert.equal(afterFailure.version, 2);
    const pendingId = afterFailure.intents.find(
      (intent) => intent.body.target.kind === "workspace",
    ).body.id;
    unavailable = false;
    const retried = await journal.recordAuthorizedIntent(secondTarget);
    assert.equal(
      retried.body.id,
      pendingId,
      "retry must deliver the same immutable intent",
    );
    assert.equal((await journal.snapshot()).version, 2);
    assert.equal(retried.independentlyAcknowledged, true);

    const restoredConfig = {
      ...config,
      directory: path.join(root, "restored-old-backup"),
    };
    await fs.mkdir(restoredConfig.directory, { mode: 0o700 });
    await fs.writeFile(
      path.join(restoredConfig.directory, "metadata.json"),
      genesisRaw,
      { mode: 0o600 },
    );
    const restored = await openDeletionJournal(restoredConfig, verifiedFetch);
    await assert.rejects(
      restored.verifyIndependentCheckpoint(await restored.snapshot(), {
        recoverPending: false,
      }),
      /complete|match|head/i,
    );
    for (const name of await fs.readdir(receiverDirectory)) {
      if (name.endsWith(".intent.json"))
        await fs.copyFile(
          path.join(receiverDirectory, name),
          path.join(restoredConfig.directory, name),
        );
    }
    assert.equal(
      await restored.verifyIndependentCheckpoint(await restored.snapshot(), {
        recoverPending: true,
      }),
      true,
    );
    const recovered = await restored.snapshot();
    assert.equal(recovered.version, 2);
    assert.ok(
      recovered.intents.every((intent) => intent.independentlyAcknowledged),
    );

    const state = await inspectDeletionJournal(
      {},
      {
        loadDeletionConfig: () => restoredConfig,
        openDeletionJournal: (c) => openDeletionJournal(c, verifiedFetch),
      },
    );
    assert.equal(state.ok, true);
    assert.equal(state.proofValid, true);
    assert.equal(state.journalComplete, true);
    assert.equal(state.capacityAvailable, true);
    assert.equal(JSON.stringify(state).includes(genesis.body.journalId), false);
    assert.equal(JSON.stringify(state).includes("synthetic_user"), false);
    assert.equal(JSON.stringify(state).includes(config.key), false);
  },
);
