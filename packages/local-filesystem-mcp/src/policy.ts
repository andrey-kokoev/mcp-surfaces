import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

export function resolveAnchoredAllowedRoot(spec, anchors = defaultAnchors()) {
  if (typeof spec !== 'string' || spec.trim().length === 0) throw new Error('anchored_allowed_root_required');
  const trimmed = spec.trim();
  const separator = trimmed.indexOf(':');
  if (separator <= 0) throw new Error(`anchored_allowed_root_requires_anchor: ${trimmed}`);
  const anchor = trimmed.slice(0, separator).trim();
  const relativePath = trimmed.slice(separator + 1).trim();
  if (!anchor || !relativePath) throw new Error(`anchored_allowed_root_requires_anchor_and_path: ${trimmed}`);
  if (!Object.hasOwn(anchors, anchor)) throw new Error(`anchored_allowed_root_unknown_anchor: ${anchor}`);
  if (isAbsolute(relativePath)) throw new Error(`anchored_allowed_root_path_must_be_relative: ${trimmed}`);
  const anchorRoot = resolve(String(anchors[anchor]));
  const resolved = resolve(anchorRoot, relativePath);
  const rel = relative(anchorRoot, resolved);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) throw new Error(`anchored_allowed_root_path_escapes_anchor: ${trimmed}`);
  return {
    root: resolved,
    provenance: {
      source: 'anchored_allowed_root',
      anchor,
      anchor_root: anchorRoot,
      relative_path: relativePath,
      spec: trimmed,
    },
  };
}

function defaultAnchors(): Record<string, unknown> {
  return { user_home: homedir() };
}

export function buildAllowedRoots({ codexConfigPath = null, explicitRoots = [], anchoredRoots = [], rootsConfigPath = null, anchors = defaultAnchors() } = {}) {
  const entries = [];
  if (codexConfigPath) {
    for (const entry of parseTrustedProjectRootsFromTrustConfig(codexConfigPath)) {
      entries.push(entry);
    }
  }
  if (rootsConfigPath) {
    const parsed = JSON.parse(readFileSync(rootsConfigPath, 'utf8'));
    if (parsed.allowed_roots !== undefined && !Array.isArray(parsed.allowed_roots)) throw new Error('roots_config_requires_allowed_roots_array');
    for (const root of parsed.allowed_roots ?? []) {
      entries.push({ root, provenance: { source: 'roots_config', config_path: rootsConfigPath } });
    }
    if (parsed.anchored_allowed_roots !== undefined) {
      if (!Array.isArray(parsed.anchored_allowed_roots)) throw new Error('roots_config_requires_anchored_allowed_roots_array');
      for (const root of parsed.anchored_allowed_roots) {
        const entry = resolveAnchoredAllowedRoot(root, anchors);
        entries.push({ ...entry, provenance: { ...entry.provenance, source: 'roots_config_anchored_allowed_root', config_path: rootsConfigPath } });
      }
    }
  }
  for (const root of explicitRoots) {
    entries.push({ root, provenance: { source: 'explicit_flag', flag: '--allowed-root' } });
  }
  for (const root of anchoredRoots) {
    const entry = resolveAnchoredAllowedRoot(root, anchors);
    entries.push({ ...entry, provenance: { ...entry.provenance, flag: '--anchored-allowed-root' } });
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
  return {
    path: candidate,
    root,
    resolution_base: isAbsolute(inputPath) ? null : base,
    resolution_rule: isAbsolute(inputPath) ? 'absolute_path' : 'first_allowed_root',
  };
}

export function findContainingRoot(path, allowedRoots) {
  const candidate = resolve(path);
  for (const root of allowedRoots) {
    const rel = relative(root, candidate);
    if (rel === '' || (!rel.startsWith('..') && rel !== '..' && !isAbsolute(rel))) return root;
  }
  return null;
}
