// Anotações inline do estágio "Estático" (US-079 — V-03 · Gherkin "[Validação]"): lê a saída do
// Turborepo (`<pacote>:<tarefa>: …`) e transforma erros do `tsc`, do ESLint (formato stylish) e
// do Prettier em anotações no arquivo e na linha do PR, com caminhos relativos à raiz.
import path from 'node:path';

import type { AnnotationLevel } from './annotations.js';

export interface SourceAnnotation {
  readonly level: AnnotationLevel;
  readonly file: string;
  readonly line?: number;
  readonly col?: number;
  readonly title: string;
  readonly message: string;
}

const PREFIX = /^(@[^:\s]+\/[^:\s]+|\/\/):([A-Za-z0-9:_-]+?):(?: (.*))?$/;
const TSC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const ESLINT_FILE = /^(?:[A-Za-z]:[\\/]|\/).+\.(?:[cm]?[jt]sx?|json)$/;
const ESLINT_ISSUE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([@\w/-]+))?$/;
const PRETTIER = /^\[warn\] (?!Code style issues)(.+)$/;

function toPosix(file: string): string {
  return file.replace(/\\/g, '/');
}

/**
 * @param output saída combinada do turbo
 * @param packageDirs nome do pacote → diretório relativo à raiz (`//` = raiz)
 * @param root raiz absoluta do repositório (para caminhos absolutos do ESLint)
 */
export function parseToolOutput(
  output: string,
  packageDirs: ReadonlyMap<string, string>,
  root: string,
): SourceAnnotation[] {
  const result: SourceAnnotation[] = [];
  const seen = new Set<string>();
  const eslintFile = new Map<string, string>();
  const relative = (pkg: string, file: string) => {
    const absolute = path.isAbsolute(file)
      ? file
      : path.join(root, packageDirs.get(pkg) ?? '.', file);
    return toPosix(path.relative(root, absolute));
  };
  const push = (item: SourceAnnotation) => {
    const key = `${item.file}:${String(item.line)}:${String(item.col)}:${item.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(item);
  };

  for (const raw of output.split(/\r?\n/)) {
    const prefixed = PREFIX.exec(raw);
    const pkg = prefixed?.[1] ?? '//';
    const task = prefixed?.[2] ?? '';
    const line = (prefixed ? (prefixed[3] ?? '') : raw).replace(/\s+$/, '');

    const tsc = TSC.exec(line.trim());
    if (tsc) {
      const [, file = '', row = '', col = '', level = 'error', code = '', message = ''] = tsc;
      push({
        level: level === 'warning' ? 'warning' : 'error',
        file: relative(pkg, file),
        line: Number(row),
        col: Number(col),
        title: `TypeScript ${code}`,
        message,
      });
      continue;
    }

    if (ESLINT_FILE.test(line.trim())) {
      eslintFile.set(`${pkg}:${task}`, line.trim());
      continue;
    }
    const issue = ESLINT_ISSUE.exec(line);
    const current = eslintFile.get(`${pkg}:${task}`);
    if (issue && current) {
      const [, row = '', col = '', level = 'error', message = '', rule] = issue;
      push({
        level: level === 'warning' ? 'warning' : 'error',
        file: relative(pkg, current),
        line: Number(row),
        col: Number(col),
        title: rule ? `ESLint ${rule}` : 'ESLint',
        message,
      });
      continue;
    }
    if (line.trim() === '') eslintFile.delete(`${pkg}:${task}`);

    const prettier = PRETTIER.exec(line.trim());
    if (prettier) {
      push({
        level: 'error',
        file: relative(pkg, prettier[1] ?? ''),
        title: 'Prettier',
        message: 'Formatação fora do padrão: rode "pnpm format".',
      });
    }
  }
  return result;
}
