import type { LibraryState } from "./storage";

/** A persistent work session can contain any number of independent capture recordings. */
export interface SessionGroupMetadata {
  id: string;
  profileId: string;
  profileName: string;
  name: string;
  status: "open" | "closed";
  libraryState: LibraryState;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trashedAt: string | null;
  trashOrigin: "active" | "archived" | null;
}
