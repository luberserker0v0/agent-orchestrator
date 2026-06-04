import { describe, it, expect } from 'vitest';
import { PortPool } from './port-pool.js';

describe('PortPool', () => {
  it('should allocate and release ports', () => {
    const pool = new PortPool(30000, 30005);
    expect(pool.getUsedCount()).toBe(0);

    const port = pool.allocate();
    expect(port).toBe(30000);
    expect(pool.getUsedCount()).toBe(1);

    pool.release(port!);
    expect(pool.getUsedCount()).toBe(0);
  });

  it('should return null when pool is exhausted', () => {
    const pool = new PortPool(30000, 30002);
    pool.allocate();
    pool.allocate();
    pool.allocate();
    const exhausted = pool.allocate();
    expect(exhausted).toBeNull();
  });

  it('should not release unknown ports', () => {
    const pool = new PortPool(30000, 30002);
    pool.allocate();
    pool.release(99999); // unknown port
    expect(pool.getUsedCount()).toBe(1);
  });
});
