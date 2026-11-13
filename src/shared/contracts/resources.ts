export interface ResourceEntry {
  pageId?: string | undefined;
  activePageId?: string | undefined;
  url: string;
  mimeType?: string | undefined;
  type?: string | undefined;
  statusCode?: number | undefined;
  capturedAt?: string | undefined;
  status: "saved" | "missing";
  sha256?: string | undefined;
  bytes?: number | undefined;
  error?: string | undefined;
}
export interface ResourceRecord extends ResourceEntry {
  seq: number;
  elapsedMs: number;
}
export interface ResourceSummary {
  available: boolean;
  saved: number;
  missing: number;
  missingURLs: string[];
  bytes: number;
  captureError: string | null;
}
