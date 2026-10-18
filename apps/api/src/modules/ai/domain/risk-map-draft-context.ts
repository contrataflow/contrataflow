import {
  AI_RISK_PROPOSAL_LIMITS,
  PRIORITY_LABELS,
  RISK_LEVEL_LABELS,
  RISK_PHASE_LABELS,
  TREATMENT_TYPE_LABELS,
  aiProposedRiskSchema,
} from '@contrataflow/validation';
import type {
  AiOutputWarning,
  AiProposedRisk,
  Priority,
  RiskLevel,
  RiskPhase,
  SectionRequirement,
  TreatmentType,
} from '@contrataflow/validation';
import { z } from 'zod';

import type { ContextPart } from './context-sanitizer.js';
import type { RiskRefinement, RiskRefiner, SectionSpec } from './output-converter.js';
import { structuredSectionSchema } from './structured-output.js';
import type { StructuredResponse } from './structured-output.js';

/*
 * Proposta do mapa de riscos com IA (US-119 · RN-AI-38..41): a montagem do contexto
 * (`RiskMapProposalContextAssembler`), o schema da resposta e a normalização dos riscos propostos
 * (`RiskProposalNormalizer`). Puro: as fontes chegam já lidas pelas fachadas de leitura (D9). O DFD
 * é obrigatório; ETP e TR entram se existirem (precedência aprovado → versão → rascunho, com
 * `USED_DRAFT_INPUTS`); os riscos já registrados entram para evitar duplicidade. Nunca valores,
 * responsáveis nem nomes (RN-AI-05): as seções de valor (`ESTIMATES`, `ESTIMATED_VALUE`) ficam de
 * fora — o sigilo do orçamento não é afetado.
 */

/** Seções narrativas do `RISK_MAP` que a proposta pode trazer (RN-AI-41). */
export const RISK_MAP_NARRATIVE_SECTIONS = ['INTRODUCTION', 'METHODOLOGY', 'NOTES'] as const;

/** Seções de valor da cadeia: nunca entram no contexto (RN-AI-05). */
const VALUE_SECTIONS: ReadonlySet<string> = new Set(['ESTIMATES', 'ESTIMATED_VALUE']);

/** Código de categoria usado quando a IA propõe um código inexistente/inativo (RN-AI-39). */
export const FALLBACK_RISK_CATEGORY = 'OUTRO';

// --- Resposta do provedor ---------------------------------------------------------------------------

/**
 * O risco como o provedor o devolve: sem chaves da proposta (atribuídas aqui, em ordem) e com a
 * semelhança pelo CÓDIGO do risco registrado (`R01`) — ids não vão ao modelo (a sanitização
 * mascara sequências numéricas longas); o normalizador traduz para `similarToRiskId`.
 */
const providerRiskSchema = aiProposedRiskSchema
  .omit({ proposalKey: true, treatments: true, similarToRiskId: true })
  .extend({
    similarToRiskCode: z.string().max(10).optional(),
    treatments: z
      .array(aiProposedRiskSchema.shape.treatments.element.omit({ proposalKey: true }))
      .min(AI_RISK_PROPOSAL_LIMITS.minTreatments)
      .max(AI_RISK_PROPOSAL_LIMITS.maxTreatments),
  });

/**
 * Schema da resposta do mapa de riscos (RN-AI-39): seções narrativas (só com o documento emitido) e
 * de 1 a 15 riscos. Campos fora do schema (responsável, prazo, data, valor) = saída inválida.
 */
export const riskMapResponseSchema: z.ZodType<StructuredResponse> = z.strictObject({
  sections: z.array(structuredSectionSchema).max(RISK_MAP_NARRATIVE_SECTIONS.length),
  risks: z.array(providerRiskSchema).min(1).max(AI_RISK_PROPOSAL_LIMITS.maxRisks),
});

// --- Normalização -------------------------------------------------------------------------------------

export interface RiskProposalRules {
  /** `risk.scale.max` vigente (3..5). */
  readonly scaleMax: number;
  /** Códigos ATIVOS do `RISK_CATEGORY` do tenant. */
  readonly categoryCodes: ReadonlySet<string>;
  /** Riscos já registrados no processo: código → id (alvo de `similarToRiskId`). */
  readonly existingRisks: ReadonlyMap<string, string>;
}

/**
 * `RiskProposalNormalizer` (RN-AI-39): graus acima da escala vigente = saída inválida (reparo e,
 * persistindo, `OUTPUT_INVALID`); categoria desconhecida → `OUTRO`; `similarToRiskCode` de risco
 * do processo vira `similarToRiskId` (desconhecido some); chaves `R1`, `R1.T1`… na ordem da resposta.
 */
export function normalizeRiskProposal(
  risks: readonly Record<string, unknown>[] | undefined,
  rules: RiskProposalRules,
): RiskRefinement {
  const parsed = z
    .array(providerRiskSchema)
    .min(1)
    .safeParse(risks ?? []);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `risks.${issue.path.join('.') || '(raiz)'}: ${issue.code}`,
      ),
    };
  }
  const issues: string[] = [];
  const normalized: AiProposedRisk[] = parsed.data.map((risk, index) => {
    for (const field of ['probability', 'impact'] as const) {
      if (risk[field] > rules.scaleMax)
        issues.push(`risks.${String(index)}.${field}: out_of_scale`);
    }
    const key = `R${String(index + 1)}`;
    const { similarToRiskCode, ...rest } = risk;
    const similarToRiskId =
      similarToRiskCode === undefined
        ? undefined
        : rules.existingRisks.get(similarToRiskCode.trim());
    return {
      ...rest,
      proposalKey: key,
      title: risk.title.trim(),
      categoryCode: rules.categoryCodes.has(risk.categoryCode)
        ? risk.categoryCode
        : FALLBACK_RISK_CATEGORY,
      ...(similarToRiskId === undefined ? {} : { similarToRiskId }),
      treatments: risk.treatments.map((treatment, position) => ({
        ...treatment,
        proposalKey: `${key}.T${String(position + 1)}`,
      })),
    };
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, risks: normalized };
}

// --- Contexto -------------------------------------------------------------------------------------------

/** Documento da cadeia lido pela fachada do `document` (`AiChainSource`). */
export interface RiskMapChainDocument {
  readonly documentId: string;
  readonly documentTypeCode: string;
  readonly source: 'APPROVED_VERSION' | 'VERSION' | 'DRAFT';
  readonly versionNumber: number | null;
  readonly draftRevision: number | null;
  readonly sections: readonly { readonly key: string; readonly text: string }[];
}

export interface RiskMapTemplateSection {
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  readonly helpText: string | null;
  readonly legalBasis: string | null;
  readonly maxChars: number;
  readonly allowNarrative: boolean;
}

export interface RiskMapDraftSources {
  readonly process: {
    readonly id: string;
    readonly code: string | null;
    readonly title: string;
    readonly object: string;
    readonly description: string | null;
    readonly contractingType: string | null;
    readonly modality: string | null;
    readonly isPriceRegistration: boolean;
    readonly priority: Priority;
    readonly isBudgetConfidential: boolean;
  };
  readonly dfd: RiskMapChainDocument;
  readonly etp: RiskMapChainDocument | null;
  readonly termOfReference: RiskMapChainDocument | null;
  readonly risks: readonly {
    readonly id: string;
    readonly code: string;
    readonly title: string;
    readonly categoryCode: string;
    readonly phase: RiskPhase;
    readonly level: RiskLevel;
    readonly treatments: readonly { readonly type: TreatmentType; readonly description: string }[];
  }[];
  readonly categories: readonly { readonly code: string; readonly label: string }[];
  readonly scale: {
    readonly max: number;
    readonly probabilityLabels: readonly string[];
    readonly impactLabels: readonly string[];
  };
  /** O `RISK_MAP` já emitido (seções narrativas entram — RN-AI-41); `null` = só riscos. */
  readonly riskMap: {
    readonly documentId: string;
    readonly documentTypeCode: string;
    readonly draftRevision: number;
    readonly sectionStates: Readonly<Record<string, string>>;
    readonly template: {
      readonly versionId: string;
      readonly versionNumber: number;
      readonly sections: readonly RiskMapTemplateSection[];
    } | null;
  } | null;
}

export interface RiskMapDraftContext {
  readonly parts: ContextPart[];
  readonly sections: SectionSpec[];
  readonly isBudgetConfidential: boolean;
  readonly warnings: AiOutputWarning[];
  readonly refineRisks: RiskRefiner;
  readonly ignoreUnknownSections: boolean;
}

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
}

/** Parte de um documento da cadeia: `DOCUMENT_VERSION` (versão) ou `DOCUMENT_DRAFT` (rascunho). */
function chainPart(document: RiskMapChainDocument, label: string): ContextPart {
  const ref =
    document.source === 'DRAFT'
      ? {
          kind: 'DOCUMENT_DRAFT' as const,
          id: document.documentId,
          documentTypeCode: document.documentTypeCode,
          revision: document.draftRevision ?? 0,
        }
      : {
          kind: 'DOCUMENT_VERSION' as const,
          id: document.documentId,
          documentTypeCode: document.documentTypeCode,
          versionNumber: document.versionNumber ?? 1,
        };
  return {
    ref,
    label,
    data: document.sections
      .filter((section) => !VALUE_SECTIONS.has(section.key))
      .map((section) => ({ secao: section.key, texto: section.text })),
  };
}

/** Seções narrativas do `RISK_MAP` emitido (as computadas — matriz e lista — ficam de fora). */
export function riskMapDraftSections(
  sections: readonly RiskMapTemplateSection[] | null,
): SectionSpec[] {
  const allowed: ReadonlySet<string> = new Set(RISK_MAP_NARRATIVE_SECTIONS);
  return (sections ?? [])
    .filter((section) => section.allowNarrative && allowed.has(section.key))
    .map((section) => ({
      sectionKey: section.key,
      title: section.title,
      maxChars: section.maxChars,
      legalBasis: section.legalBasis,
      ...(section.requirement === 'OPTIONAL' ? { optional: true } : {}),
    }));
}

export function assembleRiskMapDraftContext(sources: RiskMapDraftSources): RiskMapDraftContext {
  const { process, dfd, etp, termOfReference, risks, categories, scale, riskMap } = sources;
  const warnings: AiOutputWarning[] = [];
  for (const [input, document] of [
    ['ETP', etp],
    ['TERM_OF_REFERENCE', termOfReference],
  ] as const) {
    if (document === null) warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input } });
  }
  for (const document of [dfd, etp, termOfReference]) {
    if (document?.source === 'DRAFT') {
      warnings.push({
        code: 'USED_DRAFT_INPUTS',
        params: { input: document.documentTypeCode },
      });
    }
  }

  const parts: ContextPart[] = [
    {
      ref: { kind: 'PROCESS', id: process.id },
      label: 'Processo',
      data: compact({
        codigo: process.code,
        titulo: process.title,
        objeto: process.object,
        descricao: process.description,
        prioridade: PRIORITY_LABELS[process.priority],
        registroDePrecos: process.isPriceRegistration ? 'Sim' : 'Não',
      }),
    },
    {
      ref: { kind: 'CATALOG', id: null },
      label: 'Classificação e categorias de risco',
      data: compact({
        tipoDeContratacao: process.contractingType,
        modalidade: process.modality,
        categoriasDeRisco: categories.map((category) => ({
          codigo: category.code,
          nome: category.label,
        })),
        fases: Object.entries(RISK_PHASE_LABELS).map(([codigo, nome]) => ({ codigo, nome })),
        escala: {
          maximo: scale.max,
          probabilidade: scale.probabilityLabels.map((rotulo, index) => ({
            grau: index + 1,
            rotulo,
          })),
          impacto: scale.impactLabels.map((rotulo, index) => ({ grau: index + 1, rotulo })),
        },
      }),
    },
    chainPart(dfd, 'DFD'),
  ];
  if (etp !== null) parts.push({ ...chainPart(etp, 'ETP'), optional: true });
  if (termOfReference !== null) {
    parts.push({ ...chainPart(termOfReference, 'Termo de Referência'), optional: true });
  }
  parts.push({
    ref: { kind: 'RISKS', id: process.id },
    label: 'Riscos já registrados',
    data: risks.map((risk) => ({
      codigo: risk.code,
      titulo: risk.title,
      categoria: risk.categoryCode,
      fase: RISK_PHASE_LABELS[risk.phase],
      nivel: RISK_LEVEL_LABELS[risk.level],
      tratamentos: risk.treatments.map((treatment) => ({
        tipo: TREATMENT_TYPE_LABELS[treatment.type],
        descricao: treatment.description,
      })),
    })),
  });

  let sections: SectionSpec[] = [];
  if (riskMap !== null) {
    sections = riskMapDraftSections(riskMap.template?.sections ?? null);
    const narrative = new Set(sections.map((section) => section.sectionKey));
    parts.push({
      ref: {
        kind: 'DOCUMENT_DRAFT',
        id: riskMap.documentId,
        documentTypeCode: riskMap.documentTypeCode,
        revision: riskMap.draftRevision,
      },
      label: 'Situação das seções do Mapa de Riscos',
      data: [...narrative].map((key) => ({
        secao: key,
        preenchida: riskMap.sectionStates[key] === 'FILLED' ? 'Sim' : 'Não',
      })),
    });
    parts.push({
      ref:
        riskMap.template === null
          ? { kind: 'TEMPLATE_VERSION', id: null }
          : {
              kind: 'TEMPLATE_VERSION',
              id: riskMap.template.versionId,
              versionNumber: riskMap.template.versionNumber,
            },
      label: 'Guia de redação do modelo do órgão',
      data: (riskMap.template?.sections ?? [])
        .filter((section) => narrative.has(section.key))
        .map((section) =>
          compact({
            secao: section.key,
            titulo: section.title,
            obrigatoria: section.requirement === 'OPTIONAL' ? 'Não' : 'Sim',
            orientacao: section.helpText,
            baseLegal: section.legalBasis,
          }),
        ),
    });
  }

  const rules: RiskProposalRules = {
    scaleMax: scale.max,
    categoryCodes: new Set(categories.map((category) => category.code)),
    existingRisks: new Map(risks.map((risk) => [risk.code, risk.id])),
  };
  return {
    parts,
    sections,
    isBudgetConfidential: process.isBudgetConfidential,
    warnings,
    refineRisks: (proposed) => normalizeRiskProposal(proposed, rules),
    // Sem o `RISK_MAP` emitido, seções na resposta são descartadas (FA-03 · RN-AI-41).
    ignoreUnknownSections: riskMap === null,
  };
}
