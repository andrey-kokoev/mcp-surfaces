import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SiteFabricClient, defaultMcpLoaderEntrypoint } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeLoader = resolve(here, 'fake-loader.js');

assert.match(defaultMcpLoaderEntrypoint().replace(/\\/g, '/'), /packages\/mcp-loader-mcp\/dist\/src\/main\.js$/);

const client = await SiteFabricClient.open({
  siteRoot: 'D:\\fake-site',
  loaderEntrypoint: fakeLoader,
  allowedSurfaceIds: ['alpha', 'beta'],
  requestTimeoutMs: 1_000,
  closeTimeoutMs: 250,
});

try {
  const first = await client.call('alpha', 'echo', { value: 1 });
  assert.deepEqual(first, { schema: 'fake.echo.v1', arguments: { value: 1 }, attach_count: 1 });

  const second = await client.call('alpha', 'echo', { value: 2 });
  assert.deepEqual(second, { schema: 'fake.echo.v1', arguments: { value: 2 }, attach_count: 1 });

  const concurrent = await Promise.all([
    client.call('beta', 'echo', { value: 'a' }),
    client.call('beta', 'echo', { value: 'b' }),
    client.call('beta', 'echo', { value: 'c' }),
  ]);
  assert.equal(concurrent.every((result) => result.attach_count === 2), true);

  await assert.rejects(() => client.call('gamma', 'echo'), /site_fabric_surface_not_allowed:gamma/);
  await assert.rejects(() => client.call('alpha', 'materialized'), /mcp_runtime_result_materialized:alpha:materialized/);
  await assert.rejects(() => client.call('alpha', 'fail'), /mcp_tool_error:alpha:fail/);
  await assert.rejects(() => client.call('alpha', 'hang', {}, { timeoutMs: 50 }), /mcp_request_timeout:tools\/call:50ms/);
} finally {
  await client.close();
}

console.log('mcp-runtime-client ok');
