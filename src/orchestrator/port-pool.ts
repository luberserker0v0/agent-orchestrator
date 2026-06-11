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
  private readonly allowDynamicFallback: boolean;

  constructor(start: number, end: number, allowDynamicFallback = true) {
    this.available = [];
    for (let p = start; p <= end; p++) {
      this.available.push(p);
    }
    this.allowDynamicFallback = allowDynamicFallback;
    portPoolAvailable.set(this.available.length);
    logger.info(`PortPool initialized: ${start}-${end} (${this.available.length} ports, dynamicFallback=${allowDynamicFallback})`);
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
      logger.warn(`Port ${port} is already in use, skipping`);
    }

    if (this.allowDynamicFallback) {
      logger.info('Port range exhausted, attempting dynamic port allocation');
      return this.allocateDynamic();
    }

    return null;
  }

  private allocateDynamic(): Promise<number | null> {
    return new Promise((resolve) => {
      const server = createServer();
      server.on('error', () => {
        logger.error('Dynamic port allocation failed');
        resolve(null);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object' && 'port' in addr) {
          const port = addr.port;
          this.inUse.add(port);
          portPoolAvailable.set(this.available.length);
          logger.info(`Port allocated (dynamic): ${port} (available: ${this.available.length})`);
          server.close(() => resolve(port));
        } else {
          logger.error('Dynamic port allocation failed: could not determine port');
          resolve(null);
        }
      });
    });
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
