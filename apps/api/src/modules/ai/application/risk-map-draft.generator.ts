import { riskScaleSettingSchema } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { AiPolicyRevokedError } from './ai-generator.js';
import type {
  AiGenerator,
  AiGeneratorCheck,
  AiGeneratorContext,
  AiGeneratorRequest,
} from './ai-generator.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { RiskFacade } from '../../risk/application/risk.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import {
  assembleRiskMapDraftContext,
  riskMapResponseSchema,
} from '../domain/risk-map-draft-context.js';
import type { RiskMapChainDocument } from '../domain/risk-map-draft-context.js';
import { RISK_MAP_DRAFT_PROMPT } from '../prompts/draft.risk_map/prompt.js';

/*
 * `RiskMapDraftGenerator` — `RISK_MAP`/`DRAFT` (US-119 · RN-AI-38..41): a proposta de riscos e
 * tratamentos (e das seções narrativas do `RISK_MAP` já emitido). Alvo = processo; `documentId` =
 * o `RISK_MAP`, se emitido. No pedido, o DFD não cancelado (`AI_PREREQUISITE_MISSING`); no job, o
 * contexto pelas FACHADAS DE LEITURA de `document`, `process`, `risk`, `catalog` e `tenancy`
 * (regra D9), na transação do tenant (RLS). A criação dos riscos é do `risk` (RSK-11), que lê a
 * proposta pela porta `AiSuggestionSource`.
 */

/** Reserva de tokens da proposta do mapa de riscos (RN-AI-18 · "Fluxo principal", passo 2). */
const RISK_MAP_DRAFT_RESERVED_TOKENS = 25_000;
const RISK_MAP_DRAFT_MAX_OUTPUT_TOKENS = 8_000;

@Injectable()
export class RiskMapDraftGenerator implements AiGenerator {
  readonly targetModule = 'RISK_MAP' as const;
  readonly kind = 'DRAFT' as const;
  readonly prompt = RISK_MAP_DRAFT_PROMPT;
  readonly reservedTokens = RISK_MAP_DRAFT_RESERVED_TOKENS;
  readonly needSummary = 'OPTIONAL' as const;
  readonly maxOutputTokens = RISK_MAP_DRAFT_MAX_OUTPUT_TOKENS;
  readonly responseSchema = riskMapResponseSchema;

  constructor(
    private readonly documents: DocumentFacade,
    private readonly processes: ProcessFacade,
    private readonly risks: RiskFacade,
    private readonly catalog: CatalogFacade,
    private readonly tenancy: TenancyFacade,
  ) {}

  /**
   * RN-AI-38 (V-02): DFD não cancelado no processo. Com o `RISK_MAP` emitido, o pedido o aponta
   * (o status editável já foi conferido pelo `aiTargetIn` — FA-05).
   */
  async validateRequest(tx: TenantTx, request: AiGeneratorRequest): Promise<AiGeneratorCheck> {
    const dfd = await this.documents.aiChainSourceIn(tx, request.processId, 'DFD');
    if (dfd === null) {
      throw new ApiError('AI_PREREQUISITE_MISSING', {
        detail: 'Crie o DFD antes de gerar a proposta de riscos.',
        extensions: { meta: { missing: ['DFD'] } },
      });
    }
    if (request.documentId === null) {
      const riskMap = await this.documents.aiChainSourceIn(tx, request.processId, 'RISK_MAP');
      if (riskMap !== null) {
        throw validationError([
          {
            field: 'documentId',
            code: 'CONDITIONAL_REQUIRED',
            message: 'Informe o Mapa de Riscos já emitido para este processo.',
          },
        ]);
      }
    }
    return { baseRevision: null };
  }

  async buildContext(tx: TenantTx, generation: AiGeneration): Promise<AiGeneratorContext> {
    // Leituras em sequência: uma transação interativa não executa consultas em paralelo.
    const dfd = await this.documents.aiChainSourceIn(tx, generation.processId, 'DFD');
    if (dfd === null) throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    const etp = await this.documents.aiChainSourceIn(tx, generation.processId, 'ETP');
    const termOfReference = await this.documents.aiChainSourceIn(
      tx,
      generation.processId,
      'TERM_OF_REFERENCE',
    );
    const process = await this.processes.aiContextIn(tx, generation.processId);
    if (process === null) throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    const riskMap =
      generation.documentId === null
        ? null
        : await this.documents.aiDraftSourceIn(tx, generation.documentId);
    if (generation.documentId !== null && riskMap === null) {
      throw new AiPolicyRevokedError('PREREQUISITE_LOST');
    }

    const labels = new Map<string, string>();
    const codes = new Map<string, string>();
    const existing = await this.risks.aiContextIn(tx, generation.processId);
    const referenced = [
      process.contractingTypeId,
      process.modalityId,
      ...existing.map((risk) => risk.categoryId),
    ].filter((id): id is string => id !== null);
    for (const id of new Set(referenced)) {
      const item = await this.catalog.find(tx, id);
      if (item !== null) {
        labels.set(id, item.label);
        codes.set(id, item.code);
      }
    }
    const categories = await this.catalog.activeItemsOf(tx, 'RISK_CATEGORY');
    const settings = await this.tenancy.settingValues(tx, ['risk.scale']);
    const scale = riskScaleSettingSchema.parse(settings.get('risk.scale'));
    const labelOf = (id: string | null) => (id === null ? null : (labels.get(id) ?? null));

    return assembleRiskMapDraftContext({
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
      dfd: chainDocument(dfd),
      etp: etp === null ? null : chainDocument(etp),
      termOfReference: termOfReference === null ? null : chainDocument(termOfReference),
      risks: existing.map((risk) => ({
        id: risk.id,
        code: risk.code,
        title: risk.title,
        categoryCode: codes.get(risk.categoryId) ?? '',
        phase: risk.phase,
        level: risk.level,
        treatments: risk.treatments,
      })),
      categories: categories.map((category) => ({ code: category.code, label: category.label })),
      scale: {
        max: scale.max,
        probabilityLabels: scale.probabilityLabels,
        impactLabels: scale.impactLabels,
      },
      riskMap:
        riskMap === null
          ? null
          : {
              documentId: riskMap.documentId,
              documentTypeCode: riskMap.documentTypeCode,
              draftRevision: riskMap.draftRevision,
              sectionStates: riskMap.sectionStates,
              template:
                riskMap.template === null
                  ? null
                  : {
                      versionId: riskMap.template.versionId,
                      versionNumber: riskMap.template.versionNumber,
                      sections: riskMap.template.sections,
                    },
            },
    });
  }
}

function chainDocument(
  source: NonNullable<Awaited<ReturnType<DocumentFacade['aiChainSourceIn']>>>,
): RiskMapChainDocument {
  return {
    documentId: source.documentId,
    documentTypeCode: source.documentTypeCode,
    source: source.source,
    versionNumber: source.versionNumber,
    draftRevision: source.draftRevision,
    sections: source.sections,
  };
}
