import { createServer } from 'node:net';
import { logger } from '../utils/logger.js';
import { portPoolAvailable } from '../metrics/registry.js';

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

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

  async allocate(): Promise<number | null> {
    while (this.available.length > 0) {
      const port = this.available.shift()!;
      if (await isPortFree(port)) {
        this.inUse.add(port);
        portPoolAvailable.set(this.available.length);
        logger.info(`Port allocated: ${port} (available: ${this.available.length})`);
        return port;
      }
      // Port is in use by another process, skip it permanently
      logger.warn(`Port ${port} is already in use, skipping`);
    }
    return null;
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
