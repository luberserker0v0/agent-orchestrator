/** Minimal opencode.json (no provider — no model access) */
export const opencodeConfigMinimal: Record<string, unknown> = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    bash: { '*': 'deny' },
    external_directory: { '*': 'deny' },
  },
};

/** opencode.json with a real local provider (for message.send / list-models scenarios) */
export const opencodeConfigWithProvider: Record<string, unknown> = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    bash: { '*': 'deny' },
    external_directory: { '*': 'deny' },
  },
  provider: {
    my_local_lmstudio: {
      name: 'my local lmstudio',
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'http://192.168.0.18:25555/v1',
        apiKey: 'e2e-test-key',
      },
      models: {
        'gemma-4-e4b-uncensored-hauhaucs-aggressive': {
          name: 'gemma-4-e4b-uncensored-hauhaucs-aggressive',
        },
        'qwen3.5-9b-uncensored-hauhaucs-aggressive': {
          name: 'qwen3.5-9b-uncensored-hauhaucs-aggressive',
        },
      },
    },
  },
};
