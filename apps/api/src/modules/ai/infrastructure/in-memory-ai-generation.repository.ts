import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { AiGenerationActiveError } from '../application/ports.js';
import type {
  AiGenerationCursor,
  AiGenerationListFilter,
  AiGenerationRepository,
  AiGenerationTarget,
  AiTransactions,
  ExpectedState,
} from '../application/ports.js';
import { expireGeneration, isActive } from '../domain/ai-generation.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import type { AiUsageRow } from '../domain/ai-usage.js';

/*
 * Trava por tenant das transações simuladas — o equivalente em memória do `pg_advisory_xact_lock`
 * (US-116): adquirida em `lockTenantUsage` e liberada quando a transação aberta por
 * `runWithTenantLocks` termina. Numa transação simulada sem esse suporte, a trava é no-op.
 */
const heldByTx = new WeakMap<object, { keys: Set<string>; releases: (() => void)[] }>();
const lockTails = new Map<string, Promise<void>>();

/** Transação simulada que libera as travas de tenant ao terminar (commit ou erro). */
export function runWithTenantLocks<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runSimulatedTransaction(async (tx) => {
    const held = { keys: new Set<string>(), releases: [] as (() => void)[] };
    heldByTx.set(tx, held);
    try {
      return await work(tx);
    } finally {
      heldByTx.delete(tx);
      for (const release of held.releases) release();
    }
  });
}

function acquireTenantLock(tx: TenantTx, key: string): Promise<void> {
  const held = heldByTx.get(tx);
  if (held === undefined || held.keys.has(key)) return Promise.resolve();
  held.keys.add(key);
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  lockTails.set(key, tail);
  held.releases.push(() => {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  });
  return previous;
}

/** Mesmo alvo dos únicos parciais de `ai_generations` (RN-AI-12). */
function sameTarget(a: AiGenerationTarget, b: AiGenerationTarget): boolean {
  if (a.kind !== b.kind || a.processId !== b.processId) return false;
  return a.kind === 'DRAFT'
    ? a.targetModule === b.targetModule
    : a.documentId === b.documentId && a.sectionKey === b.sectionKey;
}

function newestFirst(a: AiGeneration, b: AiGeneration): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
}

/**
 * Gerações em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`), uma ativa por
 * alvo, gravação condicional ao estado lido e nenhuma exclusão.
 */
@Injectable()
export class InMemoryAiGenerationRepository implements AiGenerationRepository {
  private readonly rows = new Map<string, AiGeneration>();
  /** Falha simulada de gravação (Falha de banco nos testes): erro para a próxima que casar. */
  failWrite: ((next: AiGeneration) => Error | null) | null = null;

  private inTenant(): AiGeneration[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  private takeFailure(next: AiGeneration): void {
    const failure = this.failWrite?.(next) ?? null;
    if (failure === null) return;
    this.failWrite = null;
    throw failure;
  }

  insert(_tx: TenantTx, generation: AiGeneration): Promise<void> {
    this.takeFailure(generation);
    const active = this.inTenant().find((row) => isActive(row) && sameTarget(row, generation));
    if (active !== undefined) return Promise.reject(new AiGenerationActiveError(active.id));
    this.rows.set(generation.id, generation);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, id: string): Promise<AiGeneration | null> {
    return Promise.resolve(this.inTenant().find((row) => row.id === id) ?? null);
  }

  findActive(_tx: TenantTx, target: AiGenerationTarget): Promise<AiGeneration | null> {
    return Promise.resolve(
      this.inTenant().find((row) => isActive(row) && sameTarget(row, target)) ?? null,
    );
  }

  list(
    _tx: TenantTx,
    processId: string,
    filter: AiGenerationListFilter,
    page: { readonly after: AiGenerationCursor | null; readonly limit: number },
  ): Promise<AiGeneration[]> {
    const after = page.after;
    const rows = this.inTenant()
      .filter(
        (row) =>
          row.processId === processId &&
          (filter.documentId === undefined || row.documentId === filter.documentId) &&
          (filter.targetModule === undefined || row.targetModule === filter.targetModule) &&
          (filter.kind === undefined || row.kind === filter.kind) &&
          (filter.statuses === undefined || filter.statuses.includes(row.status)) &&
          (filter.requestedById === undefined || row.createdById === filter.requestedById),
      )
      .filter(
        (row) =>
          after === null ||
          row.createdAt.getTime() < after.createdAt.getTime() ||
          (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id),
      )
      .sort(newestFirst);
    return Promise.resolve(rows.slice(0, page.limit));
  }

  update(_tx: TenantTx, next: AiGeneration, expected: ExpectedState): Promise<boolean> {
    this.takeFailure(next);
    const current = this.inTenant().find((row) => row.id === next.id);
    const matches =
      current?.status === expected.status &&
      (expected.attempts === undefined || current.attempts === expected.attempts) &&
      (expected.updatedAt === undefined ||
        current.updatedAt.getTime() === expected.updatedAt.getTime());
    if (!matches) return Promise.resolve(false);
    this.rows.set(next.id, next);
    return Promise.resolve(true);
  }

  expireDue(_tx: TenantTx, now: Date): Promise<number> {
    let count = 0;
    for (const row of this.inTenant()) {
      if (row.status !== 'SUCCEEDED' || row.expiresAt === null) continue;
      if (row.expiresAt.getTime() > now.getTime()) continue;
      this.rows.set(row.id, expireGeneration(row, now));
      count += 1;
    }
    return Promise.resolve(count);
  }

  findStaleRunning(_tx: TenantTx, before: Date, limit: number): Promise<AiGeneration[]> {
    return Promise.resolve(
      this.inTenant()
        .filter(
          (row) =>
            row.status === 'RUNNING' &&
            row.startedAt !== null &&
            row.startedAt.getTime() < before.getTime(),
        )
        .slice(0, limit),
    );
  }

  usageRows(_tx: TenantTx, from: Date, to: Date): Promise<AiUsageRow[]> {
    return Promise.resolve(
      this.inTenant()
        .filter(
          (row) =>
            row.createdAt.getTime() >= from.getTime() && row.createdAt.getTime() < to.getTime(),
        )
        .map((row) => ({
          id: row.id,
          status: row.status,
          errorCode: row.errorCode,
          startedAt: row.startedAt,
          targetModule: row.targetModule,
          kind: row.kind,
          action: row.action,
          createdById: row.createdById,
          createdAt: row.createdAt,
          reservedTokens: row.reservedTokens,
          totalTokens: row.totalTokens,
          costUsd: row.costUsd,
        })),
    );
  }

  lockTenantUsage(tx: TenantTx): Promise<void> {
    return acquireTenantLock(tx, `ai-usage:${currentRequestContext()?.tenantId ?? ''}`);
  }

  /** Testes: todas as linhas, de todos os tenants. */
  all(): AiGeneration[] {
    return [...this.rows.values()];
  }

  /** Testes: grava a linha como está (cenários montados à mão). */
  seed(generation: AiGeneration): void {
    this.rows.set(generation.id, generation);
  }
}

export class InMemoryAiTransactions implements AiTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runWithTenantLocks(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
