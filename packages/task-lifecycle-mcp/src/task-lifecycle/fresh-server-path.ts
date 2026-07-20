import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from 'node:path';

export type FreshServerPathAdmission = {
  status: 'admitted' | 'refused';
  requested_path: string;
  resolved_path: string;
  path_kind: 'site_root_relative' | 'absolute';
  authority_root: string | null;
  allowed_roots: string[];
  reason: string | null;
};

export function resolveFreshServerPath(input: {
  siteRoot: string;
  serverPath: string;
  runtimeModulePath: string;
  env?: NodeJS.ProcessEnv;
}): FreshServerPathAdmission {
  const siteRoot = resolve(input.siteRoot);
  const pathKind = isAbsolute(input.serverPath) ? 'absolute' : 'site_root_relative';
  const resolvedPath = pathKind === 'absolute' ? resolve(input.serverPath) : resolve(siteRoot, input.serverPath);
  const packageRoot = findTaskLifecyclePackageRoot(input.runtimeModulePath);
  const configuredRoots = String((input.env ?? process.env).NARADA_TASK_LIFECYCLE_FRESH_SERVER_ALLOWED_ROOTS ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
  const allowedRoots = uniquePaths([siteRoot, ...(packageRoot ? [packageRoot] : []), ...configuredRoots]);
  const lexicalAuthorityRoot = allowedRoots.find((root) => isPathWithin(root, resolvedPath)) ?? null;
  const authorityRoot = lexicalAuthorityRoot && (
    !existsSync(resolvedPath) || isCanonicalPathWithin(lexicalAuthorityRoot, resolvedPath)
  ) ? lexicalAuthorityRoot : null;
  let reason: string | null = null;
  if (!authorityRoot) reason = 'server_path_outside_allowed_roots';
  else if (!existsSync(resolvedPath)) reason = 'server_path_not_found';
  else if (!statSync(resolvedPath).isFile()) reason = 'server_path_not_file';
  else if (!['.js', '.mjs', '.cjs'].includes(extname(resolvedPath).toLowerCase())) reason = 'server_path_extension_not_executable_mcp_script';
  return {
    status: reason ? 'refused' : 'admitted',
    requested_path: input.serverPath,
    resolved_path: resolvedPath,
    path_kind: pathKind,
    authority_root: authorityRoot,
    allowed_roots: allowedRoots,
    reason,
  };
}

function isCanonicalPathWithin(root: string, target: string): boolean {
  try {
    return isPathWithin(realpathSync(root), realpathSync(target));
  } catch {
    return false;
  }
}

export function findTaskLifecyclePackageRoot(runtimeModulePath: string): string | null {
  let cursor = dirname(resolve(runtimeModulePath));
  while (true) {
    const packageJson = resolve(cursor, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, 'utf8'));
        if (parsed?.name === '@narada2/task-lifecycle-mcp') return cursor;
      } catch {
        // Keep walking; malformed unrelated package metadata is not authority.
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function isPathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
