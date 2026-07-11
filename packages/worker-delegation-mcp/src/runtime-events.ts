import { existsSync, readFileSync } from 'node:fs';

export type AssistantExtractionEvidence = {
  schema: 'narada.worker.assistant_extraction.v1';
  assistant_message_seen: boolean;
  assistant_message_event_count: number;
  assistant_message_extracted: boolean;
  terminal_events: string[];
  failures: string[];
};

const UNAVAILABLE_MCP_RUNTIME_ERROR = /mcp runtime fault|mcp_runtime_fault|surface_registry_tool_not_declared|admission_required|tool_not_declared|unknown[_ -]tool|unavailable[_ -]tool/i;

export function extractUnavailableMcpRuntimeError(text: string): string | null {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => UNAVAILABLE_MCP_RUNTIME_ERROR.test(line)) ?? null;
}

export function isUnavailableMcpRuntimeError(text: string): boolean {
  return UNAVAILABLE_MCP_RUNTIME_ERROR.test(text);
}

export class AgentRuntimeEventTracker {
  workerSessionId: string | null = null;
  finalAssistantMessage: string | null = null;
  turnCompleted = false;
  runtimeError: string | null = null;
  private assistantMessageSeen = false;
  private assistantMessageEventCount = 0;
  private assistantMessageExtracted = false;
  private assistantExtractionFailures = new Set<string>();
  private terminalEvents = new Set<string>();

  handleEvent(event: unknown): void {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    const eventName = typeof record.event === 'string' ? record.event : typeof record.type === 'string' ? record.type : null;
    if (typeof record.session_id === 'string' && record.session_id) this.workerSessionId ||= record.session_id;
    if (eventName === 'assistant_message') {
      this.assistantMessageSeen = true;
      this.assistantMessageEventCount += 1;
      const assistantText = assistantMessageText(record);
      if (assistantText) {
        this.finalAssistantMessage = assistantText;
        this.assistantMessageExtracted = true;
      } else {
        this.assistantExtractionFailures.add('assistant_message_without_text_content');
      }
    }
    if (eventName === 'error') {
      const message = eventErrorMessage(record);
      if (message) {
        this.runtimeError ||= message;
        if (isUnavailableMcpRuntimeError(message)) {
          this.terminalEvents.add('mcp_tool_error');
          this.turnCompleted = true;
        }
      }
    }
    if (eventName === 'turn_failed' || eventName === 'carrier_turn_failed' || eventName === 'session_control_rejected') {
      this.terminalEvents.add(eventName);
      this.runtimeError = eventErrorMessage(record) ?? this.runtimeError ?? eventName;
      this.turnCompleted = true;
    }
    if (eventName === 'turn_complete' || eventName === 'carrier_turn_completed') {
      this.terminalEvents.add(eventName);
      this.turnCompleted = true;
    }
    if (eventName === 'session_closed') this.terminalEvents.add('session_closed');
  }

  evidence(): AssistantExtractionEvidence {
    return {
      schema: 'narada.worker.assistant_extraction.v1',
      assistant_message_seen: this.assistantMessageSeen,
      assistant_message_event_count: this.assistantMessageEventCount,
      assistant_message_extracted: this.assistantMessageExtracted,
      terminal_events: [...this.terminalEvents],
      failures: [...this.assistantExtractionFailures],
    };
  }
}

export function emptyAssistantExtraction(): AssistantExtractionEvidence {
  return {
    schema: 'narada.worker.assistant_extraction.v1',
    assistant_message_seen: false,
    assistant_message_event_count: 0,
    assistant_message_extracted: false,
    terminal_events: [],
    failures: [],
  };
}

export function missingAssistantMessageError(extraction: Record<string, unknown>): string {
  const terminalEvents = Array.isArray(extraction.terminal_events) ? extraction.terminal_events.map(String).filter(Boolean) : [];
  const failures = Array.isArray(extraction.failures) ? extraction.failures.map(String).filter(Boolean) : [];
  if (terminalEvents.length === 0) {
    return `agent_runtime_exited_before_assistant_output: assistant_message_seen=${Boolean(extraction.assistant_message_seen)} assistant_message_extracted=${Boolean(extraction.assistant_message_extracted)}`;
  }
  const terminal = terminalEvents.length > 0 ? terminalEvents.join(',') : 'none';
  const failureText = failures.length > 0 ? ` extraction_failures=${failures.join(',')}` : '';
  return `agent_runtime_completed_without_assistant_output: terminal_events=${terminal} assistant_message_seen=${Boolean(extraction.assistant_message_seen)} assistant_message_extracted=${Boolean(extraction.assistant_message_extracted)}${failureText}`;
}

export function assistantMessageText(record: Record<string, unknown>): string | null {
  for (const key of ['content', 'message', 'text', 'summary']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const content = record.content;
  if (Array.isArray(content)) {
    const parts = content.map((item) => assistantMessageText(asRecord(item))).filter((item): item is string => Boolean(item));
    if (parts.length > 0) return parts.join('\n').trim();
  }
  const message = asRecord(record.message);
  for (const key of ['content', 'text', 'summary']) {
    const value = message[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function eventErrorMessage(record: Record<string, unknown>): string | null {
  const candidates = [
    compactString(record.error),
    compactString(record.message),
    compactString(record.reason),
    compactString(record.code),
  ].filter((value): value is string => Boolean(value));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (candidates[0].includes(candidates[1])) return candidates[0];
  return candidates.join(': ');
}

export function extractSessionEventEvidence(eventsPath: string): Record<string, unknown> {
  const empty = {
    readable: false,
    event_count: 0,
    prompt_admission: 'unknown',
    assistant_message_seen: false,
    terminal_events: [] as string[],
    mutation_admission: { carrier_mutation_admitted: null, delegated_mutation_admitted: null },
    safe_events: [] as Record<string, unknown>[],
  };
  if (!existsSync(eventsPath)) return { ...empty, reason: 'events_path_missing' };
  try {
    const text = readFileSync(eventsPath, 'utf8').trim();
    if (!text) return { ...empty, readable: true, reason: 'events_empty' };
    const safeEvents: Record<string, unknown>[] = [];
    const terminalEvents = new Set<string>();
    let eventCount = 0;
    let promptSent = false;
    let turnStarted = false;
    let assistantSeen = false;
    let carrierMutationAdmitted: boolean | null = null;
    let delegatedMutationAdmitted: boolean | null = null;
    for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(-200)) {
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; } catch { continue; }
      const record = asRecord(parsed);
      eventCount += 1;
      const type = eventType(record) ?? (typeof record.method === 'string' && record.method.trim() ? record.method.trim() : 'unknown');
      if (record.method === 'conversation.send') promptSent = true;
      if (type === 'turn_started') turnStarted = true;
      if (type === 'assistant_message') assistantSeen = true;
      if (type === 'turn_complete' || type === 'carrier_turn_completed' || type === 'input_event_completed' || type === 'turn_failed' || type === 'carrier_turn_failed' || type === 'session_control_rejected' || type === 'session_closed') terminalEvents.add(type);
      const admission = extractMutationAdmission(record);
      if (typeof admission.carrier_mutation_admitted === 'boolean') carrierMutationAdmitted = admission.carrier_mutation_admitted;
      if (typeof admission.delegated_mutation_admitted === 'boolean') delegatedMutationAdmitted = admission.delegated_mutation_admitted;
      safeEvents.push({
        type,
        request_id: typeof record.request_id === 'string' ? record.request_id : null,
        turn_id: typeof record.turn_id === 'string' ? record.turn_id : null,
        terminal_state: typeof record.terminal_state === 'string' ? record.terminal_state : null,
        reason: previewText(record.reason ?? record.error ?? record.message, 160),
      });
    }
    return {
      readable: true,
      event_count: eventCount,
      prompt_admission: promptSent ? 'conversation_send_frame_seen' : turnStarted ? 'turn_started_without_visible_send_frame' : 'no_prompt_or_turn_event_seen',
      assistant_message_seen: assistantSeen,
      terminal_events: [...terminalEvents],
      mutation_admission: { carrier_mutation_admitted: carrierMutationAdmitted, delegated_mutation_admitted: delegatedMutationAdmitted },
      safe_events: safeEvents.slice(-12),
    };
  } catch (error) {
    return { ...empty, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function extractMutationAdmission(value: unknown): { carrier_mutation_admitted?: boolean; delegated_mutation_admitted?: boolean } {
  const record = asRecord(value);
  const result: { carrier_mutation_admitted?: boolean; delegated_mutation_admitted?: boolean } = {};
  if (typeof record.carrier_mutation_admitted === 'boolean') result.carrier_mutation_admitted = record.carrier_mutation_admitted;
  if (typeof record.delegated_mutation_admitted === 'boolean') result.delegated_mutation_admitted = record.delegated_mutation_admitted;
  for (const item of Object.values(record)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = extractMutationAdmission(item);
      if (result.carrier_mutation_admitted === undefined && nested.carrier_mutation_admitted !== undefined) result.carrier_mutation_admitted = nested.carrier_mutation_admitted;
      if (result.delegated_mutation_admitted === undefined && nested.delegated_mutation_admitted !== undefined) result.delegated_mutation_admitted = nested.delegated_mutation_admitted;
    }
  }
  return result;
}

export function eventTimestamp(value: unknown): Date | null {
  const record = asRecord(value);
  for (const key of ['timestamp', 'created_at', 'time']) {
    const item = record[key];
    if (typeof item === 'string') {
      const ms = Date.parse(item);
      if (Number.isFinite(ms)) return new Date(ms);
    }
  }
  return null;
}

export function eventType(value: unknown): string | null {
  const record = asRecord(value);
  if (typeof record.type === 'string' && record.type.trim()) return record.type.trim();
  return typeof record.event === 'string' && record.event.trim() ? record.event.trim() : null;
}

export function latestEventText(value: unknown): string | null {
  const record = asRecord(value);
  const assistantText = assistantMessageText(record);
  if (assistantText) return assistantText;
  for (const key of ['message', 'msg', 'summary', 'text']) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  const type = eventType(value);
  if (type) return type;
  if (value === null) return null;
  return JSON.stringify(value);
}

export function normalizeActivityKind(type: string | null, preview: string | null): string {
  const text = `${type ?? ''} ${preview ?? ''}`.toLowerCase();
  if (/command|exec|shell|structured_command/.test(text)) return 'command';
  if (/apply_patch|edit|write|modified|file_change/.test(text)) return 'file_edit';
  if (/read|grep|glob|search/.test(text)) return 'file_read';
  if (/tool|call/.test(text)) return 'tool';
  if (/error|failed/.test(text)) return 'error';
  return 'model_turn';
}

function compactString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return compactString(record.message) ?? compactString(record.error) ?? compactString(record.reason) ?? compactString(record.code);
}

function previewText(value: unknown, limit: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
