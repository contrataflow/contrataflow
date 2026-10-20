// Ações em lote da caixa de tarefas sobre PostgreSQL real (US-058 · Sucesso, Tenant incorreto,
// Concorrência, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento (workflow padrão DEC-015), processos criados pelo PRC-02 e levados a uma etapa na
// fila da Coordenadoria (sem responsável), e o TSK-03 (`bulk-claim`). Prova uma transação por item
// (sucesso e recusa convivem), o processo de outro tenant no lote como `REFERENCE_NOT_FOUND` sem
// revelar nem alterar nada (RLS), dois lotes concorrentes com processos em comum (o `FOR UPDATE`
// deixa um responsável por processo) e os `ProcessAssigned` `PENDING` no outbox com a auditoria
// `process.claim` carregando `metadata.batchId`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { bulkResultResponseSchema } from '@contrataflow/validation';
import type { BulkResultResponse } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BULK_ANA,
  BULK_DANI,
  BULK_SUBJECTS,
  startTaskBulkDatabase,
} from '../support/task-bulk-fixtures.js';
import type { TaskBulkDatabase } from '../support/task-bulk-fixtures.js';

type Row = Readonly<Record<string, unknown>>;

describe('Feature: Ações em lote na caixa de tarefas sobre PostgreSQL (US-058)', () => {
  let fixture: TaskBulkDatabase;

  const bulkOf = (response: request.Response): BulkResultResponse => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return bulkResultResponseSchema.parse(response.body);
  };

  /** O que o "assumir" grava (para provar que nada mudou). */
  const effects = async (id: string) => ({
    process: (
      await fixture.db.admin<Row>(
        'SELECT version, current_responsible_id FROM processes WHERE id = $1',
        [id],
      )
    )[0],
    assignments: await fixture.db.admin<Row>(
      `SELECT assignee_id, type::text, is_active FROM process_assignments
        WHERE process_id = $1 ORDER BY started_at, id`,
      [id],
    ),
    movements: await fixture.db.admin<Row>(
      'SELECT sequence, action::text FROM process_movements WHERE process_id = $1 ORDER BY sequence',
      [id],
    ),
    audit: await fixture.db.admin<Row>(
      `SELECT action, metadata->>'batchId' AS batch_id FROM audit_logs
        WHERE process_id = $1 AND action <> 'process.create' ORDER BY action`,
      [id],
    ),
    events: await fixture.db.admin<Row>(
      `SELECT event_type, status::text FROM outbox_events
        WHERE process_id = $1 AND event_type <> 'ProcessCreated' ORDER BY event_type`,
      [id],
    ),
  });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fixture = await startTaskBulkDatabase();
  });

  afterAll(async () => {
    await fixture.close();
    vi.restoreAllMocks();
  });

  it('[Sucesso] [Falha de integração] lote de 3: uma transação por item, auditoria com o mesmo batchId e ProcessAssigned PENDING', async () => {
    const ids = [
      await fixture.processInQueue(),
      await fixture.processInQueue(),
      await fixture.processInQueue(),
    ];
    const result = bulkOf(await fixture.bulkClaim(ids));
    expect(result.meta).toEqual({ successCount: 3, errorCount: 0 });
    const batchIds = new Set<unknown>();
    for (const id of ids) {
      const after = await effects(id);
      expect(after.process).toMatchObject({ current_responsible_id: BULK_ANA });
      expect(after.assignments.filter((row) => row.is_active === true)).toEqual([
        { assignee_id: BULK_ANA, type: 'CLAIM', is_active: true },
      ]);
      expect(after.movements.map((row) => row.action)).toEqual(['CREATE', 'CLAIM']);
      expect(after.audit).toEqual([
        { action: 'process.claim', batch_id: expect.any(String) as unknown },
      ]);
      batchIds.add(after.audit[0]?.batch_id);
      expect(after.events).toEqual([{ event_type: 'ProcessAssigned', status: 'PENDING' }]);
    }
    expect(batchIds.size).toBe(1);
  });

  it('[Tenant incorreto] processo de B no lote de A: item REFERENCE_NOT_FOUND sem revelar nem alterar nada; os itens de A seguem', async () => {
    const ownIds = [await fixture.processInQueue(), await fixture.processInQueue()];
    const foreign = await fixture.processInQueue(fixture.tenantB);
    const before = await effects(foreign);

    const response = await fixture.bulkClaim([...ownIds, foreign]);
    const result = bulkOf(response);

    expect(result.meta).toEqual({ successCount: 2, errorCount: 1 });
    expect(result.data[2]).toEqual({
      processId: foreign,
      ok: false,
      code: 'REFERENCE_NOT_FOUND',
      message: 'O processo não pôde ser processado.',
    });
    expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    expect(await effects(foreign)).toEqual(before);
    for (const id of ownIds) {
      expect((await effects(id)).process).toMatchObject({ current_responsible_id: BULK_ANA });
    }
  });

  it('[Concorrência] dois lotes com processos em comum: um responsável por processo; o perdedor recebe PROCESS_ALREADY_ASSIGNED', async () => {
    const ids = [await fixture.processInQueue(), await fixture.processInQueue()];
    const [ana, dani] = await Promise.all([
      fixture.bulkClaim(ids, BULK_SUBJECTS.ana),
      fixture.bulkClaim(ids, BULK_SUBJECTS.dani),
    ]);
    const results = [bulkOf(ana), bulkOf(dani)];
    for (const [index, id] of ids.entries()) {
      const outcomes = results.map((result) => result.data[index]);
      expect(outcomes.filter((item) => item?.ok)).toHaveLength(1);
      expect(outcomes.find((item) => item?.ok === false)).toMatchObject({
        code: 'PROCESS_ALREADY_ASSIGNED',
      });
      const after = await effects(id);
      expect(after.assignments.filter((row) => row.is_active === true)).toHaveLength(1);
      expect(after.movements.filter((row) => row.action === 'CLAIM')).toHaveLength(1);
      expect([BULK_ANA, BULK_DANI]).toContain(after.process?.current_responsible_id);
    }
  });
});
