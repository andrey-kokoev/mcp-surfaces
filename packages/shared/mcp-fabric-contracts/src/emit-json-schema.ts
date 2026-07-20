import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpFabricJsonSchemas } from './index.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputDirectory = path.join(packageRoot, 'dist', 'schema');

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  Object.entries(McpFabricJsonSchemas).map(async ([name, schema]) => {
    const filePath = path.join(outputDirectory, `${name.replaceAll('_', '-')}.schema.json`);
    await writeFile(filePath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  }),
);
