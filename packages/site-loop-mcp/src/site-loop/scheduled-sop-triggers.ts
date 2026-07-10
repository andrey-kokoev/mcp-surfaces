import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteLoopConfig, SiteLoopScheduledSop } from './site-loop-config.js';

type ScheduledSopResult = {
  id: string;
  sop_id: string;
  status: 'not_due' | 'planned' | 'created' | 'exists';
  period: number | null;
  due_at: string;
  envelope_id?: string;
  path?: string;
};

export function emitScheduledSopTriggers(
  siteRoot: string,
  config: SiteLoopConfig,
  options: { dryRun?: boolean; now?: string | Date } = {},
) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('scheduled_sop_trigger_invalid_now');

  const results = config.scheduled_sops.map((schedule) =>
    emitScheduledSopTrigger(siteRoot, config, schedule, now, options.dryRun === true),
  );

  return {
    schema: 'narada.site_loop.scheduled_sop_triggers.v1',
    status: 'ok',
    observed_at: now.toISOString(),
    created: results.filter((item) => item.status === 'created').length,
    planned: results.filter((item) => item.status === 'planned').length,
    existing: results.filter((item) => item.status === 'exists').length,
    not_due: results.filter((item) => item.status === 'not_due').length,
    results,
  };
}

function emitScheduledSopTrigger(
  siteRoot: string,
  config: SiteLoopConfig,
  schedule: SiteLoopScheduledSop,
  now: Date,
  dryRun: boolean,
): ScheduledSopResult {
  const anchorMs = Date.parse(schedule.anchor_at);
  const intervalMs = schedule.interval_days * 24 * 60 * 60 * 1000;
  const elapsed = now.getTime() - anchorMs;
  if (elapsed < 0) {
    return {
      id: schedule.id,
      sop_id: schedule.sop_id,
      status: 'not_due',
      period: null,
      due_at: schedule.anchor_at,
    };
  }

  const period = Math.floor(elapsed / intervalMs);
  const dueAt = new Date(anchorMs + period * intervalMs).toISOString();
  const periodKey = dueAt.slice(0, 10).replace(/-/g, '');
  const envelopeId = `env_scheduled_sop_${sanitize(schedule.id)}_${periodKey}`;
  const dir = join(siteRoot, '.ai', 'inbox-envelopes');
  const path = join(dir, `scheduled-sop-${sanitize(schedule.id)}-${periodKey}.json`);
  if (existsSync(path)) {
    return { id: schedule.id, sop_id: schedule.sop_id, status: 'exists', period, due_at: dueAt, envelope_id: envelopeId, path };
  }
  if (dryRun) {
    return { id: schedule.id, sop_id: schedule.sop_id, status: 'planned', period, due_at: dueAt, envelope_id: envelopeId, path };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema: 'narada.inbox_envelope.v1',
    envelope_id: envelopeId,
    received_at: now.toISOString(),
    kind: 'request',
    authority: { level: 'site_policy', principal: `${config.loop_id}.scheduled_sops` },
    source: { kind: 'site_loop_schedule', ref: schedule.id },
    payload: {
      title: schedule.title,
      summary: schedule.instructions,
      recommendation: 'escalate',
      target_role: schedule.target_role,
      preferred_agent_id: schedule.preferred_agent_id,
      sop_id: schedule.sop_id,
      trigger_kind: 'schedule',
      trigger_source_ref: `${schedule.id}:${dueAt}`,
      cadence: { interval_days: schedule.interval_days, anchor_at: schedule.anchor_at },
      mutation_posture: schedule.mutation_posture,
    },
    status: 'received',
  }, null, 2), 'utf8');

  return { id: schedule.id, sop_id: schedule.sop_id, status: 'created', period, due_at: dueAt, envelope_id: envelopeId, path };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
