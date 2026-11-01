import assert from "node:assert/strict";
import { test } from "node:test";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  AudioCodec,
  EgressInfo,
  EncodedFileType,
  EncodingOptions,
  VideoCodec,
} from "livekit-server-sdk";
import { loadConfig } from "../src/config.js";
import { createMedia } from "../src/media.js";

test("recording RPC keeps the private S3 output and bounded interoperable MP4 encoding", async () => {
  const c = loadConfig({
    DATABASE_URL: "postgres://test.invalid/test",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    LIVEKIT_INTERNAL_URL: "http://livekit.invalid:7880",
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret-at-least-32-characters",
    S3_BUCKET: "imon-recordings",
    S3_ENDPOINT: "http://recording-storage:8333",
    S3_PUBLIC_ENDPOINT: "https://download.invalid:8443",
    S3_ACCESS_KEY_ID: "unit-test-access",
    S3_SECRET_ACCESS_KEY: "unit-test-secret",
    S3_FORCE_PATH_STYLE: "true",
  });
  const media = createMedia(c);
  let called = false;
  media.egress.startRoomCompositeEgress = async (room, output, options) => {
    called = true;
    assert.equal(room, "room-generation-2");
    assert.ok("file" in output && output.file);
    assert.equal(output.file.fileType, EncodedFileType.MP4);
    assert.equal(output.file.filepath, "recordings/workspace/recording.mp4");
    assert.equal(output.file.disableManifest, true);
    assert.equal(output.file.output.case, "s3");
    if (output.file.output.case !== "s3")
      throw new Error("Expected private S3");
    assert.equal(
      output.file.output.value.endpoint,
      "http://recording-storage:8333",
    );
    assert.equal(output.file.output.value.bucket, "imon-recordings");
    assert.equal(output.file.output.value.forcePathStyle, true);
    assert.equal(output.file.output.value.accessKey, "unit-test-access");
    assert.ok(options && typeof options === "object");
    assert.equal(options.layout, "grid");
    const encoding = options?.encodingOptions;
    assert.ok(encoding instanceof EncodingOptions);
    assert.equal(encoding.width, 1280);
    assert.equal(encoding.height, 720);
    assert.equal(encoding.framerate, 15);
    assert.equal(encoding.videoCodec, VideoCodec.H264_MAIN);
    assert.equal(encoding.videoBitrate, 1200);
    assert.equal(encoding.audioCodec, AudioCodec.AAC);
    assert.equal(encoding.audioBitrate, 64);
    assert.equal(encoding.audioFrequency, 48000);
    assert.equal(encoding.keyFrameInterval, 4);
    return new EgressInfo({ egressId: "bounded-egress" });
  };
  assert.equal(
    (
      await media.start(
        "room-generation-2",
        "recordings/workspace/recording.mp4",
      )
    ).egressId,
    "bounded-egress",
  );
  assert.equal(called, true);
});

test("S3 cleanup removes only the exact MP4 and legacy manifest, and retries a failed manifest deletion", async (t) => {
  const workspaceId = "c5eaf202-5b95-463e-97a3-85c6165c22bf";
  const recordingId = "afbe3c12-e107-46dc-a886-04bddf3aa6f5";
  const key = `recordings/${workspaceId}/${recordingId}.mp4`;
  const egressId = "EG_legacyCapture_123";
  const manifestKey = `recordings/${workspaceId}/${egressId}.json`;
  const requests: { bucket: string | undefined; key: string | undefined }[] =
    [];
  let manifestFails = true;
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    assert.ok(command instanceof DeleteObjectCommand);
    requests.push({ bucket: command.input.Bucket, key: command.input.Key });
    if (command.input.Key === manifestKey && manifestFails)
      throw Object.assign(new Error("Test manifest deletion denied"), {
        name: "AccessDenied",
      });
    return { $metadata: {} };
  });
  const media = createMedia(
    loadConfig({
      DATABASE_URL: "postgres://test.invalid/test",
      DEV_ALLOW_UNVERIFIED_EMAIL: "true",
      LIVEKIT_INTERNAL_URL: "http://livekit.invalid:7880",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "test-secret-at-least-32-characters",
      S3_BUCKET: "imon-recordings",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: "http://storage.invalid:8333",
      S3_ACCESS_KEY_ID: "unit-test-access",
      S3_SECRET_ACCESS_KEY: "unit-test-secret",
      S3_FORCE_PATH_STYLE: "true",
    }),
  );
  await assert.rejects(media.delete(key, egressId), { name: "AccessDenied" });
  assert.deepEqual(requests, [
    { bucket: "imon-recordings", key },
    { bucket: "imon-recordings", key: manifestKey },
  ]);
  manifestFails = false;
  await media.delete(key, egressId);
  assert.deepEqual(requests.slice(2), [
    { bucket: "imon-recordings", key },
    { bucket: "imon-recordings", key: manifestKey },
  ]);
  await media.delete(key, "EG_../../unrelated-recording");
  assert.deepEqual(requests.slice(4), [{ bucket: "imon-recordings", key }]);
});
