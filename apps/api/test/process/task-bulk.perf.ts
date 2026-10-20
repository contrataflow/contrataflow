// US-058 · "Testes necessários — Performance": lote de 50 itens processado em < 5 s (p95). Mede o
// TSK-03 (`POST /tasks/bulk-claim`) inteiro — pipeline HTTP, autorização e 50 transações do PRC-21
// em sequência (trava, POL-04, gravação, auditoria e outbox) — no PostgreSQL real com o papel da
// aplicação, cada amostra com 50 processos novos na fila da unidade. Suíte de performance (DEC-087:
// medida no endurecimento, fora do CI do PR): `pnpm --filter @contrataflow/api test:perf`.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startTaskBulkDatabase } from '../support/task-bulk-fixtures.js';
import type { TaskBulkDatabase } from '../support/task-bulk-fixtures.js';

const BATCH = 50;
const WARMUP = 1;
const SAMPLES = 10;
const P95_BUDGET_MS = 5_000;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[Desempenho] assumir em lote 50 processos (US-058)', () => {
  let fixture: TaskBulkDatabase;

  const queue = async () => {
    const ids: string[] = [];
    for (let index = 0; index < BATCH; index += 1) ids.push(await fixture.processInQueue());
    return ids;
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    fixture = await startTaskBulkDatabase();
  }, 300_000);

  afterAll(async () => {
    await fixture.close();
    vi.restoreAllMocks();
  });

  it(`p95 < ${String(P95_BUDGET_MS)} ms com ${String(BATCH)} itens por lote`, async () => {
    const samples: number[] = [];
    for (let run = 0; run < WARMUP + SAMPLES; run += 1) {
      const ids = await queue();
      const startedAt = performance.now();
      const response = await fixture.bulkClaim(ids);
      const elapsed = performance.now() - startedAt;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { meta: { successCount: number } }).meta.successCount).toBe(BATCH);
      if (run >= WARMUP) samples.push(elapsed);
    }
    expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
  }, 900_000);
});
