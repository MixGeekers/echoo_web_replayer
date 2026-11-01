import type { SessionStore } from "../storage/session-store";
import { ResourceCapture } from "./capture";
import type { ResourceHost } from "./capture";
import { ResourceCatalog } from "./catalog";
import { ResourceProtocol } from "./protocol";
import type { ResourceRequest } from "./protocol";

/** Application facade; capture, catalog and offline serving have separate state. */
export class ResourceRecorder {
  private readonly capture: ResourceCapture;
  private readonly catalogReader: ResourceCatalog;
  private readonly protocol: ResourceProtocol;
  constructor(
    store: SessionStore,
    host: ResourceHost,
    onChange: () => void = () => {},
  ) {
    this.catalogReader = new ResourceCatalog(store);
    this.protocol = new ResourceProtocol(store, this.catalogReader);
    this.capture = new ResourceCapture(store, host, (id) => {
      if (id) this.catalogReader.invalidate(id);
      onChange();
    });
  }
  async init(root: string): Promise<this> {
    await this.capture.init(root);
    return this;
  }
  start(id: string | null): Promise<void> {
    return this.capture.start(id);
  }
  stop(): Promise<void> {
    return this.capture.stop();
  }
  flush(): Promise<void> {
    return this.capture.flush();
  }
  close(): Promise<void> {
    return this.capture.close();
  }
  catalog(id: string) {
    return this.catalogReader.read(id);
  }
  get captureError(): string | null { return this.capture.error; }
  summary(id: string, endSeq = Infinity) {
    return this.catalogReader.summary(id, endSeq, this.capture.error);
  }
  respond(request: ResourceRequest): Promise<Response> {
    return this.protocol.respond(request);
  }
}
