export type RuntimeAccess =
  | { type: 'local'; cwd: string }
  | { type: 'docker-volume'; volumeName: string; mountPoint: string }
  | { type: 'docker'; container: string };

export interface StorageBackend {
  createWorkspaceDir(workspaceId: string): Promise<void>;
  ensureWorkspaceDir(workspaceId: string): Promise<void>;
  destroyWorkspace(workspaceId: string): Promise<void>;
  hasWorkspace(workspaceId: string): Promise<boolean>;
  ensureDir(workspaceId: string, relativePath: string): Promise<void>;

  readFile(workspaceId: string, relativePath: string): Promise<Buffer>;
  writeFile(workspaceId: string, relativePath: string, content: string | Buffer): Promise<void>;
  listEntries(workspaceId: string, relativePath?: string): Promise<string[]>;
  deleteEntry(workspaceId: string, relativePath: string): Promise<void>;

  getWorkspaceSize(workspaceId: string): Promise<number>;
  cleanupOrphans(): Promise<void>;

  copyToStorage(workspaceId: string, sourceLocalPath: string, destRelativePath: string): Promise<void>;
  copyToStorageRecursive(workspaceId: string, sourceLocalDir: string, destRelativeRoot: string): Promise<void>;

  getRuntimeAccess(workspaceId: string): RuntimeAccess;
}
