// US-100 · Objetivo "sobrecarga do contexto ≤ 2 ms p95 por transação": o `set_config` que abre toda
// `TenantTransaction`, medido pela própria métrica de produção (`cf_tenant_context_overhead_seconds`)
// no PostgreSQL real com o papel da aplicação. Suíte de performance (DEC-087: medida no
// endurecimento, fora do CI do PR): `pnpm --filter @contrataflow/api test:perf`, sozinha por
// `vitest.perf.config.ts` — a disputa de CPU com as suítes de integração paralelas distorce a latência.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import { isolationMetrics } from '#shared/tenancy/isolation.js';

import { asTenant, startTestDatabase } from './support/postgres.js';
import type { TestDatabase } from './support/postgres.js';

const A = '0192d000-0000-7000-8000-00000000000a';
const WARMUP = 20;
const SAMPLES = 200;

describe('[Desempenho] sobrecarga do contexto de tenant por transação (US-100)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(
      `INSERT INTO tenants (id, slug, name, type, status, state_code)
       VALUES ('${A}', 'prefeitura-a', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC')`,
    );
    app = db.client('cf_app');
  });

  afterAll(async () => {
    await db.stop();
  });

  it('o set_config do contexto fica em p95 ≤ 2 ms (cf_tenant_context_overhead_seconds)', async () => {
    const record = vi.spyOn(isolationMetrics().contextOverhead, 'record');
    const transaction = new TenantTransaction(app);
    const read = () => asTenant(A, () => transaction.read((tx) => tx.tenantMembership.count()));
    // Aquecimento fora da amostra: conexão aberta e consultas preparadas.
    for (let i = 0; i < WARMUP; i += 1) await read();
    record.mockClear();
    for (let i = 0; i < SAMPLES; i += 1) await read();

    const samples = record.mock.calls
      .filter(([, attributes]) => attributes?.scope === 'TENANT')
      .map(([seconds]) => seconds)
      .sort((x, y) => x - y);
    expect(samples).toHaveLength(SAMPLES);
    const p95 = samples[Math.ceil(SAMPLES * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95, `p95 = ${(p95 * 1000).toFixed(3)} ms`).toBeLessThanOrEqual(0.002);
  });
});
