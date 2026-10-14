// Cobertura do código novo (US-079 — RN-FND-24): linhas adicionadas no PR em
// `apps/api/src/modules/<módulo>/{domain,application}/**`, cruzadas com o lcov do Vitest; cada
// módulo tocado precisa de `ci.coverageThreshold`% (padrão 80) das linhas executáveis novas cobertas.
// Os 100% das regras de cálculo e políticas são conferidos na revisão (release-checklist.md).
import path from 'node:path';

/** Arquivo → linha → execuções. */
export type LineCoverage = Map<string, Map<number, number>>;

function toPosix(file: string): string {
  return file.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Interpreta um `lcov.info`. Caminhos relativos (`SF:src/...`) são resolvidos a partir de
 * `packageDir` (relativo à raiz); absolutos, a partir de `root`.
 */
export function parseLcov(text: string, packageDir: string, root: string): LineCoverage {
  const result: LineCoverage = new Map();
  let current: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const source = line.slice(3);
      const relative = path.isAbsolute(source)
        ? path.relative(root, source)
        : path.join(packageDir, source);
      const file = toPosix(path.normalize(relative));
      current = result.get(file) ?? new Map<number, number>();
      result.set(file, current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNumber = '', hits = ''] = line.slice(3).split(',');
      const number = Number(lineNumber);
      current.set(number, Math.max(current.get(number) ?? 0, Number(hits)));
    } else if (line === 'end_of_record') {
      current = undefined;
    }
  }
  return result;
}

const MODULE_LAYER =
  /^apps\/api\/src\/modules\/([^/]+)\/(domain|application)\/.+(?<!\.spec|\.test)\.tsx?$/;

/** Módulo de DEC-040 dono do arquivo, se ele estiver em `domain/` ou `application/`. */
export function moduleOf(file: string): string | undefined {
  return MODULE_LAYER.exec(file)?.[1];
}

export interface ModuleCoverage {
  readonly module: string;
  /** Linhas executáveis novas. */
  readonly total: number;
  readonly covered: number;
  /** Percentual (100 quando não há linha executável nova). */
  readonly percent: number;
  readonly passed: boolean;
  /** Linhas novas sem cobertura, por arquivo (para anotar no PR). */
  readonly uncovered: ReadonlyMap<string, readonly number[]>;
}

export interface CoverageGateResult {
  readonly modules: readonly ModuleCoverage[];
  /** Arquivos novos sem dados no lcov (excluídos ou só tipos). */
  readonly missing: readonly string[];
  readonly passed: boolean;
}

export function evaluateCoverage(
  changed: ReadonlyMap<string, ReadonlySet<number>>,
  coverage: LineCoverage,
  threshold: number,
): CoverageGateResult {
  const perModule = new Map<
    string,
    { total: number; covered: number; uncovered: Map<string, number[]> }
  >();
  const missing: string[] = [];
  for (const [file, lines] of changed) {
    const module = moduleOf(file);
    if (module === undefined) continue;
    const fileCoverage = coverage.get(file);
    if (!fileCoverage) {
      missing.push(file);
      continue;
    }
    const entry = perModule.get(module) ?? {
      total: 0,
      covered: 0,
      uncovered: new Map<string, number[]>(),
    };
    perModule.set(module, entry);
    for (const line of [...lines].sort((a, b) => a - b)) {
      const hits = fileCoverage.get(line);
      if (hits === undefined) continue; // linha não executável (tipo, comentário, chave)
      entry.total += 1;
      if (hits > 0) {
        entry.covered += 1;
      } else {
        const list = entry.uncovered.get(file) ?? [];
        list.push(line);
        entry.uncovered.set(file, list);
      }
    }
  }
  const modules = [...perModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, entry]): ModuleCoverage => {
      const percent = entry.total === 0 ? 100 : (entry.covered / entry.total) * 100;
      return {
        module,
        total: entry.total,
        covered: entry.covered,
        percent: Math.round(percent * 10) / 10,
        passed: percent >= threshold,
        uncovered: entry.uncovered,
      };
    });
  return { modules, missing: missing.sort(), passed: modules.every((item) => item.passed) };
}

/** Agrupa linhas consecutivas para anotar trechos (`12-15`) em vez de linha a linha. */
export function lineRanges(lines: readonly number[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}
