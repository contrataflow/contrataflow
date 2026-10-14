// tsx tools/ci/changes.ts --base <sha> [--head <sha>] — output `code` do estágio Higiene (FA-05).
import { parseArgs } from 'node:util';

import { createReporter } from './lib/annotations.js';
import { classifyChanges } from './lib/changes.js';
import { changedFiles } from './lib/git.js';

const { values } = parseArgs({
  options: { base: { type: 'string' }, head: { type: 'string', default: 'HEAD' } },
});

const reporter = createReporter();
const files = values.base ? changedFiles(values.base, values.head) : [];
const scope = classifyChanges(files);

reporter.setOutput('code', String(scope.code));
if (scope.docsOnly) {
  reporter.annotate(
    'notice',
    `Mudança só em docs/** (${scope.files} arquivos): estágios 4–7 pulados; 1–3 continuam ativos.`,
    { title: 'Escopo da mudança' },
  );
}
reporter.log(
  'info',
  'ci.changes',
  scope.code ? 'mudança de código' : 'mudança só de documentação',
  {
    files: scope.files,
    code: scope.code,
  },
);
