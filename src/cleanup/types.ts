export const CLEANUP_TARGETS = ['logs', 'persistentData'] as const;

export type CleanupTarget = typeof CLEANUP_TARGETS[number];
export type CleanupBackend = 'filesystem' | 'kubernetes';
export type CleanupArtifactState = 'untracked' | 'pending' | 'eligible';
export type CleanupOutcome = 'marked' | 'cleared' | 'deleted' | 'skipped' | 'failed';

export interface CleanupArtifact {
  target: CleanupTarget;
  artifactId: string;
  backend: CleanupBackend;
  runtimeId?: string;
  conversationId?: string;
  state: CleanupArtifactState;
  reason: string;
  sizeBytes: number | null;
  lastModifiedAt?: number;
  firstObservedAt?: number;
  eligibleAt?: number;
}

export interface CleanupArtifactResult extends CleanupArtifact {
  outcome: CleanupOutcome;
  code?: string;
  message?: string;
}

export interface CleanupTargetReport {
  target: CleanupTarget;
  enabled: boolean;
  scanned: number;
  eligible: number;
  eligibleBytes: number | null;
  marked?: number;
  cleared?: number;
  deleted?: number;
  skipped?: number;
  failed?: number;
  reclaimedBytes?: number | null;
}

export interface CleanupSummary {
  scanned: number;
  eligible: number;
  eligibleBytes: number | null;
  marked?: number;
  cleared?: number;
  deleted?: number;
  skipped?: number;
  failed?: number;
  reclaimedBytes?: number | null;
}

export interface CleanupReport {
  mode: 'preview' | 'run';
  status: 'completed' | 'partial' | 'failed';
  startedAt: number;
  finishedAt: number;
  summary: CleanupSummary;
  targets: CleanupTargetReport[];
  items: Array<CleanupArtifact | CleanupArtifactResult>;
}

export interface CleanupProvider {
  readonly target: CleanupTarget;
  readonly backend: CleanupBackend;
  readonly enabled: boolean;
  preview(now: number): Promise<CleanupArtifact[]>;
  run(now: number): Promise<CleanupArtifactResult[]>;
}

export interface CleanupSelection {
  targets: CleanupTarget[];
}
