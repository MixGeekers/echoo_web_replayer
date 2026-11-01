import type { SessionGroupMetadata, SessionMetadata } from "../../shared/contracts/ui";
import type { LibraryState } from "../../shared/contracts/storage";

export interface LibraryQuery {
  profileId: string | null;
  scope: LibraryState;
  name: string;
  from: string;
  to: string;
}

export function libraryDateError(from: string, to: string): string {
  if (from && to && from > to) return "开始日期不能晚于结束日期";
  return "";
}

export function libraryMatches(name: string, timestamp: string, query: Pick<LibraryQuery, "name" | "from" | "to">): boolean {
  if (libraryDateError(query.from, query.to)) return false;
  if (!name.toLocaleLowerCase().includes(query.name.trim().toLocaleLowerCase())) return false;
  if (!query.from && !query.to) return true;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return (!query.from || day >= query.from) && (!query.to || day <= query.to);
}

/** Parents appear as context when a child matches; they never inherit the child's match. */
export function queryLibrary(groups: SessionGroupMetadata[], records: SessionMetadata[], query: LibraryQuery) {
  const byId = new Map(groups.map(group => [group.id, group]));
  const directGroupIds = new Set(groups.filter(group =>
    (!query.profileId || group.profileId === query.profileId) && group.libraryState === query.scope &&
    libraryMatches(group.name, group.createdAt, query)).map(group => group.id));
  const visibleRecords = records.filter(record => {
    const group = byId.get(record.sessionGroupId);
    if (!group || (query.profileId && record.profileId !== query.profileId)) return false;
    const effective = group.libraryState === "trashed" || record.libraryState === "trashed" ? "trashed" :
      group.libraryState === "archived" || record.libraryState === "archived" ? "archived" : "active";
    return effective === query.scope && libraryMatches(record.name, record.startedAt, query);
  });
  const contextIds = new Set(visibleRecords.map(record => record.sessionGroupId));
  return {groups: groups.filter(group => directGroupIds.has(group.id) || contextIds.has(group.id)), records: visibleRecords, directGroupIds};
}
