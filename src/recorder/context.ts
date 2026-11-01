import type { RecorderSend } from "../shared/contracts/recording";
import type { NodeRegistry } from "./nodes";
export interface RecorderContext {
  nodes: NodeRegistry;
  isRecording(): boolean;
  send: RecorderSend;
  report(operation: string, error: unknown): void;
}
