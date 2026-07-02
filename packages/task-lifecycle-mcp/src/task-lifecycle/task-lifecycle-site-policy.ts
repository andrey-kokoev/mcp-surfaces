import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TaskLifecycleSitePolicy = {
  roster: {
    roles_are_obligation_targets: boolean;
  };
};

export type TaskLifecycleSitePolicyRead = {
  policy: TaskLifecycleSitePolicy;
  source: 'default' | 'site_config';
  path: string;
};

export const DEFAULT_TASK_LIFECYCLE_SITE_POLICY: TaskLifecycleSitePolicy = Object.freeze({
  roster: Object.freeze({
    roles_are_obligation_targets: false,
  }),
});

export function taskLifecycleSitePolicyPath(siteRoot: string): string {
  return join(siteRoot, '.narada', 'task-lifecycle.toml');
}

export function readTaskLifecycleSitePolicy(siteRoot: string): TaskLifecycleSitePolicyRead {
  const path = taskLifecycleSitePolicyPath(siteRoot);
  if (!existsSync(path)) {
    return { policy: cloneDefaultPolicy(), source: 'default', path };
  }
  const text = readFileSync(path, 'utf8');
  return {
    policy: parseTaskLifecyclePolicyToml(text, path),
    source: 'site_config',
    path,
  };
}

function cloneDefaultPolicy(): TaskLifecycleSitePolicy {
  return {
    roster: {
      roles_are_obligation_targets: DEFAULT_TASK_LIFECYCLE_SITE_POLICY.roster.roles_are_obligation_targets,
    },
  };
}

function parseTaskLifecyclePolicyToml(text: string, path: string): TaskLifecycleSitePolicy {
  const policy = cloneDefaultPolicy();
  let section = '';
  let sawRosterSetting = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index];
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyValueMatch) {
      throw new Error(`task_lifecycle_site_policy_invalid: ${path}:${lineNumber}: expected [section] or key = value`);
    }

    const key = keyValueMatch[1];
    const value = keyValueMatch[2].trim();
    if (section !== 'roster' || key !== 'roles_are_obligation_targets') {
      continue;
    }
    if (sawRosterSetting) {
      throw new Error(`task_lifecycle_site_policy_invalid: ${path}:${lineNumber}: duplicate roster.roles_are_obligation_targets`);
    }
    if (value !== 'true' && value !== 'false') {
      throw new Error(`task_lifecycle_site_policy_invalid: ${path}:${lineNumber}: roster.roles_are_obligation_targets must be true or false`);
    }
    policy.roster.roles_are_obligation_targets = value === 'true';
    sawRosterSetting = true;
  }
  return policy;
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') inString = !inString;
    if (char === '#' && !inString) return line.slice(0, index);
  }
  return line;
}
