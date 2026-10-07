import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('npm release metadata verification', () => {
  const root = process.cwd();
  const script = join(root, 'scripts', 'verify-package.cjs');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };

  it('accepts a release tag matching the package version', () => {
    const result = spawnSync(process.execPath, [script, `v${packageJson.version}`], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Verified ${packageJson.name}@${packageJson.version}`);
  }, 15_000);

  it('rejects a release tag that does not match the package version', () => {
    const result = spawnSync(process.execPath, [script, 'v0.0.0-invalid'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package version');
  }, 15_000);
});
