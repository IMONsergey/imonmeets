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
