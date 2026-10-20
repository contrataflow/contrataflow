import type {
  AiGenerationDto,
  AiGenerationListItemDto,
  AiGenerationListQuery,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { isProcessVisible } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import { cursorResult, decodeCursor } from '#shared/http/pagination.js';
import type { CursorResult } from '#shared/http/pagination.js';

import { toAiGenerationDto, toAiGenerationListItem } from './ai-generation.view.js';
import { generationNotFound } from './ai.errors.js';
import { AI_GENERATION_REPOSITORY, AI_TRANSACTIONS } from './ports.js';
import type { AiGenerationRepository, AiTransactions } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { AiGeneration } from '../domain/ai-generation.js';

/*
 * AI-02 (consultar) e AI-03 (listar do processo) — US-115 · RN-AI-13: exigem `PROCESS_VIEW` do
 * processo da geração. Geração inexistente, de outro tenant (RLS) ou de processo não visível →
 * 404 `AI_GENERATION_NOT_FOUND` (CA-T-01); visível sem `PROCESS_VIEW` cobrindo → 403. Sem custo,
 * resumo nem instrução; a lista nunca traz `output`.
 */

const cursorSchema = z.strictObject({ c: z.iso.datetime(), i: z.uuid() });

export interface AiGenerationView {
  readonly dto: AiGenerationDto;
  /** `ETag` = status + `updatedAt` (consulta condicional do polling). */
  readonly etag: string;
}

@Injectable()
export class AiGenerationQueries {
  constructor(
    @Inject(AI_TRANSACTIONS) private readonly transactions: AiTransactions,
    @Inject(AI_GENERATION_REPOSITORY) private readonly generations: AiGenerationRepository,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  get(generationId: string): Promise<AiGenerationView> {
    return this.transactions.read(async (tx) => {
      const generation = await this.generations.findById(tx, generationId);
      if (generation === null) throw generationNotFound();
      const process = await this.processes.load(tx, generation.processId);
      if (
        process === null ||
        !isProcessVisible(await this.access.processVisibilityScope(), process.access)
      ) {
        throw generationNotFound();
      }
      await this.access.assertCanOnProcess('PROCESS_VIEW', process.access);
      const names = await this.names(tx, [generation]);
      return {
        dto: toAiGenerationDto(generation, names.get(generation.createdById) ?? ''),
        etag: etagOf(generation),
      };
    });
  }

  /** O processo já foi conferido pelo guard (`PROCESS_VIEW` + visibilidade — 404/403). */
  list(
    processId: string,
    query: AiGenerationListQuery,
  ): Promise<CursorResult<AiGenerationListItemDto>> {
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor, cursorSchema);
    return this.transactions.read(async (tx) => {
      const rows = await this.generations.list(
        tx,
        processId,
        {
          documentId: query.documentId,
          targetModule: query.targetModule,
          kind: query.kind,
          statuses: query.status,
          requestedById: query.requestedById,
        },
        {
          after: after === null ? null : { createdAt: new Date(after.c), id: after.i },
          limit: query.limit + 1,
        },
      );
      const names = await this.names(tx, rows);
      return cursorResult(
        rows.map((row) => toAiGenerationListItem(row, names.get(row.createdById) ?? '')),
        query.limit,
        (item) => ({ c: item.createdAt, i: item.id }),
      );
    });
  }

  private names(tx: TenantTx, rows: readonly AiGeneration[]): Promise<Map<string, string>> {
    return this.identity.userDisplayNames(tx, [...new Set(rows.map((row) => row.createdById))]);
  }
}

export function etagOf(generation: AiGeneration): string {
  return `"${generation.status}-${String(generation.updatedAt.getTime())}"`;
}
