import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntry, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import {
  AUDIT_EXPORT_BATCH_SIZE,
  ExportAuditLogsHandler,
  GetAuditLogHandler,
  SearchAuditLogsHandler,
  toAuditLogDto,
} from './audit-logs.handlers.js';
import type { AuditTransactions } from './ports.js';
import { testConfig } from '../../../../test/support/api-test-app.js';
import { seal } from '../domain/audit-record.js';
import type { AuditRecord, SealedAuditRecord } from '../domain/audit-record.js';
import { InMemoryAuditLogStore } from '../infrastructure/in-memory-audit.store.js';

const T = '0192d075-0000-7000-8000-00000000000a';
const NOW = new Date('2026-09-30T12:00:00.000Z');
const SEPTEMBER = { occurredFrom: '2026-09-01T00:00:00Z', occurredTo: '2026-09-29T23:59:59Z' };

function rec(index: number, overrides: Partial<AuditRecord> = {}): SealedAuditRecord {
  return seal({
    id: `0192d075-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
    // Vários registros no mesmo milissegundo: o desempate do cursor é o id.
    occurredAt: new Date(Date.parse('2026-09-02T00:00:00Z') + Math.floor(index / 3) * 60_000),
    tenantId: T,
    actorType: 'USER',
    actorUserId: null,
    actorName: `Pessoa ${String(index)}`,
    actorMembershipId: null,
    onBehalfOfUserId: null,
    action: 'process.update',
    category: 'DATA_CHANGE',
    result: 'SUCCESS',
    entityType: null,
    entityId: null,
    processId: null,
    changes: null,
    metadata: {},
    reasonCode: null,
    ip: null,
    userAgent: null,
    correlationId: null,
    requestId: null,
    sessionIdHash: null,
    ...overrides,
  });
}

class CountingTransactions implements AuditTransactions {
  reads = 0;
  failAtRead: number | null = null;

  inTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  inPlatform<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    this.reads += 1;
    if (this.failAtRead === this.reads) {
      return Promise.reject(Object.assign(new Error('Connection terminated'), { code: 'P1001' }));
    }
    return runSimulatedTransaction(work);
  }
}

class RecordingTrail implements AuditTrailPort {
  readonly entries: AuditEntry[] = [];

  record(): never {
    throw new Error('não usado');
  }

  recordStandalone(entry: AuditEntry) {
    this.entries.push(entry);
    return Promise.resolve({
      kind: 'recorded' as const,
      id: 'x',
      occurredAt: new Date(NOW),
      rowHash: '0'.repeat(64),
    });
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

describe('casos de uso da consulta e exportação da trilha (US-075)', () => {
  let store: InMemoryAuditLogStore;
  let transactions: CountingTransactions;
  let trail: RecordingTrail;
  const inTenant = <R>(fn: () => R) => runAsSystem({ name: 'Teste US-075', tenantId: T }, fn);

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store = new InMemoryAuditLogStore();
    transactions = new CountingTransactions();
    trail = new RecordingTrail();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const exporter = (maxRows = 100_000) =>
    new ExportAuditLogsHandler(
      testConfig({ AUDIT_EXPORT_MAX_ROWS: String(maxRows) }),
      store,
      transactions,
      trail,
      () => new Date(NOW),
    );

  it('exporta em lotes por cursor, sem repetir nem pular, com memória por lote', async () => {
    const total = AUDIT_EXPORT_BATCH_SIZE * 2 + 37;
    for (let index = 1; index <= total; index += 1) store.records.push(rec(index));
    const file = await inTenant(() => exporter().execute({ ...SEPTEMBER, format: 'ndjson' }));
    expect(file.rowCount).toBe(total);
    expect(file.fileName).toBe('auditoria-20260901-20260929.ndjson');
    const lines = (await readAll(file.stream)).split('\n').filter((line) => line !== '');
    const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    // 1 contagem + 3 lotes (o último incompleto encerra).
    expect(transactions.reads).toBe(4);
    expect(trail.entries).toEqual([
      expect.objectContaining({
        action: 'audit.export',
        metadata: expect.objectContaining({ format: 'ndjson', rowCount: total }) as unknown,
      }),
    ]);
  });

  it('o arquivo para no teto de linhas mesmo se a trilha crescer entre a contagem e o envio', async () => {
    for (let index = 1; index <= 5; index += 1) store.records.push(rec(index));
    const file = await inTenant(() => exporter(5).execute({ ...SEPTEMBER, format: 'csv' }));
    for (let index = 6; index <= 9; index += 1) store.records.push(rec(index));
    const lines = (await readAll(file.stream)).split('\r\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1 + 5);
  });

  it('acima do teto → EXPORT_TOO_LARGE com a contagem, sem auditar nem ler lotes', async () => {
    for (let index = 1; index <= 8; index += 1) store.records.push(rec(index));
    const error = await inTenant(() => exporter(5).execute({ ...SEPTEMBER, format: 'csv' })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'EXPORT_TOO_LARGE',
      status: 422,
      detail: 'Muitos registros para exportar (8). Refine o período ou os filtros.',
    });
    expect(trail.entries).toEqual([]);
    expect(transactions.reads).toBe(1);
  });

  it('falha do banco no meio do envio interrompe o arquivo com erro (nunca truncado como completo)', async () => {
    for (let index = 1; index <= AUDIT_EXPORT_BATCH_SIZE + 10; index += 1) {
      store.records.push(rec(index));
    }
    transactions.failAtRead = 3;
    const file = await inTenant(() => exporter().execute({ ...SEPTEMBER, format: 'csv' }));
    await expect(readAll(file.stream)).rejects.toThrow('Connection terminated');
  });

  it('banco fora do ar antes do arquivo → 503 DEPENDENCY_UNAVAILABLE', async () => {
    transactions.failAtRead = 1;
    await expect(
      inTenant(() => exporter().execute({ ...SEPTEMBER, format: 'csv' })),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503 });
    transactions.failAtRead = 2;
    await expect(
      inTenant(() =>
        new SearchAuditLogsHandler(store, transactions, trail).execute({ ...SEPTEMBER, limit: 50 }),
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('cursor corrompido → 422 com a mensagem da tela; detalhe inexistente → 404', async () => {
    const search = new SearchAuditLogsHandler(store, transactions, trail);
    await expect(
      inTenant(() => search.execute({ ...SEPTEMBER, limit: 50, cursor: 'eyJ4IjoxfQ' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      inTenant(() =>
        new GetAuditLogHandler(store, transactions, trail).execute(
          '0192d075-0000-7000-8000-00000000beef',
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', detail: 'Registro de auditoria não encontrado.' });
  });

  it('presenter: changes como gravado; entrada fora do formato vira `new` sem caminho', () => {
    const dto = toAuditLogDto(
      rec(1, {
        changes: [{ path: 'cpf', old: '***.456.789-**', new: null }, 'solto', { sem: 'path' }],
        metadata: { coalesce: { scope: 'S', revision: 3, size: 10 } },
      }),
    );
    expect(dto.changes).toEqual([
      { path: 'cpf', old: '***.456.789-**', new: null },
      { path: '', old: null, new: 'solto' },
      { path: '', old: null, new: { sem: 'path' } },
    ]);
    expect(dto.metadata).toEqual({ coalesce: { scope: 'S', revision: 3, size: 10 } });
    expect(dto).not.toHaveProperty('tenantId');
    expect(dto.occurredAt).toBe('2026-09-02T00:00:00.000Z');
  });
});
