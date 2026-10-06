import { readFileSync } from 'node:fs';

export class AoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AoApiError';
  }
}

export interface AoApiClientOptions {
  server: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  accept?: string;
}

export class AoApiClient {
  private readonly baseUrl: URL;

  constructor(private readonly options: AoApiClientOptions) {
    try {
      this.baseUrl = new URL(options.server);
    } catch {
      throw new Error('Invalid server URL');
    }
    if (this.baseUrl.protocol !== 'http:' && this.baseUrl.protocol !== 'https:') {
      throw new Error('Server URL must use http or https');
    }
    if (this.baseUrl.username || this.baseUrl.password) throw new Error('Server URL must not contain credentials');
  }

  async request<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    const headers: Record<string, string> = { Accept: options.accept ?? 'application/json' };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AoApiError(0, 'REQUEST_TIMEOUT', `Request timed out after ${this.options.timeoutMs}ms`);
      }
      throw new AoApiError(0, 'CONNECTION_FAILED', 'Unable to connect to AgentOrchestrator', sanitizeCause(error));
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      let parsed: { error?: { code?: string; message?: string; details?: unknown }; code?: string; message?: string } = {};
      try {
        parsed = text ? JSON.parse(text) as typeof parsed : {};
      } catch {
        // Never echo arbitrary upstream bodies; they can contain credentials.
      }
      const payload: { code?: string; message?: string; details?: unknown } = parsed.error ?? parsed;
      throw new AoApiError(
        response.status,
        payload.code ?? `HTTP_${response.status}`,
        payload.message ?? `AgentOrchestrator returned HTTP ${response.status}`,
        payload.details,
      );
    }

    if (!text) return undefined as T;
    if ((response.headers.get('content-type') ?? '').includes('json')) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new AoApiError(0, 'INVALID_RESPONSE', 'AgentOrchestrator returned malformed JSON');
      }
    }
    return text as T;
  }
}

export function readApiKey(apiKeyFile?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (apiKeyFile) {
    const value = readFileSync(apiKeyFile, 'utf8').trim();
    if (!value) throw new Error('API key file must not be empty');
    return value;
  }
  const value = env['AOR_API_KEY'];
  return value?.trim() || undefined;
}

function sanitizeCause(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'Error' };
  const code = (error as NodeJS.ErrnoException).code;
  return { name: error.name, ...(code ? { code } : {}) };
}

export function apiExitCode(error: unknown): number {
  if (!(error instanceof AoApiError)) return 1;
  if (error.status === 401 || error.status === 403) return 3;
  if (error.status === 404) return 4;
  if (error.status === 409) return 5;
  return 1;
}
