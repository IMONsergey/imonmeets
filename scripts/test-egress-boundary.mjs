#!/usr/bin/env node
// Opt-in, isolated acceptance of the pinned Egress file pipeline. No production access.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import {
  EgressInfo,
  WebEgressRequest,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  VideoCodec,
  AudioCodec,
} from "livekit-server-sdk";

assert.equal(process.env.IMON_ISOLATED_EGRESS_ACCEPTANCE, "1");
const runId = process.env.IMON_EGRESS_RUN_ID;
assert.match(runId ?? "", /^[a-z0-9]{8,24}$/);
const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const state =
  "/home/sergey/.local/state/imonmeets-commercial-20261103/recording-boundary-20261103";
const folder = path.join(state, "run-" + runId);
const slice = "imonrec" + runId + ".slice";
const label = "imonmeets.egress.boundary=" + runId;
const net = "imonrec-" + runId;
const names = Object.fromEntries(
  ["redis", "livekit", "fixture", "egress"].map((x) => [x, net + "-" + x]),
);
const secrets = [];
const clean = (value) => {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join("[SECRET]");
  return text
    .replace(/(?:access_token=)[^&\s"']+/g, "access_token=[REDACTED]")
    .replace(
      /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
      "[JWT]",
    );
};
function run(command, args, timeout = 20000, binary = false) {
  try {
    return execFileSync(command, args, {
      encoding: binary ? undefined : "utf8",
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw new Error(
      clean(command + ": " + (e.stderr || e.message)).slice(0, 8000),
    );
  }
}
const docker = (args, timeout) =>
  run("sudo", ["-n", "docker", ...args], timeout).trim();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await pause(300);
  }
  throw last ?? new Error("Bounded wait expired");
}
function removeOwned(name) {
  let value;
  try {
    value = JSON.parse(docker(["inspect", name]))[0];
  } catch {
    return;
  }
  assert.equal(value.Config.Labels["imonmeets.egress.boundary"], runId);
  docker(["rm", "-f", name], 20000);
}
function cleanup() {
  for (const name of Object.values(names).reverse()) removeOwned(name);
  let network;
  try {
    network = JSON.parse(docker(["network", "inspect", net]))[0];
  } catch {
    network = null;
  }
  if (network) {
    assert.equal(network.Labels["imonmeets.egress.boundary"], runId);
    docker(["network", "rm", net]);
  }
  assert.equal(docker(["ps", "-aq", "--filter", "label=" + label]), "");
  assert.equal(
    docker(["network", "ls", "-q", "--filter", "label=" + label]),
    "",
  );
}
if (process.argv.includes("--cleanup")) {
  cleanup();
  for (const name of [
    "rpc-config.json",
    "livekit.json",
    "egress-duration.json",
    "egress-size.json",
    "synthetic-backup-key.pem",
    "synthetic-backup-recipient.pem",
  ])
    rmSync(path.join(folder, name), { force: true });
  const receiptPath = path.join(folder, "receipt.json");
  if (existsSync(receiptPath)) {
    const value = JSON.parse(readFileSync(receiptPath, "utf8"));
    value.outerCleanupVerified = true;
    writeFileSync(receiptPath, JSON.stringify(value, null, 2) + "\n");
  }
  console.log("Owned Egress fixture cleanup verified");
  process.exit(0);
}
assert.equal(
  existsSync(folder),
  false,
  "A fresh run ID is required to preserve earlier evidence",
);
mkdirSync(folder, { recursive: true, mode: 0o700 });
assert.ok(
  readFileSync("/proc/self/cgroup", "utf8").includes("/" + slice + "/"),
  "Run in its bounded aggregate systemd slice",
);
run("sudo", [
  "-n",
  "systemctl",
  "set-property",
  "--runtime",
  slice,
  "CPUQuota=100%",
  "MemoryMax=2147483648",
  "TasksMax=512",
]);
const receipt = {
  result: "RUNNING",
  runId,
  startedAt: new Date().toISOString(),
  sourceHead: run("git", ["-C", root, "rev-parse", "HEAD"]).trim(),
  sourceHash: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
  upstreamSourceCommit: "171423b0b3e7c6531de270b16f1db4f7a6bd2084",
  scope:
    "Short WebEgress runs using the same pinned MP4 file pipeline; synthetic moving canvas and tone; local file output and real encrypted backup/restore. No production or external media.",
  productionBoundaryAccepted: false,
  limits: {
    cpuQuota: "100%",
    memoryMax: 2147483648,
    tasksMax: 512,
    workers: 1,
    aggregateSlice: slice,
  },
  encoding: {
    width: 1280,
    height: 720,
    framerate: 15,
    video: "H264_MAIN",
    videoKbps: 1200,
    audio: "AAC",
    audioKbps: 64,
    audioHz: 48000,
    keyFrameInterval: 4,
  },
  runs: [],
  checks: [],
};
const save = () =>
  writeFileSync(
    path.join(folder, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
const record = (name) => {
  receipt.checks.push(name);
  console.log("PASS " + name);
  save();
};
function safeLog(name, destination) {
  try {
    const value = spawnSync(
      "sudo",
      ["-n", "docker", "logs", "--tail", "1000", name],
      { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
    );
    writeFileSync(
      path.join(folder, destination),
      clean((value.stdout || "") + (value.stderr || "")) + "\n",
      { mode: 0o600 },
    );
  } catch (e) {
    writeFileSync(path.join(folder, destination), clean(e.message));
  }
}
function container(name, image, args, memory, command = []) {
  return docker(
    [
      "run",
      "-d",
      "--pull=never",
      "--name",
      names[name],
      "--label",
      label,
      "--network",
      net,
      "--network-alias",
      name,
      "--cgroup-parent",
      slice,
      "--memory",
      memory,
      "--memory-swap",
      memory,
      "--pids-limit",
      name === "egress" ? "384" : "96",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=5m",
      "--log-opt",
      "max-file=1",
      ...args,
      image,
      ...command,
    ],
    30000,
  );
}
const fixtureCode = `import {createServer} from 'node:http';
const html=\`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic Egress boundary fixture</title><style>html,body{margin:0;background:#13233a}canvas{width:1280px;height:720px}</style></head><body><canvas width="1280" height="720"></canvas><script>
const c=document.querySelector('canvas'),x=c.getContext('2d');let frame=0;
function paint(){frame++;for(let y=0;y<720;y+=32)for(let a=0;a<1280;a+=32){const n=(a*17+y*31+frame*47)%256;x.fillStyle='rgb('+n+','+(255-n)+','+((n*7)%256)+')';x.fillRect(a,y,32,32)}x.fillStyle='#fff';x.font='36px sans-serif';x.fillText('SYNTHETIC BOUNDARY '+frame,30,60)}
paint();setInterval(paint,66);
const ac=new AudioContext({sampleRate:48000}),o=ac.createOscillator(),g=ac.createGain();o.frequency.value=440;g.gain.value=.08;o.connect(g);g.connect(ac.destination);o.start();ac.resume().then(()=>{console.log('START_RECORDING')});
</script></body></html>\`;
createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});r.end(html)}).listen(8080,'0.0.0.0');`;
writeFileSync(path.join(folder, "fixture.mjs"), fixtureCode, { mode: 0o644 });
const key = "boundary" + runId,
  secret = randomBytes(32).toString("hex");
secrets.push(key, secret);
const rpcCode = `import {readFileSync} from 'node:fs';import {createHmac} from 'node:crypto';
const {key,secret}=JSON.parse(readFileSync('/rpc-config.json','utf8'));const method=process.argv[2];
if(!['ListEgress','StartWebEgress','StopEgress'].includes(method))throw Error('Unknown fixture method');
const now=Math.floor(Date.now()/1000),enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const unsigned=enc({alg:'HS256',typ:'JWT'})+'.'+enc({iss:key,sub:'synthetic-boundary-operator',nbf:now-5,exp:now+120,video:{roomRecord:true}});
const token=unsigned+'.'+createHmac('sha256',secret).update(unsigned).digest('base64url');
const response=await fetch('http://livekit:7880/twirp/livekit.Egress/'+method,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:process.argv[3]||'{}',signal:AbortSignal.timeout(20000)});
const text=await response.text();if(!response.ok)throw Error(response.status+' '+text);process.stdout.write(text);`;
writeFileSync(path.join(folder, "rpc.mjs"), rpcCode, { mode: 0o644 });
writeFileSync(
  path.join(folder, "rpc-config.json"),
  JSON.stringify({ key, secret }),
  { mode: 0o644 },
);
const rpc = (method, body = {}) =>
  JSON.parse(
    docker(
      ["exec", names.fixture, "node", "/rpc.mjs", method, JSON.stringify(body)],
      25000,
    ),
  );
let client;
try {
  const imageRefs = {
    egress:
      "sha256:ac244a40268ce1dd1510fbff6eb529609ec68aceff1602343f79be8ca08c355b",
    livekit: "livekit/livekit-server:v1.13.11",
    redis: "redis:7.4-alpine",
    fixture:
      "sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20",
  };
  const images = {};
  for (const [name, ref] of Object.entries(imageRefs))
    images[name] = JSON.parse(docker(["image", "inspect", ref]))[0].Id;
  receipt.images = images;
  receipt.cgroup = run("sudo", [
    "-n",
    "systemctl",
    "show",
    slice,
    "--property=ControlGroup,CPUQuotaPerSecUSec,MemoryMax,TasksMax",
  ]).trim();
  save();
  docker(["network", "create", "--internal", "--label", label, net]);
  container(
    "redis",
    images.redis,
    ["--read-only", "--tmpfs", "/data:size=16m", "--tmpfs", "/tmp:size=16m"],
    "64m",
    ["redis-server", "--save", "", "--appendonly", "no"],
  );
  container(
    "fixture",
    images.fixture,
    [
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--mount",
      "type=bind,src=" +
        path.join(folder, "fixture.mjs") +
        ",dst=/fixture.mjs,readonly",
      "--mount",
      "type=bind,src=" +
        path.join(folder, "rpc.mjs") +
        ",dst=/rpc.mjs,readonly",
      "--mount",
      "type=bind,src=" +
        path.join(folder, "rpc-config.json") +
        ",dst=/rpc-config.json,readonly",
    ],
    "128m",
    ["node", "/fixture.mjs"],
  );
  const livekitConfig = {
    port: 7880,
    bind_addresses: ["0.0.0.0"],
    keys: { [key]: secret },
    redis: { address: "redis:6379" },
    rtc: {
      tcp_port: 7881,
      port_range_start: 40000,
      port_range_end: 40004,
      use_external_ip: false,
    },
    logging: { level: "info" },
  };
  writeFileSync(
    path.join(folder, "livekit.json"),
    JSON.stringify(livekitConfig),
    { mode: 0o644 },
  );
  container(
    "livekit",
    images.livekit,
    [
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--mount",
      "type=bind,src=" +
        path.join(folder, "livekit.json") +
        ",dst=/config.json,readonly",
      "--entrypoint",
      "/livekit-server",
    ],
    "192m",
    ["--config", "/config.json"],
  );
  client = {
    async listEgress(body = {}) {
      return (rpc("ListEgress", body).items || []).map((x) =>
        EgressInfo.fromJson(x, { ignoreUnknownFields: true }),
      );
    },
    async startWebEgress(url, output, options) {
      const request = new WebEgressRequest({
        url,
        awaitStartSignal: options.awaitStartSignal,
        fileOutputs: [output.file],
        options: { case: "advanced", value: options.encodingOptions },
      });
      return EgressInfo.fromJson(rpc("StartWebEgress", request.toJson()), {
        ignoreUnknownFields: true,
      });
    },
  };
  await until(async () => {
    await client.listEgress();
    return true;
  });
  record(
    "isolated API/Redis/fixture ready; no public ports or production credentials",
  );
  for (const phase of [
    { name: "duration", seconds: 12, bytes: 64 * 1024 * 1024 },
    { name: "size", seconds: 90, bytes: 1024 * 1024 },
  ]) {
    console.log("START " + phase.name);
    const config = {
      api_key: key,
      api_secret: secret,
      ws_url: "ws://livekit:7880",
      redis: { address: "redis:6379" },
      insecure: true,
      enable_chrome_sandbox: true,
      health_port: 8080,
      logging: { level: "debug" },
      session_limits: {
        file_output_max_duration: phase.seconds + "s",
        file_output_max_size: phase.bytes,
      },
      cpu_cost: {
        web_cpu_cost: 0.3,
        max_cpu_utilization: 0.99,
        memory_source: "cgroup",
        max_memory: 1.4,
        memory_cost: 0.3,
      },
    };
    writeFileSync(
      path.join(folder, "egress-" + phase.name + ".json"),
      JSON.stringify(config),
      { mode: 0o644 },
    );
    const args = [
      "run",
      "-d",
      "--pull=never",
      "--name",
      names.egress,
      "--label",
      label,
      "--network",
      net,
      "--network-alias",
      "egress",
      "--cgroup-parent",
      slice,
      "--memory",
      "1500m",
      "--memory-swap",
      "1500m",
      "--pids-limit",
      "384",
      "--user",
      "1001:0",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--security-opt=seccomp=" +
        path.join(root, "deploy/egress-chrome-seccomp.json"),
      "--shm-size=128m",
      "--tmpfs",
      "/tmp:size=128m,mode=1777",
      "--tmpfs",
      "/home/egress:size=128m,uid=1001,gid=0,mode=0700",
      "--tmpfs",
      "/home/egress/tmp:size=128m,uid=1001,gid=0,mode=0700",
      "--tmpfs",
      "/out:size=64m,uid=1001,gid=0,mode=0700",
      "--mount",
      "type=bind,src=" +
        path.join(folder, "egress-" + phase.name + ".json") +
        ",dst=/config.json,readonly",
      "-e",
      "EGRESS_CONFIG_FILE=/config.json",
      "-e",
      "HOME=/home/egress",
      "-e",
      "XDG_RUNTIME_DIR=/home/egress/.cache/xdgr",
      "--entrypoint",
      "/tini",
      images.egress,
      "--",
      "/bin/bash",
      "-ec",
      "mkdir -p /home/egress/.cache/xdgr /home/egress/.config/pulse; exec /entrypoint.sh",
    ];
    docker(args, 30000);
    await until(
      () =>
        docker([
          "exec",
          names.egress,
          "curl",
          "--fail",
          "--silent",
          "--max-time",
          "2",
          "http://127.0.0.1:8080/",
        ]) !== undefined,
      30000,
    );
    const outputPath = "/out/" + phase.name + ".mp4";
    const started = await client.startWebEgress(
      "http://fixture:8080/",
      {
        file: new EncodedFileOutput({
          fileType: EncodedFileType.MP4,
          filepath: outputPath,
          disableManifest: true,
        }),
      },
      {
        awaitStartSignal: true,
        encodingOptions: new EncodingOptions({
          width: 1280,
          height: 720,
          framerate: 15,
          videoCodec: VideoCodec.H264_MAIN,
          videoBitrate: 1200,
          audioCodec: AudioCodec.AAC,
          audioBitrate: 64,
          audioFrequency: 48000,
          keyFrameInterval: 4,
        }),
      },
    );
    const observations = [];
    const complete = await until(async () => {
      const values = await client.listEgress({ egressId: started.egressId });
      const info = values[0];
      if (!info) return false;
      observations.push({
        at: new Date().toISOString(),
        status: EgressStatus[info.status],
        bytes: String(info.fileResults[0]?.size ?? 0),
        error: clean(info.error),
      });
      return [
        EgressStatus.EGRESS_COMPLETE,
        EgressStatus.EGRESS_FAILED,
        EgressStatus.EGRESS_ABORTED,
        EgressStatus.EGRESS_LIMIT_REACHED,
      ].includes(info.status) && info.endedAt > 0n
        ? info
        : false;
    }, 120000);
    writeFileSync(
      path.join(folder, phase.name + "-egress.json"),
      clean(JSON.stringify(complete.toJson(), null, 2)) + "\n",
      { mode: 0o600 },
    );
    safeLog(names.egress, phase.name + "-egress.log");
    assert.equal(
      complete.status,
      EgressStatus.EGRESS_LIMIT_REACHED,
      clean(complete.error),
    );
    const file = complete.fileResults.find((x) => x.filename === outputPath);
    assert.ok(
      file && file.size > 0n,
      "Terminal limit response must have the exact completed output",
    );
    const destination = path.join(folder, phase.name + ".mp4");
    const insideSize = Number(
      docker(["exec", names.egress, "stat", "-c", "%s", outputPath]),
    );
    assert.equal(BigInt(insideSize), file.size);
    const bytes = run(
      "sudo",
      ["-n", "docker", "exec", names.egress, "cat", outputPath],
      15000,
      true,
    );
    assert.equal(bytes.length, insideSize);
    writeFileSync(destination, bytes, { mode: 0o600 });
    const size = statSync(destination).size;
    assert.equal(BigInt(size), file.size);
    const probe = JSON.parse(
      run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        destination,
      ]),
    );
    assert.ok(
      probe.streams.some(
        (s) => s.codec_name === "h264" && s.width === 1280 && s.height === 720,
      ),
    );
    assert.ok(
      probe.streams.some(
        (s) => s.codec_name === "aac" && Number(s.sample_rate) === 48000,
      ),
    );
    run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-xerror",
        "-threads",
        "1",
        "-i",
        destination,
        "-f",
        "null",
        "-",
      ],
      60000,
    );
    const pcm = run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-threads",
        "1",
        "-i",
        destination,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      60000,
      true,
    );
    let energy = 0;
    for (let p = 0; p + 1 < pcm.length; p += 2)
      energy += (pcm.readInt16LE(p) / 32768) ** 2;
    const rms = Math.sqrt(energy / (pcm.length / 2));
    assert.ok(rms > 0.005, "Synthetic audio must be audible, not silent AAC");
    const duration = Number(probe.format.duration);
    assert.ok(duration > 1 && duration <= phase.seconds + 3);
    if (phase.name === "size")
      assert.ok(
        size > phase.bytes,
        "Pinned stop threshold must be distinguished from final MP4 maximum",
      );
    const logs = readFileSync(
      path.join(folder, phase.name + "-egress.log"),
      "utf8",
    );
    if (phase.name === "size")
      assert.ok(logs.includes("output storage limit reached"));
    else assert.ok(!logs.includes("output storage limit reached"));
    receipt.runs.push({
      phase: phase.name,
      durationLimitSeconds: phase.seconds,
      stopThresholdBytes: phase.bytes,
      finalBytes: size,
      durationSeconds: duration,
      audioRms: rms,
      sha256: createHash("sha256")
        .update(readFileSync(destination))
        .digest("hex"),
      status: EgressStatus[complete.status],
      sizeOvershootBytes: Math.max(0, size - phase.bytes),
      observations,
      probe,
    });
    record(
      phase.name +
        ": actual Egress limit, exact file metadata, H264/AAC, complete decode and audible synthetic tone",
    );
    removeOwned(names.egress);
  }
  receipt.backup = JSON.parse(
    run(
      "python3",
      [path.join(root, "scripts/verify-egress-boundary-backup.py"), folder],
      90000,
    ),
  );
  record(
    "actual short MP4 encrypted and restored byte-for-byte; equal soft-stop/hard-backup ceiling rejected",
  );
  receipt.result = "PASS_SCALED_EGRESS_BOUNDARY_AND_BACKUP";
} catch (error) {
  receipt.result = "FAIL";
  receipt.error = clean(error.stack || error.message);
  for (const [kind, name] of Object.entries(names))
    safeLog(name, "failure-" + kind + ".log");
  process.exitCode = 1;
} finally {
  try {
    cleanup();
    receipt.cleanupVerified = true;
  } catch (e) {
    receipt.cleanupVerified = false;
    receipt.cleanupError = clean(e.message);
    process.exitCode = 1;
  }
  for (const name of [
    "rpc-config.json",
    "livekit.json",
    "egress-duration.json",
    "egress-size.json",
  ])
    rmSync(path.join(folder, name), { force: true });
  receipt.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      result: receipt.result,
      runs: receipt.runs.map((x) => ({
        phase: x.phase,
        bytes: x.finalBytes,
        seconds: x.durationSeconds,
        overshoot: x.sizeOvershootBytes,
      })),
      error: receipt.error,
      cleanupVerified: receipt.cleanupVerified,
    }),
  );
}
