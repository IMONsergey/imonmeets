#!/usr/bin/env python3
"""Build and exercise the exact receiver image using only isolated synthetic data.

No public ports, production keys, independent-host acceptance or app deployment.
The image is built from a clean Git archive; all test containers are scope owned.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ["sudo", "-n", "docker"]
KEY = "synthetic-receiver-image-journal-key-never-deployed-20261103"
TOKEN = "synthetic-receiver-image-http-token-never-deployed-20261103"


def run(args, *, cwd=ROOT, timeout=30, check=True):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                            timeout=timeout, check=False)
    if check and result.returncode:
        raise RuntimeError("Isolated command failed: " + " ".join(args[:5]) +
                           "\n" + result.stderr[-4000:])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    if os.getuid() != 1000:
        raise RuntimeError("This isolated image acceptance requires the documented host UID1000")
    if run(["git", "status", "--porcelain"]).stdout.strip():
        raise RuntimeError("Commit receiver sources before image acceptance")
    commit = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    output = Path(args.output_dir).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    output.chmod(0o700)
    os.umask(0o077)
    scope = "imon-witness-image-" + uuid.uuid4().hex
    name = scope + "-service"
    receipt = {"schema": 1, "kind": "deletion-witness-image-acceptance",
               "sourceCommit": commit, "startedAt": datetime.now(timezone.utc).isoformat(),
               "productionChanges": False, "deployed": False,
               "independentHostAccepted": False, "checks": [], "status": "RUNNING"}

    def passed(label):
        receipt["checks"].append(label)
        print("PASS " + label, flush=True)

    def cleanup():
        ids = run(DOCKER + ["ps", "-aq", "--filter", "label=imonmeets.scope=" + scope]).stdout.split()
        for identifier in ids:
            run(DOCKER + ["rm", "-f", identifier])
        remaining = run(DOCKER + ["ps", "-aq", "--filter", "label=imonmeets.scope=" + scope]).stdout.strip()
        if remaining:
            raise RuntimeError("Owned receiver test containers remain")
        receipt["cleanupVerified"] = True

    try:
        with tempfile.TemporaryDirectory(prefix="imon-witness-image-") as directory:
            folder = Path(directory)
            archive = folder / "source.tar"
            context = folder / "context"
            context.mkdir(mode=0o700)
            run(["git", "archive", "--format=tar", "--output=" + str(archive), commit])
            receipt["sourceArchiveSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
            run(["tar", "-xf", str(archive), "-C", str(context)])
            dockerfile = context / "apps/deletion-witness/Dockerfile"
            if any(line.strip().upper().startswith("RUN ") for line in dockerfile.read_text().splitlines()):
                raise RuntimeError("Receiver image gained RUN steps; extend bounded builder observation first")
            tag = "imonmeets-deletion-witness:candidate-" + commit
            build = run(["sudo", "-n", "env", "DOCKER_BUILDKIT=0", "docker", "build",
                         "--cpu-period=100000", "--cpu-quota=100000", "--memory=2g", "--memory-swap=2g",
                         "--force-rm", "--build-arg", "VCS_REF=" + commit,
                         "--label", "world.imon.component=deletion-witness",
                         "--file", str(dockerfile), "--tag", tag, str(context)], timeout=120)
            (output / "build.log").write_text(build.stdout + build.stderr)
            info = json.loads(run(DOCKER + ["image", "inspect", tag]).stdout)[0]
            image = info["Id"]
            if info["Config"]["Labels"].get("org.opencontainers.image.revision") != commit or info["Config"]["User"] != "node":
                raise RuntimeError("Receiver image identity or runtime user differs")
            receipt.update({"imageId": image, "imageTag": tag,
                            "serverSha256": hashlib.sha256((context / "apps/deletion-witness/server.mjs").read_bytes()).hexdigest()})
            passed("clean source archive, pinned base and non-root image identity")
            private, data = folder / "private", folder / "data"
            private.mkdir(mode=0o700)
            data.mkdir(mode=0o700)
            fixture = r'''
import {initializeDeletionJournal,canonicalJson} from './apps/api/dist/deletion-journal.js';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const folder=process.argv[1];
await initializeDeletionJournal({directory:folder+'/application',key:process.argv[2],required:false,witnessUrl:'',witnessToken:'',witnessPublicKey:''});
const raw=await readFile(folder+'/application/metadata.json');
const genesis=JSON.parse(raw);
const pair=generateKeyPairSync('ed25519');
await writeFile(folder+'/private/genesis.json',raw,{mode:0o600});
await writeFile(folder+'/private/signing.pem',pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
await writeFile(folder+'/private/public.pem',pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
console.log(JSON.stringify({journalId:genesis.body.journalId,genesisSha256:createHash('sha256').update(canonicalJson(genesis)).digest('hex')}));
'''
            enrollment = json.loads(run(["node", "--input-type=module", "-e", fixture, str(folder), KEY]).stdout)
            environment = {"WITNESS_DIRECTORY": "/data", "WITNESS_STORAGE_ROLE": "independent-durable",
                           "WITNESS_ALLOWED_JOURNAL_ID": enrollment["journalId"],
                           "WITNESS_ALLOWED_GENESIS_SHA256": enrollment["genesisSha256"],
                           "WITNESS_GENESIS_PATH": "/run/imon/genesis.json",
                           "WITNESS_SIGNING_KEY_FILE": "/run/imon/signing.pem",
                           "WITNESS_JOURNAL_KEY": KEY, "WITNESS_API_TOKEN": TOKEN}
            env_file = folder / "fixture.env"
            env_file.write_text("".join(key + "=" + value + "\n" for key, value in environment.items()))
            common = ["--rm", "--label", "imonmeets.scope=" + scope, "--network", "none",
                      "--read-only", "--cpus", "0.5", "--memory", "256m", "--pids-limit", "64",
                      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                      "--tmpfs", "/tmp:size=8m,mode=1777", "--env-file", str(env_file),
                      "--mount", "type=bind,src=" + str(data) + ",dst=/data",
                      "--mount", "type=bind,src=" + str(private) + ",dst=/run/imon,readonly"]

            def ephemeral(*arguments, expected_success=True):
                result = run(DOCKER + ["run"] + common + [image, *arguments], timeout=15, check=False)
                if (result.returncode == 0) != expected_success:
                    raise RuntimeError("Unexpected isolated receiver exit: " + result.stderr[-1000:])
                return result

            ephemeral("--initialize")
            anchor = data / "high-water.json"
            initial = anchor.read_bytes()
            if json.loads(initial)["body"]["version"] != 0 or anchor.stat().st_mode & 0o777 != 0o600:
                raise RuntimeError("Initialization did not persist a private zero-version anchor")
            passed("image forwards explicit initialization and preserves private file mode")
            ephemeral("--initialize", expected_success=False)
            if anchor.read_bytes() != initial:
                raise RuntimeError("Repeated initialization changed durable history")
            passed("repeated initialization fails without replacing enrolled history")

            def node(code):
                return run(DOCKER + ["exec", name, "node", "--input-type=module", "-e", code], timeout=15)

            def start():
                run(DOCKER + ["run", "-d", "--name", name] + common + [image])
                deadline = time.monotonic() + 10
                while True:
                    result = run(DOCKER + ["exec", name, "node", "-e",
                        "fetch('http://127.0.0.1:3551/health',{headers:{Authorization:'Bearer '+process.env.WITNESS_API_TOKEN}}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"], check=False, timeout=5)
                    if result.returncode == 0:
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Isolated receiver did not become healthy")
                    time.sleep(0.1)

            def stop():
                run(DOCKER + ["stop", "--time", "3", name], timeout=10)

            start()
            if node("console.log(process.getuid())").stdout.strip() != "1000":
                raise RuntimeError("Receiver image test did not run with its documented UID")
            ephemeral(expected_success=False)
            if anchor.read_bytes() != initial:
                raise RuntimeError("Competing writer changed history")
            passed("non-root service holds exclusive kernel lock across a competing container")
            append = r'''
import {readFile} from 'node:fs/promises';
import {createHmac,randomUUID,randomBytes,verify} from 'node:crypto';
import {canonicalJson,digest} from '/app/server.mjs';
const genesis=JSON.parse(await readFile('/run/imon/genesis.json','utf8'));
const body={schema:1,journalId:genesis.body.journalId,id:randomUUID(),requestedAt:Date.now(),actorId:'synthetic_user',target:{kind:'account',accountId:'synthetic_user'}};
const intent={body,mac:createHmac('sha256',process.env.WITNESS_JOURNAL_KEY).update(canonicalJson(body)).digest('hex')};
const nonce=randomBytes(32).toString('base64url');
const response=await fetch('http://127.0.0.1:3551/intents',{method:'POST',headers:{Authorization:'Bearer '+process.env.WITNESS_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({nonce,genesis,intent})});
if(response.status!==200)throw new Error('Append failed');
const proof=await response.json();
const key=await readFile('/run/imon/public.pem');
if(proof.body.version!==1||proof.body.nonce!==nonce||proof.body.intentId!==body.id||proof.body.intentSha256!==digest(intent)||!verify(null,Buffer.from(canonicalJson(proof.body)),key,Buffer.from(proof.signature,'base64url')))throw new Error('Invalid append proof');
console.log(JSON.stringify({id:body.id,version:proof.body.version,signatureValid:true}));
'''
            accepted = json.loads(node(append).stdout)
            intent_file = data / (accepted["id"] + ".intent.json")
            if not intent_file.exists() or json.loads(anchor.read_text())["body"]["version"] != 1:
                raise RuntimeError("Acknowledged record or restart anchor not persisted")
            passed("real container acknowledges a signed intent only with a persisted full anchor")
            stop()
            start()
            checkpoint = node("const r=await fetch('http://127.0.0.1:3551/checkpoint',{method:'POST',headers:{Authorization:'Bearer '+process.env.WITNESS_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({journalId:process.env.WITNESS_ALLOWED_JOURNAL_ID,nonce:'A'.repeat(43)})});const p=await r.json();if(r.status!==200||p.body.version!==1)throw new Error('Restart lost journal head');console.log('version1');")
            if checkpoint.stdout.strip() != "version1":
                raise RuntimeError("Restart checkpoint not established")
            passed("restarted container retains the exact acknowledged journal version")
            stop()
            saved_intent = private / "saved-intent.json"
            intent_file.rename(saved_intent)
            ephemeral(expected_success=False)
            if intent_file.exists() or json.loads(anchor.read_text())["body"]["version"] != 1:
                raise RuntimeError("Missing intent was silently repaired or anchor reduced")
            saved_intent.rename(intent_file)
            passed("missing acknowledged intent prevents restart without shrinking history")
            saved_anchor = private / "saved-anchor.json"
            anchor.rename(saved_anchor)
            ephemeral(expected_success=False)
            if anchor.exists():
                raise RuntimeError("Normal container startup recreated a missing anchor")
            saved_anchor.rename(anchor)
            passed("normal image startup never initializes a lost restart anchor")
            start()
            stop()
            passed("restoring the exact retained fixture allows a healthy restart")
            if run(["git", "rev-parse", "HEAD"]).stdout.strip() != commit or run(["git", "status", "--porcelain"]).stdout.strip():
                raise RuntimeError("Source changed during receiver image acceptance")
            receipt["status"] = "PASS"
    except BaseException as error:
        receipt["status"] = "FAIL"
        receipt["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        try:
            cleanup()
        except BaseException as error:
            receipt["status"] = "FAIL"
            receipt["cleanupError"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            receipt["completedAt"] = datetime.now(timezone.utc).isoformat()
            (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    main()
