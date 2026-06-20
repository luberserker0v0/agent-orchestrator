import { existsSync, readFileSync } from 'node:fs';

export function isRunningInContainer(): boolean {
  try {
    if (existsSync('/.dockerenv')) return true;
    const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
    return cgroup.includes('docker') || cgroup.includes('/docker/');
  } catch {
    return false;
  }
}
