import { logger } from '../utils/logger.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import {
  cleanupArtifactsTotal,
  cleanupLastSuccessTimestampSeconds,
  cleanupReclaimedBytesTotal,
  cleanupRunsTotal,
} from '../metrics/registry.js';
import { CLEANUP_TARGETS } from './types.js';
import type {
  CleanupArtifact,
  CleanupArtifactResult,
  CleanupProvider,
  CleanupReport,
  CleanupSummary,
  CleanupTarget,
  CleanupTargetReport,
} from './types.js';

type CleanupTrigger = 'manual' | 'schedule';

function sumKnownBytes(items: CleanupArtifact[], onlyEligible: boolean): number | null {
  const selected = onlyEligible ? items.filter(item => item.state === 'eligible') : items;
  if (selected.length === 0) return 0;
  if (selected.some(item => item.sizeBytes === null)) return null;
  return selected.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
}

function summarizeTarget(
  target: CleanupTarget,
  enabled: boolean,
  items: Array<CleanupArtifact | CleanupArtifactResult>,
): CleanupTargetReport {
  const results = items.filter((item): item is CleanupArtifactResult => 'outcome' in item);
  const reclaimed = results.filter(item => item.outcome === 'deleted');
  return {
    target,
    enabled,
    scanned: items.length,
    eligible: items.filter(item => item.state === 'eligible').length,
    eligibleBytes: sumKnownBytes(items, true),
    ...(results.length > 0 ? {
      marked: results.filter(item => item.outcome === 'marked').length,
      cleared: results.filter(item => item.outcome === 'cleared').length,
      deleted: reclaimed.length,
      skipped: results.filter(item => item.outcome === 'skipped').length,
      failed: results.filter(item => item.outcome === 'failed').length,
      reclaimedBytes: sumKnownBytes(reclaimed, false),
    } : {}),
  };
}

function summarize(targets: CleanupTargetReport[]): CleanupSummary {
  const aggregateNullable = (field: 'eligibleBytes' | 'reclaimedBytes'): number | null => {
    const values = targets.map(target => target[field]).filter(value => value !== undefined);
    if (values.some(value => value === null)) return null;
    return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  };
  return {
    scanned: targets.reduce((sum, target) => sum + target.scanned, 0),
    eligible: targets.reduce((sum, target) => sum + target.eligible, 0),
    eligibleBytes: aggregateNullable('eligibleBytes'),
    ...(targets.some(target => target.deleted !== undefined) ? {
      marked: targets.reduce((sum, target) => sum + (target.marked ?? 0), 0),
      cleared: targets.reduce((sum, target) => sum + (target.cleared ?? 0), 0),
      deleted: targets.reduce((sum, target) => sum + (target.deleted ?? 0), 0),
      skipped: targets.reduce((sum, target) => sum + (target.skipped ?? 0), 0),
      failed: targets.reduce((sum, target) => sum + (target.failed ?? 0), 0),
      reclaimedBytes: aggregateNullable('reclaimedBytes'),
    } : {}),
  };
}

export class CleanupManager {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private shuttingDown = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly providers: CleanupProvider[],
    private readonly sweepIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer || this.shuttingDown) return;
    void this.runScheduled();
    this.timer = setInterval(() => void this.runScheduled(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async shutdown(): Promise<void> {
    this.stop();
    this.shuttingDown = true;
    if (!this.busy) return;
    await new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  isRunning(): boolean {
    return this.busy;
  }

  async preview(targets: CleanupTarget[] = [...CLEANUP_TARGETS]): Promise<CleanupReport> {
    return this.withGate(() => this.collect('preview', targets));
  }

  async run(targets: CleanupTarget[], trigger: CleanupTrigger = 'manual'): Promise<CleanupReport> {
    const report = await this.withGate(() => this.collect('run', targets));
    cleanupRunsTotal.labels(trigger, report.status).inc();
    for (const target of report.targets) {
      if ((target.failed ?? 0) === 0 && target.enabled) {
        cleanupLastSuccessTimestampSeconds.labels(target.target).set(report.finishedAt / 1000);
      }
    }
    for (const item of report.items) {
      if (!('outcome' in item)) continue;
      cleanupArtifactsTotal.labels(
        item.target,
        item.outcome,
        item.outcome === 'failed' ? 'error' : 'success',
      ).inc();
      // Preserve known local-byte accounting even when the same target report
      // also contains a PVC deletion whose reclaimed size is intentionally
      // unknown.
      if (item.outcome === 'deleted' && typeof item.sizeBytes === 'number' && item.sizeBytes > 0) {
        cleanupReclaimedBytesTotal.labels(item.target).inc(item.sizeBytes);
      }
      if (item.outcome === 'failed') {
        logger.warn('Cleanup artifact action failed', {
          target: item.target,
          backend: item.backend,
          artifactId: item.artifactId,
          ...(item.conversationId ? { conversationId: item.conversationId } : {}),
          ...(item.code ? { code: item.code } : {}),
        });
      }
    }
    return report;
  }

  runOnce(targets: CleanupTarget[], trigger: CleanupTrigger = 'manual'): Promise<CleanupReport> {
    return this.run(targets, trigger);
  }

  private async withGate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      throw new AppError(503, ErrorCodes.CLEANUP_FAILED, 'Cleanup service is shutting down');
    }
    if (this.busy) {
      throw new AppError(409, ErrorCodes.CLEANUP_IN_PROGRESS, 'Another cleanup operation is already running');
    }
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private async collect(mode: 'preview' | 'run', selectedTargets: CleanupTarget[]): Promise<CleanupReport> {
    const startedAt = this.now();
    const items: Array<CleanupArtifact | CleanupArtifactResult> = [];
    const targetReports: CleanupTargetReport[] = [];

    for (const target of selectedTargets) {
      const providers = this.providers.filter(provider => provider.target === target);
      const enabled = providers.some(provider => provider.enabled);
      const targetItems: Array<CleanupArtifact | CleanupArtifactResult> = [];
      for (const provider of providers) {
        if (!provider.enabled) continue;
        try {
          const providerItems = mode === 'preview'
            ? await provider.preview(startedAt)
            : await provider.run(startedAt);
          targetItems.push(...providerItems);
        } catch (err) {
          if (mode === 'preview') {
            throw new AppError(500, ErrorCodes.CLEANUP_FAILED, `Unable to preview ${target} cleanup`);
          }
          targetItems.push({
            target,
            artifactId: `provider-${target}`,
            backend: provider.backend,
            state: 'eligible',
            reason: 'provider-error',
            sizeBytes: null,
            outcome: 'failed',
            code: ErrorCodes.CLEANUP_FAILED,
            message: 'Cleanup provider failed; inspect server logs for details',
          });
          logger.warn('Cleanup provider failed', {
            target,
            errorType: err instanceof Error ? err.name : 'UnknownError',
          });
        }
      }
      items.push(...targetItems);
      targetReports.push(summarizeTarget(target, enabled, targetItems));
    }

    const summary = summarize(targetReports);
    const successfulActions = (summary.deleted ?? 0) + (summary.marked ?? 0) + (summary.cleared ?? 0);
    const status = mode === 'preview' || (summary.failed ?? 0) === 0
      ? 'completed'
      : successfulActions > 0 ? 'partial' : 'failed';
    return {
      mode,
      status,
      startedAt,
      finishedAt: this.now(),
      summary,
      targets: targetReports,
      items,
    };
  }

  private async runScheduled(): Promise<void> {
    if (this.busy) {
      cleanupRunsTotal.labels('schedule', 'skipped').inc();
      logger.debug('Scheduled cleanup skipped because another cleanup operation is running');
      return;
    }
    const targets = CLEANUP_TARGETS.filter(target =>
      this.providers.some(provider => provider.target === target && provider.enabled),
    );
    if (targets.length === 0) return;
    try {
      const report = await this.run([...targets], 'schedule');
      logger.info('Cleanup sweep completed', {
        status: report.status,
        scanned: report.summary.scanned,
        deleted: report.summary.deleted ?? 0,
        failed: report.summary.failed ?? 0,
      });
    } catch (err) {
      cleanupRunsTotal.labels('schedule', 'failed').inc();
      logger.warn('Scheduled cleanup failed', err);
    }
  }
}
