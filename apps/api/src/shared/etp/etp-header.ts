import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * Cabeçalho tipado do ETP visto pelos outros artefatos do processo (US-037 · RN-TR-17/22): o `term`
 * (nível 4) importa o valor estimado e a pesquisa vinculada do ETP para o TR, mas não pode importar
 * a fachada do `etp` (mesmo nível — DEC-040): pergunta a esta porta do shared kernel e o `etp`
 * registra o leitor no `onModuleInit` (mesmo arranjo do `PriceResearchSummaryRegistry`). As seções
 * e os itens do ETP vêm do `document` (nível 2). Sem leitor registrado, o ETP não tem cabeçalho
 * (falha fechado: a importação não oferece os campos).
 */

export interface EtpHeader {
  /** = `documentId` (CHECK `etps_id_is_document`). */
  readonly id: string;
  readonly processId: string;
  /** Decimal(18,2) como string; `null` enquanto não estimado. */
  readonly estimatedTotalValue: string | null;
  readonly priceResearchId: string | null;
  /** `version` do cabeçalho (muda a cada gravação — RN-TR-19). */
  readonly version: number;
}

export interface EtpHeaderReader {
  /** O ETP `id` (RLS: do tenant); `null` se inexistente. */
  findById(tx: TenantTx, id: string): Promise<EtpHeader | null>;
}

/** Registro do leitor (implementado pelo módulo `etp`). */
@Injectable()
export class EtpHeaderRegistry {
  private reader: EtpHeaderReader | null = null;

  register(reader: EtpHeaderReader): void {
    this.reader = reader;
  }

  headerOf(tx: TenantTx, id: string): Promise<EtpHeader | null> {
    return this.reader ? this.reader.findById(tx, id) : Promise.resolve(null);
  }
}

/** Importado por `term` (consumidor) e `etp` (implementador); a instância é única. */
@Module({
  providers: [EtpHeaderRegistry],
  exports: [EtpHeaderRegistry],
})
export class EtpHeaderModule {}
