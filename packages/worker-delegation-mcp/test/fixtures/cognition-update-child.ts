import { existsSync, writeFileSync } from 'node:fs';
import {
  loadCognitionDefaultsState,
  updateCognitionDefault,
  type ProviderCognitionDefaults,
} from '../../src/cognition-defaults.js';

const [siteRoot, readyPath, goPath, provider, cognition, model] = process.argv.slice(2);
if (!siteRoot || !readyPath || !goPath || !provider || !cognition || !model) throw new Error('missing cognition update child arguments');

const providerModels = {
  alpha: ['alpha-low', 'alpha-medium', 'alpha-high'],
  beta: ['beta-low', 'beta-medium', 'beta-high'],
};
const registryDefaults: ProviderCognitionDefaults = {
  alpha: {
    low: { model: 'alpha-low', reasoningEffort: 'low' },
    medium: { model: 'alpha-medium', reasoningEffort: 'medium' },
    high: { model: 'alpha-high', reasoningEffort: 'high' },
  },
  beta: {
    low: { model: 'beta-low', reasoningEffort: 'low' },
    medium: { model: 'beta-medium', reasoningEffort: 'medium' },
    high: { model: 'beta-high', reasoningEffort: 'high' },
  },
};
const loaded = loadCognitionDefaultsState({ siteRoot, providerModels, registryDefaults, defaultProvider: 'alpha' });
writeFileSync(readyPath, `${process.pid}\n`, 'utf8');
const startedAt = Date.now();
while (!existsSync(goPath)) {
  if (Date.now() - startedAt > 15_000) throw new Error('timed out waiting for concurrency barrier');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const result = updateCognitionDefault({
  state: loaded.state,
  defaults: loaded.defaults,
  provider,
  cognition,
  model,
  reasoningEffort: 'max',
  actor: `concurrency-child-${process.pid}`,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
