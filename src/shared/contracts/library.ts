export type LibraryBatchAction = "archive" | "unarchive" | "trash" | "restore" | "delete";

/** Selecting a Session includes every child recording, including filtered-out children. */
export interface LibraryBatchInput {
  action: LibraryBatchAction;
  sessionGroupIds: string[];
  sessionIds: string[];
}
