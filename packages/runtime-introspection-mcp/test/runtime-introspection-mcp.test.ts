import assert from 'node:assert/strict';
import {
  handleRequest,
  listTools,
  runtimeIntrospectionAnalyze,
  runtimeIntrospectionFormats,
  runtimeIntrospectionShow,
  runtimeIntrospectionTop,
} from '../src/main.js';

const tools = listTools();
assert.deepEqual(tools.map((tool) => tool.name), [
  'runtime_introspection_formats',
  'runtime_introspection_analyze',
  'runtime_introspection_top',
  'runtime_introspection_show',
]);
assert.equal(tools.every((tool) => tool.annotations.readOnlyHint === true), true);
assert.equal(tools.every((tool) => tool.inputSchema.additionalProperties === false), true);

const formats = runtimeIntrospectionFormats();
assert.deepEqual(formats.formats.map((format) => format.format), ['generic-events', 'codex-jsonl', 'codex-transcript']);
assert.equal(formats.adapter_model.codex, 'input_adapter_only');

const analysis = runtimeIntrospectionAnalyze({
  format: 'codex-transcript',
  transcript: [
    {
      id: '1',
      timestamp: '2026-06-20T14:00:00.000Z',
      role: 'assistant',
      type: 'tool_call',
      tool_name: 'mcp__narada_andrey_local_filesystem.fs_read_file',
      status: 'ok',
      duration_ms: 12,
    },
    {
      id: '2',
      timestamp: '2026-06-20T14:00:01.000Z',
      role: 'assistant',
      type: 'tool_call',
      tool_name: 'mcp__narada_andrey_structured_command.structured_c_f506b8d2121f',
      status: 'refused',
      duration_ms: 3,
      content: 'command refused',
    },
    {
      id: '3',
      timestamp: '2026-06-20T14:00:02.000Z',
      role: 'assistant',
      type: 'tool_call',
      tool_name: 'functions.shell_command',
      status: 'ok',
      duration_ms: 5,
    },
  ],
});
assert.equal(analysis.format, 'codex-transcript');
assert.equal(analysis.summary.event_count, 3);
assert.equal(analysis.summary.refused_count, 1);
assert.deepEqual(analysis.summary.input_adapters, ['codex']);
assert.equal(analysis.counts.by_surface['local-filesystem'], 1);
assert.equal(analysis.counts.by_surface['structured-command'], 1);
assert.equal(analysis.counts.by_surface.codex, undefined);
assert.equal(analysis.notes.includes('codex_records_are_treated_as_input_adapter_not_narada_surface'), true);

const topSurface = runtimeIntrospectionTop({ analysis, dimension: 'surface', limit: 1 });
assert.equal(topSurface.items.length, 1);
assert.equal(topSurface.items[0].count, 1);

const topAdapter = runtimeIntrospectionTop({ analysis, dimension: 'adapter', limit: 5 });
assert.deepEqual(topAdapter.items.map((item) => item.name), ['codex']);
assert.equal(topAdapter.items[0].count, 3);

const showErrors = runtimeIntrospectionShow({ analysis, view: 'errors' });
assert.equal(Array.isArray(showErrors.data), true);
const errorData = showErrors.data as typeof analysis.timeline;
assert.equal(errorData.length, 1);
assert.equal(errorData[0].status, 'refused');

const showTimeline = runtimeIntrospectionShow({ analysis, view: 'timeline', limit: 2 });
assert.equal(Array.isArray(showTimeline.data), true);
const timelineData = showTimeline.data as typeof analysis.timeline;
assert.equal(timelineData.length, 2);
assert.deepEqual(timelineData.map((event) => event.event_id), ['1', '2']);

const jsonlAnalysis = runtimeIntrospectionAnalyze({
  format: 'codex-jsonl',
  jsonl: [
    JSON.stringify({ id: 'j1', type: 'tool_call', tool_name: 'mcp__narada_andrey_git.git_status', status: 'ok' }),
    JSON.stringify({ id: 'j2', type: 'error', content: 'bad trace', status: 'error' }),
  ].join('\n'),
});
assert.equal(jsonlAnalysis.counts.by_surface.git, 1);
assert.equal(jsonlAnalysis.summary.error_count, 1);

const rpc = handleRequest({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'runtime_introspection_show',
    arguments: { analysis, view: 'summary' },
  },
}) as any;
assert.equal(rpc.result.structuredContent.schema, 'narada.runtime_introspection.show.v1');
assert.equal(rpc.result.structuredContent.data.event_count, 3);

const badFormat = handleRequest({
  jsonrpc: '2.0',
  id: 8,
  method: 'tools/call',
  params: {
    name: 'runtime_introspection_analyze',
    arguments: { format: 'narada-codex-surface' },
  },
}) as any;
assert.equal(badFormat.error.data.code, 'runtime_introspection_format_unsupported');

console.log('runtime-introspection MCP tests passed');
