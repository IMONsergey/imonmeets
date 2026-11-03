import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EgressInfo,
  EgressStatus,
  EncodedFileOutput,
} from "livekit-server-sdk";
import { recordingTransition, matchesRecording } from "../src/recordings.js";
const key = "recordings/workspace/recording.mp4";
test("recording lifecycle cannot regress and completion requires exact output", () => {
  const starting = new EgressInfo({ status: EgressStatus.EGRESS_STARTING });
  const active = new EgressInfo({ status: EgressStatus.EGRESS_ACTIVE });
  assert.equal(recordingTransition("active", starting, key), null);
  assert.equal(recordingTransition("ending", active, key), null);
  assert.equal(recordingTransition("complete", active, key), null);
  const missing = new EgressInfo({ status: EgressStatus.EGRESS_COMPLETE });
  assert.equal(recordingTransition("active", missing, key)?.status, "failed");
  const mismatch = new EgressInfo({
    status: EgressStatus.EGRESS_COMPLETE,
    fileResults: [{ filename: "other.mp4", size: 10n }],
  });
  assert.equal(recordingTransition("active", mismatch, key)?.status, "failed");
  const complete = new EgressInfo({
    status: EgressStatus.EGRESS_COMPLETE,
    fileResults: [{ filename: key, size: 10n }],
  });
  assert.equal(
    recordingTransition("ending", complete, key)?.status,
    "complete",
  );
});
test("correlation requires exact recording object key, including before file results exist", () => {
  const info = new EgressInfo({
    request: {
      case: "roomComposite",
      value: { fileOutputs: [new EncodedFileOutput({ filepath: key })] },
    },
  });
  assert.equal(matchesRecording(info, key), true);
  assert.equal(matchesRecording(info, "recordings/workspace/next.mp4"), false);
});

test("limit-reached preserves a matching recorded file and warns about truncation", () => {
  const complete = new EgressInfo({
    status: EgressStatus.EGRESS_LIMIT_REACHED,
    fileResults: [{ filename: key, size: 40n }],
  });
  assert.equal(
    recordingTransition("active", complete, key)?.status,
    "complete",
  );
  assert.match(recordingTransition("active", complete, key)!.error!, /лимиту/);
  assert.equal(
    recordingTransition(
      "active",
      new EgressInfo({ status: EgressStatus.EGRESS_LIMIT_REACHED }),
      key,
    )?.status,
    "failed",
  );
});
test("modern egress request correlates by exact output path", () => {
  const info = new EgressInfo({
    request: {
      case: "egress",
      value: {
        outputs: [{ config: { case: "file", value: { filepath: key } } }],
      },
    },
  });
  assert.equal(matchesRecording(info, key), true);
  assert.equal(matchesRecording(info, "different"), false);
});

// Egress v1.15 uses the same status/error for its duration and storage limits.
// The real short size fixture finalized a valid MP4 at 1,482,622 bytes after a
// 1 MiB stop threshold; the product must not invent a duration-only cause.
test("a completed size-limited capture does not claim a duration-only stop", () => {
  const info = new EgressInfo({
    status: EgressStatus.EGRESS_LIMIT_REACHED,
    error: "Session limit reached",
    details: "End reason: Session limit reached",
    fileResults: [{ filename: key, size: 1482622n }],
  });
  const result = recordingTransition("active", info, key);
  assert.equal(result?.status, "complete");
  assert.equal(
    result?.error,
    "Запись завершена по лимиту длительности или размера файла.",
  );
});
