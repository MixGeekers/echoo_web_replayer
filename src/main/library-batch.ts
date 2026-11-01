import type { LibraryBatchAction, LibraryBatchInput } from "../shared/contracts/library";
import type { SessionGroupMetadata } from "../shared/contracts/session-group";
import type { LibraryState, SessionMetadata } from "../shared/contracts/storage";

export interface LibraryBatchPlan extends LibraryBatchInput {
  /** All children of selected Sessions, plus directly selected recordings, once each. */
  affectedSessionIds: string[];
}

export function parseLibraryBatch(value: unknown): LibraryBatchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的批量整理参数");
  const input = value as Record<string, unknown>;
  if (typeof input.action !== "string" || !["archive", "unarchive", "trash", "restore", "delete"].includes(input.action))
    throw new Error("无效的批量整理操作");
  const ids = (field: string) => {
    const values = input[field];
    if (!Array.isArray(values) || values.some(id => typeof id !== "string" || !id))
      throw new Error("批量整理目标必须为 ID 列表");
    return [...new Set(values as string[])];
  };
  return {action: input.action as LibraryBatchAction, sessionGroupIds: ids("sessionGroupIds"), sessionIds: ids("sessionIds")};
}

function validateState(action: LibraryBatchAction, state: LibraryState, label: string) {
  const expected = action === "archive" ? "active" : action === "unarchive" ? "archived" :
    action === "restore" || action === "delete" ? "trashed" : null;
  if (expected && state !== expected) {
    const message = action === "archive" ? "只有常用内容可以归档" : action === "unarchive" ? "只有已归档内容可以取消归档" :
      action === "restore" ? "只有回收站内容可以恢复" : "请先移入回收站，再彻底删除";
    throw new Error(`${label}：${message}；未执行任何批量操作`);
  }
  if (action === "trash" && state === "trashed")
    throw new Error(`${label}：已在回收站；未执行任何批量操作`);
}

/** Pure preflight: never mutate a valid prefix before discovering an invalid target. */
export function planLibraryBatch(
  value: LibraryBatchInput,
  state: {sessionGroups: SessionGroupMetadata[]; sessions: SessionMetadata[]},
): LibraryBatchPlan {
  const input = parseLibraryBatch(value);
  if (!input.sessionGroupIds.length && !input.sessionIds.length) throw new Error("请先选择 Session 或采集记录");
  const groups = new Map(state.sessionGroups.map(group => [group.id, group]));
  const sessions = new Map(state.sessions.map(session => [session.id, session]));
  // Even a descendant removed by normalization must refer to an existing record.
  for (const id of input.sessionGroupIds) if (!groups.has(id)) throw new Error("所选 Session 已不存在，请刷新后重新选择；未执行任何批量操作");
  for (const id of input.sessionIds) if (!sessions.has(id)) throw new Error("所选采集记录已不存在，请刷新后重新选择；未执行任何批量操作");
  const groupIds = new Set(input.sessionGroupIds);
  const sessionIds = input.sessionIds.filter(id => !groupIds.has(sessions.get(id)!.sessionGroupId));
  for (const id of groupIds) {
    const group = groups.get(id)!;
    validateState(input.action, group.libraryState, `Session“${group.name}”`);
  }
  for (const id of sessionIds) {
    const session = sessions.get(id)!, group = groups.get(session.sessionGroupId);
    if (!group) throw new Error(`采集记录“${session.name}”缺少所属 Session；未执行任何批量操作`);
    if (group.libraryState === "trashed")
      throw new Error(`采集记录“${session.name}”：请先恢复所属 Session，或直接选择整个 Session；未执行任何批量操作`);
    validateState(input.action, session.libraryState, `采集记录“${session.name}”`);
  }
  const affectedSessionIds = [...new Set([
    ...state.sessions.filter(session => groupIds.has(session.sessionGroupId)).map(session => session.id),
    ...sessionIds,
  ])];
  for (const id of affectedSessionIds) {
    const session = sessions.get(id)!;
    if (session.status === "recording" || session.status === "paused")
      throw new Error(`采集记录“${session.name}”仍在采集中，请先结束采集；未执行任何批量操作`);
  }
  return {...input, sessionIds, affectedSessionIds};
}
