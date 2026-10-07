import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolve a path below a trusted root while refusing every existing symbolic
 * link or junction below that root. Missing trailing components are allowed so
 * the returned path can be used for creation.
 *
 * The configured root itself may be a symlink (a common deployment pattern),
 * but workspace-controlled descendants may not be. Callers must still perform
 * their filesystem operation immediately after this check to minimize TOCTOU
 * exposure inherent in path-based Node.js filesystem APIs.
 */
export function resolvePathWithoutSymlinks(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...segments);
  if (!isContained(resolvedRoot, candidate)) {
    throw new Error('Unsafe path: resolved path escapes its configured root');
  }

  const canonicalRoot = existsSync(resolvedRoot) ? realpathSync.native(resolvedRoot) : resolvedRoot;
  const rel = relative(resolvedRoot, candidate);
  if (!rel) return candidate;

  let current = resolvedRoot;
  for (const component of rel.split(sep)) {
    current = resolve(current, component);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Unsafe path: symbolic links are not allowed in managed workspace paths');
    }
    const canonicalCurrent = realpathSync.native(current);
    if (!isContained(canonicalRoot, canonicalCurrent)) {
      throw new Error('Unsafe path: resolved path escapes its configured root');
    }
  }

  return candidate;
}

/** Resolve an existing source and verify its canonical target is allowed. */
export function resolveAllowedSource(source: string, allowedRoots: string[]): string {
  const resolvedSource = resolve(source);
  const lexicallyAllowed = allowedRoots.some((root) => isContained(resolve(root), resolvedSource));
  if (!lexicallyAllowed) {
    throw new Error('Source path not allowed');
  }
  if (!existsSync(resolvedSource)) return resolvedSource;
  const canonicalSource = realpathSync.native(resolvedSource);
  const allowed = allowedRoots.some((root) => {
    const resolvedRoot = resolve(root);
    if (!existsSync(resolvedRoot)) return false;
    return isContained(realpathSync.native(resolvedRoot), canonicalSource);
  });
  if (!allowed) {
    throw new Error('Source path not allowed');
  }
  return canonicalSource;
}

/** Reject links anywhere in a directory tree before copying or hashing it. */
export function assertTreeHasNoSymlinks(root: string): void {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error('Unsafe path: symbolic links are not allowed in managed workspace paths');
  }
  if (!rootStat.isDirectory()) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error('Unsafe path: symbolic links are not allowed in managed workspace paths');
    }
    if (entry.isDirectory()) assertTreeHasNoSymlinks(resolve(root, entry.name));
  }
}
