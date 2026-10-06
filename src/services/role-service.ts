import { readFileSync, existsSync } from 'node:fs';
import { parse as parseJSONC } from 'jsonc-parser';
import type { BuiltinApiKeyRole, RolesConfig } from '../config-loader.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { atomicWriteFileSync } from '../storage/atomic-file.js';

export interface RoleDefinition {
  name: string;
  permissions: string[];
  builtin: boolean;
}

const BUILTIN_ROLES: Record<BuiltinApiKeyRole, string[]> = {
  admin: ['*'],
  user: [
    'runtime:list', 'role:read',
    'conversation:list', 'conversation:get', 'conversation:events',
    'conversation:start', 'conversation:stop', 'conversation:restart', 'conversation:delete',
    'message:send', 'message:history',
    'config:write', 'config:get',
    'agent:write', 'agent:delete', 'agent:list', 'agent:get',
    'file:write', 'file:delete', 'file:copy', 'file:read', 'file:list',
    'session:create', 'session:delete', 'session:fork', 'session:abort',
    'session:list', 'session:get', 'session:children',
    'provider:list',
    'skill:import', 'skill:delete', 'skill:list', 'skill:get', 'skill:info',
  ],
  observer: [
    'runtime:list', 'role:read',
    'conversation:list', 'conversation:get', 'conversation:events',
    'message:history',
    'config:get',
    'agent:list', 'agent:get',
    'file:read', 'file:list',
    'session:list', 'session:get', 'session:children',
    'provider:list',
    'skill:list', 'skill:get', 'skill:info',
  ],
};

const ROLE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export class RoleService {
  private roles: Map<string, RoleDefinition> = new Map();
  private configPath: string;

  constructor(configPath: string, initialRoles?: RolesConfig) {
    this.configPath = configPath;

    // Load built-in roles
    for (const [name, permissions] of Object.entries(BUILTIN_ROLES)) {
      this.roles.set(name, { name, permissions, builtin: true });
    }

    // Load custom roles from config
    if (initialRoles) {
      for (const [name, def] of Object.entries(initialRoles)) {
        if (this.roles.has(name)) continue;
        this.roles.set(name, { name, permissions: [...def.permissions], builtin: false });
      }
    }
  }

  list(): RoleDefinition[] {
    return Array.from(this.roles.values(), role => this.cloneRole(role));
  }

  get(name: string): RoleDefinition | undefined {
    const role = this.roles.get(name);
    return role ? this.cloneRole(role) : undefined;
  }

  create(name: string, permissions: string[]): RoleDefinition {
    this.validateName(name);
    if (this.roles.has(name)) {
      throw new AppError(409, ErrorCodes.ROLE_ALREADY_EXISTS, `Role "${name}" already exists`);
    }

    const role: RoleDefinition = { name, permissions: [...permissions], builtin: false };
    const nextRoles = new Map(this.roles);
    nextRoles.set(name, role);
    this.persist(nextRoles);
    this.roles = nextRoles;
    logger.info(`Role created: ${name}`);
    return this.cloneRole(role);
  }

  update(name: string, permissions: string[]): RoleDefinition {
    const existing = this.roles.get(name);
    if (!existing) {
      throw new AppError(404, ErrorCodes.ROLE_NOT_FOUND, `Role "${name}" not found`);
    }
    if (existing.builtin) {
      throw new AppError(403, ErrorCodes.CANNOT_MODIFY_BUILTIN_ROLE, `Cannot modify built-in role "${name}"`);
    }

    const role: RoleDefinition = { ...existing, permissions: [...permissions] };
    const nextRoles = new Map(this.roles);
    nextRoles.set(name, role);
    this.persist(nextRoles);
    this.roles = nextRoles;
    logger.info(`Role updated: ${name}`);
    return this.cloneRole(role);
  }

  delete(name: string): void {
    const existing = this.roles.get(name);
    if (!existing) {
      throw new AppError(404, ErrorCodes.ROLE_NOT_FOUND, `Role "${name}" not found`);
    }
    if (existing.builtin) {
      throw new AppError(403, ErrorCodes.CANNOT_DELETE_BUILTIN_ROLE, `Cannot delete built-in role "${name}"`);
    }

    const nextRoles = new Map(this.roles);
    nextRoles.delete(name);
    this.persist(nextRoles);
    this.roles = nextRoles;
    logger.info(`Role deleted: ${name}`);
  }

  hasPermission(roleName: string, permission: string): boolean {
    const role = this.roles.get(roleName);
    if (!role) return false;

    if (role.permissions.includes('*')) return true;
    return role.permissions.includes(permission);
  }

  private validateName(name: string): void {
    if (!ROLE_NAME_REGEX.test(name)) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_ROLE_NAME,
        `Invalid role name "${name}". Must start with a letter and contain only alphanumeric, hyphen, or underscore characters (max 64).`
      );
    }
  }

  private cloneRole(role: RoleDefinition): RoleDefinition {
    return { ...role, permissions: [...role.permissions] };
  }

  private persist(roles: ReadonlyMap<string, RoleDefinition>): void {
    const rolesObj: RolesConfig = {};
    for (const [name, def] of roles) {
      if (def.builtin) continue;
      rolesObj[name] = { permissions: def.permissions };
    }

    try {
      let config: Record<string, unknown>;
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, 'utf-8');
        config = parseJSONC(raw) as Record<string, unknown>;
      } else {
        config = {};
      }

      config['roles'] = rolesObj;
      atomicWriteFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      logger.error(`Failed to persist roles to config: ${(err as Error).message}`);
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Failed to persist role configuration');
    }
  }
}
