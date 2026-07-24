import { logger } from '../utils/logger.js';
import { opencodeHttpRequestsTotal, opencodeHttpRequestDurationSeconds } from '../metrics/registry.js';
import type { AgentClient, SessionInfo, MessageEntry, SendPromptResult, AgentDefinition, ProviderListResult, AgentConfig, HealthInfo, SendPromptParams, CreateSessionParams } from '../agent-runtime/types.js';

export class OpenCodeAgentClient implements AgentClient {
  private baseUrl: string;
  private authHeader?: string;
  private timeoutMs: number;

  constructor(baseUrl: string, username?: string, password?: string, timeoutMs = 600000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    if (username && password) {
      this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
  }

  private normalizePath(path: string): string {
    const segment = path.split('?')[0].split('/').filter(Boolean)[0];
    return segment || 'unknown';
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), this.timeoutMs);
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(signal.reason));
    }
    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    logger.debug(`[OpenCode HTTP] ${method} ${path}`);
    const normalizedPath = this.normalizePath(path);
    const start = performance.now();
    try {
      const res = await fetch(url, init);
      const duration = (performance.now() - start) / 1000;
      opencodeHttpRequestDurationSeconds.labels(method, normalizedPath).observe(duration);

      if (!res.ok) {
        opencodeHttpRequestsTotal.labels(method, normalizedPath, String(res.status)).inc();
        const text = await res.text().catch(() => 'Unknown error');
        throw new Error(`OpenCode HTTP ${res.status}: ${text}`);
      }

      opencodeHttpRequestsTotal.labels(method, normalizedPath, String(res.status)).inc();
      if (res.status === 204) {
        return undefined as unknown as T;
      }

      return (await res.json()) as T;
    } catch (err) {
      if (!(err as Error).message?.startsWith('OpenCode HTTP ')) {
        const duration = (performance.now() - start) / 1000;
        opencodeHttpRequestDurationSeconds.labels(method, normalizedPath).observe(duration);
        opencodeHttpRequestsTotal.labels(method, normalizedPath, 'error').inc();
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async health(signal?: AbortSignal): Promise<HealthInfo> {
    return this.request<HealthInfo>('GET', '/global/health', undefined, signal);
  }

  async createSession(body: CreateSessionParams): Promise<SessionInfo> {
    return this.request<SessionInfo>('POST', '/session', body);
  }

  async getSession(id: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('GET', `/session/${id}`);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.request<boolean>('DELETE', `/session/${id}`);
  }

  async listMessages(sessionId: string, limit?: number): Promise<MessageEntry[]> {
    const query = limit !== undefined ? `?limit=${limit}` : '';
    return this.request<MessageEntry[]>('GET', `/session/${sessionId}/message${query}`);
  }

  async sendPrompt(sessionId: string, body: SendPromptParams): Promise<SendPromptResult> {
    return this.request<SendPromptResult>('POST', `/session/${sessionId}/message`, body);
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return this.request<boolean>('POST', `/session/${sessionId}/abort`);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>('GET', '/session');
  }

  async getSessionChildren(id: string): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>('GET', `/session/${id}/children`);
  }

  async forkSession(id: string, messageID?: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('POST', `/session/${id}/fork`, messageID ? { messageID } : undefined);
  }

  async listAgents(): Promise<AgentDefinition[]> {
    return this.request<AgentDefinition[]>('GET', '/agent');
  }

  async listProviders(): Promise<ProviderListResult> {
    return this.request<ProviderListResult>('GET', '/config/providers');
  }

  async getConfig(): Promise<AgentConfig> {
    return this.request<AgentConfig>('GET', '/config');
  }
}

export type { Message, Part } from './types.js';
