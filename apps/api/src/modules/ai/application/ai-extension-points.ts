import type { AiGenerationKind, AiTargetModule } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { AiGeneration } from '../domain/ai-generation.js';
import type { AiOutputPostProcessor } from '../domain/post-processing.js';

/*
 * Portões e ganchos extensíveis do pipeline (US-115 · "Impacto técnico"):
 *
 * - `AiTenantGate` (US-116): IA ligada no órgão, termos aceitos, limite mensal e diário e reserva
 *   de tokens. Porta OBRIGATÓRIA: sem implementação registrada, AI-01 falha fechado com 403
 *   `AI_DISABLED` e o job cancela por política. Consultado no pedido e revalidado no job (RN-AI-22).
 * - `AiOutputPostProcessor` (US-122): cadeia ordenada; o `AiModule` registra o `GroundingGuard`.
 */

export type AiGateDenial =
  | 'AI_DISABLED'
  | 'AI_USAGE_LIMIT_REACHED'
  | 'AI_USER_DAILY_LIMIT_REACHED'
  /** Só na execução: o solicitante perdeu `AI_GENERATE` sobre o processo (RN-AI-22). */
  | 'PERMISSION_DENIED';

export type AiGateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly code: AiGateDenial };

export interface AiGateRequest {
  readonly userId: string;
  readonly processId: string;
  readonly targetModule: AiTargetModule;
  readonly kind: AiGenerationKind;
  readonly reservedTokens: number;
  /** `REQUEST` em AI-01; `EXECUTION` na revalidação do job antes de chamar o provedor. */
  readonly stage: 'REQUEST' | 'EXECUTION';
  /** Na execução: a própria geração (fora da contagem diária) e o seu `createdAt` (mês/dia). */
  readonly generationId?: string;
  readonly createdAt?: Date;
}

export interface AiTenantGate {
  check(tx: TenantTx, request: AiGateRequest): Promise<AiGateDecision>;
  /**
   * Término da geração com tokens gravados (sucesso, falha ou resposta descartada), na mesma
   * transação: avisos de consumo do mês (US-116 · RN-AI-20). `addedTokens` = tokens que passaram
   * a contar como consumo nesta gravação. Opcional.
   */
  settle?(tx: TenantTx, generation: AiGeneration, addedTokens: number): Promise<void>;
}

@Injectable()
export class AiTenantGateRegistry implements AiTenantGate {
  private gate: AiTenantGate | null = null;

  register(gate: AiTenantGate): void {
    this.gate = gate;
  }

  /** Sem portão registrado → `AI_DISABLED` (falha fechada). */
  check(tx: TenantTx, request: AiGateRequest): Promise<AiGateDecision> {
    if (this.gate === null) return Promise.resolve({ allowed: false, code: 'AI_DISABLED' });
    return this.gate.check(tx, request);
  }

  settle(tx: TenantTx, generation: AiGeneration, addedTokens: number): Promise<void> {
    return this.gate?.settle?.(tx, generation, addedTokens) ?? Promise.resolve();
  }
}

@Injectable()
export class AiPostProcessorRegistry {
  private readonly chain: AiOutputPostProcessor[] = [];

  /** Acrescenta ao fim da cadeia (a ordem de registro é a ordem de execução). */
  register(processor: AiOutputPostProcessor): void {
    if (this.chain.some((current) => current.name === processor.name)) {
      throw new Error(`Pós-processador ${processor.name} registrado duas vezes`);
    }
    this.chain.push(processor);
  }

  all(): readonly AiOutputPostProcessor[] {
    return [...this.chain];
  }

  /** Só testes: esvazia a cadeia. */
  clear(): void {
    this.chain.length = 0;
  }
}
