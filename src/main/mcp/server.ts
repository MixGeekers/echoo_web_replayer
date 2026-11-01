import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";

export interface MCPConnectionHello { connectionId: string; clientId: string; name: string; credential: string | null; }
export interface LocalMCPServerOptions {
  root: string;
  instanceId: string;
  onConnect: (hello: MCPConnectionHello) => Promise<{credential: string; pending: boolean; pairingCode?: string}>;
  onDisconnect: (connectionId: string) => Promise<void> | void;
  onCall: (connectionId: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
}
export interface MCPDiscovery { version: 1; instanceId: string; endpoint: string; secret: string; pid: number; }
const MAX_FRAME = 2 * 1024 * 1024;
function safeEqual(a: unknown, b: string) { return typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request"); return value as Record<string, unknown>; }

/** Owner-only discovery and a random handshake key keep the local RPC separate from web content. */
export async function createMCPServer(options: LocalMCPServerOptions) {
  await fs.mkdir(options.root, {recursive: true, mode: 0o700});
  await fs.chmod(options.root, 0o700).catch(() => {});
  const secret = randomBytes(32).toString("hex"), suffix = randomBytes(12).toString("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\tracedock-${suffix}` : path.join(os.tmpdir(), `tracedock-${process.getuid?.() ?? "user"}-${suffix}.sock`);
  const discoveryPath = path.join(options.root, "instance.json");
  const sockets = new Map<net.Socket, string>();
  const server = net.createServer(socket => {
    const connectionId = `connection-${randomUUID()}`;
    let authenticated = false, closed = false, buffer = "", connecting: Promise<void> | null = null;
    const send = (id: unknown, result?: unknown, error?: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(error ? {id,error} : {id,result}) + "\n"); };
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => { closed = true; sockets.delete(socket); if(authenticated) void Promise.resolve(options.onDisconnect(connectionId)).catch(() => {}); });
    async function receive(raw: unknown) {
      let id: unknown = null;
      try {
        const request = record(raw); id = request.id;
        if (!Number.isSafeInteger(id) || Number(id) < 0) throw new Error("Invalid request id");
        const params = record(request.params ?? {});
        if(request.method === "hello") {
          if(authenticated || connecting) throw new Error("Already connected");
          if(!safeEqual(params.secret, secret)) throw new Error("Invalid local handshake");
          if(typeof params.clientId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(params.clientId)) throw new Error("Invalid client id");
          if(typeof params.name !== "string" || !params.name.trim() || params.name.length > 120) throw new Error("Invalid client name");
          const hello: MCPConnectionHello = {connectionId, clientId: params.clientId, name: params.name, credential: typeof params.credential === "string" ? params.credential : null};
          connecting = (async () => {
            const result = await options.onConnect(hello);
            if(closed) { await options.onDisconnect(connectionId); return; }
            authenticated = true; sockets.set(socket, connectionId);
            send(id, {...result, connectionId, instanceId: options.instanceId});
          })();
          await connecting; return;
        }
        if(connecting) await connecting;
        if(!authenticated) throw new Error("Handshake required");
        if(request.method === "ping") { send(id, {alive: true}); return; }
        if(request.method !== "call" || typeof params.name !== "string") throw new Error("Unknown request");
        send(id, await options.onCall(connectionId, params.name, record(params.arguments ?? {})));
      } catch(error) { send(id, undefined, {message: error instanceof Error ? error.message : String(error)}); }
    }
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if(Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); return; }
      let newline: number;
      while((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if(!line.trim()) continue;
        try { void receive(JSON.parse(line)); } catch { socket.destroy(); return; }
      }
    });
    const handshakeTimeout = setTimeout(() => { if(!authenticated) socket.destroy(); }, 15_000); handshakeTimeout.unref(); socket.once("close", () => clearTimeout(handshakeTimeout));
  });
  await new Promise<void>((resolve,reject) => { server.once("error", reject); server.listen(endpoint, () => { server.removeListener("error", reject); resolve(); }); });
  if(process.platform !== "win32") await fs.chmod(endpoint, 0o600);
  const discovery: MCPDiscovery = {version: 1, instanceId: options.instanceId, endpoint, secret, pid: process.pid};
  const temporary = `${discoveryPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(discovery), {mode: 0o600}); await fs.rename(temporary, discoveryPath);
  let stopped = false;
  return {
    discoveryPath,
    disconnect(connectionId: string) { for(const [socket,id] of sockets) if(id === connectionId) socket.destroy(); },
    async close() {
      if(stopped) return; stopped = true;
      for(const socket of sockets.keys()) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { const current = JSON.parse(await fs.readFile(discoveryPath,"utf8")) as MCPDiscovery; if(current.instanceId === options.instanceId) await fs.rm(discoveryPath,{force:true}); } catch {}
      if(process.platform !== "win32") await fs.rm(endpoint,{force:true});
    },
  };
}
