/**
 * Site-local task relatedness search.
 *
 * Explicit task tags are the preferred signal. Derived terms from the task
 * title, goal, and context are a compatibility fallback for older or
 * untagged tasks. Relatedness is descriptive only; it never routes, ranks the
 * workboard, authorizes, or changes task state.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontMatter } from '@narada2/task-governance-core/task-governance';
import { parseStoredTaskTags, parseTaskTagsValue } from '@narada2/task-governance-core/task-tags';

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','are','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','must','shall','can','need','dare','ought','used','this','that','these','those','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','her','its','our','their','mine','yours','hers','ours','theirs','what','which','who','whom','whose','where','when','why','how','all','each','every','both','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','now','then','here','there','up','down','out','off','over','under','again','further','also','into','through','during','before','after','above','below','between','among','within','without','against','towards','upon','across','around','behind','beyond','except','inside','outside','until','via','per','amongst','amid','beside','besides','concerning','despite','following','like','minus','near','past','regarding','round','save','since','till','toward','underneath','unlike','versus','worth',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

function deriveTags(sources) {
  const counts = new Map();
  for (const token of tokenize(sources.filter(Boolean).join(' '))) {
    const tag = token.replace(/_/g, '-');
    counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([tag]) => tag);
}

interface TaskTagInfo {
  task_number: number | null;
  title: string | null;
  explicit_tags: string[];
  derived_tags: string[];
}

function extractTaskTags(taskPath): TaskTagInfo {
  const text = readFileSync(taskPath, 'utf8');
  const { frontMatter, body: parsedBody } = parseFrontMatter(text);
  const body = parsedBody.trim();
  const frontmatterTitle = typeof frontMatter.title === 'string' ? frontMatter.title.trim() : '';
  const frontmatterNumberValue = frontMatter.number ?? frontMatter.task_number;
  const frontmatterNumber = typeof frontmatterNumberValue === 'string'
    || typeof frontmatterNumberValue === 'number'
    ? String(frontmatterNumberValue)
    : '';
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const sources = [];
  if (frontmatterTitle) sources.push(frontmatterTitle);
  if (titleMatch) sources.push(titleMatch[1]);
  const goalMatch = body.match(/^##\s+Goal\s*$/m);
  if (goalMatch) {
    const start = goalMatch.index + goalMatch[0].length;
    const rest = body.slice(start);
    const next = rest.match(/^##\s/m);
    sources.push((next ? body.slice(start, start + next.index) : body.slice(start)).slice(0, 500));
  }
  const ctxMatch = body.match(/^##\s+Context\s*$/m);
  if (ctxMatch) {
    const start = ctxMatch.index + ctxMatch[0].length;
    const rest = body.slice(start);
    const next = rest.match(/^##\s/m);
    sources.push((next ? body.slice(start, start + next.index) : body.slice(start)).slice(0, 300));
  }
  const derivedTags = deriveTags(sources);
  let explicitTags: string[] = [];
  try {
    explicitTags = parseTaskTagsValue(frontMatter.tags);
  } catch {
    // A malformed legacy label is ignored; derived terms remain usable.
  }
  const parsedNumber = Number.parseInt(frontmatterNumber, 10);
  return {
    task_number: Number.isNaN(parsedNumber) ? null : parsedNumber,
    title: frontmatterTitle || (titleMatch ? titleMatch[1] : null),
    explicit_tags: explicitTags,
    derived_tags: derivedTags,
  };
}

function infoFromStoredSpec(spec, fallback: TaskTagInfo | undefined): TaskTagInfo {
  const explicitTags = parseStoredTaskTags(spec.tags_json);
  const derivedTags = deriveTags([
    spec.title,
    spec.goal_markdown,
    spec.context_markdown,
  ]);
  return {
    task_number: Number(spec.task_number),
    title: spec.title ?? fallback?.title ?? null,
    // Once SQLite has a task spec, its explicit tag set is authoritative even
    // when it is intentionally empty. Falling back here would resurrect stale
    // Markdown labels after a clear or a failed projection write.
    explicit_tags: explicitTags,
    derived_tags: derivedTags.length > 0 ? derivedTags : (fallback?.derived_tags ?? []),
  };
}

function effectiveTags(info: TaskTagInfo): string[] {
  return info.explicit_tags.length > 0 ? info.explicit_tags : info.derived_tags;
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((tag) => rightSet.has(tag));
}

export function findRelatedTasks({ tasksDir, targetTaskNumber, limit = 8, store = null }) {
  const dir = resolve(tasksDir);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const byNumber = new Map<number, TaskTagInfo>();
  for (const f of files) {
    const info = extractTaskTags(join(dir, f));
    if (info.task_number) byNumber.set(info.task_number, info);
  }

  if (store?.getAllTaskSpecs) {
    for (const spec of store.getAllTaskSpecs()) {
      const fallback = byNumber.get(Number(spec.task_number));
      byNumber.set(Number(spec.task_number), infoFromStoredSpec(spec, fallback));
    }
  }

  const allTags = Array.from(byNumber.values());
  const target = byNumber.get(targetTaskNumber);
  if (!target) return { target: targetTaskNumber, related: [], schema: 'narada.task.relatedness.v0' };
  const targetTags = effectiveTags(target);

  const scored = [];
  for (const other of allTags) {
    if (other.task_number === targetTaskNumber) continue;
    const explicitOverlap = intersection(target.explicit_tags, other.explicit_tags);
    const derivedOverlap = intersection(target.derived_tags, other.derived_tags);
    const overlap = explicitOverlap.length > 0 ? explicitOverlap : derivedOverlap;
    if (overlap.length === 0) continue;
    const matchBasis = explicitOverlap.length > 0 ? 'explicit_tags' : 'derived_terms';
    const otherTags = effectiveTags(other);
    const score = overlap.length * (overlap.length / Math.max(targetTags.length, otherTags.length));
    scored.push({
      task_number: other.task_number,
      title: other.title,
      overlap_tags: overlap,
      overlap_count: overlap.length,
      match_basis: matchBasis,
      score: Math.round(score * 100) / 100,
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.task_number ?? 0) - (b.task_number ?? 0));
  return {
    target: targetTaskNumber,
    target_tags: targetTags,
    target_explicit_tags: target.explicit_tags,
    target_derived_tags: target.derived_tags,
    related: scored.slice(0, Math.max(0, limit)),
    schema: 'narada.task.relatedness.v0',
    generated_at: new Date().toISOString(),
  };
}
