import assert from "node:assert/strict";
import { test } from "node:test";
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
