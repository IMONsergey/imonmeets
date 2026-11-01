import type { MeetingEmbedEvent } from "./embed-protocol.js";
export type {
  MeetingEmbedEvent,
  MeetingEmbedState,
  MeetingEmbedErrorCode,
} from "./embed-protocol.js";
export declare function mountMeeting(options: {
  container: HTMLElement;
  /** Canonical origin only, e.g. https://imonmeets.vercel.app. */
  appUrl: string;
  room: string;
  /** Prefill only; the participant chooses when to join. */
  name?: string;
  title?: string;
  height?: number;
  timeoutMs?: number;
  onEvent?: (event: MeetingEmbedEvent) => void;
}): Readonly<{
  iframe: HTMLIFrameElement;
  ready: Promise<void>;
  leave(): void;
  destroy(): void;
}>;
