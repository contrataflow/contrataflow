/*
 * Resumo das suítes de desempenho (`test:perf`): cada cenário imprime no console uma linha com o
 * número de amostras, p50 e p95 (e a meta, quando há). Só console — nenhum arquivo é gravado.
 * A linha começa com `[PERF]` para o resumo poder ser lido com `grep '\[PERF\]'` no fim da execução.
 */

/** Percentil `q` (0–1) pelo método do posto mais próximo. */
export function percentile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.max(Math.ceil(sorted.length * q) - 1, 0)] ?? Number.POSITIVE_INFINITY;
}

export const p50 = (samples: readonly number[]): number => percentile(samples, 0.5);
export const p95 = (samples: readonly number[]): number => percentile(samples, 0.95);

/**
 * Imprime `[PERF] cenário | n=… | p50=… ms | p95=… ms | meta p95 < … ms` e devolve o p95 para o
 * `expect`. `budgetMs` é a meta do p95 (só informativa aqui: quem decide é o `expect` do teste).
 */
export function reportPerf(
  scenario: string,
  samples: readonly number[],
  budgetMs?: number,
): number {
  const value = p95(samples);
  const target = budgetMs === undefined ? '' : ` | meta p95 < ${budgetMs.toString()} ms`;
  const line = `[PERF] ${scenario} | n=${samples.length.toString()} | p50=${p50(samples).toFixed(1)} ms | p95=${value.toFixed(1)} ms${target}`;
  process.stdout.write(`${line}\n`);
  return value;
}
