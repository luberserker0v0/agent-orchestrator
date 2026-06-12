import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJSONC } from 'jsonc-parser';

const DIR = fileURLToPath(new URL('.', import.meta.url));

function readTemplate(name: string): Record<string, unknown> {
  const local = join(DIR, `${name}.json`);
  const example = join(DIR, `${name}.example.json`);
  const path = existsSync(local) ? local : example;
  return parseJSONC(readFileSync(path, 'utf-8'));
}

export const OPENCODE_CONFIG = readTemplate('opencode');
