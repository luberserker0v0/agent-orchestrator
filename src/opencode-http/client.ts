import { logger } from '../utils/logger.js';
import type { GlobalHealth, Session, CreateSessionBody, PromptBody, PromptResponse, Agent, ProviderInfo, ConfigInfo, Message, Part } from './types.js';

export class OpenCodeClient {
  private baseUrl: string;
  private authHeader?: string;

  constructor(baseUrl: string, username?: string, password?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    if (username && password) {
      this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
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
    const init: RequestInit = {
      method,
      headers,
      signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    logger.info(`[OpenCode HTTP] ${method} ${path}`);
    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error');
      throw new Error(`OpenCode HTTP ${res.status}: ${text}`);
    }

    if (res.status === 204) {
      return undefined as unknown as T;
    }

    return (await res.json()) as T;
  }

  async health(signal?: AbortSignal): Promise<GlobalHealth> {
    return this.request<GlobalHealth>('GET', '/global/health', undefined, signal);
  }

  async createSession(body: CreateSessionBody): Promise<Session> {
    return this.request<Session>('POST', '/session', body);
  }

  async getSession(id: string): Promise<Session> {
    return this.request<Session>('GET', `/session/${id}`);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.request<boolean>('DELETE', `/session/${id}`);
  }

  async listMessages(sessionId: string, limit?: number): Promise<{ info: Message; parts: Part[] }[]> {
    const query = limit !== undefined ? `?limit=${limit}` : '';
    return this.request<{ info: Message; parts: Part[] }[]>('GET', `/session/${sessionId}/message${query}`);
  }

  async sendPrompt(sessionId: string, body: PromptBody): Promise<PromptResponse> {
    return this.request<PromptResponse>('POST', `/session/${sessionId}/message`, body);
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return this.request<boolean>('POST', `/session/${sessionId}/abort`);
  }

  async listSessions(): Promise<Session[]> {
    return this.request<Session[]>('GET', '/session');
  }

  async getSessionChildren(id: string): Promise<Session[]> {
    return this.request<Session[]>('GET', `/session/${id}/children`);
  }

  async forkSession(id: string, messageID?: string): Promise<Session> {
    return this.request<Session>('POST', `/session/${id}/fork`, messageID ? { messageID } : undefined);
  }

  async listAgents(): Promise<Agent[]> {
    return this.request<Agent[]>('GET', '/agent');
  }

  async listProviders(): Promise<{ providers: ProviderInfo[]; default: Record<string, string> }> {
    return this.request('GET', '/config/providers');
  }

  async getConfig(): Promise<ConfigInfo> {
    return this.request<ConfigInfo>('GET', '/config');
  }
}

// Re-export types
export type { Message, Part } from './types.js';
