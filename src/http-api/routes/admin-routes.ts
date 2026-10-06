import type { Express, Request, Response } from 'express';
import type { CleanupManager } from '../../cleanup/cleanup-manager.js';
import { CLEANUP_TARGETS, type CleanupTarget } from '../../cleanup/types.js';
import type { RoleService } from '../../services/role-service.js';
import { AppError, ErrorCodes } from '../../utils/errors.js';
import { handleControllerError, sendError } from '../route-helpers.js';

export function registerAdminRoutes(app: Express, roles: RoleService, cleanup?: CleanupManager): void {
  registerRoleQueries(app, roles);
  registerRoleMutations(app, roles);
  registerCleanupRoutes(app, cleanup);
}

function registerRoleQueries(app: Express, roles: RoleService): void {
  app.get('/api/roles', (_req, res) => res.json(roles.list().map(publicRole)));
  app.get('/api/roles/:name', (req: Request, res: Response) => {
    const role = roles.get(req.params.name as string);
    if (!role) {
      sendError(res, 404, ErrorCodes.ROLE_NOT_FOUND, `Role "${req.params.name as string}" not found`);
      return;
    }
    res.json(publicRole(role));
  });
}

function registerRoleMutations(app: Express, roles: RoleService): void {
  app.post('/api/roles', (req, res) => mutateRole(res, () => {
    const { name, permissions } = req.body as { name?: string; permissions?: string[] };
    if (!name || typeof name !== 'string') throw missing('Missing or invalid "name" field');
    if (!Array.isArray(permissions)) throw missing('Missing or invalid "permissions" array');
    res.status(201).json(publicRole(roles.create(name, permissions)));
  }));
  app.put('/api/roles/:name', (req, res) => mutateRole(res, () => {
    const { permissions } = req.body as { permissions?: string[] };
    if (!Array.isArray(permissions)) throw missing('Missing or invalid "permissions" array');
    res.json(publicRole(roles.update(req.params.name as string, permissions)));
  }));
  app.delete('/api/roles/:name', (req, res) => mutateRole(res, () => {
    roles.delete(req.params.name as string);
    res.json({ deleted: true });
  }));
}

function registerCleanupRoutes(app: Express, cleanup?: CleanupManager): void {
  app.post('/api/cleanup/preview', async (req, res) => {
    const targets = parseCleanupTargets(req.body, false);
    if (!targets) return sendError(res, 400, ErrorCodes.INVALID_REQUEST_BODY, 'Body may contain only a unique non-empty "targets" array');
    if (!cleanup) return sendError(res, 503, ErrorCodes.CLEANUP_FAILED, 'Cleanup service is not available');
    try {
      res.json(await cleanup.preview(targets));
    } catch (error) {
      handleControllerError(res, error);
    }
  });
  app.post('/api/cleanup/run', async (req, res) => runCleanup(req, res, cleanup));
}

async function runCleanup(req: Request, res: Response, cleanup?: CleanupManager): Promise<void> {
  const record = objectRecord(req.body);
  if (record.confirm !== true) return sendError(res, 400, ErrorCodes.CLEANUP_CONFIRMATION_REQUIRED, 'Cleanup requires literal "confirm": true');
  const targets = parseCleanupTargets(req.body, true);
  if (!targets) return sendError(res, 400, ErrorCodes.INVALID_REQUEST_BODY, 'Body must contain only unique non-empty "targets" and "confirm": true');
  if (!cleanup) return sendError(res, 503, ErrorCodes.CLEANUP_FAILED, 'Cleanup service is not available');
  try {
    res.json(await cleanup.run(targets));
  } catch (error) {
    handleControllerError(res, error);
  }
}

function parseCleanupTargets(body: unknown, requireConfirm: boolean): CleanupTarget[] | undefined {
  if (body === undefined && !requireConfirm) return [...CLEANUP_TARGETS];
  const record = objectRecord(body);
  if (body !== record) return undefined;
  const allowed = new Set(requireConfirm ? ['targets', 'confirm'] : ['targets']);
  if (Object.keys(record).some(key => !allowed.has(key)) || (requireConfirm && record.confirm !== true)) return undefined;
  if (record.targets === undefined) return requireConfirm ? undefined : [...CLEANUP_TARGETS];
  if (!Array.isArray(record.targets) || record.targets.length === 0) return undefined;
  if (record.targets.some(target => !CLEANUP_TARGETS.includes(target as CleanupTarget))) return undefined;
  const targets = record.targets as CleanupTarget[];
  return new Set(targets).size === targets.length ? targets : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicRole(role: { name: string; permissions: string[]; builtin: boolean }): object {
  return { name: role.name, permissions: role.permissions, builtin: role.builtin };
}

function mutateRole(res: Response, operation: () => void): void {
  try {
    operation();
  } catch (error) {
    handleControllerError(res, error);
  }
}

function missing(message: string): AppError {
  return new AppError(400, ErrorCodes.MISSING_FIELD, message);
}
