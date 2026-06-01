import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export function parseTrustedProjectRootsFromTrustConfig(configPath) {
  const source = readFileSync(configPath, 'utf8');
  const roots = [];
  let currentProject = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[projects\.'([^']+)'\]$/i) ?? line.match(/^\[projects\."([^"]+)"\]$/i);
    if (header) {
      currentProject = header[1];
      continue;
    }
    if (line.startsWith('[')) {
      currentProject = null;
      continue;
    }
    if (!currentProject) continue;
    const trust = line.match(/^trust_level\s*=\s*"([^"]+)"$/i);
    if (trust && trust[1].toLowerCase() === 'trusted') roots.push(currentProject);
  }
  return normalizeAllowedRoots(roots);
}

export function normalizeAllowedRoots(roots) {
  const seen = new Set();
  const normalized = [];
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue;
    const resolved = resolve(root.trim());
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

export function buildAllowedRoots({ codexConfigPath = null, explicitRoots = [], rootsConfigPath = null } = {}) {
  let roots = [];
  if (codexConfigPath) roots.push(...parseTrustedProjectRootsFromTrustConfig(codexConfigPath));
  if (rootsConfigPath) {
    const parsed = JSON.parse(readFileSync(rootsConfigPath, 'utf8'));
    if (!Array.isArray(parsed.allowed_roots)) throw new Error('roots_config_requires_allowed_roots_array');
    roots.push(...parsed.allowed_roots);
  }
  roots.push(...explicitRoots);
  roots = normalizeAllowedRoots(roots);
  if (roots.length === 0) throw new Error('filesystem_mcp_requires_at_least_one_allowed_root');
  return roots;
}

export function resolveAllowedPath(inputPath, allowedRoots, { defaultRoot = null, requireExistingParent = false } = {}) {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) throw new Error('path_required');
  const base = defaultRoot ?? allowedRoots[0];
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(base, inputPath);
  const root = findContainingRoot(candidate, allowedRoots);
  if (!root) throw new Error(`path_outside_allowed_roots: ${inputPath}`);
  if (requireExistingParent && !existsSync(root)) throw new Error(`allowed_root_not_found: ${root}`);
  return { path: candidate, root };
}

export function findContainingRoot(path, allowedRoots) {
  const candidate = resolve(path);
  for (const root of allowedRoots) {
    const rel = relative(root, candidate);
    if (rel === '' || (!rel.startsWith('..') && rel !== '..' && !isAbsolute(rel))) return root;
  }
  return null;
}
