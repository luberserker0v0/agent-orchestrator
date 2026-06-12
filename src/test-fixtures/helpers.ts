import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON } from '../config-loader.js';
import type { OpencodeConfig } from '../opencode-http/types.js';

const FIXTURES_DIR = fileURLToPath(new URL('.', import.meta.url));

export function readAgentConfig<T = Record<string, unknown>>(
  name: string,
  validate?: (config: unknown) => { valid: boolean; errors: string[] },
): T {
  const local = join(FIXTURES_DIR, `${name}.json`);
  const example = join(FIXTURES_DIR, `${name}.example.json`);
  const path = existsSync(local) ? local : example;
  const config = readJSON(path) as T;

  if (validate) {
    const result = validate(config);
    if (!result.valid) {
      throw new Error(`Invalid agent config "${name}": ${result.errors.join('; ')}`);
    }
  }

  return config;
}

/**
 * Upload an opencode.json config to a conversation via the HTTP API.
 * Used in tests that need a provider / model before sending messages.
 */
export async function uploadOpencodeConfig(
  baseUrl: string,
  conversationId: string,
  config: OpencodeConfig,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (res.status !== 204) {
    throw new Error(
      `uploadOpencodeConfig failed: POST /api/conversations/${conversationId}/config returned ${res.status}`,
    );
  }
}
