import type { RecorderPayloadMap } from "./recording";
import type { NetworkPayloadMap } from "./network";
export interface ApplicationPayloadMap extends NetworkPayloadMap {
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
