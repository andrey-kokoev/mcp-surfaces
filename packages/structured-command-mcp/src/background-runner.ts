#!/usr/bin/env node
import { readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  audit,
  buildStructuredCommandExecutionPayload,
  readStructuredCommandExecution,
  spawnStructured,
  updateStructuredCommandExecution,
  type StructuredCommandState,
} from './main.js';

type BackgroundExecutionRequest = {
  schema: 'narada.structured_command.background_request.v0';
  execution_ref: string;
  storage_root: string;
  audit_log_dir: string | null;
  command: string;
  args: string[];
  working_directory: string;
  timeout_ms: number;
  max_output_bytes: number;
  started_at: string;
  execution_posture: Record<string, unknown>;
  input_ref: unknown;
};

const requestPath = process.argv[2];
if (!requestPath) throw new Error('structured_command_background_request_path_required');
const expectedSha256 = process.argv[3];
if (!expectedSha256) throw new Error('structured_command_background_request_sha256_required');
const trustedExecutionRef = process.argv[4];
const trustedStorageRoot = process.argv[5];
const trustedAuditLogDir = process.argv[6] || null;
if (!trustedExecutionRef || !trustedStorageRoot) throw new Error('structured_command_background_trusted_context_required');

await run(requestPath, expectedSha256, trustedExecutionRef, trustedStorageRoot, trustedAuditLogDir);

async function run(path: string, expectedHash: string, executionRef: string, storageRoot: string, auditLogDir: string | null): Promise<void> {
  const state = {
    storageRoot,
    auditLogDir,
  } as StructuredCommandState;
  try {
    const request = JSON.parse(readFileSync(path, 'utf8')) as BackgroundExecutionRequest;
    const actualHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (actualHash !== expectedHash || request.execution_ref !== executionRef || request.storage_root !== storageRoot || request.audit_log_dir !== auditLogDir) {
      throw new Error('structured_command_background_request_integrity_mismatch');
    }
    if (request.schema !== 'narada.structured_command.background_request.v0') throw new Error('structured_command_background_request_schema_invalid');
    const result = await spawnStructured(request.command, request.args, {
      cwd: request.working_directory,
      timeoutMs: request.timeout_ms,
      maxOutputBytes: request.max_output_bytes,
      env: process.env,
    });
    const payload = buildStructuredCommandExecutionPayload({
      decision: {
        command: request.command,
        args: request.args,
        working_directory: request.working_directory,
      },
      result,
      startedAt: request.started_at,
      timeoutMs: request.timeout_ms,
      executionPosture: request.execution_posture,
      inputRef: request.input_ref,
      executionMode: 'background',
      waitForCompletion: false,
    });
    audit(state, payload);
    updateStructuredCommandExecution(executionRef, payload, state);
  } catch (error) {
    const existing = readStructuredCommandExecution(executionRef, state);
    const prior = existing.result as Record<string, unknown>;
    const payload = {
      ...prior,
      status: 'failed',
      pending: false,
      finished_at: new Date().toISOString(),
      exit_code: null,
      stderr: error instanceof Error ? error.message : String(error),
    };
    audit(state, payload);
    updateStructuredCommandExecution(executionRef, payload, state);
  } finally {
    rmSync(path, { force: true });
  }
}
