import type { HealthCheckConfig } from '../config-loader.js';
import { OpenCodeAgentClient } from '../opencode-http/client.js';
import { logger } from '../utils/logger.js';

export interface HealthCheckAuth {
  username: string;
  password: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForHealthy(
  id: string,
  baseUrl: string,
  auth: HealthCheckAuth,
  config: HealthCheckConfig,
): Promise<void> {
  const healthClient = new OpenCodeAgentClient(baseUrl, auth.username, auth.password, config.clientTimeoutMs);
  for (let i = 0; i < config.retries; i++) {
    await delay(config.intervalMs);
    try {
      const result = await healthClient.health();
      if (result.healthy) {
        logger.info(`[OpenCode ${id}] health check passed (version ${result.version})`);
        return;
      }
    } catch (err) {
      logger.debug(`[OpenCode ${id}] health check attempt ${i + 1} failed: ${(err as Error).message}`);
    }
  }
  throw new Error(`OpenCode instance failed health check after ${config.retries} retries`);
}
