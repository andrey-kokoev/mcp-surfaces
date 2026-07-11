import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeWorkerImplementationBuildManifest } from './implementation-identity.js';

export function writeImplementationIdentityManifest(): void {
  writeWorkerImplementationBuildManifest();
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) writeImplementationIdentityManifest();
