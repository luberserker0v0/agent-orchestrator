import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProviderConfig } from './test-env.js';

const DIR = fileURLToPath(new URL('.', import.meta.url));

const BASE_TEMPLATE: Record<string, unknown> = JSON.parse(
  readFileSync(join(DIR, 'opencode.template.json'), 'utf-8'),
);

const PROVIDER_TEMPLATE: Record<string, unknown> = JSON.parse(
  readFileSync(join(DIR, 'opencode.provider.template.json'), 'utf-8'),
);

/** Minimal opencode.json (no provider — no model access) */
export const opencodeConfigMinimal: Record<string, unknown> =
  structuredClone(BASE_TEMPLATE);

/**
 * Create an opencode.json with a provider, reading endpoint / api key / models
 * from environment or .env.test (see .env.test.example).
 */
export function createProviderConfig(): Record<string, unknown> {
  const provider = loadProviderConfig();
  const config = structuredClone(PROVIDER_TEMPLATE) as Record<string, unknown>;

  const prov = (config.provider as Record<string, unknown>)
    .my_local_lmstudio as Record<string, unknown>;
  const opts = prov.options as Record<string, string>;
  opts.baseURL = provider.baseUrl;
  opts.apiKey = provider.apiKey;

  const models: Record<string, { name: string }> = {};
  for (const m of provider.models) {
    models[m.name] = { name: m.name };
  }
  prov.models = models;

  return config;
}
