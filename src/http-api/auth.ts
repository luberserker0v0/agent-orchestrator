import type { Express, RequestHandler } from 'express';
import type { ApiKeyRole, ServerConfig } from '../config-loader.js';
import { normalizeApiKeys } from '../config-loader.js';
import type { RoleService } from '../services/role-service.js';

declare module 'express-serve-static-core' {
  interface Request {
    apiKeyRole?: ApiKeyRole;
    apiKeyName?: string;
  }
}

const PUBLIC_PATHS = new Set(['/health', '/metrics', '/api-docs', '/api-docs.json', '/dashboard', '/dashboard/']);

const ROUTE_PERMISSIONS: Array<{ method: string; pattern: RegExp; permission: string }> = [
  { method: 'GET', pattern: /^\/api\/runtimes$/, permission: 'runtime:list' },
  { method: 'GET', pattern: /^\/api\/roles(?:\/[^/]+)?$/, permission: 'role:read' },
  { method: 'POST', pattern: /^\/api\/cleanup\/preview$/, permission: 'cleanup:read' },
  { method: 'POST', pattern: /^\/api\/cleanup\/run$/, permission: 'cleanup:run' },
  { method: 'POST', pattern: /^\/api\/conversations$/, permission: 'conversation:start' },
  { method: 'GET', pattern: /^\/api\/conversations$/, permission: 'conversation:list' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+$/, permission: 'conversation:get' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/events$/, permission: 'conversation:events' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/start$/, permission: 'conversation:start' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/stop$/, permission: 'conversation:stop' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/restart$/, permission: 'conversation:restart' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/migrate$/, permission: 'conversation:migrate' },
  { method: 'DELETE', pattern: /^\/api\/conversations\/[^/]+$/, permission: 'conversation:delete' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/config$/, permission: 'config:get' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/config$/, permission: 'config:write' },
  { method: 'PATCH', pattern: /^\/api\/conversations\/[^/]+\/config$/, permission: 'config:write' },
  { method: 'PUT', pattern: /^\/api\/conversations\/[^/]+\/agents$/, permission: 'agent:write' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/agents$/, permission: 'agent:list' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/agents\/[^/]+$/, permission: 'agent:get' },
  { method: 'DELETE', pattern: /^\/api\/conversations\/[^/]+\/agents\/[^/]+$/, permission: 'agent:delete' },
  { method: 'PUT', pattern: /^\/api\/conversations\/[^/]+\/agent\/config$/, permission: 'agent:write' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/agent\/config$/, permission: 'agent:get' },
  { method: 'DELETE', pattern: /^\/api\/conversations\/[^/]+\/agent\/config$/, permission: 'agent:delete' },
  { method: 'PUT', pattern: /^\/api\/conversations\/[^/]+\/files$/, permission: 'file:write' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/files\/read$/, permission: 'file:read' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/files\/delete$/, permission: 'file:delete' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/files\/copy$/, permission: 'file:copy' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/files\/list$/, permission: 'file:list' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/sessions$/, permission: 'session:create' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/sessions$/, permission: 'session:list' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/sessions\/[^/]+$/, permission: 'session:get' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/sessions\/[^/]+\/children$/, permission: 'session:children' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/sessions\/[^/]+\/messages$/, permission: 'message:history' },
  { method: 'DELETE', pattern: /^\/api\/conversations\/[^/]+\/sessions\/[^/]+$/, permission: 'session:delete' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/sessions\/[^/]+\/fork$/, permission: 'session:fork' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/sessions\/abort$/, permission: 'session:abort' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/providers$/, permission: 'provider:list' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/message$/, permission: 'message:send' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/skills\/(?:import|upload)$/, permission: 'skill:import' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/skills$/, permission: 'skill:list' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/skills\/[^/]+$/, permission: 'skill:get' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/skills\/[^/]+\/info$/, permission: 'skill:info' },
  { method: 'DELETE', pattern: /^\/api\/conversations\/[^/]+\/skills\/[^/]+$/, permission: 'skill:delete' },
  { method: 'POST', pattern: /^\/api\/conversations\/[^/]+\/agents\/[^/]+\/skills\/(?:import|upload)$/, permission: 'skill:import' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/agents\/[^/]+\/skills$/, permission: 'skill:list' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/agents\/[^/]+\/skills\/[^/]+$/, permission: 'skill:get' },
  { method: 'GET', pattern: /^\/api\/conversations\/[^/]+\/agents\/[^/]+\/skills\/[^/]+\/info$/, permission: 'skill:info' },
  { method: 'DELETE', pattern: /^\/api\/conversations\/[^/]+\/agents\/[^/]+\/skills\/[^/]+$/, permission: 'skill:delete' },
  { method: 'POST', pattern: /^\/api\/roles$/, permission: 'role:write' },
  { method: 'PUT', pattern: /^\/api\/roles\/[^/]+$/, permission: 'role:write' },
  { method: 'DELETE', pattern: /^\/api\/roles\/[^/]+$/, permission: 'role:write' },
];

export type ResolvedApiKeys = ReturnType<typeof normalizeApiKeys>;

export interface AuthContext {
  apiKeys: ResolvedApiKeys;
  rbacEnabled: boolean;
}

export function installAuth(app: Express, config: ServerConfig, roles: RoleService): AuthContext {
  const apiKeys = normalizeApiKeys(config);
  const rbacEnabled = resolveRbacEnabled(config, apiKeys);
  if (rbacEnabled) {
    app.use(authentication(apiKeys));
    app.use(authorization(roles));
  }
  return { apiKeys, rbacEnabled };
}

function resolveRbacEnabled(config: ServerConfig, keys: ResolvedApiKeys): boolean {
  if (config.rbac?.enabled === true) return true;
  if (config.rbac?.enabled === false) return false;
  return Boolean(keys?.length);
}

function authentication(apiKeys: ResolvedApiKeys): RequestHandler {
  return (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' } });
      return;
    }
    const match = apiKeys?.find(entry => entry.key === header.slice(7));
    if (!match) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
      return;
    }
    req.apiKeyRole = match.role;
    req.apiKeyName = match.name;
    next();
  };
}

function authorization(roles: RoleService): RequestHandler {
  return (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || req.path === '/api/auth/role') return next();
    const route = ROUTE_PERMISSIONS.find(entry => entry.method === req.method && entry.pattern.test(req.path));
    if (!req.apiKeyRole || !route || !roles.hasPermission(req.apiKeyRole, route.permission)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      return;
    }
    next();
  };
}
