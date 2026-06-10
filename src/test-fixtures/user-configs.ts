import { loadProviderConfig } from './test-env.js';

/** Minimal opencode.json (no provider — no model access) */
export const opencodeConfigMinimal: Record<string, unknown> = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    bash: { '*': 'deny' },
    external_directory: { '*': 'deny' },
  },
};

/**
 * Create an opencode.json with a provider, reading endpoint / api key / models
 * from environment or .env.test (see .env.test.example).
 */
export function createProviderConfig(): Record<string, unknown> {
  const provider = loadProviderConfig();

  const models: Record<string, { name: string }> = {};
  for (const m of provider.models) {
    models[m.name] = { name: m.name };
  }

  return {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      bash: { '*': 'deny' },
      external_directory: { '*': 'deny' },
      question: 'deny',
    },
    provider: {
      my_local_lmstudio: {
        name: 'my local lmstudio',
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: provider.baseUrl,
          apiKey: provider.apiKey,
        },
        models,
      },
    },
  };
}
