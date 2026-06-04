import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const targets = ['dist', 'workspace'];

for (const target of targets) {
  try {
    const fullPath = join(process.cwd(), target);
    rmSync(fullPath, { recursive: true, force: true });
    console.log(`Removed: ${fullPath}`);
  } catch (err) {
    console.error(`Failed to remove ${target}:`, (err as Error).message);
  }
}

// Remove *.log files in project root
const entries = readdirSync(process.cwd());
for (const entry of entries) {
  if (entry.endsWith('.log')) {
    try {
      rmSync(join(process.cwd(), entry));
      console.log(`Removed: ${entry}`);
    } catch {
      // ignore
    }
  }
}

console.log('Clean complete');
