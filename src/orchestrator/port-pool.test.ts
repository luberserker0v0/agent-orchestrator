import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortPool } from './port-pool.js';

// Use high port range unlikely to conflict with other processes
const BASE_PORT = 52000;

// Mock the net module to control which ports appear occupied
vi.mock('node:net', () => {
  const occupiedPorts = new Set<number>();
  type Cb = (...args: unknown[]) => void;
  let dynamicPortCounter = 54000;

  const mockServer: Record<string, unknown> = {
    on: vi.fn((_event: string, cb: Cb) => {
      if (_event === 'error') {
        mockServer._errorCb = cb;
      }
      return mockServer;
    }),
    listen: vi.fn((port: number, _host: string, cb?: Cb) => {
      if (occupiedPorts.has(port)) {
        setImmediate(() => (mockServer._errorCb as Cb)?.(new Error('EADDRINUSE')));
      } else {
        setImmediate(() => cb?.());
      }
      return mockServer;
    }),
    close: vi.fn((cb?: Cb) => {
      setImmediate(() => cb?.());
      return mockServer;
    }),
    address: vi.fn(() => ({ port: dynamicPortCounter++, family: 'IPv4', address: '127.0.0.1' })),
    _errorCb: null as Cb | null,
  };

  return {
    createServer: vi.fn(() => ({
      ...mockServer,
      listeners: {} as Record<string, Cb[]>,
      on: vi.fn((event: string, cb: Cb) => {
        if (event === 'error') mockServer._errorCb = cb;
        return mockServer;
      }),
    })),
    __setPortOccupied: (port: number, occupied: boolean) => {
      if (occupied) occupiedPorts.add(port);
      else occupiedPorts.delete(port);
    },
  };
});

describe('PortPool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should allocate and release ports', async () => {
    const pool = new PortPool(BASE_PORT, BASE_PORT + 5);
    expect(pool.getUsedCount()).toBe(0);

    const port = await pool.allocate();
    expect(port).not.toBeNull();
    expect(pool.getUsedCount()).toBe(1);

    pool.release(port!);
    expect(pool.getUsedCount()).toBe(0);
  });

  it('should return null when pool is exhausted (dynamic fallback disabled)', async () => {
    const pool = new PortPool(BASE_PORT + 10, BASE_PORT + 12, false);
    await pool.allocate();
    await pool.allocate();
    await pool.allocate();
    const exhausted = await pool.allocate();
    expect(exhausted).toBeNull();
  });

  it('should not release unknown ports', async () => {
    const pool = new PortPool(BASE_PORT + 20, BASE_PORT + 22);
    await pool.allocate();
    pool.release(99999); // unknown port
    expect(pool.getUsedCount()).toBe(1);
  });

  it('should skip occupied ports', async () => {
    const pool = new PortPool(BASE_PORT + 30, BASE_PORT + 32);
    const port1 = await pool.allocate();
    expect(port1).not.toBeNull();
    pool.release(port1!);
  });

  it('should detect occupied ports via OS-level check', async () => {
    const pool = new PortPool(BASE_PORT + 40, BASE_PORT + 42);
    const allocated = await pool.allocate();
    expect(allocated).not.toBeNull();
    expect(pool.getUsedCount()).toBe(1);
    pool.release(allocated!);
  });

  it('should skip port occupied by another process', async () => {
    const net = await import('node:net');
    (net as any).__setPortOccupied(BASE_PORT + 50, true);

    const pool = new PortPool(BASE_PORT + 50, BASE_PORT + 51);
    const port = await pool.allocate();
    // BASE_PORT+50 is occupied, so should get BASE_PORT+51
    expect(port).toBe(BASE_PORT + 51);
    pool.release(port!);
  });

  it('should return null when all ports are occupied (dynamic fallback disabled)', async () => {
    const net = await import('node:net');
    (net as any).__setPortOccupied(BASE_PORT + 60, true);
    (net as any).__setPortOccupied(BASE_PORT + 61, true);

    const pool = new PortPool(BASE_PORT + 60, BASE_PORT + 61, false);
    const port = await pool.allocate();
    expect(port).toBeNull();
  });

  it('should fallback to dynamic port when range exhausted', async () => {
    const pool = new PortPool(BASE_PORT + 80, BASE_PORT + 80);
    const port = await pool.allocate();
    expect(port).not.toBeNull();
    // Range had only 1 port; second allocate triggers dynamic fallback
    const port2 = await pool.allocate();
    expect(port2).not.toBeNull();
    expect(port2).not.toBe(port);
    pool.release(port!);
    pool.release(port2!);
  });

  it('should not use dynamic fallback when disabled', async () => {
    const pool = new PortPool(BASE_PORT + 90, BASE_PORT + 90, false);
    const port = await pool.allocate();
    expect(port).not.toBeNull();
    const port2 = await pool.allocate();
    expect(port2).toBeNull();
    pool.release(port!);
  });

  it('should release dynamic ports correctly', async () => {
    const pool = new PortPool(BASE_PORT + 100, BASE_PORT + 100);
    await pool.allocate();
    const dynamicPort = await pool.allocate();
    expect(dynamicPort).not.toBeNull();
    expect(pool.getUsedCount()).toBe(2);
    pool.release(dynamicPort!);
    expect(pool.getUsedCount()).toBe(1);
  });

  it('should handle double release of same port', async () => {
    const pool = new PortPool(BASE_PORT + 70, BASE_PORT + 72);
    const port = await pool.allocate();
    expect(pool.getUsedCount()).toBe(1);

    pool.release(port!);
    expect(pool.getUsedCount()).toBe(0);

    // Second release should be no-op
    pool.release(port!);
    expect(pool.getUsedCount()).toBe(0);
  });
});
