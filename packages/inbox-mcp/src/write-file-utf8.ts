import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileUtf8(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8' });
}
