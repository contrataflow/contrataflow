import type { DomainEventEnvelope, JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import {
  ETP_ESTIMATE_SYNC_ROUTING_KEYS,
  EtpEstimateSynchronizer,
  syncEtpEstimates,
} from './etp-estimate-synchronizer.js';
import type { InlineHandlerContext } from './inline-handlers.js';
import { resolveRoutes } from './routes.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const RESEARCH = '0192f022-0000-7000-8000-0000000000d1';
const ETP = '0192f022-0000-7000-8000-0000000000e1';
const PROCESS = '0192f022-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-19T18:00:00.000Z');

function envelope(
  routingKey: string,
  payload: Record<string, unknown>,
  tenantId: string | null = TENANT,
): DomainEventEnvelope<Record<string, unknown>> {
  return {
    eventId: '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293',
    eventType: 'PriceResearchRecalculated',
    routingKey,
    eventVersion: 1,
    occurredAt: NOW.toISOString(),
    tenantId,
    aggregateType: 'PriceResearch',
    aggregateId: RESEARCH,
    processId: PROCESS,
    actor: { type: 'SYSTEM', userId: null, membershipId: null },
    correlationId: 'corr-1',
    causationId: null,
    payload,
  };
}

/** Cliente SQL que devolve as linhas do `UPDATE` e registra os comandos. */
function fakeClient(updated: readonly Record<string, unknown>[], linked = 0) {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const client: SqlClient = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a assinatura de `SqlClient.query`
    query: <R extends object>(sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('UPDATE etps')) {
        return Promise.resolve({ rows: updated as R[], rowCount: updated.length });
      }
      if (sql.includes('count(*)')) {
        return Promise.resolve({ rows: [{ count: linked }] as R[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] as R[], rowCount: 1 });
    },
  };
  return { client, queries };
}

function contextOf(client: SqlClient): InlineHandlerContext {
  return {
    meta: { tenantId: TENANT, correlationId: 'corr-1' } as JobMeta,
    attempt: 2,
    jobId: 'job-1',
    tenantTransaction: (work) => work(client),
  };
}

const ROW = { id: ETP, process_id: PROCESS, document_id: ETP, version: 4 };

describe('EtpEstimateSynchronizer (US-022 · RN-ETP-29/31)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('as rotas do fan-out levam recálculo, conclusão e cancelamento da pesquisa ao handler', () => {
    for (const routingKey of ETP_ESTIMATE_SYNC_ROUTING_KEYS) {
      expect(resolveRoutes(routingKey).inline).toContain('EtpEstimateSynchronizer');
    }
    expect(resolveRoutes('document.finalized.etp').inline).not.toContain('EtpEstimateSynchronizer');
  });

  it('recálculo: copia o total para os ETPs vinculados e audita cada um (SYSTEM, sem valores)', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client, queries } = fakeClient([ROW]);
    await new EtpEstimateSynchronizer(() => NOW).handle(
      envelope('price_research.recalculated', { priceResearchId: RESEARCH }),
      contextOf(client),
    );
    expect(queries[0]?.sql).toContain('estimated_total_value = r.total_estimated_value');
    expect(queries[0]?.params).toEqual([RESEARCH, NOW, ['DRAFT', 'RETURNED']]);
    const audit = queries.find((query) => query.sql.includes('INSERT INTO audit_logs'));
    expect(audit?.params).toContain('document.draft_update');
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      fields: ['estimatedTotalValue'],
      priceResearchId: RESEARCH,
      trigger: 'recalculated',
      version: 4,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'etp.estimate_synced',
        etpId: ETP,
        trigger: 'recalculated',
      }),
    );
  });

  it('conclusão e cancelamento usam o documentId (= id da pesquisa); cancelamento desfaz o vínculo', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const completed = fakeClient([ROW]);
    await new EtpEstimateSynchronizer(() => NOW).handle(
      envelope('document.finalized.price_research', { documentId: RESEARCH }),
      contextOf(completed.client),
    );
    expect(completed.queries[0]?.params[0]).toBe(RESEARCH);
    const canceled = fakeClient([ROW]);
    await new EtpEstimateSynchronizer(() => NOW).handle(
      envelope('document.canceled.price_research', { documentId: RESEARCH }),
      contextOf(canceled.client),
    );
    expect(canceled.queries[0]?.sql).toContain('estimated_value_source = NULL');
    const audit = canceled.queries.find((query) => query.sql.includes('INSERT INTO audit_logs'));
    expect(JSON.parse(String(audit?.params[10]))).toMatchObject({
      fields: ['estimatedValueSource', 'priceResearchId'],
      estimatedValueSource: null,
      trigger: 'canceled',
    });
  });

  it('reentrega sem nada a aplicar: nenhuma auditoria e o aviso etp.estimate_sync_retry', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { client, queries } = fakeClient([], 1);
    await new EtpEstimateSynchronizer(() => NOW).handle(
      envelope('price_research.recalculated', { priceResearchId: RESEARCH }),
      contextOf(client),
    );
    expect(queries.some((query) => query.sql.includes('audit_logs'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'etp.estimate_sync_retry', linkedEtps: 1, attempt: 2 }),
    );
  });

  it('ignora outras routing keys, evento de plataforma e payload sem id da pesquisa', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { client, queries } = fakeClient([ROW]);
    const handler = new EtpEstimateSynchronizer(() => NOW);
    await handler.handle(
      envelope('document.finalized.etp', { documentId: RESEARCH }),
      contextOf(client),
    );
    await handler.handle(
      envelope('price_research.recalculated', { priceResearchId: RESEARCH }, null),
      contextOf(client),
    );
    await handler.handle(
      envelope('price_research.recalculated', { priceResearchId: 'x' }),
      contextOf(client),
    );
    expect(queries).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'etp.estimate_sync_bad_payload' }),
    );
  });

  it('sem a transação do job, falha (o job é repetido); erro do banco é logado e relançado', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const handler = new EtpEstimateSynchronizer(() => NOW);
    const event = envelope('price_research.recalculated', { priceResearchId: RESEARCH });
    await expect(handler.handle(event)).rejects.toThrow(/sem a transação/);
    const down: InlineHandlerContext = {
      ...contextOf(fakeClient([]).client),
      tenantTransaction: () => Promise.reject(Object.assign(new Error('down'), { code: '08006' })),
    };
    await expect(handler.handle(event, down)).rejects.toThrow('down');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'etp.estimate_sync_failed', errorClass: 'TRANSIENT' }),
    );
  });

  it('syncEtpEstimates conta os vinculados só quando nada mudou', async () => {
    const changed = fakeClient([ROW], 5);
    const input = {
      tenantId: TENANT,
      priceResearchId: RESEARCH,
      trigger: 'recalculated' as const,
      eventId: 'e',
      correlationId: 'c',
      now: NOW,
    };
    expect(await syncEtpEstimates(changed.client, input)).toEqual({
      synced: [{ id: ETP, processId: PROCESS, documentId: ETP, version: 4 }],
      unchanged: 0,
    });
    expect(changed.queries.some((query) => query.sql.includes('count(*)'))).toBe(false);
  });
});
