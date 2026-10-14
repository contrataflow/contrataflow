// Título do PR = mensagem do commit de squash em `main` (US-079 — fluxo principal 5): o título é
// validado pelo mesmo commitlint dos hooks locais (US-077), com os rodapés `Refs:` e
// `BREAKING CHANGE:` que estiverem no corpo do PR.
import lint from '@commitlint/lint';
import load from '@commitlint/load';

const FOOTER = /^(Refs|BREAKING CHANGE|BREAKING-CHANGE):\s*\S.*$/;

/** Mensagem que o commitlint avalia: título + rodapés encontrados no corpo do PR. */
export function squashMessage(title: string, body: string): string {
  const footers = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => FOOTER.test(line));
  return footers.length === 0 ? title.trim() : `${title.trim()}\n\n${footers.join('\n')}`;
}

export interface LintIssue {
  readonly name: string;
  readonly message: string;
}

export async function lintCommitMessage(
  message: string,
  cwd: string,
): Promise<{ valid: boolean; errors: LintIssue[] }> {
  const config = await load({}, { cwd });
  const result = await lint(message, config.rules, {
    ...(config.parserPreset?.parserOpts ? { parserOpts: config.parserPreset.parserOpts } : {}),
    plugins: config.plugins,
    ...(config.ignores ? { ignores: config.ignores } : {}),
    defaultIgnores: config.defaultIgnores ?? true,
  });
  return {
    valid: result.valid,
    errors: result.errors.map((error) => ({ name: error.name, message: error.message })),
  };
}
