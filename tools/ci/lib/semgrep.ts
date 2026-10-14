// Achados do Semgrep (US-079 — V-04): anotação inline no PR com o id da regra violada, sem depender
// do upload de SARIF para o code scanning.
import type { SourceAnnotation } from './annotate.js';

interface SemgrepResult {
  readonly check_id?: string;
  readonly path?: string;
  readonly start?: { readonly line?: number; readonly col?: number };
  readonly extra?: { readonly message?: string; readonly severity?: string };
}

interface SemgrepError {
  readonly message?: string;
  readonly level?: string;
}

export interface SemgrepReport {
  readonly findings: readonly SourceAnnotation[];
  /** Erros do próprio Semgrep (regra inválida, arquivo que não parseia). */
  readonly errors: readonly string[];
}

export function parseSemgrepJson(json: string): SemgrepReport {
  const raw = JSON.parse(json) as {
    results?: readonly SemgrepResult[];
    errors?: readonly SemgrepError[];
  };
  const findings = (raw.results ?? []).map((result): SourceAnnotation => ({
    level: result.extra?.severity === 'WARNING' ? 'warning' : 'error',
    file: result.path ?? '?',
    ...(result.start?.line === undefined ? {} : { line: result.start.line }),
    ...(result.start?.col === undefined ? {} : { col: result.start.col }),
    title: `Semgrep ${(result.check_id ?? '?').split('.').at(-1) ?? ''}`,
    message: (result.extra?.message ?? '').replace(/\s+/g, ' ').trim(),
  }));
  const errors = (raw.errors ?? [])
    .filter((error) => error.level === 'error')
    .map((error) => (error.message ?? '').trim());
  return { findings, errors };
}
