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

export function loadDockerConfig(): { image: string; containerPort: number } {
  return {
    image: process.env.AO_TEST_DOCKER_IMAGE || 'ghcr.io/anomalyco/opencode',
    containerPort: Number(process.env.AO_TEST_CONTAINER_PORT) || 3000,
  };
}
