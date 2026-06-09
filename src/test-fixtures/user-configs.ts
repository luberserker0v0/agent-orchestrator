/** Minimal opencode.json (no provider — no model access) */
export const opencodeConfigMinimal: Record<string, unknown> = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    bash: { '*': 'deny' },
    external_directory: { '*': 'deny' },
  },
};

/** opencode.json with a test provider (for message.send / list-models scenarios) */
export const opencodeConfigWithProvider: Record<string, unknown> = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    bash: { '*': 'deny' },
    external_directory: { '*': 'deny' },
  },
  provider: {
    'test-provider': {
      name: 'Test Provider',
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'http://127.0.0.1:25555/v1',
        apiKey: 'test-key',
      },
      models: {
        'test-model': { name: 'Test Model' },
      },
    },
  },
};
