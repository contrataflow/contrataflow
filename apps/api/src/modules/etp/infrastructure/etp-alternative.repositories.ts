import type { RichTextDocValue } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { isUniqueViolation, VersionConflictError } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { EtpAlternativeUniqueViolation } from '../application/ports.js';
import type { EtpAlternativeRepository } from '../application/ports.js';
import { isNameTaken } from '../domain/etp-alternative.js';
import type { EtpAlternative } from '../domain/etp-alternative.js';

/*
 * `etp_alternatives` (US-021): no PostgreSQL sempre no `tx` da `TenantTransaction` (RLS do tenant);
 * os índices únicos parciais (nome por ETP sem caixa — RN-ETP-18 — e uma `RECOMMENDED` por ETP —
 * RN-ETP-20) viram `EtpAlternativeUniqueViolation`. Em memória para os testes e o modo de identidade
 * fake, com a mesma semântica (tenant do contexto, exclusão lógica, versão e as duas unicidades).
 */

type Row = Prisma.EtpAlternativeGetPayload<object>;

const asDoc = (value: unknown): RichTextDocValue => value as RichTextDocValue;

function toDomain(row: Row): EtpAlternative {
  return {
    id: row.id,
    tenantId: row.tenantId,
    etpId: row.etpId,
    processId: row.processId,
    name: row.name,
    description: asDoc(row.description),
    advantages: row.advantages === null ? null : asDoc(row.advantages),
    disadvantages: row.disadvantages === null ? null : asDoc(row.disadvantages),
    estimatedCost: row.estimatedCost?.toFixed(2) ?? null,
    riskLevel: row.riskLevel,
    observations: row.observations,
    decision: row.decision,
    decisionJustification: row.decisionJustification,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

/** `Prisma.DbNull` limpa a coluna JSON (um `null` cru não é aceito pelo Prisma). */
const nullableJson = (value: RichTextDocValue | null) =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

/** Colunas que o ETP-07/09 altera. */
function editable(alternative: EtpAlternative) {
  return {
    name: alternative.name,
    description: alternative.description as Prisma.InputJsonValue,
    advantages: nullableJson(alternative.advantages),
    disadvantages: nullableJson(alternative.disadvantages),
    estimatedCost: alternative.estimatedCost,
    riskLevel: alternative.riskLevel,
    observations: alternative.observations,
    decision: alternative.decision,
    decisionJustification: alternative.decisionJustification,
    sortOrder: alternative.sortOrder,
    updatedAt: alternative.updatedAt,
    updatedById: alternative.updatedById,
  };
}

/** Promessa recusada com o erro (o adaptador em memória responde como o Prisma — assíncrono). */
function rejected(error: unknown): Promise<never> {
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) throw new EtpAlternativeUniqueViolation();
    throw error;
  }
}

@Injectable()
export class PrismaEtpAlternativeRepository implements EtpAlternativeRepository {
  async listByEtp(tx: TenantTx, etpId: string): Promise<EtpAlternative[]> {
    const rows = await tx.etpAlternative.findMany({
      where: { etpId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDomain);
  }

  async findById(tx: TenantTx, id: string): Promise<EtpAlternative | null> {
    const row = await tx.etpAlternative.findFirst({ where: { id, deletedAt: null } });
    return row === null ? null : toDomain(row);
  }

  async insert(tx: TenantTx, alternative: EtpAlternative): Promise<void> {
    await guarded(() =>
      tx.etpAlternative.create({
        data: {
          ...editable(alternative),
          id: alternative.id,
          tenantId: alternative.tenantId,
          etpId: alternative.etpId,
          processId: alternative.processId,
          createdAt: alternative.createdAt,
          createdById: alternative.createdById,
          version: alternative.version,
        },
        select: { id: true },
      }),
    );
  }

  async update(tx: TenantTx, alternative: EtpAlternative, expectedVersion: number): Promise<void> {
    await guarded(() =>
      updateVersioned(
        { aggregateType: 'EtpAlternative', aggregateId: alternative.id, expectedVersion },
        () =>
          tx.etpAlternative.updateMany({
            where: { id: alternative.id, version: expectedVersion, deletedAt: null },
            data: { ...editable(alternative), version: { increment: 1 } },
          }),
      ),
    );
  }

  async softDelete(
    tx: TenantTx,
    alternative: EtpAlternative,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'EtpAlternative', aggregateId: alternative.id, expectedVersion },
      () =>
        tx.etpAlternative.updateMany({
          where: { id: alternative.id, version: expectedVersion, deletedAt: null },
          data: {
            deletedAt: deletion.at,
            deletedById: deletion.userId,
            updatedAt: deletion.at,
            updatedById: deletion.userId,
            version: { increment: 1 },
          },
        }),
    );
  }

  async names(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, { readonly name: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.etpAlternative.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, { name: row.name }]));
  }
}

interface StoredAlternative extends EtpAlternative {
  readonly deletedAt: Date | null;
  readonly deletedById: string | null;
}

/** Alternativas em memória: mesma semântica do adaptador Prisma, isoladas pelo tenant do contexto. */
@Injectable()
export class InMemoryEtpAlternativeRepository implements EtpAlternativeRepository {
  private readonly rows = new Map<string, StoredAlternative>();

  private inTenant(): StoredAlternative[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  private active(etpId: string): StoredAlternative[] {
    return this.inTenant().filter((row) => row.etpId === etpId && row.deletedAt === null);
  }

  /** Os dois índices únicos parciais de `etp_alternatives`. */
  private assertUnique(candidate: EtpAlternative): void {
    const siblings = this.active(candidate.etpId);
    const otherRecommended =
      candidate.decision === 'RECOMMENDED' &&
      siblings.some((row) => row.id !== candidate.id && row.decision === 'RECOMMENDED');
    if (otherRecommended || isNameTaken(siblings, candidate.name, candidate.id)) {
      throw new EtpAlternativeUniqueViolation();
    }
  }

  private current(id: string, expectedVersion: number): StoredAlternative {
    const found = this.inTenant().find((row) => row.id === id && row.deletedAt === null);
    if (found?.version !== expectedVersion) {
      throw new VersionConflictError({
        aggregateType: 'EtpAlternative',
        aggregateId: id,
        expectedVersion,
      });
    }
    return found;
  }

  listByEtp(_tx: TenantTx, etpId: string): Promise<EtpAlternative[]> {
    return Promise.resolve(
      this.active(etpId).sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      ),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<EtpAlternative | null> {
    return Promise.resolve(
      this.inTenant().find((row) => row.id === id && row.deletedAt === null) ?? null,
    );
  }

  insert(_tx: TenantTx, alternative: EtpAlternative): Promise<void> {
    try {
      if (this.rows.has(alternative.id)) throw new Error('etp_alternatives_pkey');
      this.assertUnique(alternative);
    } catch (error) {
      return rejected(error);
    }
    this.rows.set(alternative.id, { ...alternative, deletedAt: null, deletedById: null });
    return Promise.resolve();
  }

  update(_tx: TenantTx, alternative: EtpAlternative, expectedVersion: number): Promise<void> {
    try {
      const current = this.current(alternative.id, expectedVersion);
      this.assertUnique(alternative);
      this.rows.set(alternative.id, {
        ...alternative,
        tenantId: current.tenantId,
        etpId: current.etpId,
        processId: current.processId,
        createdAt: current.createdAt,
        createdById: current.createdById,
        deletedAt: null,
        deletedById: null,
        version: expectedVersion + 1,
      });
      return Promise.resolve();
    } catch (error) {
      return rejected(error);
    }
  }

  softDelete(
    _tx: TenantTx,
    alternative: EtpAlternative,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void> {
    try {
      const current = this.current(alternative.id, expectedVersion);
      this.rows.set(alternative.id, {
        ...current,
        deletedAt: deletion.at,
        deletedById: deletion.userId,
        updatedAt: deletion.at,
        updatedById: deletion.userId,
        version: expectedVersion + 1,
      });
      return Promise.resolve();
    } catch (error) {
      return rejected(error);
    }
  }

  names(_tx: TenantTx, ids: readonly string[]): Promise<Map<string, { readonly name: string }>> {
    const wanted = new Set(ids);
    return Promise.resolve(
      new Map(
        this.inTenant()
          .filter((row) => wanted.has(row.id))
          .map((row) => [row.id, { name: row.name }]),
      ),
    );
  }

  /** Inspeção de testes: todas as linhas (de todos os tenants), inclusive excluídas. */
  snapshot(): readonly StoredAlternative[] {
    return [...this.rows.values()];
  }
}
