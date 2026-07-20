import assert from 'node:assert/strict';
import { MOONSHOT_SCHEMA_DIALECT, validateMoonshotToolInputSchema } from '../src/moonshot-schema.js';

assert.deepEqual(validateMoonshotToolInputSchema({
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Name' },
    count: { type: ['integer', 'null'], enum: [1, 2, null] },
  },
  required: ['name'],
  additionalProperties: false,
}), []);

const parentTypeAnyOf = validateMoonshotToolInputSchema({
  type: 'object',
  anyOf: [
    { type: 'object', properties: { value: { type: 'string' } } },
    { type: 'object', properties: { value: { type: 'number' } } },
  ],
});
assert.ok(parentTypeAnyOf.some((finding) => finding.code === 'type_with_any_of'));
assert.match(parentTypeAnyOf.find((finding) => finding.code === 'type_with_any_of')?.message ?? '', /type should be defined in anyOf items/);

assert.ok(validateMoonshotToolInputSchema({ type: 'string', enum: [] })
  .some((finding) => finding.code === 'enum_empty_or_invalid'));

assert.deepEqual(validateMoonshotToolInputSchema({
  anyOf: [
    { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
  ],
}), []);

assert.ok(validateMoonshotToolInputSchema({
  type: 'object',
  properties: { present: { type: 'string' } },
  required: ['missing'],
}).some((finding) => finding.code === 'required_property_missing'));

assert.ok(validateMoonshotToolInputSchema({
  $defs: { item: { type: 'string', description: 'Target description' } },
  $ref: '#/$defs/item',
  description: 'Sibling description',
}).some((finding) => finding.code === 'ref_keyword_conflict'));

console.log(`Moonshot schema fixtures ok (${MOONSHOT_SCHEMA_DIALECT})`);
