import type { RequestHandler } from 'express';
import { httpRequestDurationSeconds, httpRequestsTotal } from '../metrics/registry.js';
import { logger } from '../utils/logger.js';

export class RequestTracker {
  private activeRequests = 0;
  private readonly waiters = new Set<() => void>();

  readonly middleware: RequestHandler = (req, res, next) => {
    this.activeRequests++;
    const endTimer = httpRequestDurationSeconds.startTimer({ method: req.method });
    let finalized = false;
    const finalize = (completed: boolean): void => {
      if (finalized) return;
      finalized = true;
      this.activeRequests--;
      const status = completed ? String(res.statusCode) : '499';
      endTimer({ status });
      httpRequestsTotal.inc({ method: req.method, status });
      this.notifyWhenIdle();
    };
    res.once('finish', () => finalize(true));
    res.once('close', () => finalize(res.writableFinished));
    next();
  };

  waitForIdle(timeoutMs: number): Promise<void> {
    if (this.activeRequests === 0) return Promise.resolve();
    return new Promise(resolve => this.addWaiter(resolve, timeoutMs));
  }

  private addWaiter(resolve: () => void, timeoutMs: number): void {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.waiters.delete(settle);
      resolve();
    };
    this.waiters.add(settle);
    const timer = setTimeout(() => {
      logger.warn(`Graceful shutdown: ${this.activeRequests} request(s) still in-flight after ${timeoutMs}ms`);
      settle();
    }, timeoutMs);
  }

  private notifyWhenIdle(): void {
    if (this.activeRequests !== 0) return;
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
}
