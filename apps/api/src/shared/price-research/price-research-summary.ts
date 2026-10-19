import type { DocumentStatus } from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * Pesquisas de preços vistas pelos outros artefatos do processo (US-036 · RN-TR-07/08 · DEC-032 ·
 * US-022: o vínculo do valor estimado do ETP — `linkOf`). O
 * `term` (nível 4) precisa do total da pesquisa concluída para o valor estimado do TR, mas não pode
 * importar a fachada do `price-research` (mesmo nível — DEC-040): pergunta a esta porta do shared
 * kernel e o `price-research` registra o leitor no `onModuleInit` (mesmo arranjo do
 * `ProcessItemCatalogRegistry`). Sem leitor registrado, o processo não tem pesquisa (falha fechado:
 * o TR nasce sem valor e o vínculo manual é recusado).
 */

/** Status do documento da pesquisa que a tornam "concluída" (RN-TR-07). */
const COMPLETED_STATUSES: ReadonlySet<DocumentStatus> = new Set(['FINALIZED', 'APPROVED']);

/** Pesquisa não cancelada nem excluída do processo, com o status do seu documento. */
export interface PriceResearchSummary {
  readonly id: string;
  readonly processId: string;
  readonly documentId: string;
  readonly code: string | null;
  readonly status: DocumentStatus;
  /** Decimal(18,2) como string; `null` enquanto não calculado. */
  readonly totalEstimatedValue: string | null;
}

export interface PriceResearchSummaryReader {
  /** Pesquisas do processo (sem as canceladas/excluídas), mais recente primeiro (RLS: do tenant). */
  listByProcess(tx: TenantTx, processId: string): Promise<PriceResearchSummary[]>;
  /**
   * A pesquisa `id` INCLUSIVE cancelada (`status = CANCELED`) — o vínculo do ETP distingue
   * cancelada (`REFERENCE_INACTIVE`) de inexistente (US-022 · V-06). Excluída ou de outro tenant
   * (RLS) = `null`.
   */
  findById(tx: TenantTx, id: string): Promise<PriceResearchSummary | null>;
}

/** Pesquisa candidata ao vínculo do valor estimado (US-022 · RN-ETP-28 · V-06). */
export type PriceResearchLink =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'CANCELED' }
  | { readonly kind: 'ACTIVE'; readonly summary: PriceResearchSummary };

/** A pesquisa está concluída e tem total (RN-TR-07). */
export function isCompletedPriceResearch(summary: PriceResearchSummary): boolean {
  return COMPLETED_STATUSES.has(summary.status) && summary.totalEstimatedValue !== null;
}

/** Registro do leitor (implementado pelo módulo `price-research`). */
@Injectable()
export class PriceResearchSummaryRegistry {
  private reader: PriceResearchSummaryReader | null = null;

  register(reader: PriceResearchSummaryReader): void {
    this.reader = reader;
  }

  listByProcess(tx: TenantTx, processId: string): Promise<PriceResearchSummary[]> {
    return this.reader ? this.reader.listByProcess(tx, processId) : Promise.resolve([]);
  }

  /**
   * V-06 da US-022: a pesquisa `id` do processo para o vínculo do ETP — inexistente, de outro
   * processo ou de outro tenant = `NOT_FOUND` (sem revelar); cancelada = `CANCELED`.
   */
  async linkOf(tx: TenantTx, processId: string, id: string): Promise<PriceResearchLink> {
    const summary = this.reader ? await this.reader.findById(tx, id) : null;
    if (summary?.processId !== processId) return { kind: 'NOT_FOUND' };
    return summary.status === 'CANCELED' ? { kind: 'CANCELED' } : { kind: 'ACTIVE', summary };
  }

  /** A pesquisa concluída mais recente do processo (RN-TR-07), ou `null`. */
  async completedOf(tx: TenantTx, processId: string): Promise<PriceResearchSummary | null> {
    const all = await this.listByProcess(tx, processId);
    return all.find(isCompletedPriceResearch) ?? null;
  }

  /** A pesquisa `id` do processo (V-12: de outro processo ou tenant = `null`). */
  async findInProcess(
    tx: TenantTx,
    processId: string,
    id: string,
  ): Promise<PriceResearchSummary | null> {
    const all = await this.listByProcess(tx, processId);
    return all.find((summary) => summary.id === id) ?? null;
  }
}

/**
 * Importado por `term`/`etp` (consumidores) e `price-research` (implementador); a instância é única.
 */
@Module({
  providers: [PriceResearchSummaryRegistry],
  exports: [PriceResearchSummaryRegistry],
})
export class PriceResearchSummaryModule {}
