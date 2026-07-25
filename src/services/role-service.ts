import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse as parseJSONC } from 'jsonc-parser';
import type { ApiKeyRole, RolesConfig } from '../config-loader.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface RoleDefinition {
  name: string;
  permissions: string[];
  builtin: boolean;
}

const BUILTIN_ROLES: Record<ApiKeyRole, string[]> = {
  admin: ['*'],
  user: [
    'conversation:start', 'conversation:stop', 'conversation:restart', 'conversation:delete',
    'message:send',
    'config:write',
    'agent:write', 'agent:delete',
    'file:write', 'file:delete', 'file:copy',
    'session:create', 'session:delete', 'session:fork', 'session:abort',
    'skill:import', 'skill:delete',
  ],
  observer: [
    'conversation:list', 'conversation:get', 'conversation:events',
    'message:history',
    'config:get',
    'agent:list', 'agent:get',
    'file:read', 'file:list',
    'session:list', 'session:get', 'session:children',
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
        this.roles.set(name, { name, permissions: def.permissions, builtin: false });
      }
    }
  }

  list(): RoleDefinition[] {
    return Array.from(this.roles.values());
  }

  get(name: string): RoleDefinition | undefined {
    return this.roles.get(name);
  }

  create(name: string, permissions: string[]): RoleDefinition {
    this.validateName(name);
    if (this.roles.has(name)) {
      throw new AppError(409, ErrorCodes.ROLE_ALREADY_EXISTS, `Role "${name}" already exists`);
    }

    const role: RoleDefinition = { name, permissions, builtin: false };
    this.roles.set(name, role);
    this.persist();
    logger.info(`Role created: ${name}`);
    return role;
  }

  update(name: string, permissions: string[]): RoleDefinition {
    const existing = this.roles.get(name);
    if (!existing) {
      throw new AppError(404, ErrorCodes.ROLE_NOT_FOUND, `Role "${name}" not found`);
    }
    if (existing.builtin && name === 'admin') {
      throw new AppError(403, ErrorCodes.CANNOT_MODIFY_ADMIN, 'Cannot modify admin role');
    }

    existing.permissions = permissions;
    this.persist();
    logger.info(`Role updated: ${name}`);
    return existing;
  }

  delete(name: string): void {
    const existing = this.roles.get(name);
    if (!existing) {
      throw new AppError(404, ErrorCodes.ROLE_NOT_FOUND, `Role "${name}" not found`);
    }
    if (name === 'admin') {
      throw new AppError(403, ErrorCodes.CANNOT_DELETE_ADMIN, 'Cannot delete admin role');
    }

    this.roles.delete(name);
    this.persist();
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

  private persist(): void {
    const rolesObj: RolesConfig = {};
    for (const [name, def] of this.roles) {
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
      writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to persist roles to config: ${(err as Error).message}`);
    }
  }
}
