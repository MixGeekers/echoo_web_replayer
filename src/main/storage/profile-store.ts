import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProfileMetadata } from "../../shared/contracts/profile";

export const PROFILE_ID_PATTERN = /^profile-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_NAME_LENGTH = 80;
interface ProfileDocument {
  schemaVersion: 1;
  activeId: string | null;
  profiles: ProfileMetadata[];
}

function profileName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Profile 名称必须为字符串");
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH)
    throw new Error(`Profile 名称须为 1–${MAX_NAME_LENGTH} 个字符`);
  return name;
}

function readDocument(value: unknown): ProfileDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效的 Profile 数据");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.profiles))
    throw new Error("无效的 Profile 数据版本");
  const ids = new Set<string>(), names = new Set<string>();
  const profiles: ProfileMetadata[] = raw.profiles.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("无效的 Profile 元数据");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !PROFILE_ID_PATTERN.test(item.id) || ids.has(item.id))
      throw new Error("无效或重复的 Profile ID");
    const name = profileName(item.name);
    if (name !== item.name || names.has(name.toLocaleLowerCase()))
      throw new Error("无效或重复的 Profile 名称");
    if (
      typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
      typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))
    ) throw new Error("无效的 Profile 时间");
    ids.add(item.id);
    names.add(name.toLocaleLowerCase());
    return { id: item.id, name, createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
  if (raw.activeId !== null && (typeof raw.activeId !== "string" || !ids.has(raw.activeId)))
    throw new Error("活动 Profile 不存在");
  return { schemaVersion: 1, profiles, activeId: raw.activeId as string | null };
}

/** Profile identities are independent of the lifetime of their browser views and recordings. */
export class ProfileStore {
  readonly rootDir: string;
  private document: ProfileDocument = { schemaVersion: 1, profiles: [], activeId: null };
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Profile 存储尚未初始化");
  }

  private async commit(document: ProfileDocument): Promise<void> {
    const file = path.join(this.rootDir, "profiles.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
      await fs.rename(temporary, file);
      this.document = document;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  init(): Promise<this> {
    return this.enqueue(async () => {
      if (this.initialized) return this;
      await fs.mkdir(this.rootDir, { recursive: true });
      let contents: string;
      try {
        contents = await fs.readFile(path.join(this.rootDir, "profiles.json"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const now = new Date().toISOString();
        const profile = { id: `profile-${randomUUID()}`, name: "默认环境", createdAt: now, updatedAt: now };
        await this.commit({ schemaVersion: 1, activeId: profile.id, profiles: [profile] });
        this.initialized = true;
        return this;
      }
      this.document = readDocument(JSON.parse(contents) as unknown);
      this.initialized = true;
      return this;
    });
  }

  get activeId(): string | null {
    this.requireInitialized();
    return this.document.activeId;
  }

  list(): ProfileMetadata[] {
    this.requireInitialized();
    return this.document.profiles.map(profile => ({ ...profile }));
  }

  get(id: string): ProfileMetadata {
    this.requireInitialized();
    if (typeof id !== "string" || !PROFILE_ID_PATTERN.test(id))
      throw new Error("无效的 Profile ID");
    const profile = this.document.profiles.find(entry => entry.id === id);
    if (!profile) throw new Error("找不到指定 Profile");
    return { ...profile };
  }

  private uniqueName(value: unknown, exceptId?: string): string {
    const name = profileName(value);
    if (this.document.profiles.some(profile => profile.id !== exceptId && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
      throw new Error("Profile 名称已存在");
    return name;
  }

  create(value: string): Promise<ProfileMetadata> {
    return this.enqueue(async () => {
      this.requireInitialized();
      const name = this.uniqueName(value), now = new Date().toISOString();
      const profile = { id: `profile-${randomUUID()}`, name, createdAt: now, updatedAt: now };
      await this.commit({ ...this.document, profiles: [...this.document.profiles, profile] });
      return { ...profile };
    });
  }

  rename(id: string, value: string): Promise<ProfileMetadata> {
    return this.enqueue(async () => {
      const profile = this.get(id);
      const renamed = { ...profile, name: this.uniqueName(value, id), updatedAt: new Date().toISOString() };
      await this.commit({ ...this.document, profiles: this.document.profiles.map(entry => entry.id === id ? renamed : entry) });
      return { ...renamed };
    });
  }

  select(id: string | null): Promise<ProfileMetadata | null> {
    return this.enqueue(async () => {
      this.requireInitialized();
      const selected = id === null ? null : this.get(id);
      await this.commit({ ...this.document, activeId: id });
      return selected;
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.get(id);
      if (this.document.activeId === id) throw new Error("请先关闭此 Profile 的浏览环境");
      await this.commit({ ...this.document, profiles: this.document.profiles.filter(profile => profile.id !== id) });
    });
  }
}
