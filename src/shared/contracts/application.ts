import type { FrameVisual, FramePatch } from "../frame-visual";
import type { RecorderPayloadMap } from "./recording";
import type { NetworkPayloadMap } from "./network";
export const frameControlKeys = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
export interface FrameSelector {
  selector: string;
  shadowPath: string[];
}
export interface FrameActionTarget extends FrameSelector {
  inputType?: string;
  editable?: boolean;
}
export interface FrameActionPayload {
  action: string;
  element: string;
  /** Document-local element number, only meaningful until navigation. */
  node: number;
  visualNodeId?: string;
  framePath?: FrameSelector[];
  target?: FrameActionTarget;
  checked?: boolean;
  selectedIndices?: number[];
  controlKey?: string;
  modifiers?: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
  detail?: number;
  button?: number;
  scroll?: { x: number; y: number };
  documentId: string;
  frameId: string;
  origin: string;
}
export interface ApplicationPayloadMap extends NetworkPayloadMap {
  "frame.snapshot": FrameVisual;
  "frame.mutation": FramePatch;
  "frame.detach": { documentId: string };
  "action.frame": FrameActionPayload;
  "session.start": { name: string; appVersion: string; redaction: boolean };
  "session.pause": { reason: string };
  "session.resume": { reason: string; note: string };
  "session.stop": { reason: string };
  "page.navigation": {
    url: string;
    sameDocument: boolean;
    httpResponseCode?: number;
  };
  "page.error": { errorCode: number; errorDescription: string; url: string };
  "page.popup": { url: string; disposition: string };
  "recorder.error": {
    message: string;
    possibleGap?: boolean;
    command?: string;
    reason?: string;
    operation?: string;
    exitCode?: number;
  };
}
export type LivePayloadMap = Omit<RecorderPayloadMap, "recorder.error"> &
  ApplicationPayloadMap;
export type ApplicationEventSink = <K extends keyof ApplicationPayloadMap>(
  type: K,
  payload: ApplicationPayloadMap[K],
) => void;
