// 桌面验收必须注册为 npm 测试，且每个测试都要接入 CI 和 verify。
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/windows-verify.yml", root), "utf8");
const verify = await readFile(new URL("scripts/verify.mjs", root), "utf8");

const tests = Object.keys(pkg.scripts).filter(name => name === "test" || name.startsWith("test:"));
const smokeFiles = (await readdir(new URL("scripts/", root)))
  .filter(name => name === "smoke.cjs" || name.endsWith("-smoke.cjs"));
const unregistered = smokeFiles.filter(file => !tests.some(name => pkg.scripts[name].includes(`scripts/${file}`)));
const ran = new Set(
  [...workflow.matchAll(/npm (?:run )?(test(?::[\w-]+)?)\b/g)].map(match => match[1]),
);
const missingCI = tests.filter(name => !ran.has(name));
// test:portable 依赖打包产物，verify.mjs 不负责构建，因此不要求其包含。
const missingVerify = tests.filter(name => name !== "test:portable" && !verify.includes(`"${name}"`));

if (unregistered.length || missingCI.length || missingVerify.length) {
  if (unregistered.length) console.error(`桌面验收未注册为 npm 测试：${unregistered.join(", ")}`);
  if (missingCI.length) console.error(`CI 工作流缺少：${missingCI.join(", ")}`);
  if (missingVerify.length) console.error(`scripts/verify.mjs 缺少：${missingVerify.join(", ")}`);
  process.exit(1);
}
console.log(`CI 已覆盖 ${tests.length} 个测试脚本`);
