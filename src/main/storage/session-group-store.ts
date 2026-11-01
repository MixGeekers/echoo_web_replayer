import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionGroupMetadata } from "../../shared/contracts/session-group";
import { PROFILE_ID_PATTERN } from "./profile-store";

export const SESSION_GROUP_ID_PATTERN = /^group-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface Document {
  schemaVersion: 1;
  groups: SessionGroupMetadata[];
  deleting: string[];
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160)
    throw new Error("Session 名称须为 1–160 个字符");
  return value.trim();
}
function readDocument(value: unknown): Document {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效 Session 数据");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.groups) || !Array.isArray(raw.deleting))
    throw new Error("无效 Session 数据版本");
  const ids = new Set<string>();
  const groups = raw.groups.map((value: unknown): SessionGroupMetadata => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效 Session 元数据");
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !SESSION_GROUP_ID_PATTERN.test(item.id) || ids.has(item.id))
      throw new Error("无效或重复的 Session ID");
    if (typeof item.profileId !== "string" || !PROFILE_ID_PATTERN.test(item.profileId) ||
        typeof item.profileName !== "string" || !item.profileName.trim()) throw new Error("无效 Session Profile");
    const label = name(item.name);
    if (label !== item.name) throw new Error("无效 Session 名称");
    if (item.status !== "open" && item.status !== "closed") throw new Error("无效 Session 状态");
    if (item.libraryState !== "active" && item.libraryState !== "archived" && item.libraryState !== "trashed")
      throw new Error("无效 Session 管理状态");
    for (const key of ["createdAt", "updatedAt"])
      if (typeof item[key] !== "string" || !Number.isFinite(Date.parse(item[key]))) throw new Error("无效 Session 时间");
    for (const key of ["archivedAt", "trashedAt"])
      if (item[key] !== null && (typeof item[key] !== "string" || !Number.isFinite(Date.parse(item[key]))))
        throw new Error("无效 Session 时间");
    if (item.libraryState === "trashed") {
      if ((item.trashOrigin !== "active" && item.trashOrigin !== "archived") || item.trashedAt === null)
        throw new Error("无效 Session 回收站信息");
    } else if (item.trashOrigin !== null || item.trashedAt !== null) throw new Error("无效 Session 回收站信息");
    const archived = item.libraryState === "archived" || item.trashOrigin === "archived";
    if (archived !== (item.archivedAt !== null) || (archived && item.status !== "closed"))
      throw new Error("无效 Session 归档信息");
    ids.add(item.id);
    return {...item} as unknown as SessionGroupMetadata;
  });
  const deleting = raw.deleting.map((id: unknown) => {
    if (typeof id !== "string" || !ids.has(id) || groups.find(group => group.id === id)?.libraryState !== "trashed")
      throw new Error("无效 Session 删除事务");
    return id;
  });
  if (new Set(deleting).size !== deleting.length) throw new Error("重复 Session 删除事务");
  return {schemaVersion: 1, groups, deleting};
}

/** Session containers and deletion intent are committed independently of capture files. */
export class SessionGroupStore {
  readonly rootDir: string;
  private document: Document = {schemaVersion: 1, groups: [], deleting: []};
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(rootDir: string) { this.rootDir = path.resolve(rootDir); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  private requireInitialized() { if (!this.initialized) throw new Error("Session 存储尚未初始化"); }
  private async commit(document: Document) {
    const file = path.join(this.rootDir, "session-groups.json"), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {flag: "wx"});
      await fs.rename(temporary, file);
      this.document = document;
    } finally { await fs.rm(temporary, {force: true}).catch(() => {}); }
  }
  init(): Promise<this> {
    return this.enqueue(async () => {
      if (this.initialized) return this;
      await fs.mkdir(this.rootDir, {recursive: true});
      try {
        this.document = readDocument(JSON.parse(await fs.readFile(path.join(this.rootDir, "session-groups.json"), "utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.commit({schemaVersion: 1, groups: [], deleting: []});
      }
      this.initialized = true;
      return this;
    });
  }
  list() {
    this.requireInitialized();
    return this.document.groups.filter(group => !this.document.deleting.includes(group.id)).map(group => ({...group}));
  }
  get(id: string): SessionGroupMetadata {
    this.requireInitialized();
    if (typeof id !== "string" || !SESSION_GROUP_ID_PATTERN.test(id)) throw new Error("无效 Session ID");
    const group = this.document.groups.find(item => item.id === id);
    if (!group) throw new Error("找不到指定 Session");
    if (this.document.deleting.includes(id)) throw new Error("Session 正在删除，请重新启动以完成清理");
    return {...group};
  }
  pendingDeletions() { this.requireInitialized(); return [...this.document.deleting]; }
  create(value: string, profile: {id: string; name: string}) {
    return this.enqueue(async () => {
      this.requireInitialized();
      if (!profile || !PROFILE_ID_PATTERN.test(profile.id) || typeof profile.name !== "string" || !profile.name.trim())
        throw new Error("Session 必须属于有效 Profile");
      const now = new Date().toISOString();
      const group: SessionGroupMetadata = {id: `group-${randomUUID()}`, profileId: profile.id, profileName: profile.name,
        name: name(value), status: "open", libraryState: "active", createdAt: now, updatedAt: now,
        archivedAt: null, trashedAt: null, trashOrigin: null};
      await this.commit({...this.document, groups: [...this.document.groups, group]});
      return {...group};
    });
  }
  private change(id: string, update: (group: SessionGroupMetadata) => Partial<SessionGroupMetadata>) {
    return this.enqueue(async () => {
      const current = this.get(id), next = {...current, ...update(current), updatedAt: new Date().toISOString()};
      await this.commit({...this.document, groups: this.document.groups.map(group => group.id === id ? next : group)});
      return {...next};
    });
  }
  rename(id: string, value: string) {
    return this.change(id, group => {
      if (group.libraryState === "trashed") throw new Error("请先恢复 Session");
      return {name: name(value)};
    });
  }
  close(id: string) {
    return this.change(id, group => {
      if (group.libraryState !== "active") throw new Error("只能关闭常用 Session");
      return {status: "closed"};
    });
  }
  reopen(id: string) {
    return this.change(id, group => {
      if (group.libraryState !== "active") throw new Error("请先恢复或取消归档 Session");
      return {status: "open"};
    });
  }
  archive(id: string) {
    return this.change(id, group => {
      if (group.libraryState !== "active") throw new Error("只能归档常用 Session");
      return {libraryState: "archived", status: "closed", archivedAt: new Date().toISOString()};
    });
  }
  unarchive(id: string) {
    return this.change(id, group => {
      if (group.libraryState !== "archived") throw new Error("此 Session 未归档");
      return {libraryState: "active", archivedAt: null};
    });
  }
  trash(id: string) {
    return this.change(id, group => {
      if (group.libraryState === "trashed") throw new Error("此 Session 已在回收站");
      return {libraryState: "trashed", trashOrigin: group.libraryState, trashedAt: new Date().toISOString()};
    });
  }
  restore(id: string) {
    return this.change(id, group => {
      if (group.libraryState !== "trashed" || !group.trashOrigin) throw new Error("此 Session 不在回收站");
      return {libraryState: group.trashOrigin, trashOrigin: null, trashedAt: null};
    });
  }
  beginDelete(id: string) {
    return this.enqueue(async () => {
      const group = this.get(id);
      if (group.libraryState !== "trashed") throw new Error("请先将 Session 移入回收站");
      await this.commit({...this.document, deleting: [...this.document.deleting, id]});
    });
  }
  finishDelete(id: string) {
    return this.enqueue(async () => {
      this.requireInitialized();
      if (!this.document.deleting.includes(id)) throw new Error("Session 没有待完成的删除事务");
      await this.commit({...this.document, groups: this.document.groups.filter(group => group.id !== id),
        deleting: this.document.deleting.filter(value => value !== id)});
    });
  }
}
