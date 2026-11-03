// 确保 package.json 中每个 test / test:* 脚本都在 CI 工作流和 verify 脚本中运行，
// 避免新增的验收只在本地存在。
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/windows-verify.yml", root), "utf8");
const verify = await readFile(new URL("scripts/verify.mjs", root), "utf8");

const tests = Object.keys(pkg.scripts).filter(name => name === "test" || name.startsWith("test:"));
const ran = new Set(
  [...workflow.matchAll(/npm (?:run )?(test(?::[\w-]+)?)\b/g)].map(match => match[1]),
);
const missingCI = tests.filter(name => !ran.has(name));
// test:portable 依赖打包产物，verify.mjs 不负责构建，因此不要求其包含。
const missingVerify = tests.filter(name => name !== "test:portable" && !verify.includes(`"${name}"`));

if (missingCI.length || missingVerify.length) {
  if (missingCI.length) console.error(`CI 工作流缺少：${missingCI.join(", ")}`);
  if (missingVerify.length) console.error(`scripts/verify.mjs 缺少：${missingVerify.join(", ")}`);
  process.exit(1);
}
console.log(`CI 已覆盖 ${tests.length} 个测试脚本`);
