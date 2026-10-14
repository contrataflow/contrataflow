// tsx tools/ci/pr-title.ts — lê PR_TITLE e PR_BODY do ambiente (nunca interpolados no shell do
// workflow, contra injeção de comandos) e valida a futura mensagem do squash com o commitlint.
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import { lintCommitMessage, squashMessage } from './lib/pr-title.js';

const reporter = createReporter();
const message = squashMessage(process.env.PR_TITLE ?? '', process.env.PR_BODY ?? '');
const result = await lintCommitMessage(message, REPO_ROOT);

for (const error of result.errors) {
  reporter.annotate('error', `${error.name}: ${error.message}`, {
    title: 'Título do PR (commitlint)',
  });
}
if (!result.valid) {
  reporter.annotate(
    'error',
    'O título do PR vira a mensagem do squash: use "tipo(escopo): assunto" e "Refs: US-NNN" no corpo.',
  );
}
reporter.log(result.valid ? 'info' : 'error', 'ci.pr_title', message.split('\n')[0] ?? '');
process.exitCode = result.valid ? 0 : 1;
