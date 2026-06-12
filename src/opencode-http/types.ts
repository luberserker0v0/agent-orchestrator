/**
 * OpenCode Server API Types (derived from OpenAPI spec)
 * https://opencode.ai/docs/zh-tw/server/
 */

export interface ModelSpec {
  providerID: string;
  modelID: string;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id?: string;
  tool: string;
  args: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  tool_call_id?: string;
  output: unknown;
}

export type Part = TextPart | ToolCallPart | ToolResultPart;

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  created_at: string;
  updated_at: string;
}

export interface AssistantMessage extends Message {
  role: 'assistant';
}

export interface UserMessage extends Message {
  role: 'user';
}

export interface Session {
  id: string;
  title: string | null;
  parent_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionBody {
  title?: string;
  parentID?: string;
}

export interface PromptBody {
  messageID?: string;
  model?: ModelSpec;
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: unknown[];
  parts: Part[];
  outputFormat?: {
    type: 'text' | 'json_schema';
    schema?: unknown;
    retryCount?: number;
  };
}

export interface PromptResponse {
  info: AssistantMessage;
  parts: Part[];
}

export interface GlobalHealth {
  healthy: boolean;
  version: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: string[];
}

export interface ConfigInfo {
  model?: string;
  [key: string]: unknown;
}

// ─── OpenCode JSON config types ──────────────────────────

export interface OpencodeProviderEntry {
  name?: string;
  npm?: string;
  options?: { baseURL?: string; apiKey?: string; [key: string]: unknown };
  models?: Record<string, Record<string, unknown>>;
}

export interface OpencodeConfig {
  $schema?: string;
  model?: string;
  small_model?: string;
  provider?: Record<string, OpencodeProviderEntry>;
  permission?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
}

export function validateOpencodeConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof config !== 'object' || config === null) {
    errors.push('Config must be a JSON object');
    return { valid: false, errors };
  }
  const c = config as OpencodeConfig;
  if (!c.model) {
    errors.push('Root field "model" is required (format: "providerID/modelID")');
  } else if (typeof c.model === 'string' && !c.model.includes('/')) {
    errors.push('model must be in format "providerID/modelID"');
  }
  return { valid: errors.length === 0, errors };
}
