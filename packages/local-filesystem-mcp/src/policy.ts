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
    if (trust && trust[1].toLowerCase() === 'trusted') {
      roots.push({ root: currentProject, provenance: { source: 'codex_trust_config', config_path: configPath, project: currentProject } });
    }
  }
  return normalizeAllowedRoots(roots, 'codex_trust_config');
}

export function normalizeAllowedRoots(roots, source = 'unspecified') {
  const seen = new Set();
  const normalized = [];
  for (const entry of roots) {
    const isEntryObject = entry && typeof entry === 'object';
    const raw = typeof entry === 'string' ? entry : isEntryObject ? entry.root : undefined;
    const provenance = isEntryObject && entry.provenance ? entry.provenance : { source };
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const resolved = resolve(raw.trim());
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ root: resolved, provenance });
  }
  return normalized;
}

export function buildAllowedRoots({ codexConfigPath = null, explicitRoots = [], rootsConfigPath = null } = {}) {
  const entries = [];
  if (codexConfigPath) {
    for (const entry of parseTrustedProjectRootsFromTrustConfig(codexConfigPath)) {
      entries.push(entry);
    }
  }
  if (rootsConfigPath) {
    const parsed = JSON.parse(readFileSync(rootsConfigPath, 'utf8'));
    if (!Array.isArray(parsed.allowed_roots)) throw new Error('roots_config_requires_allowed_roots_array');
    for (const root of parsed.allowed_roots) {
      entries.push({ root, provenance: { source: 'roots_config', config_path: rootsConfigPath } });
    }
  }
  for (const root of explicitRoots) {
    entries.push({ root, provenance: { source: 'explicit_flag', flag: '--allowed-root' } });
  }
  const normalized = normalizeAllowedRoots(entries);
  if (normalized.length === 0) throw new Error('filesystem_mcp_requires_at_least_one_allowed_root');
  return normalized;
}

export function rootEntriesToRoots(rootEntries) {
  if (!Array.isArray(rootEntries)) return [];
  return rootEntries.map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry?.root;
  }).filter((root): root is string => typeof root === 'string');
}

export function resolveAllowedPath(inputPath, allowedRootEntries, { defaultRoot = null, requireExistingParent = false } = {}) {
  const allowedRoots = rootEntriesToRoots(allowedRootEntries);
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
