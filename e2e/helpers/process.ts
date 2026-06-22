import { execSync } from 'node:child_process';

export function findPidByPort(port: number): number | undefined {
  if (process.platform === 'win32') {
    const stdout = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8', timeout: 5000 });
    for (const line of stdout.split(/\r?\n/)) {
      if (line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (!isNaN(pid)) return pid;
      }
    }
    return undefined;
  }
  try {
    const pid = execSync(`lsof -ti :${port}`, { encoding: 'utf8', timeout: 5000 }).trim();
    const n = Number(pid);
    return isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

export function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
  } else {
    execSync(`kill -9 ${pid}`, { stdio: 'ignore', timeout: 5000 });
  }
}

export function killProcessByPort(port: number): boolean {
  const pid = findPidByPort(port);
  if (pid === undefined) return false;
  killProcess(pid);
  return true;
}
