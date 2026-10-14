// pnpm ci:contract [--base origin/main] [--file apps/api/openapi/api.v1.json]
// Estágio "Contrato" (US-079 — RN-FND-23 · V-05): roda depois de `turbo run openapi:generate` e
// compara o contrato gerado no PR com o versionado na base. Também exige que o arquivo versionado
// esteja em dia com o código (geração determinística — RN-FND-38).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { run } from '../lib/process.js';
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import { showFile } from './lib/git.js';
import { breakingMessage, diffOpenApi } from './lib/openapi-diff.js';
import type { OpenApiDocument } from './lib/openapi-diff.js';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    file: { type: 'string', default: 'apps/api/openapi/api.v1.json' },
  },
});

const reporter = createReporter();
const file = values.file;
const headPath = path.join(REPO_ROOT, file);
const headText = existsSync(headPath) ? readFileSync(headPath, 'utf8') : undefined;
const baseText = showFile(values.base, file);

function parse(text: string, origin: string): OpenApiDocument {
  try {
    return JSON.parse(text) as OpenApiDocument;
  } catch (error) {
    reporter.annotate('error', `OpenAPI inválido (${origin}): ${String(error)}`, { file });
    process.exit(1);
  }
}

// 1. O arquivo versionado precisa ser exatamente o gerado (senão o diff compararia o arquivo errado).
const status = run('git', ['status', '--porcelain', '--', file], { cwd: REPO_ROOT });
if (status.stdout.trim() !== '') {
  reporter.annotate(
    'error',
    'Contrato desatualizado: rode "pnpm turbo run openapi:generate" e versione o arquivo gerado.',
    { file, title: 'OPENAPI_OUTDATED' },
  );
  process.exit(1);
}

if (headText === undefined && baseText === undefined) {
  reporter.annotate(
    'notice',
    `Nenhum contrato em ${file} ainda (gerado a partir da US-080); nada a comparar.`,
    { title: 'Contrato' },
  );
  process.exit(0);
}
if (headText === undefined) {
  reporter.annotate('error', `${file} foi removido: o contrato v1 não pode deixar de existir.`, {
    file,
    title: 'OPENAPI_BREAKING_CHANGE',
  });
  process.exit(1);
}

const head = parse(headText, 'PR');
const base = baseText === undefined ? { paths: {} } : parse(baseText, values.base);
const changes = diffOpenApi(base, head);
const breaking = changes.filter((change) => change.level === 'breaking');
const warnings = changes.filter((change) => change.level === 'warning');
const additive = changes.filter((change) => change.level === 'additive');

for (const change of breaking) {
  reporter.annotate('error', `${breakingMessage(change.route)} (${change.detail})`, {
    file,
    title: 'OPENAPI_BREAKING_CHANGE',
  });
}
for (const change of warnings) {
  reporter.annotate('warning', `${change.route}: ${change.detail}`, { file, title: 'Contrato' });
}

const rows = changes.map(
  (change) =>
    `| ${change.level === 'breaking' ? '❌ incompatível' : change.level === 'warning' ? '⚠ atenção' : '✅ aditiva'} | \`${change.route}\` | ${change.detail} |`,
);
reporter.summary(
  [
    '### Contrato OpenAPI v1',
    changes.length === 0
      ? 'Sem mudanças no contrato.'
      : ['| Classificação | Operação | Mudança |', '|---|---|---|', ...rows].join('\n'),
  ].join('\n\n'),
);
reporter.log(
  breaking.length === 0 ? 'info' : 'error',
  'ci.contract',
  `${additive.length} aditivas, ${warnings.length} de atenção, ${breaking.length} incompatíveis.`,
);
process.exitCode = breaking.length === 0 ? 0 : 1;
