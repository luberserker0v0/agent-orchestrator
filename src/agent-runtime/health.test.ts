import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForHealthy } from './health.js';

const healthMock = vi.hoisted(() => vi.fn());

vi.mock('../opencode-http/client.js', () => {
  class MockClient {
    health = healthMock;
  }
  return { OpenCodeAgentClient: MockClient };
});

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.useFakeTimers();

async function flushTimers(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000);
}

describe('waitForHealthy', () => {
  const id = 'test-conv';
  const baseUrl = 'http://127.0.0.1:30000';
  const auth = { username: 'user', password: 'pass' };
  const config = { retries: 3, intervalMs: 100, clientTimeoutMs: 5000 };

  beforeEach(() => {
    healthMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves when health check passes on first attempt', async () => {
    healthMock.mockResolvedValue({ healthy: true, version: '1.0.0' });

    const promise = waitForHealthy(id, baseUrl, auth, config);
    await flushTimers();

    await expect(promise).resolves.toBeUndefined();
  });

  it('retries on failure and resolves when health check eventually passes', async () => {
    healthMock
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValueOnce({ healthy: true, version: '1.0.0' });

    const promise = waitForHealthy(id, baseUrl, auth, config);
    await flushTimers();

    await expect(promise).resolves.toBeUndefined();
    expect(healthMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    healthMock.mockRejectedValue(new Error('Connection refused'));

    const promise = waitForHealthy(id, baseUrl, auth, config);
    await flushTimers();

    await expect(promise).rejects.toThrow(
      'OpenCode instance failed health check after 3 retries',
    );
    expect(healthMock).toHaveBeenCalledTimes(3);
  });

  it('throws when health returns healthy: false', async () => {
    healthMock.mockResolvedValue({ healthy: false, version: '1.0.0' });

    const promise = waitForHealthy(id, baseUrl, auth, config);
    await flushTimers();

    await expect(promise).rejects.toThrow(
      'OpenCode instance failed health check after 3 retries',
    );
  });

  it('resolves on first healthy response when previous returned healthy: false', async () => {
    healthMock
      .mockResolvedValueOnce({ healthy: false, version: '1.0.0' })
      .mockResolvedValueOnce({ healthy: true, version: '1.0.0' });

    const promise = waitForHealthy(id, baseUrl, auth, config);
    await flushTimers();

    await expect(promise).resolves.toBeUndefined();
    expect(healthMock).toHaveBeenCalledTimes(2);
  });

  it('uses single retry with zero interval', async () => {
    const quickConfig = { retries: 1, intervalMs: 0, clientTimeoutMs: 100 };
    healthMock.mockResolvedValue({ healthy: true, version: '1.0.0' });

    const promise = waitForHealthy(id, baseUrl, auth, quickConfig);
    await flushTimers();

    await expect(promise).resolves.toBeUndefined();
    expect(healthMock).toHaveBeenCalledTimes(1);
  });
});