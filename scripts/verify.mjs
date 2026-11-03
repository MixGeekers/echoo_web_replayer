import { spawn } from "node:child_process";
const command = process.platform === "win32" ? "npm.cmd" : "npm";
const jobs = [
  "typecheck",
  "test",
  "test:smoke",
  "test:lifecycle",
  "test:navigation",
  "test:library",
  "test:mcp-browser",
  "test:mcp",
  "test:replay",
  "test:resource-navigation",
  "test:export-desktop",
  "test:large",
];
for (const job of jobs) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, ["run", job], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) process.exit(typeof code === "number" ? code : 1);
}
