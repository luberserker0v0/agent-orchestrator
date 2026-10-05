import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  configureFileLogging: vi.fn(),
  shutdownLogger: vi.fn(),
}));

vi.mock('./utils/logger.js', () => ({
  configureFileLogging: loggerMocks.configureFileLogging,
  shutdownLogger: loggerMocks.shutdownLogger,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { initializeConfiguredFileLogging, validateContainerRuntimeStorage } from './index.js';

describe('validateContainerRuntimeStorage', () => {
  it('allows direct runtime with local storage', () => {
    expect(validateContainerRuntimeStorage('direct', 'local')).toBeUndefined();
  });

  it('allows kubernetes runtime with local storage because PVCs carry session data', () => {
    expect(validateContainerRuntimeStorage('kubernetes', 'local')).toBeUndefined();
  });

  it('allows a missing runtime type for later registration validation', () => {
    expect(validateContainerRuntimeStorage(undefined, 'local')).toBeUndefined();
  });

  it('rejects docker runtime with local storage in containers', () => {
    const problem = validateContainerRuntimeStorage('docker', 'local');
    expect(problem).toContain('default runtime type "docker"');
    expect(problem).toContain('docker-volume');
  });

  it('allows non-local storage types', () => {
    expect(validateContainerRuntimeStorage('docker', 'docker-volume')).toBeUndefined();
  });
});

describe('initializeConfiguredFileLogging', () => {
  beforeEach(() => {
    loggerMocks.configureFileLogging.mockReset();
  });

  it('does nothing while file logging is disabled', async () => {
    await initializeConfiguredFileLogging({
      logging: {
        file: {
          enabled: false,
          directory: './logs',
          maxFileSizeBytes: 1024,
          maxRotatedFiles: 2,
          retentionMs: 60_000,
        },
      },
    });

    expect(loggerMocks.configureFileLogging).not.toHaveBeenCalled();
  });

  it('initializes the sink with a non-recursive failure callback', async () => {
    const file = {
      enabled: true,
      directory: './logs',
      maxFileSizeBytes: 2048,
      maxRotatedFiles: 3,
      retentionMs: 120_000,
    };

    await initializeConfiguredFileLogging({ logging: { file } });

    expect(loggerMocks.configureFileLogging).toHaveBeenCalledOnce();
    expect(loggerMocks.configureFileLogging).toHaveBeenCalledWith(file, expect.any(Function));
  });

  it('propagates initialization errors so startup cannot silently lose configured logs', async () => {
    loggerMocks.configureFileLogging.mockRejectedValueOnce(new Error('unsafe destination'));

    await expect(initializeConfiguredFileLogging({
      logging: {
        file: {
          enabled: true,
          directory: './logs',
          maxFileSizeBytes: 1024,
          maxRotatedFiles: 1,
          retentionMs: 60_000,
        },
      },
    })).rejects.toThrow('unsafe destination');
  });
});
