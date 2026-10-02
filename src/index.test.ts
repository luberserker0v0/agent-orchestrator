import { describe, it, expect } from 'vitest';
import { validateContainerRuntimeStorage } from './index.js';

describe('validateContainerRuntimeStorage', () => {
  it('allows direct runtime with local storage', () => {
    expect(validateContainerRuntimeStorage('direct', 'local')).toBeUndefined();
  });

  it('allows kubernetes runtime with local storage (PVCs carry session data)', () => {
    expect(validateContainerRuntimeStorage('kubernetes', 'local')).toBeUndefined();
  });

  it('allows missing runtime type (validated later at registration)', () => {
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
