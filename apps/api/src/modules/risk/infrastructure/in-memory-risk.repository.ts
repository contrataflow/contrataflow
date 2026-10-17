import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  RiskListFilter,
  RiskRepository,
  RiskTransactions,
  RiskTreatmentRef,
} from '../application/ports.js';
import type { Risk } from '../domain/risk.js';

/** Tratamento em memória (o suficiente para a cascata da US-033; o CRUD é da US-034). */
export interface InMemoryRiskTreatment extends RiskTreatmentRef {
  readonly tenantId: string;
  readonly deletedAt: Date | null;
}

/**
 * Riscos em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`), código único por
 * processo entre TODOS os riscos (inclusive excluídos), exclusão lógica e concorrência otimista.
 */
@Injectable()
export class InMemoryRiskRepository implements RiskRepository {
  private readonly rows = new Map<string, Risk>();
  private readonly treatments = new Map<string, InMemoryRiskTreatment>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private allInTenant(): Risk[] {
    const tenantId = this.tenantId();
    return [...this.rows.values()].filter((risk) => risk.tenantId === tenantId);
  }

  private inTenant(): Risk[] {
    return this.allInTenant().filter((risk) => risk.deletedAt === null);
  }

  listByProcess(_tx: TenantTx, processId: string, filter: RiskListFilter): Promise<Risk[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((risk) => risk.processId === processId)
        .filter((risk) => filter.phase === undefined || risk.phase === filter.phase)
        .filter((risk) => filter.categoryId === undefined || risk.categoryId === filter.categoryId)
        .filter((risk) => filter.status === undefined || risk.status === filter.status)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<Risk | null> {
    return Promise.resolve(this.inTenant().find((risk) => risk.id === id) ?? null);
  }

  processOf(_tx: TenantTx, id: string): Promise<string | null> {
    return Promise.resolve(this.allInTenant().find((risk) => risk.id === id)?.processId ?? null);
  }

  /** As transações em memória do módulo já rodam uma de cada vez: nada a travar. */
  lockProcessCodes(): Promise<void> {
    return Promise.resolve();
  }

  usedCodes(_tx: TenantTx, processId: string): Promise<string[]> {
    return Promise.resolve(
      this.allInTenant()
        .filter((risk) => risk.processId === processId)
        .map((risk) => risk.code),
    );
  }

  insert(_tx: TenantTx, risk: Risk): Promise<void> {
    const taken = [...this.rows.values()].some(
      (other) =>
        other.tenantId === risk.tenantId &&
        other.processId === risk.processId &&
        other.code === risk.code,
    );
    if (taken) return Promise.reject(new Error(`risks_code_key: ${risk.code} já usado.`));
    this.rows.set(risk.id, risk);
    return Promise.resolve();
  }

  update(_tx: TenantTx, risk: Risk, expectedVersion: number): Promise<void> {
    const current = this.current(risk.id, expectedVersion);
    if (current instanceof Error) return Promise.reject(current);
    this.rows.set(risk.id, {
      ...risk,
      tenantId: current.tenantId,
      processId: current.processId,
      code: current.code,
      deletedAt: null,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  softDelete(
    _tx: TenantTx,
    risk: Risk,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void> {
    const current = this.current(risk.id, expectedVersion);
    if (current instanceof Error) return Promise.reject(current);
    this.rows.set(risk.id, {
      ...current,
      deletedAt: deletion.at,
      deletedById: deletion.userId,
      updatedAt: deletion.at,
      updatedById: deletion.userId,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  treatmentsOf(_tx: TenantTx, riskIds: readonly string[]): Promise<RiskTreatmentRef[]> {
    const tenantId = this.tenantId();
    return Promise.resolve(
      [...this.treatments.values()]
        .filter(
          (treatment) =>
            treatment.tenantId === tenantId &&
            treatment.deletedAt === null &&
            riskIds.includes(treatment.riskId),
        )
        .map(({ id, riskId, type, description, status }) => ({
          id,
          riskId,
          type,
          description,
          status,
        })),
    );
  }

  softDeleteTreatments(
    _tx: TenantTx,
    riskId: string,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<number> {
    const tenantId = this.tenantId();
    let count = 0;
    for (const treatment of this.treatments.values()) {
      if (treatment.tenantId !== tenantId || treatment.riskId !== riskId) continue;
      if (treatment.deletedAt !== null) continue;
      this.treatments.set(treatment.id, { ...treatment, deletedAt: deletion.at });
      count += 1;
    }
    return Promise.resolve(count);
  }

  labels(
    _tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, { readonly code: string; readonly title: string }>> {
    return Promise.resolve(
      new Map(
        this.allInTenant()
          .filter((risk) => ids.includes(risk.id))
          .map((risk) => [risk.id, { code: risk.code, title: risk.title }]),
      ),
    );
  }

  private current(id: string, expectedVersion: number): Risk | VersionConflictError {
    const current = this.inTenant().find((risk) => risk.id === id);
    if (current?.version !== expectedVersion) {
      return new VersionConflictError({ aggregateType: 'Risk', aggregateId: id, expectedVersion });
    }
    return current;
  }

  /** Inspeção de testes: todos os riscos de todos os tenants, inclusive excluídos. */
  snapshot(): readonly Risk[] {
    return [...this.rows.values()];
  }

  /** Inspeção de testes: todos os tratamentos. */
  treatmentRows(): readonly InMemoryRiskTreatment[] {
    return [...this.treatments.values()];
  }

  /** Carga de testes (tratamentos da US-034). */
  seedTreatments(...treatments: readonly InMemoryRiskTreatment[]): void {
    for (const treatment of treatments) this.treatments.set(treatment.id, treatment);
  }
}

/**
 * Transações simuladas: um `tx` sentinela ativo só durante o trabalho, uma de cada vez — o
 * equivalente em memória da trava de numeração por processo (Concorrência da US-033).
 */
@Injectable()
export class InMemoryRiskTransactions implements RiskTransactions {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
