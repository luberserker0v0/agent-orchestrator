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

export const DEFAULT_DOCKER_TEST_IMAGE = 'ghcr.io/anomalyco/opencode:1.17.8';

export function loadDockerConfig(): { image: string } {
  return {
    image: process.env.AO_TEST_DOCKER_IMAGE || DEFAULT_DOCKER_TEST_IMAGE,
  };
}
