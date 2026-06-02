/**
 * Task relatedness search — Phase 1: tag-based overlap.
 * Extracts implicit tags from task titles/content and finds overlapping tasks.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','are','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','must','shall','can','need','dare','ought','used','this','that','these','those','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','her','its','our','their','mine','yours','hers','ours','theirs','what','which','who','whom','whose','where','when','why','how','all','each','every','both','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','now','then','here','there','up','down','out','off','over','under','again','further','on','off','also','into','through','during','before','after','above','below','between','among','within','without','against','towards','upon','across','around','behind','beyond','except','inside','outside','until','via','per','amongst','amid','beside','besides','concerning','despite','following','like','minus','near','past','regarding','round','save','since','till','toward','underneath','unlike','versus','worth',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

function extractFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('---', 3);
  if (end === -1) return {};
  const fm = text.slice(3, end).trim();
  const result = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

export function extractTaskTags(taskPath) {
  const text = readFileSync(taskPath, 'utf8');
  const fm = extractFrontmatter(text);
  const body = text.replace(/^---[\s\S]*?---/, '').trim();

  // Collect text sources for tagging
  const sources = [];
  if (fm.title) sources.push(fm.title);
  // Title from first heading
  const titleMatch = body.match(/^#\s+(.+)$/m);
  if (titleMatch) sources.push(titleMatch[1]);
  // Goal section
  const goalMatch = body.match(/^##\s+Goal\s*$/m);
  if (goalMatch) {
    const start = goalMatch.index + goalMatch[0].length;
    const rest = body.slice(start);
    const next = rest.match(/^##\s/m);
    const goalText = next ? body.slice(start, start + next.index) : body.slice(start);
    sources.push(goalText.slice(0, 500));
  }
  // Context section
  const ctxMatch = body.match(/^##\s+Context\s*$/m);
  if (ctxMatch) {
    const start = ctxMatch.index + ctxMatch[0].length;
    const rest = body.slice(start);
    const next = rest.match(/^##\s/m);
    const ctxText = next ? body.slice(start, start + next.index) : body.slice(start);
    sources.push(ctxText.slice(0, 300));
  }

  const tokens = tokenize(sources.join(' '));
  const tagCounts = new Map();
  for (const t of tokens) {
    tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }

  // Sort by frequency, take top 12 as implicit tags
  const sorted = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag]) => tag);

  // Add explicit tags from frontmatter if present
  if (fm.tags) {
    const explicit = fm.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    for (const t of explicit) {
      if (!sorted.includes(t)) sorted.push(t);
    }
  }

  return {
    task_number: parseInt(fm.number, 10) || null,
    tags: sorted,
    title: fm.title || (titleMatch ? titleMatch[1] : null),
  };
}

export function findRelatedTasks({ tasksDir, targetTaskNumber, limit = 8 }) {
  const dir = resolve(tasksDir);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

  const allTags = [];
  for (const f of files) {
    const info = extractTaskTags(join(dir, f));
    if (info.task_number) allTags.push(info);
  }

  const target = allTags.find((t) => t.task_number === targetTaskNumber);
  if (!target) return { target: targetTaskNumber, related: [], schema: 'narada.task.relatedness.v0' };

  const targetTagSet = new Set(target.tags);
  const scored = [];

  for (const other of allTags) {
    if (other.task_number === targetTaskNumber) continue;
    const overlap = other.tags.filter((t) => targetTagSet.has(t));
    if (overlap.length === 0) continue;
    // Score: overlap count weighted by overlap ratio
    const score = overlap.length * (overlap.length / Math.max(target.tags.length, other.tags.length));
    scored.push({
      task_number: other.task_number,
      title: other.title,
      overlap_tags: overlap,
      overlap_count: overlap.length,
      score: Math.round(score * 100) / 100,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    target: targetTaskNumber,
    target_tags: target.tags,
    related: scored.slice(0, limit),
    schema: 'narada.task.relatedness.v0',
    generated_at: new Date().toISOString(),
  };
}
