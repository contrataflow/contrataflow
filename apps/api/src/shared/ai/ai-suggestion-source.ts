import type { AiGenerationKind, AiSectionAction, AiTargetModule } from '@contrataflow/types';
import type { AiGenerationOutput, AiInputRef } from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';
import { ApiError } from '../errors/api-error.js';

/*
 * Porta `AiSuggestionSource` (DEC-079 · RN-AI-04/13): a aplicação do conteúdo gerado é COMANDO do
 * módulo dono — `document` (seções, DOC-26) e `risk` (riscos, RSK-11) —, executado por uma pessoa.
 * O `ai` (nível 5) não chama esses comandos (regra D9); no sentido contrário, o dono lê a proposta
 * e marca a aplicação por esta porta, NA MESMA transação. O `ai` registra a implementação no
 * `onModuleInit` (mesmo arranjo de `DocumentProcessContextRegistry`); sem implementação, falha
 * fechada com 503 `DEPENDENCY_UNAVAILABLE`.
 */

export interface AiAppliedTargets {
  readonly sectionKeys: readonly string[];
  readonly riskIds: readonly string[];
}

/** A proposta pronta para aplicar (só do solicitante — RN-AI-13). */
export interface AiSuggestion {
  readonly generationId: string;
  readonly processId: string;
  readonly documentId: string | null;
  readonly targetModule: AiTargetModule;
  readonly kind: AiGenerationKind;
  readonly action: AiSectionAction | null;
  readonly sectionKey: string | null;
  /** Revisão da seção no pedido de ajuste (`AI_SUGGESTION_STALE` se mudou — US-121). */
  readonly baseRevision: number | null;
  readonly status: 'SUCCEEDED' | 'APPLIED';
  readonly output: AiGenerationOutput;
  readonly appliedTargets: AiAppliedTargets | null;
  readonly requestedById: string;
  /** Rastreabilidade para a auditoria `ai.content_apply` (só ids, versões e hashes — RN-AI-29). */
  readonly trace: {
    readonly model: string | null;
    readonly promptKey: string;
    readonly promptVersion: string;
    readonly inputRefs: readonly AiInputRef[];
    readonly contextHash: string | null;
    readonly outputHash: string | null;
  };
}

export interface AiSuggestionSource {
  /**
   * Proposta da geração para o usuário do contexto: inexistente/outro tenant → 404
   * `AI_GENERATION_NOT_FOUND`; de outra pessoa → 403 `AI_GENERATION_NOT_OWNED`; fora de
   * `SUCCEEDED` (ou `APPLIED` com parte pendente no mapa de riscos), vencida ou de outro
   * documento/tipo → 409 `AI_GENERATION_NOT_APPLICABLE`.
   */
  loadForApply(
    tx: TenantTx,
    input: {
      readonly generationId: string;
      readonly targetModule: AiTargetModule;
      readonly documentId: string | null;
    },
  ): Promise<AiSuggestion>;
  /**
   * Marca a aplicação, condicionada ao status lido: de duas aplicações simultâneas, uma vence e a
   * outra recebe 409 `AI_GENERATION_NOT_APPLICABLE`.
   */
  markApplied(
    tx: TenantTx,
    input: { readonly generationId: string; readonly targets: AiAppliedTargets },
  ): Promise<void>;
}

function unavailable(): ApiError {
  return new ApiError('DEPENDENCY_UNAVAILABLE', {
    detail: 'A aplicação de conteúdo gerado por IA está indisponível.',
  });
}

/** Registro da implementação (feito pelo módulo `ai`); sem ela, falha fechado. */
@Injectable()
export class AiSuggestionSourceRegistry implements AiSuggestionSource {
  private source: AiSuggestionSource | null = null;

  register(source: AiSuggestionSource): void {
    this.source = source;
  }

  loadForApply(
    tx: TenantTx,
    input: Parameters<AiSuggestionSource['loadForApply']>[1],
  ): Promise<AiSuggestion> {
    return this.source ? this.source.loadForApply(tx, input) : Promise.reject(unavailable());
  }

  markApplied(
    tx: TenantTx,
    input: Parameters<AiSuggestionSource['markApplied']>[1],
  ): Promise<void> {
    return this.source ? this.source.markApplied(tx, input) : Promise.reject(unavailable());
  }
}

/** Importado por `ai` (implementador) e pelos donos (`document`, `risk`); a instância é única. */
@Module({
  providers: [AiSuggestionSourceRegistry],
  exports: [AiSuggestionSourceRegistry],
})
export class AiSuggestionSourceModule {}
