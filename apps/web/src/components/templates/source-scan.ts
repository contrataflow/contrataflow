import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Raiz do monorepo (este arquivo fica em `apps/web/src/components/templates`). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');

const SOURCE = /\.(ts|tsx|css)$/;
const IGNORED = /\.(test|stories)\.tsx?$/;

/** Fontes de produção sob `dir` (relativo à raiz), sem testes nem histórias, com `/` como separador. */
function sourceFiles(dir: string): string[] {
  const absolute = path.join(REPO_ROOT, dir);
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((file) => SOURCE.test(file) && !IGNORED.test(file))
    .map((file) => `${dir}/${file.split(path.sep).join('/')}`)
    .sort();
}

/** Arquivos (relativos à raiz) com ao menos uma linha que casa `pattern`, e as linhas. */
export function filesMatching(dirs: readonly string[], pattern: RegExp): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const file of dirs.flatMap(sourceFiles)) {
    const lines = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
    const hits = lines.flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));
    if (hits.length > 0) found.set(file, hits);
  }
  return found;
}
