import assert from 'node:assert/strict';
import { createServerState, handleRequest } from '../src/main.js';

const state = createServerState({});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, state) as Promise<Record<string, any>>;
}
function view(res: Record<string, any>): Record<string, any> {
  return res.result.structuredContent as Record<string, any>;
}

const sapiVoices = view(await call('speech_voices', { provider: 'sapi' }));
assert.equal(sapiVoices.status, 'ok');
assert.equal(sapiVoices.provider, 'sapi');
assert.ok(Array.isArray(sapiVoices.voices));
assert.ok(sapiVoices.count >= 1, `Expected at least 1 SAPI voice, got ${sapiVoices.count}`);

const openaiVoices = view(await call('speech_voices', { provider: 'openai_api' }));
assert.equal(openaiVoices.status, 'ok');
assert.equal(openaiVoices.provider, 'openai_api');
assert.deepEqual(openaiVoices.voices, ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
assert.equal(openaiVoices.count, 6);

const sapiSpoken = view(await call('speech_speak', { text: 'This is a test. One two three.', provider: 'sapi' }));
assert.equal(sapiSpoken.status, 'spoken');
assert.equal(sapiSpoken.provider, 'sapi');

const openaiNoKey = await call('speech_speak', { text: 'Hello', provider: 'openai_api' });
assert.ok(openaiNoKey.error, 'Expected error for openai_api without key');
assert.match(openaiNoKey.error.data.message, /speech_openai_no_key/);

if (process.env.OPENAI_API_KEY) {
  const openaiSpoken = view(await call('speech_speak', { text: 'OpenAI TTS test.', provider: 'openai_api' }));
  assert.equal(openaiSpoken.status, 'spoken');
  assert.equal(openaiSpoken.provider, 'openai_api');
  console.log('openai_api speak ok');
}

console.log('speech-mcp behavior ok');
