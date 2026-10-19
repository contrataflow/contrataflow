import type { AiSectionAction, AiTargetModule } from '@contrataflow/types';
import { PRIORITY_LABELS, aiSectionAdjustProblem } from '@contrataflow/validation';
import type {
  AiOutputWarning,
  AiSectionAdjustProblem,
  Priority,
  SectionRender,
  SectionRequirement,
  SectionState,
} from '@contrataflow/validation';

import type { ContextPart } from './context-sanitizer.js';
import { DFD_DEFAULT_SECTIONS } from './dfd-draft-context.js';
import type { SectionSpec } from './output-converter.js';

/*
 * Ajuste de seção com IA (US-121 · RN-AI-47..52): a elegibilidade da seção (`SectionAdjustPolicy`)
 * e a montagem do contexto (`SectionAdjustContextAssembler`). Puro: as fontes chegam já lidas pelas
 * fachadas de leitura (D9). O texto atual da seção é a primeira entrada (`inputRef` `SECTION` com a
 * revisão) — o GroundingGuard o trata como fato, então valores escritos pela pessoa nunca viram
 * "[a confirmar]" (RN-AI-51). Os antecessores da cadeia entram se existirem, sem exigir nenhum
 * (lacuna 3: sem `AI_PREREQUISITE_MISSING`); a falta vira `MISSING_OPTIONAL_INPUT`. Nunca pessoas
 * nem as seções de valor da cadeia (RN-AI-05).
 */

/** Antecessores do documento na cadeia DFD → ETP → mapa de riscos → TR (RN-AI-48). */
export type ChainModule = 'DFD' | 'ETP' | 'RISK_MAP';

export const SECTION_ADJUST_CHAIN: Readonly<Record<AiTargetModule, readonly ChainModule[]>> = {
  DFD: [],
  ETP: ['DFD'],
  RISK_MAP: ['DFD', 'ETP'],
  TERM_OF_REFERENCE: ['DFD', 'ETP', 'RISK_MAP'],
};

const CHAIN_LABELS: Readonly<Record<ChainModule, string>> = {
  DFD: 'DFD',
  ETP: 'ETP',
  RISK_MAP: 'Mapa de Riscos',
};

/** Seções de valor da cadeia: nunca entram no contexto (RN-AI-05). */
const VALUE_SECTIONS: ReadonlySet<string> = new Set(['ESTIMATES', 'ESTIMATED_VALUE']);

export interface SectionAdjustDefinition {
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  readonly helpText: string | null;
  readonly legalBasis: string | null;
  readonly defaultText: string | null;
  readonly maxChars: number;
  readonly render: SectionRender;
  readonly allowNarrative: boolean;
}

/** A seção como a fachada do `document` a devolve (`AiSectionSource`). */
export interface SectionAdjustSection {
  readonly documentTypeCode: string;
  readonly template: { readonly versionId: string; readonly versionNumber: number } | null;
  readonly definition: SectionAdjustDefinition | null;
  readonly state: SectionState;
  readonly revision: number;
  readonly text: string;
}

/**
 * A definição vigente da seção: a do template fixado ou, no DFD sem template, a das seções padrão
 * (RN-DFD-07 — mesmo arranjo do rascunho).
 */
export function sectionDefinitionOf(
  targetModule: AiTargetModule,
  source: Pick<SectionAdjustSection, 'template' | 'definition'>,
  sectionKey: string,
): SectionAdjustDefinition | null {
  if (source.definition !== null) return source.definition;
  if (source.template !== null || targetModule !== 'DFD') return null;
  const fallback = DFD_DEFAULT_SECTIONS.find((section) => section.key === sectionKey);
  return fallback === undefined ? null : { ...fallback, render: 'TEXT' };
}

/** `SectionAdjustPolicy` (V-02/V-03): o motivo da recusa, ou `null`. */
export function sectionAdjustProblem(
  targetModule: AiTargetModule,
  action: AiSectionAction,
  sectionKey: string,
  source: SectionAdjustSection,
): AiSectionAdjustProblem | null {
  return aiSectionAdjustProblem({
    action,
    section: sectionDefinitionOf(targetModule, source, sectionKey),
    state: source.state,
    text: source.text,
  });
}

// --- Contexto ---------------------------------------------------------------------------------------

/** Documento da cadeia lido pela fachada do `document` (`AiChainSource`). */
export interface SectionAdjustChainDocument {
  readonly documentId: string;
  readonly documentTypeCode: string;
  readonly source: 'APPROVED_VERSION' | 'VERSION' | 'DRAFT';
  readonly versionNumber: number | null;
  readonly draftRevision: number | null;
  readonly sections: readonly { readonly key: string; readonly text: string }[];
}

export interface SectionAdjustSources {
  readonly targetModule: AiTargetModule;
  readonly sectionKey: string;
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
  readonly document: SectionAdjustSection & {
    readonly documentId: string;
    readonly draftRevision: number;
    readonly otherSections: readonly {
      readonly key: string;
      readonly title: string;
      readonly text: string;
    }[];
  };
  /** Antecessores na ordem de `SECTION_ADJUST_CHAIN` (`null` = ausente no processo). */
  readonly chain: readonly {
    readonly module: ChainModule;
    readonly document: SectionAdjustChainDocument | null;
  }[];
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly city: string | null;
    readonly state: string | null;
  } | null;
}

export interface SectionAdjustContext {
  readonly parts: ContextPart[];
  readonly sections: SectionSpec[];
  readonly isBudgetConfidential: boolean;
  readonly warnings: AiOutputWarning[];
}

/** A seção perdeu a elegibilidade entre o pedido e o job (ex.: marcada "não se aplica"). */
export class SectionNoLongerAdjustableError extends Error {
  constructor(readonly problem: AiSectionAdjustProblem) {
    super(`Seção não ajustável: ${problem}`);
    this.name = 'SectionNoLongerAdjustableError';
  }
}

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
}

function chainPart(document: SectionAdjustChainDocument, label: string): ContextPart {
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
    // Contexto grande: os antecessores saem antes do texto da própria seção (CONTEXT_TRUNCATED).
    optional: true,
  };
}

/**
 * `SectionAdjustContextAssembler` (RN-AI-48): texto atual da seção → guia da seção no modelo →
 * processo → demais seções do documento → antecessores da cadeia → órgão. A saída pedida é UMA
 * seção (a da geração), no `maxChars` do template.
 * @throws SectionNoLongerAdjustableError a seção deixou de ser narrativa/aplicável (FA-06 do job)
 */
export function assembleSectionAdjustContext(
  sources: SectionAdjustSources,
  action: AiSectionAction,
): SectionAdjustContext {
  const { targetModule, sectionKey, process, document, chain, organization } = sources;
  const problem = sectionAdjustProblem(targetModule, action, sectionKey, document);
  const definition = sectionDefinitionOf(targetModule, document, sectionKey);
  if (problem !== null || definition === null) {
    throw new SectionNoLongerAdjustableError(problem ?? 'AI_SECTION_NOT_SUPPORTED');
  }

  const warnings: AiOutputWarning[] = [];
  for (const { module, document: source } of chain) {
    if (source === null) {
      warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input: module } });
    } else if (source.source === 'DRAFT') {
      warnings.push({ code: 'USED_DRAFT_INPUTS', params: { input: source.documentTypeCode } });
    }
  }

  const parts: ContextPart[] = [
    {
      ref: {
        kind: 'SECTION',
        id: sectionKey,
        documentTypeCode: document.documentTypeCode,
        revision: document.revision,
      },
      label: 'Texto atual da seção',
      data: { secao: sectionKey, titulo: definition.title, texto: document.text },
    },
    {
      ref:
        document.template === null
          ? { kind: 'TEMPLATE_VERSION', id: null }
          : {
              kind: 'TEMPLATE_VERSION',
              id: document.template.versionId,
              versionNumber: document.template.versionNumber,
            },
      label: 'Guia de redação da seção no modelo do órgão',
      data: compact({
        secao: definition.key,
        titulo: definition.title,
        obrigatoria: definition.requirement === 'OPTIONAL' ? 'Não' : 'Sim',
        orientacao: definition.helpText,
        baseLegal: definition.legalBasis,
        textoPadrao: definition.defaultText,
      }),
    },
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
        tipoDeContratacao: process.contractingType,
        modalidade: process.modality,
      }),
    },
  ];
  const others = document.otherSections.filter((section) => !VALUE_SECTIONS.has(section.key));
  if (others.length > 0) {
    parts.push({
      ref: {
        kind: 'DOCUMENT_DRAFT',
        id: document.documentId,
        documentTypeCode: document.documentTypeCode,
        revision: document.draftRevision,
      },
      label: 'Demais seções do documento',
      data: others.map((section) => ({
        secao: section.key,
        titulo: section.title,
        texto: section.text,
      })),
      optional: true,
    });
  }
  for (const { module, document: source } of chain) {
    if (source !== null) parts.push(chainPart(source, CHAIN_LABELS[module]));
  }
  if (organization !== null) {
    parts.push({
      ref: { kind: 'ORGANIZATION', id: organization.id },
      label: 'Órgão',
      data: compact({
        nome: organization.name,
        municipio: organization.city,
        uf: organization.state,
      }),
    });
  }

  return {
    parts,
    sections: [
      {
        sectionKey,
        title: definition.title,
        maxChars: definition.maxChars,
        legalBasis: definition.legalBasis,
      },
    ],
    isBudgetConfidential: process.isBudgetConfidential,
    warnings,
  };
}
