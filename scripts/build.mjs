import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
await rm("out", { recursive: true, force: true });
await mkdir("out", { recursive: true });
const common = {
  bundle: true,
  sourcemap: true,
  target: "es2022",
  logLevel: "info",
};
await build({
  ...common,
  platform: "node",
  format: "cjs",
  packages: "external",
  outdir: "out",
  outExtension: { ".js": ".cjs" },
  entryPoints: {
    main: "src/main/index.ts",
    "shell-preload": "src/preload/shell.ts",
    "browser-preload": "src/preload/browser.ts",
    "session-store": "src/main/storage/session-store.ts",
    "profile-store": "src/main/storage/profile-store.ts",
    "session-group-store": "src/main/storage/session-group-store.ts",
    "library-batch": "src/main/library-batch.ts",
    "library-query": "src/renderer/shell/library-query.ts",
    "store-parser": "src/main/storage/parser.ts",
    exporter: "src/main/export/job.ts",
    "export-worker": "src/main/export/worker.ts",
    "export-derived": "src/main/export/derived.ts",
    "delta-codec": "src/main/export/delta-codec.ts",
    "delta-zip": "src/main/export/zip.ts",
    "resource-recorder": "src/main/resources/index.ts",
  },
});
await build({
  ...common,
  platform: "browser",
  format: "iife",
  outdir: "out",
  entryPoints: {
    "renderer/app": "src/renderer/app.ts",
    "demo/demo": "src/demo/demo.ts",
  },
});
await build({
  ...common,
  platform: "node",
  format: "cjs",
  outfile: "out/shared/replay-urls.js",
  entryPoints: ["src/shared/resource-urls.ts"],
});
for (const directory of ["renderer", "demo", "shared"])
  await cp(`src/${directory}`, `out/${directory}`, {
    recursive: true,
    filter: (source) => !/\.(?:[cm]?[jt]s|map)$/.test(source),
  });
await cp("src/restore.py", "out/restore.py");
