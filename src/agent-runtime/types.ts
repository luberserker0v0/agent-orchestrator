import type { ChildProcess } from 'node:child_process';

// ─── Health ────────────────────────────────────────────────────────────

export interface HealthInfo {
  healthy: boolean;
  version: string;
}

// ─── Sessions ──────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  title: string | null;
  parent_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface CreateSessionParams {
  title?: string;
  parentID?: string;
}

// ─── Messages ──────────────────────────────────────────────────────────

export interface MessageInfo {
  id: string;
  session_id: string;
  role: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface MessagePart {
  type: string;
  [key: string]: unknown;
}

export interface MessageEntry {
  info: MessageInfo;
  parts: MessagePart[];
}

export interface SendPromptParams {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: unknown[];
  parts: MessagePart[];
  outputFormat?: {
    type: 'text' | 'json_schema';
    schema?: unknown;
    retryCount?: number;
  };
  [key: string]: unknown;
}

export interface SendPromptResult {
  info: MessageInfo;
  parts: MessagePart[];
}

// ─── Providers & Config ────────────────────────────────────────────────

export interface ProviderListResult {
  providers: Array<{ id: string; name: string; models: string[] }>;
  default: Record<string, string>;
  [key: string]: unknown;
}

export interface AgentConfig {
  model?: string;
  [key: string]: unknown;
}

// ─── Agent Definitions ─────────────────────────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

// ─── AgentClient ───────────────────────────────────────────────────────

export interface AgentClient {
  health(signal?: AbortSignal): Promise<HealthInfo>;
  createSession(body: CreateSessionParams): Promise<SessionInfo>;
  getSession(id: string): Promise<SessionInfo>;
  deleteSession(id: string): Promise<boolean>;
  listSessions(): Promise<SessionInfo[]>;
  getSessionChildren(id: string): Promise<SessionInfo[]>;
  forkSession(id: string, messageID?: string): Promise<SessionInfo>;
  listMessages(sessionId: string, limit?: number): Promise<MessageEntry[]>;
  sendPrompt(sessionId: string, body: SendPromptParams): Promise<SendPromptResult>;
  abortSession(sessionId: string): Promise<boolean>;
  listProviders(): Promise<ProviderListResult>;
  getConfig(): Promise<AgentConfig>;
  listAgents(): Promise<AgentDefinition[]>;
}

// ─── AgentCapabilities ─────────────────────────────────────────────────

export interface AgentCapabilities {
  sessions: boolean;
  streaming: boolean;
  files: boolean;
  tools: boolean;
  config: boolean;
  agents: boolean;
  skills: boolean;
}

// ─── SpawnResult ───────────────────────────────────────────────────────

export interface SpawnResult {
  process: ChildProcess;
  client: AgentClient;
}

// ─── AgentRuntime ──────────────────────────────────────────────────────

export interface AgentRuntime {
  readonly type: string;
  readonly capabilities: AgentCapabilities;
  spawn(
    id: string,
    port: number,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: { retries: number; intervalMs: number; clientTimeoutMs: number },
  ): Promise<SpawnResult>;
  kill(process: ChildProcess, signal?: string | number): Promise<void>;
}
