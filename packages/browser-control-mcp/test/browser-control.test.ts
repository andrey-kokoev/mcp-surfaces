import assert from 'node:assert/strict';
import { assertAllowedOrigin, normalizeAllowedOrigins, validateCdpEndpoint, validateCdpWebSocketUrl } from '../src/cdp.js';
import { isSensitiveField, requireConfirmedIntent } from '../src/browser.js';
import { listTools } from '../src/tool-definitions.js';

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: any) => error?.code === code, code);
}

throwsCode(() => validateCdpEndpoint('https://192.168.1.10:9222'), 'cdp_endpoint_not_loopback');
throwsCode(() => validateCdpEndpoint('http://127.0.0.1:9222/debug'), 'cdp_endpoint_path_invalid');
assert.equal(validateCdpEndpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');

throwsCode(() => validateCdpWebSocketUrl('ws://192.168.1.10/devtools/page/1'), 'cdp_websocket_url_not_loopback');
throwsCode(() => validateCdpWebSocketUrl('ws://127.0.0.1/devtools/page/1?token=secret'), 'cdp_websocket_url_contains_credentials_or_query');
assert.equal(validateCdpWebSocketUrl('ws://127.0.0.1/devtools/page/1'), 'ws://127.0.0.1/devtools/page/1');

throwsCode(() => normalizeAllowedOrigins(['https://app.example.test/*']), 'allowed_origin_invalid');
throwsCode(() => normalizeAllowedOrigins(['https://app.example.test/path']), 'allowed_origin_invalid');
assert.deepEqual(normalizeAllowedOrigins(['https://app.example.test/', 'https://app.example.test']), ['https://app.example.test']);
assert.equal(assertAllowedOrigin('https://app.example.test/account?view=summary', ['https://app.example.test']), 'https://app.example.test/account?view=summary');
throwsCode(() => assertAllowedOrigin('https://other.example.test/account', ['https://app.example.test']), 'origin_not_allowed');

assert.equal(isSensitiveField('#password', { nodeName: 'INPUT', attributes: ['type', 'password'] }), true);
assert.equal(isSensitiveField('#title', { nodeName: 'INPUT', attributes: ['type', 'text', 'name', 'title'] }), false);
throwsCode(() => requireConfirmedIntent('submit', false), 'confirmation_required');
requireConfirmedIntent('verify', false);
requireConfirmedIntent('destructive', true);

const tools = listTools();
const names = tools.map((tool) => tool.name);
assert.ok(names.includes('browser_control_attach'));
assert.ok(names.includes('browser_control_accessibility_snapshot'));
assert.ok(names.includes('browser_control_screenshot'));
assert.ok(names.includes('mcp_output_show'));
assert.equal(names.some((name) => name.includes('Runtime.evaluate')), false);
const attach = tools.find((tool) => tool.name === 'browser_control_attach')!;
assert.deepEqual(attach.inputSchema.required, ['profile_id', 'session_id', 'cdp_endpoint', 'allowed_origins']);
const snapshot = tools.find((tool) => tool.name === 'browser_control_accessibility_snapshot')!;
assert.equal(snapshot.annotations?.readOnlyHint, true);
const click = tools.find((tool) => tool.name === 'browser_control_click')!;
assert.equal(click.annotations?.readOnlyHint, false);

console.log('browser-control-mcp unit checks ok');
