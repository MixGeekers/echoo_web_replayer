/** Playwright script generation from a recording timeline. No Electron or Node types. */
export type CodegenLanguage = "typescript" | "python";
export interface CodegenOptions {
  language?: CodegenLanguage | undefined;
  /** Emit recorded scroll positions as explicit scrollTo statements. Off by default. */
  includeScroll?: boolean | undefined;
  /** Fixed generation time for reproducible output; defaults to now. */
  generatedAt?: string | undefined;
  /** Safety cap for very large recordings; later steps become one TODO note. */
  maxSteps?: number | undefined;
}
export interface CodegenStats {
  /** Timeline events considered, including DOM lines skipped by the streaming reader. */
  events: number;
  actions: number;
  steps: number;
  navigations: number;
  todos: number;
  omitted: Record<string, number>;
  firstSeq: number | null;
  lastSeq: number | null;
}
export interface CodegenResult {
  language: CodegenLanguage;
  filename: string;
  code: string;
  stats: CodegenStats;
  warnings: string[];
}
export type CodegenSaveResult =
  | { canceled: true }
  | { canceled: false; path: string; bytes: number };
