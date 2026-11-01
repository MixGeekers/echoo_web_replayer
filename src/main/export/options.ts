import type { ExportOptions } from "../../shared/contracts/export";
export function validateOptions({
  encoding = "delta",
  compression = "deflate",
}: ExportOptions) {
  if (!["delta", "full"].includes(encoding))
    throw new Error("无效的数据导出格式");
  if (!["deflate", "store"].includes(compression))
    throw new Error("无效的 ZIP 压缩方式");
  return { encoding, compression };
}
