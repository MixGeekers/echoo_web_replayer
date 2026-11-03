import { app, dialog } from "electron";
import type { BrowserWindow } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CodegenLanguage,
  CodegenOptions,
  CodegenResult,
  CodegenSaveResult,
} from "../../shared/contracts/codegen";
import { object } from "../../shared/runtime";
import { generateRecordingScript } from "./index";
import type { CodegenStore } from "./index";

const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
function language(value: unknown): CodegenLanguage {
  if (value === undefined || value === "typescript") return "typescript";
  if (value === "python") return "python";
  throw new Error("无效的脚本语言");
}
function sessionId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("参数必须为字符串");
  return value;
}
/** Parse the renderer's request; the generator itself only reads the captured timeline boundary. */
export function parseGenerateRequest(input: unknown): { sessionId: string; options: CodegenOptions } {
  const q = object(input);
  if (q.includeScroll !== undefined && typeof q.includeScroll !== "boolean")
    throw new Error("无效的脚本选项");
  return {
    sessionId: sessionId(q.sessionId),
    options: { language: language(q.language), includeScroll: q.includeScroll === true },
  };
}
export function generateForUI(store: CodegenStore, input: unknown): Promise<CodegenResult> {
  const { sessionId: id, options } = parseGenerateRequest(input);
  return generateRecordingScript(store, id, options);
}
const safeName = (value: string) =>
  value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "recording";

/** Save exactly the code the user is looking at, to a path they choose in the native dialog. */
export async function saveScriptFromUI(
  win: BrowserWindow,
  input: unknown,
  recordingName: (sessionId: string) => string,
): Promise<CodegenSaveResult> {
  const q = object(input);
  const id = sessionId(q.sessionId);
  const lang = language(q.language);
  if (typeof q.code !== "string" || Buffer.byteLength(q.code) > MAX_SCRIPT_BYTES)
    throw new Error("脚本内容无效或过大");
  const base = safeName(recordingName(id));
  const python = lang === "python";
  const result = await dialog.showSaveDialog(win, {
    title: "保存 Playwright 脚本",
    defaultPath: path.join(
      app.getPath("downloads"),
      python ? `test_${base.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "tracedock"}.py` : `${base}.spec.ts`,
    ),
    filters: python
      ? [{ name: "Python (pytest-playwright)", extensions: ["py"] }]
      : [{ name: "Playwright Test (TypeScript)", extensions: ["ts"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, q.code, "utf8");
  return { canceled: false, path: result.filePath, bytes: Buffer.byteLength(q.code) };
}
