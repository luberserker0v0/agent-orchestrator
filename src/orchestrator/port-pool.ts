import { logger } from '../utils/logger.js';
import { portPoolAvailable } from '../metrics/registry.js';

export class PortPool {
  private available: number[];
  private inUse: Set<number> = new Set();

  constructor(start: number, end: number) {
    this.available = [];
    for (let p = start; p <= end; p++) {
      this.available.push(p);
    }
    portPoolAvailable.set(this.available.length);
    logger.info(`PortPool initialized: ${start}-${end} (${this.available.length} ports)`);
  }

  allocate(): number | null {
    const port = this.available.shift();
    if (port === undefined) {
      return null;
    }
    this.inUse.add(port);
    portPoolAvailable.set(this.available.length);
    logger.info(`Port allocated: ${port} (available: ${this.available.length})`);
    return port;
  }

  release(port: number): void {
    if (!this.inUse.has(port)) return;
    this.inUse.delete(port);
    this.available.push(port);
    portPoolAvailable.set(this.available.length);
    logger.info(`Port released: ${port} (available: ${this.available.length})`);
  }

  getUsedCount(): number {
    return this.inUse.size;
  }
}
