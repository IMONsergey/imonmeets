import { EgressStatus, type EgressInfo } from "livekit-server-sdk";
import type { PoolClient, QueryResultRow } from "pg";
export type RecordingStatus =
  "starting" | "active" | "ending" | "complete" | "failed";
const rank: Record<RecordingStatus, number> = {
  starting: 0,
  active: 1,
  ending: 2,
  complete: 3,
  failed: 3,
};
export function matchingOutput(info: EgressInfo, key: string) {
  return info.fileResults.find((file) => file.filename === key);
}
export function matchesRecording(info: EgressInfo, key: string) {
  if (matchingOutput(info, key)) return true;
  if (info.request.case === "roomComposite") {
    const request = info.request.value;
    return (
      request.fileOutputs.some((file) => file.filepath === key) ||
      (request.output.case === "file" && request.output.value.filepath === key)
    );
  }
  if (info.request.case === "egress")
    return info.request.value.outputs.some(
      (output) =>
        output.config.case === "file" && output.config.value.filepath === key,
    );
  return false;
}
export function recordingTransition(
  current: RecordingStatus,
  info: EgressInfo,
  key: string,
): { status: RecordingStatus; error: string | null } | null {
  if (current === "complete" || current === "failed") return null;
  let next: RecordingStatus;
  switch (info.status) {
    case EgressStatus.EGRESS_STARTING:
      next = "starting";
      break;
    case EgressStatus.EGRESS_ACTIVE:
      next = "active";
      break;
    case EgressStatus.EGRESS_ENDING:
      next = "ending";
      break;
    case EgressStatus.EGRESS_COMPLETE:
      return matchingOutput(info, key)
        ? { status: "complete", error: null }
        : { status: "failed", error: "Egress завершен без ожидаемого файла." };
    case EgressStatus.EGRESS_FAILED:
    case EgressStatus.EGRESS_ABORTED:
      return { status: "failed", error: "Egress завершился с ошибкой." };
    case EgressStatus.EGRESS_LIMIT_REACHED:
      return matchingOutput(info, key)
        ? {
            status: "complete",
            error: "Запись завершена по лимиту длительности или размера файла.",
          }
        : {
            status: "failed",
            error: "Лимит записи достигнут, ожидаемый файл отсутствует.",
          };
    default:
      return null;
  }
  return rank[next] >= rank[current] ? { status: next, error: null } : null;
}
export async function applyRecordingInfo(
  db: PoolClient,
  row: QueryResultRow,
  info: EgressInfo,
) {
  const transition = recordingTransition(row.status, info, row.object_key);
  if (!transition) return row;
  const terminal =
      transition.status === "complete" || transition.status === "failed",
    file = matchingOutput(info, row.object_key);
  const result = await db.query(
    "UPDATE im_recordings SET egress_id=$2,status=$3,ended_at=$4,size_bytes=$5,error=$6 WHERE id=$1 RETURNING *",
    [
      row.id,
      info.egressId,
      transition.status,
      terminal ? new Date() : null,
      file ? String(file.size) : row.size_bytes,
      transition.error,
    ],
  );
  return result.rows[0];
}
