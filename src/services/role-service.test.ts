import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoleService } from './role-service.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('RoleService', () => {
  let tmpDir: string;
  let configPath: string;
  let service: RoleService;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `role-service-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ server: { port: 8080 } }));
    service = new RoleService(configPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('returns built-in roles', () => {
      const roles = service.list();
      expect(roles).toHaveLength(3);
      const names = roles.map(r => r.name);
      expect(names).toContain('admin');
      expect(names).toContain('user');
      expect(names).toContain('observer');
    });

    it('marks built-in roles as builtin', () => {
      const admin = service.get('admin');
      expect(admin?.builtin).toBe(true);
    });
  });

  describe('get', () => {
    it('returns role by name', () => {
      const admin = service.get('admin');
      expect(admin).toBeDefined();
      expect(admin?.name).toBe('admin');
      expect(admin?.permissions).toEqual(['*']);
    });

    it('returns undefined for unknown role', () => {
      expect(service.get('nonexistent')).toBeUndefined();
    });
  });

  describe('create', () => {
    it('creates a new role', () => {
      const role = service.create('moderator', ['conversation:start', 'message:send']);
      expect(role.name).toBe('moderator');
      expect(role.permissions).toEqual(['conversation:start', 'message:send']);
      expect(role.builtin).toBe(false);
    });

    it('persists to config file', () => {
      service.create('moderator', ['conversation:start']);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.roles.moderator).toEqual({ permissions: ['conversation:start'] });
    });

    it('does not overwrite existing role', () => {
      expect(() => service.create('admin', ['*'])).toThrow('already exists');
    });

    it('rejects invalid names', () => {
      expect(() => service.create('', ['*'])).toThrow('Invalid role name');
      expect(() => service.create('123bad', ['*'])).toThrow('Invalid role name');
      expect(() => service.create('bad name', ['*'])).toThrow('Invalid role name');
      expect(() => service.create('a'.repeat(65), ['*'])).toThrow('Invalid role name');
    });

    it('accepts valid names', () => {
      expect(() => service.create('my-role', ['*'])).not.toThrow();
      expect(() => service.create('MyRole123', ['*'])).not.toThrow();
      expect(() => service.create('agent_dev', ['*'])).not.toThrow();
    });
  });

  describe('update', () => {
    it('updates permissions', () => {
      service.create('moderator', ['conversation:start']);
      const updated = service.update('moderator', ['conversation:start', 'message:send']);
      expect(updated.permissions).toEqual(['conversation:start', 'message:send']);
    });

    it('persists changes', () => {
      service.create('moderator', ['conversation:start']);
      service.update('moderator', ['message:send']);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.roles.moderator.permissions).toEqual(['message:send']);
    });

    it('throws for unknown role', () => {
      expect(() => service.update('nonexistent', ['*'])).toThrow('not found');
    });

    it('cannot modify admin', () => {
      expect(() => service.update('admin', ['conversation:start'])).toThrow('Cannot modify admin');
    });

    it('can modify user role', () => {
      expect(() => service.update('user', ['conversation:start'])).not.toThrow();
    });
  });

  describe('delete', () => {
    it('deletes a custom role', () => {
      service.create('moderator', ['*']);
      service.delete('moderator');
      expect(service.get('moderator')).toBeUndefined();
    });

    it('persists deletion', () => {
      service.create('moderator', ['*']);
      service.delete('moderator');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.roles).toEqual({});
    });

    it('throws for unknown role', () => {
      expect(() => service.delete('nonexistent')).toThrow('not found');
    });

    it('cannot delete admin', () => {
      expect(() => service.delete('admin')).toThrow('Cannot delete admin');
    });

    it('can delete user role', () => {
      expect(() => service.delete('user')).not.toThrow();
    });
  });

  describe('hasPermission', () => {
    it('admin has all permissions via wildcard', () => {
      expect(service.hasPermission('admin', 'conversation:start')).toBe(true);
      expect(service.hasPermission('admin', 'anything:at-all')).toBe(true);
    });

    it('user has conversation permissions', () => {
      expect(service.hasPermission('user', 'conversation:start')).toBe(true);
      expect(service.hasPermission('user', 'message:send')).toBe(true);
      expect(service.hasPermission('user', 'role:write')).toBe(false);
    });

    it('observer has read-only permissions', () => {
      expect(service.hasPermission('observer', 'conversation:list')).toBe(true);
      expect(service.hasPermission('observer', 'message:history')).toBe(true);
      expect(service.hasPermission('observer', 'conversation:start')).toBe(false);
      expect(service.hasPermission('observer', 'message:send')).toBe(false);
    });

    it('custom role permissions work', () => {
      service.create('moderator', ['conversation:start', 'message:send']);
      expect(service.hasPermission('moderator', 'conversation:start')).toBe(true);
      expect(service.hasPermission('moderator', 'conversation:delete')).toBe(false);
    });

    it('returns false for unknown role', () => {
      expect(service.hasPermission('nonexistent', 'anything')).toBe(false);
    });
  });

  describe('initial roles from config', () => {
    it('loads custom roles from initial config', () => {
      const svc = new RoleService(configPath, {
        custom_role: { permissions: ['conversation:start'] },
      });
      const role = svc.get('custom_role');
      expect(role).toBeDefined();
      expect(role?.permissions).toEqual(['conversation:start']);
      expect(role?.builtin).toBe(false);
    });

    it('does not overwrite built-in roles from config', () => {
      const svc = new RoleService(configPath, {
        admin: { permissions: ['bad'] },
      });
      const admin = svc.get('admin');
      expect(admin?.permissions).toEqual(['*']);
    });
  });
});
