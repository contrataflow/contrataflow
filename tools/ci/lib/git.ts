// Consultas ao Git usadas pelos estágios do CI (US-079): arquivos e linhas alterados no PR e
// conteúdo de um arquivo na versão base (contrato OpenAPI, migrações publicadas).
import { run } from '../../lib/process.js';
import { REPO_ROOT } from '../../lib/workspace.js';

export class GitError extends Error {}

/** Executa `git` e devolve o stdout; falha com a saída do Git. */
export function git(args: readonly string[], cwd: string = REPO_ROOT): string {
  const result = run('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs: 60_000 });
  if (result.status !== 0) {
    throw new GitError(`git ${args.join(' ')} falhou: ${result.stderr.trim() || result.stdout}`);
  }
  return result.stdout;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Arquivos alterados entre o merge-base de `base` e `head` (inclui removidos e renomeados). */
export function changedFiles(base: string, head = 'HEAD', cwd: string = REPO_ROOT): string[] {
  return lines(git(['diff', '--name-only', '--no-renames', `${base}...${head}`], cwd));
}

/** Conteúdo de `file` em `ref`; `undefined` se o arquivo não existe nessa versão. */
export function showFile(ref: string, file: string, cwd: string = REPO_ROOT): string | undefined {
  const result = run('git', ['show', `${ref}:${file}`], { cwd, timeoutMs: 60_000 });
  return result.status === 0 ? result.stdout : undefined;
}

/** Arquivos versionados sob `dir` em `ref`. */
export function filesAtRef(ref: string, dir: string, cwd: string = REPO_ROOT): string[] {
  const result = run('git', ['ls-tree', '-r', '--name-only', ref, '--', dir], {
    cwd,
    timeoutMs: 60_000,
  });
  return result.status === 0 ? lines(result.stdout) : [];
}

/**
 * Interpreta `git diff -U0`: para cada arquivo da versão nova, as linhas adicionadas ou
 * alteradas (números da versão nova). Arquivos removidos não aparecem.
 */
export function parseUnifiedZero(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') {
        current = undefined;
        continue;
      }
      const file = target.replace(/^b\//, '');
      current = result.get(file) ?? new Set<number>();
      result.set(file, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let offset = 0; offset < count; offset += 1) current.add(start + offset);
    }
  }
  for (const [file, changed] of result) if (changed.size === 0) result.delete(file);
  return result;
}

/** Linhas novas do PR nos caminhos indicados (pathspecs do Git). */
export function changedLines(
  base: string,
  head = 'HEAD',
  pathspecs: readonly string[] = [],
  cwd: string = REPO_ROOT,
): Map<string, Set<number>> {
  const diff = git(
    ['diff', '-U0', '--no-color', '--no-renames', `${base}...${head}`, '--', ...pathspecs],
    cwd,
  );
  return parseUnifiedZero(diff);
}
