import type { AiGenerationErrorCode } from '@contrataflow/types';
import { aiGenerationOutputSchema, aiInputRefSchema } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TenantTransaction } from '#shared/database/database.module.js';
import { Prisma } from '#shared/database/prisma.js';
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
import type { AiGeneration } from '../domain/ai-generation.js';

type AiGenerationRow = Prisma.AiGenerationGetPayload<object>;

const appliedTargetsSchema = z.object({
  sectionKeys: z.array(z.string()),
  riskIds: z.array(z.string()),
});

const ACTIVE = ['QUEUED', 'RUNNING'] as const;

/** Linha → domínio. Os JSONB são conferidos pelos schemas; linha corrompida vira erro. */
function toGeneration(row: AiGenerationRow): AiGeneration {
  if (row.targetModule === 'PRICE_RESEARCH') {
    throw new Error(`ai_generations ${row.id} com alvo inválido.`);
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    processId: row.processId,
    documentId: row.documentId,
    targetModule: row.targetModule,
    kind: row.kind,
    action: row.action,
    sectionKey: row.sectionKey,
    baseRevision: row.baseRevision,
    status: row.status,
    needSummary: row.needSummary,
    instruction: row.instruction,
    provider: row.provider,
    model: row.model,
    promptKey: row.promptKey,
    promptVersion: row.promptVersion,
    inputRefs: z.array(aiInputRefSchema).parse(row.inputRefs),
    contextHash: row.contextHash,
    output: row.output === null ? null : aiGenerationOutputSchema.parse(row.output),
    outputHash: row.outputHash,
    placeholdersCount: row.placeholdersCount,
    groundingReplacements: row.groundingReplacements,
    reservedTokens: row.reservedTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd === null ? null : row.costUsd.toFixed(6),
    pricingVersion: row.pricingVersion,
    latencyMs: row.latencyMs,
    attempts: row.attempts,
    providerRequestId: row.providerRequestId,
    errorCode: row.errorCode as AiGenerationErrorCode | null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
    appliedAt: row.appliedAt,
    appliedById: row.appliedById,
    appliedTargets:
      row.appliedTargets === null ? null : appliedTargetsSchema.parse(row.appliedTargets),
    discardedAt: row.discardedAt,
    discardedById: row.discardedById,
    createdAt: row.createdAt,
    createdById: row.createdById,
    updatedAt: row.updatedAt,
  };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const nullableJson = (value: unknown) => (value === null ? Prisma.DbNull : json(value));

/** Colunas mutáveis (tudo menos identidade, tenant, alvo, pedido e criação). */
function mutableColumns(generation: AiGeneration) {
  return {
    status: generation.status,
    model: generation.model,
    inputRefs: json(generation.inputRefs),
    contextHash: generation.contextHash,
    output: nullableJson(generation.output),
    outputHash: generation.outputHash,
    placeholdersCount: generation.placeholdersCount,
    groundingReplacements: generation.groundingReplacements,
    inputTokens: generation.inputTokens,
    outputTokens: generation.outputTokens,
    totalTokens: generation.totalTokens,
    costUsd: generation.costUsd,
    pricingVersion: generation.pricingVersion,
    latencyMs: generation.latencyMs,
    attempts: generation.attempts,
    providerRequestId: generation.providerRequestId,
    errorCode: generation.errorCode,
    startedAt: generation.startedAt,
    completedAt: generation.completedAt,
    expiresAt: generation.expiresAt,
    appliedAt: generation.appliedAt,
    appliedById: generation.appliedById,
    appliedTargets: nullableJson(generation.appliedTargets),
    discardedAt: generation.discardedAt,
    discardedById: generation.discardedById,
    updatedAt: generation.updatedAt,
  };
}

function targetWhere(target: AiGenerationTarget): Prisma.AiGenerationWhereInput {
  return target.kind === 'DRAFT'
    ? { processId: target.processId, targetModule: target.targetModule, kind: 'DRAFT' }
    : { documentId: target.documentId, sectionKey: target.sectionKey, kind: 'SECTION' };
}

/**
 * `ai_generations` (US-115) com RLS do tenant da transação. A inserção usa `ON CONFLICT DO NOTHING`
 * (`createMany` com `skipDuplicates`): o único parcial de "uma ativa por alvo" (RN-AI-12) não
 * aborta a transação e a ativa vencedora é devolvida no erro (V-08). As transições são `UPDATE …
 * WHERE status = <lido>` (RN-AI-03).
 */
@Injectable()
export class PrismaAiGenerationRepository implements AiGenerationRepository {
  async insert(tx: TenantTx, generation: AiGeneration): Promise<void> {
    const { count } = await tx.aiGeneration.createMany({
      data: [
        {
          id: generation.id,
          tenantId: generation.tenantId,
          processId: generation.processId,
          documentId: generation.documentId,
          targetModule: generation.targetModule,
          kind: generation.kind,
          action: generation.action,
          sectionKey: generation.sectionKey,
          baseRevision: generation.baseRevision,
          needSummary: generation.needSummary,
          instruction: generation.instruction,
          provider: generation.provider,
          promptKey: generation.promptKey,
          promptVersion: generation.promptVersion,
          reservedTokens: generation.reservedTokens,
          createdAt: generation.createdAt,
          createdById: generation.createdById,
          ...mutableColumns(generation),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return;
    const active = await this.findActive(tx, generation);
    throw new AiGenerationActiveError(active?.id ?? null);
  }

  async findById(tx: TenantTx, id: string): Promise<AiGeneration | null> {
    const row = await tx.aiGeneration.findFirst({ where: { id } });
    return row === null ? null : toGeneration(row);
  }

  async findActive(tx: TenantTx, target: AiGenerationTarget): Promise<AiGeneration | null> {
    const row = await tx.aiGeneration.findFirst({
      where: { ...targetWhere(target), status: { in: [...ACTIVE] } },
    });
    return row === null ? null : toGeneration(row);
  }

  async list(
    tx: TenantTx,
    processId: string,
    filter: AiGenerationListFilter,
    page: { readonly after: AiGenerationCursor | null; readonly limit: number },
  ): Promise<AiGeneration[]> {
    const { after } = page;
    const rows = await tx.aiGeneration.findMany({
      where: {
        processId,
        ...(filter.documentId === undefined ? {} : { documentId: filter.documentId }),
        ...(filter.targetModule === undefined ? {} : { targetModule: filter.targetModule }),
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.statuses === undefined ? {} : { status: { in: [...filter.statuses] } }),
        ...(filter.requestedById === undefined ? {} : { createdById: filter.requestedById }),
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map(toGeneration);
  }

  async update(tx: TenantTx, next: AiGeneration, expected: ExpectedState): Promise<boolean> {
    const { count } = await tx.aiGeneration.updateMany({
      where: {
        id: next.id,
        status: expected.status,
        ...(expected.attempts === undefined ? {} : { attempts: expected.attempts }),
        ...(expected.updatedAt === undefined ? {} : { updatedAt: expected.updatedAt }),
      },
      data: mutableColumns(next),
    });
    return count === 1;
  }

  async expireDue(tx: TenantTx, now: Date): Promise<number> {
    const { count } = await tx.aiGeneration.updateMany({
      where: { status: 'SUCCEEDED', expiresAt: { lte: now } },
      data: { status: 'EXPIRED', updatedAt: now },
    });
    return count;
  }

  async findStaleRunning(tx: TenantTx, before: Date, limit: number): Promise<AiGeneration[]> {
    const rows = await tx.aiGeneration.findMany({
      where: { status: 'RUNNING', startedAt: { lt: before } },
      orderBy: { startedAt: 'asc' },
      take: limit,
    });
    return rows.map(toGeneration);
  }
}

@Injectable()
export class PrismaAiTransactions implements AiTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
