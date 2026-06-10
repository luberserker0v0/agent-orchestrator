import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(process.cwd(), '.env.test');
if (existsSync(envPath)) {
  config({ path: envPath });
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  models: Array<{ name: string }>;
}

export function loadProviderConfig(): ProviderConfig {
  const baseUrl = process.env.AO_TEST_PROVIDER_BASE_URL || 'http://192.168.0.18:25555/v1';
  const apiKey = process.env.AO_TEST_PROVIDER_API_KEY || 'e2e-test-key';
  const models = parseModels(process.env.AO_TEST_PROVIDER_MODELS);
  return { baseUrl, apiKey, models };
}

function parseModels(raw?: string): Array<{ name: string }> {
  const defaults = [
    'gemma-4-e4b-uncensored-hauhaucs-aggressive',
    'qwen3.5-9b-uncensored-hauhaucs-aggressive',
  ];
  if (!raw) return defaults.map(name => ({ name }));
  return raw.split(',').map(m => m.trim()).filter(Boolean).map(name => ({ name }));
}

export function loadDockerConfig(): { image: string; containerPort: number } {
  return {
    image: process.env.AO_TEST_DOCKER_IMAGE || 'ghcr.io/anomalyco/opencode',
    containerPort: Number(process.env.AO_TEST_CONTAINER_PORT) || 3000,
  };
}
