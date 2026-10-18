import type { AiGenerationKind, AiTargetModule } from '@contrataflow/types';
import type { AiOutputWarning } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

import type { TenantTx } from '#shared/database/prisma.js';

import type { AiGenerationTarget } from './ports.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import type { ContextPart } from '../domain/context-sanitizer.js';
import type { SectionSpec } from '../domain/output-converter.js';
import { PromptRegistry } from '../domain/prompts.js';
import type { PromptTemplate } from '../domain/prompts.js';
import type { StructuredResponse } from '../domain/structured-output.js';

/*
 * Geradores (DEC-079 · US-117..US-121): um por par `targetModule`/`kind`, registrados no
 * `AiGeneratorRegistry`. O pipeline genérico (US-115) cuida de registro, fila, sanitização, prompt,
 * provedor, validação, conversão, pós-processamento e rastreabilidade; o gerador só sabe o que é
 * ESPECÍFICO do documento: pré-requisitos, seções e contexto — sempre por FACHADAS DE LEITURA de
 * outros módulos (regra D9 — dependency-cruiser `ai-read-only`), na transação do tenant.
 */

/** O pedido de AI-01 visto pelo gerador (o texto livre já validado pelo Zod). */
export interface AiGeneratorRequest extends AiGenerationTarget {
  readonly action: AiGeneration['action'];
  readonly needSummary: string | null;
  readonly instruction: string | null;
}

/** O que o gerador conferiu no pedido (V-05..V-07 e pré-requisitos da cadeia). */
export interface AiGeneratorCheck {
  /** Revisão da seção no pedido de ajuste (US-121); `null` em `DRAFT`. */
  readonly baseRevision: number | null;
}

/** Contexto montado no job, antes da sanitização. */
export interface AiGeneratorContext {
  readonly parts: readonly ContextPart[];
  readonly sections: readonly SectionSpec[];
  /** Orçamento sigiloso: valores nunca entram no contexto (RN-AI-05 · DEC-030). */
  readonly isBudgetConfidential: boolean;
  /**
   * Avisos conhecidos pelo gerador (`MISSING_OPTIONAL_INPUT`, `BUDGET_CONFIDENTIAL_VALUES_OMITTED`…),
   * somados aos da sanitização na proposta, sem repetir código e parâmetros.
   */
  readonly warnings?: readonly AiOutputWarning[];
}

/**
 * Pré-requisito perdido entre o pedido e a execução (ex.: DFD cancelado): a geração vira
 * `CANCELED`/`CANCELED_BY_POLICY` sem chamar o provedor (FA-06).
 */
export class AiPolicyRevokedError extends Error {
  constructor(readonly reason: string) {
    super(`Política da geração revogada: ${reason}`);
    this.name = 'AiPolicyRevokedError';
  }
}

export interface AiGenerator {
  readonly targetModule: AiTargetModule;
  readonly kind: AiGenerationKind;
  readonly prompt: PromptTemplate;
  /** Reserva de tokens do pedido (RN-AI-18 — DEC-079). */
  readonly reservedTokens: number;
  /** `needSummary` obrigatório (rascunho do DFD) ou opcional. */
  readonly needSummary: 'REQUIRED' | 'OPTIONAL';
  readonly maxOutputTokens: number;
  /** Schema da resposta (padrão: `structuredResponseSchema`). */
  readonly responseSchema?: z.ZodType<StructuredResponse>;
  /**
   * AI-01, no `tx` do pedido, depois de POL-18/POL-02: pré-requisitos da cadeia
   * (`AI_PREREQUISITE_MISSING`), seção suportada, `baseRevision` — lança `ApiError`.
   */
  validateRequest(tx: TenantTx, request: AiGeneratorRequest): Promise<AiGeneratorCheck>;
  /**
   * Job, na transação de leitura do tenant (RLS): o contexto e as seções pedidas.
   * @throws AiPolicyRevokedError pré-requisito perdido (FA-06)
   */
  buildContext(tx: TenantTx, generation: AiGeneration): Promise<AiGeneratorContext>;
}

/** Gerador já registrado para o par (erro de programação). */
export class DuplicateAiGeneratorError extends Error {
  constructor(key: string) {
    super(`Gerador de IA ${key} registrado duas vezes`);
    this.name = 'DuplicateAiGeneratorError';
  }
}

@Injectable()
export class AiGeneratorRegistry {
  private readonly generators = new Map<string, AiGenerator>();
  /** Prompts versionados dos geradores (RN-AI-06): chave e versão conferidas no registro. */
  readonly prompts = new PromptRegistry();

  register(generator: AiGenerator): void {
    const key = `${generator.targetModule}/${generator.kind}`;
    if (this.generators.has(key)) throw new DuplicateAiGeneratorError(key);
    this.prompts.register(generator.prompt);
    this.generators.set(key, generator);
  }

  find(targetModule: AiTargetModule, kind: AiGenerationKind): AiGenerator | undefined {
    return this.generators.get(`${targetModule}/${kind}`);
  }

  /** Só testes: remove o gerador do par. */
  unregister(targetModule: AiTargetModule, kind: AiGenerationKind): void {
    this.generators.delete(`${targetModule}/${kind}`);
  }
}
