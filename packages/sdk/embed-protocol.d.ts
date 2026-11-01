export type MeetingEmbedState =
  "prejoin" | "waiting" | "connecting" | "joined" | "reconnecting" | "left";
export type MeetingEmbedErrorCode =
  "CONNECTION_ERROR" | "REQUEST_FAILED" | "INITIALIZATION_FAILED";
export type MeetingEmbedEvent =
  | { type: "ready" }
  | { type: "state"; state: MeetingEmbedState }
  | { type: "error"; code: MeetingEmbedErrorCode };
export type MeetingEmbedCommand =
  { type: "configure"; name?: string } | { type: "leave" };
export declare const EMBED_PROTOCOL: "imon-meets";
export declare const EMBED_VERSION: 1;
export declare const EMBED_STATES: readonly MeetingEmbedState[];
export declare const EMBED_ERRORS: readonly MeetingEmbedErrorCode[];
export declare function exactOrigin(value: unknown): string | null;
export declare function validChannel(value: unknown): value is string;
export declare function frameParameters(
  hash: string,
): { origin: string; channel: string } | null;
export declare function frameEvent(
  data: unknown,
  channel: string,
): MeetingEmbedEvent | null;
export declare function parentCommand(
  data: unknown,
  channel: string,
): MeetingEmbedCommand | null;
export declare function packet(
  channel: string,
  body: MeetingEmbedEvent | MeetingEmbedCommand,
): object;
