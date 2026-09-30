import { logger } from '../utils/logger.js';
import { opencodeHttpRequestsTotal, opencodeHttpRequestDurationSeconds } from '../metrics/registry.js';
import { AppError, ErrorCodes, type LlmQuotaErrorDetails } from '../utils/errors.js';
import type { AgentClient, SessionInfo, MessageEntry, SendPromptResult, AgentDefinition, ProviderListResult, AgentConfig, HealthInfo, SendPromptParams, CreateSessionParams } from '../agent-runtime/types.js';

export type { LlmQuotaErrorDetails };

export class OpenCodeAgentClient implements AgentClient {
  private baseUrl: string;
  private authHeader?: string;
  private timeoutMs: number;

  private static readonly QUOTA_STATUSES = new Set([429, 402, 403]);
  private static readonly QUOTA_EXHAUSTED_PATTERN =
    /quota|token.*exhaust|credit|billing|payment|usage.*limit|insufficient/i;
  private static readonly RATE_LIMITED_PATTERN = /rate.?limit|too many requests/i;

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

  /**
   * Classify upstream 429/402/403 responses into typed LLM quota errors.
   * Returns undefined when the response is not quota-related (caller keeps the
   * generic error path). 429 without a quota match is treated as rate-limited
   * (retryable); 402/403 require a quota body match to avoid misclassifying
   * auth errors.
   */
  static classifyQuotaError(status: number, body: string, headers?: Headers | undefined): AppError | undefined {
    if (!OpenCodeAgentClient.QUOTA_STATUSES.has(status)) {
      return undefined;
    }
    const text = body ?? '';
    const quotaMatch = OpenCodeAgentClient.QUOTA_EXHAUSTED_PATTERN.test(text);
    const rateMatch = OpenCodeAgentClient.RATE_LIMITED_PATTERN.test(text);
    if (!quotaMatch && !rateMatch && status !== 429) {
      return undefined;
    }
    const retryAfterMs = OpenCodeAgentClient.parseRetryAfterMs(headers);
    const details: LlmQuotaErrorDetails = { upstreamStatus: status, body: text };
    if (retryAfterMs !== undefined) {
      details.retryAfterMs = retryAfterMs;
    }
    const message = `OpenCode HTTP ${status}: ${text || 'Unknown error'}`;
    if (quotaMatch) {
      return new AppError(429, ErrorCodes.LLM_QUOTA_EXHAUSTED, message, details);
    }
    return new AppError(429, ErrorCodes.LLM_RATE_LIMITED, message, details);
  }

  private static parseRetryAfterMs(headers?: Headers | undefined): number | undefined {
    const raw = headers?.get?.('retry-after') ?? headers?.get?.('Retry-After');
    if (raw === undefined || raw === null) {
      return undefined;
    }
    const seconds = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return undefined;
    }
    return seconds * 1000;
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
        const quotaError = OpenCodeAgentClient.classifyQuotaError(res.status, text, res.headers);
        throw quotaError ?? new Error(`OpenCode HTTP ${res.status}: ${text}`);
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
