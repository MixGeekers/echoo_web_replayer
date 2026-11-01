export type MCPCapability = "read" | "capture" | "browser" | "organize" | "export";
export type MCPPermissions = Record<MCPCapability, boolean>;
export interface MCPConnection {
  id: string; clientId: string; name: string; pairingCode: string;
  status: "pending" | "connected" | "disconnected" | "revoked";
  profileIds: string[]; permissions: MCPPermissions;
  requestedControl?: {profileId: string; sessionId?: string};
  lastSeenAt: string;
}
export interface MCPControl {
  connectionId: string; profileId: string; leaseId: string;
  expiresAt: string; status: "reserved" | "active"; browserEpoch: number;
}
export interface MCPActivity {id: string; at: string; actor: string; message: string; detail?: string;}
export interface MCPOperation {id: string; kind: string; status: string; progress?: string; path?: string; error?: string;}
export interface MCPDeletePlan {id: string; connectionId: string; summary: string; items: string[]; expiresAt: string; approved: boolean;}
export interface MCPState {
  enabled: boolean; instanceId: string; connections: MCPConnection[]; control: MCPControl | null;
  captureOwner: {recordingId: string; connectionId: string | null} | null;
  activity: MCPActivity[]; operations: MCPOperation[]; deletePlans: MCPDeletePlan[];
}
export type MCPCommand =
  | {action: "enable"; enabled: boolean}
  | {action: "grant"; connectionId: string; profileIds: string[]; permissions: MCPPermissions}
  | {action: "deny" | "controlDeny" | "disconnect" | "revoke"; connectionId: string}
  | {action: "controlApprove"; connectionId: string; profileId: string}
  | {action: "takeover"}
  | {action: "approveDelete"; planId: string}
  | {action: "cancelOperation"; operationId: string}
  | {action: "revealOperation"; operationId: string};
export interface MCPConfig {command: string; args: string[]; env?: Record<string, string>; instanceId?: string;}
