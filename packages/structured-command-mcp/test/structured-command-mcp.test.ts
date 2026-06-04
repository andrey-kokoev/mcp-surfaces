import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServerState,
  executeStructuredCommand,
  handleRequest,
} from '../src/main.js';
import { decideStructuredCommandExecution } from '../src/policy.js';
type DynamicTestValue = string & DynamicTestValue[] & {
  [key: string]: DynamicTestValue;
  [index: number]: DynamicTestValue;
};

type JsonRpcTestResponse = {
  result: DynamicTestValue;
  error: DynamicTestValue;
};

type ExecutionResult = Record<string, unknown> & {
  status: string;
  executed: boolean;
  stdout: string;
};
const root = mkdtempSync(join(tmpdir(), 'structured-command-mcp-'));
const auditLogDir = join(root, 'audit');
const trustConfigPath = join(root, 'config.toml');
writeFileSync(trustConfigPath, `[projects.'${root.replaceAll('\\', '\\\\')}']\ntrust_level = "trusted"\n`, 'utf8');

const state = createServerState({
  allowedRoot: root,
  allowCommand: ['node'],
  allowPrefix: ['git status'],
  auditLogDir,
});
const stateWithPwsh = createServerState({
  allowedRoot: root,
  allowCommand: ['node', 'pwsh', 'pwsh.exe', 'powershell.exe'],
  auditLogDir: join(root, 'audit-pwsh'),
});
const stateWithPwshPrefix = createServerState({
  allowedRoot: root,
  allowPrefix: ['pwsh -File'],
  auditLogDir: join(root, 'audit-pwsh-prefix'),
});
const stateFromTrustConfig = createServerState({
  rootsFromTrustConfig: trustConfigPath,
  allowCommand: ['node'],
  auditLogDir: join(root, 'audit-trust-config'),
});
const rpc = handleRequest as unknown as (request: Record<string, unknown>, requestState: typeof state) => Promise<JsonRpcTestResponse>;
const exec = executeStructuredCommand as unknown as (args: Record<string, unknown>, requestState: typeof state) => Promise<ExecutionResult>;

assert.equal(state.policy.maxTimeoutMs, 300_000);


const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, state);
assert.equal(init.result.serverInfo.name, 'structured-command-mcp');

const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, state);
const toolNames = tools.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(toolNames, [
  'structured_command_execute',
  'structured_command_execution_policy_inspect',
  'structured_command_input_create',
  'structured_command_output_show',
]);
const outputShowTool = tools.result.tools.find((tool) => tool.name === 'structured_command_output_show');
assert.ok(outputShowTool.inputSchema.properties.limit);

const ok = await exec({
  command: 'node',
  args: ['--version'],
  working_directory: root,
}, state);
assert.equal(ok.status, 'ok');
assert.equal(ok.executed, true);
assert.match(ok.stdout, /^v\d+/);
const okWithLongerTimeout = await exec({
  command: 'node',
  args: ['--version'],
  working_directory: root,
  timeout_ms: 120_000,
}, state);
assert.equal(okWithLongerTimeout.status, 'ok');
assert.equal(okWithLongerTimeout.timeout_ms, 120_000);
const okFromTrustConfig = await exec({
  command: 'node',
  args: ['--version'],
  working_directory: root,
}, stateFromTrustConfig);
assert.equal(okFromTrustConfig.status, 'ok');

assert.equal(okFromTrustConfig.executed, true);

const allowedPwsh = decideStructuredCommandExecution({
  command: 'pwsh',
  args: ['-NoProfile'],
  workingDirectory: root,
}, stateWithPwsh.policy);
assert.equal(allowedPwsh.status, 'allowed');
assert.deepEqual(allowedPwsh.reasons, []);

const allowedPwshExe = decideStructuredCommandExecution({
  command: 'pwsh.exe',
  args: ['-NoProfile'],
  workingDirectory: root,
}, stateWithPwsh.policy);
assert.equal(allowedPwshExe.status, 'allowed');
assert.deepEqual(allowedPwshExe.reasons, []);

const allowedPwshExeByPwshPrefix = decideStructuredCommandExecution({
  command: 'pwsh.exe',
  args: ['-File', join(root, 'tool.ps1')],
  workingDirectory: root,
}, stateWithPwshPrefix.policy);
assert.equal(allowedPwshExeByPwshPrefix.status, 'allowed');
assert.deepEqual(allowedPwshExeByPwshPrefix.reasons, []);

const blockedWindowsPowerShell = decideStructuredCommandExecution({
  command: 'powershell.exe',
  args: ['-NoProfile'],
  workingDirectory: root,
}, stateWithPwsh.policy);
assert.equal(blockedWindowsPowerShell.status, 'refused');
assert.ok(blockedWindowsPowerShell.reasons.includes('blocked_command:powershell.exe'));

const refusedRoot = await exec({
  command: 'node',
  args: ['--version'],
  working_directory: tmpdir(),
}, state);
assert.equal(refusedRoot.status, 'refused');

const refusedCall = await rpc({
  jsonrpc: '2.0',
  id: 32,
  method: 'tools/call',
  params: {
    name: 'structured_command_execute',
    arguments: { command: 'pwsh.exe', args: ['-File', join(root, 'tool.ps1')], working_directory: root },
  },
}, state);
assert.match(refusedCall.result.content[0].text, /structured_command_execute: refused/);
assert.match(refusedCall.result.content[0].text, /refusal_reasons: command_not_allowed/);
assert.equal(refusedCall.result.structuredContent.status, 'refused');
assert.equal(refusedCall.result.structuredContent.executed, false);
assert.ok(refusedCall.result.structuredContent.refusal_reasons.some((reason) => String(reason).startsWith('command_not_allowed:')));

const longInlineScript = `${' '.repeat(318)}process.stdout.write('long-inline-ok')`;
const okLongInlineArg = await exec({
  command: 'node',
  args: ['-e', longInlineScript],
  working_directory: root,
}, state);
assert.equal(okLongInlineArg.status, 'ok');
assert.equal(okLongInlineArg.executed, true);
assert.equal(okLongInlineArg.stdout, 'long-inline-ok');

await assert.rejects(
  () => exec({
    command: 'node',
    args: ['x'.repeat(8193)],
    working_directory: root,
  }, state),
  /structured_command_input_too_long:arguments\.args\[0\]:8193>8192/,
);

const policy = await rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'structured_command_execution_policy_inspect',
    arguments: {},
  },
}, state);
assert.match(policy.result.content[0].text, /structured_command\.execution_policy/);
assert.ok(policy.result.content[0].text.length <= 4000);
assert.equal(policy.result.structuredContent.truncated, false);
assert.equal(policy.result.structuredContent.output_ref, undefined);

const unknownTool = await rpc({
  jsonrpc: '2.0',
  id: 31,
  method: 'tools/call',
  params: {
    name: 'structured_command_missing_tool',
    arguments: {},
  },
}, state);
assert.equal(unknownTool.error.data.schema, 'narada.structured_command.error.v0');
assert.equal(unknownTool.error.data.code, 'structured_command_unknown_tool');
assert.equal(unknownTool.error.data.details.tool_name, 'structured_command_missing_tool');

const input = await rpc({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'structured_command_input_create',
    arguments: { input_id: 'inputtest1', command: 'node', args: ['--version'], working_directory: root },
  },
}, state);
assert.match(input.result.content[0].text, /structured_command\.input_create_result/);

const inputRef = input.result.structuredContent.input_ref;
assert.match(inputRef, /^structured_command_input:/);

const badInputRef = await rpc({
  jsonrpc: '2.0',
  id: 41,
  method: 'tools/call',
  params: {
    name: 'structured_command_execute',
    arguments: { input_ref: 'structured_command_output:not_an_input' },
  },
}, state);
assert.equal(badInputRef.error.data.schema, 'narada.structured_command.error.v0');
assert.equal(badInputRef.error.data.code, 'structured_command_invalid_input_ref');
assert.equal(badInputRef.error.data.details.expected_kind, 'input');

const smallCall = await rpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name: 'structured_command_execute',
    arguments: { input_ref: inputRef },
  },
}, state);
assert.equal(smallCall.result.content[0].type, 'text');
assert.match(smallCall.result.content[0].text, /structured_command_execute: ok/);
assert.match(smallCall.result.content[0].text, /stdout:/);
assert.ok(smallCall.result.content[0].text.length <= 4000);
assert.equal(smallCall.result.structuredContent.schema, 'narada.structured_command.execution_result.v0');
assert.equal(smallCall.result.structuredContent.status, 'ok');
assert.equal(smallCall.result.structuredContent.exit_code, 0);
assert.match(smallCall.result.structuredContent.stdout, /^v\d+/);
assert.equal(smallCall.result.structuredContent.stdout_ref, undefined);
assert.equal(smallCall.result.structuredContent.output_ref, undefined);

const largeCall = await rpc({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: {
    name: 'structured_command_execute',
    arguments: {
      command: 'node',
      args: ['-e', "process.stdout.write('x'.repeat(6500))"],
      working_directory: root,
    },
  },
}, state);
assert.equal(largeCall.result.content[0].type, 'text');
assert.ok(largeCall.result.content[0].text.length <= 4000);
assert.match(largeCall.result.content[0].text, /stdout preview truncated/);
assert.equal(largeCall.result.structuredContent.schema, 'narada.structured_command.execution_result.v0');
assert.equal(largeCall.result.structuredContent.status, 'ok');
assert.equal(largeCall.result.structuredContent.stdout_char_length, 6500);
assert.equal(largeCall.result.structuredContent.stdout, 'x'.repeat(1000));
assert.match(largeCall.result.structuredContent.stdout_ref, /^structured_command_output:/);
assert.equal(largeCall.result.structuredContent.stdout_next_offset, 1000);
assert.equal(largeCall.result.structuredContent.output_ref, undefined);

const stdoutPage1 = await rpc({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'structured_command_output_show',
    arguments: { output_ref: largeCall.result.structuredContent.stdout_ref },
  },
}, state);
assert.equal(stdoutPage1.result.content[0].text, 'x'.repeat(4000));
assert.equal(stdoutPage1.result.structuredContent.kind, 'stdout');
assert.equal(stdoutPage1.result.structuredContent.output_ref, largeCall.result.structuredContent.stdout_ref);
assert.equal(stdoutPage1.result.structuredContent.offset, 0);
assert.equal(stdoutPage1.result.structuredContent.limit, 4000);
assert.equal(stdoutPage1.result.structuredContent.next_offset, 4000);
assert.equal(stdoutPage1.result.structuredContent.text_char_length, 4000);
assert.equal(stdoutPage1.result.structuredContent.full_output_char_length, 6500);

const stdoutCustomPage = await rpc({
  jsonrpc: '2.0',
  id: 8,
  method: 'tools/call',
  params: {
    name: 'structured_command_output_show',
    arguments: { output_ref: largeCall.result.structuredContent.stdout_ref, offset: 1000, limit: 1200 },
  },
}, state);
assert.equal(stdoutCustomPage.result.content[0].text, 'x'.repeat(1200));
assert.equal(stdoutCustomPage.result.structuredContent.offset, 1000);
assert.equal(stdoutCustomPage.result.structuredContent.limit, 1200);
assert.equal(stdoutCustomPage.result.structuredContent.next_offset, 2200);

const stdoutFinalPage = await rpc({
  jsonrpc: '2.0',
  id: 9,
  method: 'tools/call',
  params: {
    name: 'structured_command_output_show',
    arguments: { output_ref: largeCall.result.structuredContent.stdout_ref, offset: 6000 },
  },
}, state);
assert.equal(stdoutFinalPage.result.content[0].text, 'x'.repeat(500));
assert.equal(stdoutFinalPage.result.structuredContent.offset, 6000);
assert.equal(stdoutFinalPage.result.structuredContent.limit, 4000);
assert.equal(stdoutFinalPage.result.structuredContent.next_offset, null);
assert.equal(stdoutFinalPage.result.structuredContent.full_output_char_length, 6500);

const audit = readFileSync(join(auditLogDir, 'structured-command.jsonl'), 'utf8');
assert.match(audit, /structured_command\.execution_result/);

console.log('structured command MCP tests passed');
