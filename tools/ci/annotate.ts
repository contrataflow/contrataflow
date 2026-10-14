// tsx tools/ci/annotate.ts <saída-do-turbo.log> — anota no PR os erros de tsc/ESLint/Prettier.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listWorkspaceManifests, readWorkspaceConfig, REPO_ROOT } from '../lib/workspace.js';
import { parseToolOutput } from './lib/annotate.js';
import { createReporter } from './lib/annotations.js';

const logFile = process.argv[2];
if (!logFile) {
  console.error('Uso: annotate.ts <arquivo-de-log>');
  process.exit(2);
}

const packageDirs = new Map<string, string>([['//', '.']]);
for (const manifest of listWorkspaceManifests(REPO_ROOT, readWorkspaceConfig(REPO_ROOT))) {
  packageDirs.set(manifest.name, path.posix.dirname(manifest.path));
}

const reporter = createReporter();
const annotations = parseToolOutput(readFileSync(logFile, 'utf8'), packageDirs, REPO_ROOT);
for (const item of annotations) {
  reporter.annotate(item.level, item.message, {
    file: item.file,
    ...(item.line === undefined ? {} : { line: item.line }),
    ...(item.col === undefined ? {} : { col: item.col }),
    title: item.title,
  });
}
reporter.log('info', 'ci.annotations', `${annotations.length} anotações geradas.`);
