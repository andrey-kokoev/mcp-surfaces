/**
 * BOM-safe file write utilities for Node.js.
 *
 * Problem: PowerShell Set-Content and [System.IO.File]::WriteAllText
 * with default UTF8Encoding write a UTF-8 BOM that breaks JSON.parse
 * and other parsers expecting plain UTF-8.
 *
 * These helpers guarantee UTF-8 without BOM, creating parent directories
 * as needed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write text content to a file as UTF-8 without BOM.
 * Creates parent directories if they do not exist.
 *
 * @param {string} filePath
 * @param {string} content
 */
export function writeFileUtf8(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8' });
}

/**
 * Serialize data to JSON and write as UTF-8 without BOM.
 * Creates parent directories if they do not exist.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @param {string | number} [space=2]
 */
export function writeJsonFile(filePath, data, space = 2) {
  const json = JSON.stringify(data, null, space);
  writeFileUtf8(filePath, json);
}

/**
 * Write a task spec markdown file with YAML frontmatter and body.
 * Ensures UTF-8 without BOM and trailing newline.
 *
 * @param {string} filePath
 * @param {object} frontmatter
 * @param {string} body
 */
export function writeMarkdownWithFrontmatter(filePath, frontmatter, body) {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  const content = `---\n${yaml}\n---\n\n${body.trim()}\n`;
  writeFileUtf8(filePath, content);
}
