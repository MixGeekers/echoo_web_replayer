import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cssText } from "../../shared/resource-urls";
import type { SessionStore } from "../storage/session-store";
import type { ResourceCatalog } from "./catalog";
export interface ResourceRequest {
  method: string;
  url: string;
}

/** Only serves archived bytes or bundled demo assets; never requests the origin. */
export class ResourceProtocol {
  constructor(
    private readonly store: SessionStore,
    private readonly catalog: ResourceCatalog,
    private readonly bundledRoot = __dirname,
  ) {}
  async respond(request: ResourceRequest): Promise<Response> {
    let id: string | undefined,
      url: string | null = null;
    try {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const requestURL = new URL(request.url);
      if (requestURL.hostname !== "asset")
        return new Response(null, { status: 404 });
      id = decodeURIComponent(requestURL.pathname.slice(1));
      url = requestURL.searchParams.get("url");
      const at = Math.max(0, Number(requestURL.searchParams.get("at")) || 0),
        endSeq = Math.max(
          0,
          Number(requestURL.searchParams.get("end") ?? at) || 0,
        );
      const entries = (await this.catalog.read(id)).filter(
        (entry) => entry.url === url && entry.sha256 && entry.seq <= endSeq,
      );
      const entry =
        entries.filter((entry) => entry.seq <= at).at(-1) || entries[0];
      if (!entry) {
        if (url?.startsWith("file:")) {
          const file = fileURLToPath(url);
          if (
            ["demo", "shared"].some((folder) =>
              file.startsWith(path.join(this.bundledRoot, folder) + path.sep),
            ) &&
            /\.(css|svg|png|jpg|woff2?)$/i.test(file)
          ) {
            const data = await fs.readFile(file),
              mime = file.endsWith(".css")
                ? "text/css"
                : file.endsWith(".svg")
                  ? "image/svg+xml"
                  : "application/octet-stream";
            return this.response(data, mime, url, id, at, endSeq);
          }
        }
        if (url) this.catalog.missing(id, url);
        return new Response(null, { status: 404 });
      }
      if (!url || !entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256))
        throw new Error("无效的资源路径");
      const body = await fs.readFile(
        path.join(this.store.getSessionDirectory(id), "assets", entry.sha256),
      );
      if (createHash("sha256").update(body).digest("hex") !== entry.sha256)
        throw new Error("资源校验失败");
      this.catalog.found(id, url);
      return this.response(body, entry.mimeType, url, id, at, endSeq);
    } catch {
      if (id && url && this.catalog.has(id)) this.catalog.missing(id, url);
      return new Response(null, { status: 404 });
    }
  }
  response(
    body: Buffer,
    mimeType: string | undefined,
    url: string,
    id: string,
    at: number,
    endSeq: number,
  ): Response {
    const data =
      mimeType === "text/css"
        ? Buffer.from(cssText(body.toString("utf8"), url, id, at, endSeq))
        : body;
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline' tracedock-resource:; img-src data: tracedock-resource:; font-src data: tracedock-resource:",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
