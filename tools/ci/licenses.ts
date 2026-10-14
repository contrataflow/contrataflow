// pnpm ci:licenses — licenças das dependências de runtime de api, web e worker (RN-FND-21).
// `--input <arquivo>` lê uma saída já gerada de `pnpm licenses list --prod --json`.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { run } from '../lib/process.js';
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import { checkLicenses, parsePnpmLicenses } from './lib/licenses.js';
import { POLICY_FILE, readPolicy } from './lib/policy.js';

/** Apps implantados: só o runtime deles chega às imagens (RN-FND-10 fala em runtime). */
const RUNTIME_APPS = ['@contrataflow/api', '@contrataflow/web', '@contrataflow/worker'];

const { values } = parseArgs({ options: { input: { type: 'string' } } });
const reporter = createReporter();

let json: string;
if (values.input) {
  json = readFileSync(values.input, 'utf8');
} else {
  const result = run(
    'pnpm',
    ['licenses', 'list', '--prod', '--json', ...RUNTIME_APPS.flatMap((app) => ['--filter', app])],
    { cwd: REPO_ROOT, timeoutMs: 300_000 },
  );
  if (result.status !== 0) {
    reporter.annotate('error', `pnpm licenses list falhou: ${result.stderr.trim()}`);
    process.exit(1);
  }
  json = result.stdout;
}

const policy = readPolicy();
const report = checkLicenses(
  parsePnpmLicenses(json),
  policy.licenses.allowed,
  policy.licenses.exceptions,
);

for (const violation of report.violations) {
  reporter.annotate('error', violation.message, { title: 'Licença não permitida' });
}
// Aviso leve: pacotes de plataforma (ex.: binários do sharp por SO) só aparecem em alguns runners.
for (const exception of report.unusedExceptions) {
  reporter.annotate(
    'notice',
    `Exceção de licença sem uso (${exception.package} · ${exception.license}): remova de ${POLICY_FILE}.`,
    { file: POLICY_FILE },
  );
}
reporter.log(
  report.violations.length === 0 ? 'info' : 'error',
  'ci.licenses',
  `${report.checked} pacotes de runtime verificados; ${report.excepted.length} por exceção aprovada; ${report.violations.length} violações.`,
);
process.exitCode = report.violations.length === 0 ? 0 : 1;
