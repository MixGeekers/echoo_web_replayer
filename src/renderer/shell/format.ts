import type { SessionMetadata } from "../../shared/contracts/ui";
export const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const formatDate = (value: string | undefined) => {
  const d = new Date(value ?? "");
  return Number.isNaN(d.getTime()) ? "—" : dateFormatter.format(d);
};
export const formatTime = (value: string | undefined) => {
  const d = new Date(value ?? "");
  return Number.isNaN(d.getTime()) ? "—" : timeFormatter.format(d);
};
export const count = (value: number) =>
  String(Number(value) || 0).padStart(2, "0");
export const statusName = (value: SessionMetadata["status"]) =>
  ({
    recording: "录制中",
    paused: "已暂停",
    stopped: "已结束",
    interrupted: "意外中断",
  })[value] || "就绪";
export const escapeText = (value: unknown, max = 120) =>
  String(value ?? "").slice(0, max);
