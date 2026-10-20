import type { AiTargetModule } from '@contrataflow/types';
import { AI_SECTION_RESERVED_TOKENS } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';

import { AiPolicyRevokedError } from './ai-generator.js';
import type {
  AiGenerator,
  AiGeneratorCheck,
  AiGeneratorContext,
  AiGeneratorRequest,
} from './ai-generator.js';
import { sectionNotAdjustable } from './ai.errors.js';
import type { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { DocumentFacade } from '../../document/application/document.facade.js';
import type { ProcessFacade } from '../../process/application/process.facade.js';
import type { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import {
  SECTION_ADJUST_CHAIN,
  SectionNoLongerAdjustableError,
  assembleSectionAdjustContext,
  sectionAdjustProblem,
} from '../domain/section-adjust-context.js';
import type { ChainModule, SectionAdjustChainDocument } from '../domain/section-adjust-context.js';
import { SECTION_ACTION_PROMPTS } from '../prompts/section/prompts.js';

/*
 * `SectionAdjustGenerator` — `<documento>`/`SECTION` (US-121 · RN-AI-47..52): reescrever, completar
 * ou resumir uma seção narrativa do DFD, do ETP, do Mapa de Riscos ou do TR (uma instância por
 * `targetModule`). No pedido, a `SectionAdjustPolicy` (422 `AI_SECTION_EMPTY` /
 * `AI_SECTION_NOT_SUPPORTED`) e a `baseRevision` = revisão atual da seção; no job, o contexto pelas
 * FACHADAS DE LEITURA de `document`, `process`, `catalog` e `tenancy` (regra D9), na transação do
 * tenant (RLS). A POL-02 (permissão de edição do tipo, custódia, status) é do pipeline
 * (`DocumentFacade.aiTargetIn`); a aplicação é do `document` (DOC-26, que confere a `baseRevision`).
 */

/** Teto de saída de um ajuste (a reserva do pedido é a estimativa de 6 mil tokens — RN-AI-52). */
const SECTION_ADJUST_MAX_OUTPUT_TOKENS = 4_000;

export interface SectionAdjustDependencies {
  readonly documents: DocumentFacade;
  readonly processes: ProcessFacade;
  readonly catalog: CatalogFacade;
  readonly tenancy: TenancyFacade;
}

export class SectionAdjustGenerator implements AiGenerator {
  readonly kind = 'SECTION' as const;
  readonly prompt = SECTION_ACTION_PROMPTS.REWRITE;
  readonly actionPrompts = SECTION_ACTION_PROMPTS;
  readonly reservedTokens = AI_SECTION_RESERVED_TOKENS;
  readonly needSummary = 'OPTIONAL' as const;
  readonly maxOutputTokens = SECTION_ADJUST_MAX_OUTPUT_TOKENS;

  constructor(
    readonly targetModule: AiTargetModule,
    private readonly deps: SectionAdjustDependencies,
  ) {}

  /** `SectionAdjustPolicy` (RN-AI-48 · V-02/V-03) e a `baseRevision` (RN-AI-49). */
  async validateRequest(tx: TenantTx, request: AiGeneratorRequest): Promise<AiGeneratorCheck> {
    const { documentId, sectionKey, action } = request;
    if (documentId === null || sectionKey === null || action === null) {
      throw validationError([
        {
          field: documentId === null ? 'documentId' : sectionKey === null ? 'sectionKey' : 'action',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Revise os dados do pedido.',
        },
      ]);
    }
    const source = await this.deps.documents.aiSectionSourceIn(tx, documentId, sectionKey);
    if (source === null) throw sectionNotAdjustable('AI_SECTION_NOT_SUPPORTED');
    const problem = sectionAdjustProblem(this.targetModule, action, sectionKey, source);
    if (problem !== null) throw sectionNotAdjustable(problem);
    return { baseRevision: source.revision };
  }

  async buildContext(tx: TenantTx, generation: AiGeneration): Promise<AiGeneratorContext> {
    const { documentId, sectionKey, action } = generation;
    if (documentId === null || sectionKey === null || action === null) {
      throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    }
    // Leituras em sequência: uma transação interativa não executa consultas em paralelo.
    const source = await this.deps.documents.aiSectionSourceIn(tx, documentId, sectionKey);
    const process = await this.deps.processes.aiContextIn(tx, generation.processId);
    if (source === null || process === null) throw new AiPolicyRevokedError('PREREQUISITE_LOST');

    const chain: { module: ChainModule; document: SectionAdjustChainDocument | null }[] = [];
    for (const module of SECTION_ADJUST_CHAIN[this.targetModule]) {
      const document = await this.deps.documents.aiChainSourceIn(tx, generation.processId, module);
      chain.push({ module, document });
    }
    const labels = new Map<string, string>();
    for (const id of [process.contractingTypeId, process.modalityId]) {
      if (id === null) continue;
      const item = await this.deps.catalog.find(tx, id);
      if (item !== null) labels.set(id, item.label);
    }
    const organization = await this.deps.tenancy.organizationAiProfile(tx, process.organizationId);
    const labelOf = (id: string | null) => (id === null ? null : (labels.get(id) ?? null));

    try {
      return assembleSectionAdjustContext(
        {
          targetModule: this.targetModule,
          sectionKey,
          process: {
            id: process.id,
            code: process.code,
            title: process.title,
            object: process.object,
            description: process.description,
            contractingType: labelOf(process.contractingTypeId),
            modality: labelOf(process.modalityId),
            isPriceRegistration: process.isPriceRegistration,
            priority: process.priority,
            isBudgetConfidential: process.isBudgetConfidential,
          },
          document: source,
          chain,
          organization,
        },
        action,
      );
    } catch (error) {
      // A seção deixou de ser ajustável depois do pedido: cancela sem chamar o provedor (FA-06).
      if (error instanceof SectionNoLongerAdjustableError) {
        throw new AiPolicyRevokedError(error.problem);
      }
      throw error;
    }
  }
}
