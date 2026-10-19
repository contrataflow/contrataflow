import {
  AI_NEED_SUMMARY_MAX,
  AI_NEED_SUMMARY_MIN,
  PRIORITY_LABELS,
} from '@contrataflow/validation';
import type {
  AiOutputWarning,
  OrganizationType,
  PcaStatus,
  Priority,
  SectionRequirement,
} from '@contrataflow/validation';

import type { ContextPart } from './context-sanitizer.js';
import { DEFAULT_SECTION_MAX_CHARS } from './output-converter.js';
import type { SectionSpec } from './output-converter.js';

/*
 * Rascunho do DFD com IA (US-117 · RN-AI-25..27): a política do pedido (`DfdDraftRequestPolicy`) e
 * a montagem do contexto (`DfdDraftContextAssembler`). Puro: as fontes chegam já lidas pelas
 * fachadas de leitura (D9). Cada parte vira um `inputRef` (RN-AI-26); pessoas ficam de fora (só
 * unidades — RN-AI-05) e, com orçamento sigiloso, nenhum valor entra (DEC-030). O que faltar entre
 * os insumos opcionais (itens, data prevista, vínculo do PCA) gera `MISSING_OPTIONAL_INPUT` e sai
 * como "[a confirmar]" no texto (FA-07).
 */

// --- Política do pedido (AI-01) --------------------------------------------------------------------

export type DfdDraftRequestProblem =
  'NEED_SUMMARY_REQUIRED' | 'NEED_SUMMARY_LENGTH' | 'DOCUMENT_REQUIRED';

/** RN-AI-25: resumo de 20 a 2.000 caracteres e o DFD já criado (o status é do `document`). */
export function dfdDraftRequestProblem(request: {
  readonly needSummary: string | null;
  readonly documentId: string | null;
}): DfdDraftRequestProblem | null {
  if (request.documentId === null) return 'DOCUMENT_REQUIRED';
  if (request.needSummary === null) return 'NEED_SUMMARY_REQUIRED';
  const length = request.needSummary.trim().length;
  if (length < AI_NEED_SUMMARY_MIN || length > AI_NEED_SUMMARY_MAX) return 'NEED_SUMMARY_LENGTH';
  return null;
}

// --- Seções -----------------------------------------------------------------------------------------

export interface DfdTemplateSection {
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  readonly helpText: string | null;
  readonly legalBasis: string | null;
  readonly defaultText: string | null;
  readonly maxChars: number;
  readonly allowNarrative: boolean;
}

/** Seções do DFD semeado (RN-DFD-07) — só quando o documento não tem template fixado. */
export const DFD_DEFAULT_SECTIONS: readonly DfdTemplateSection[] = [
  {
    key: 'JUSTIFICATION',
    title: 'Justificativa da necessidade',
    requirement: 'REQUIRED',
    helpText: null,
    legalBasis: 'Lei 14.133/2021, art. 12, VII; Decreto 10.947/2022, art. 8º, I',
    defaultText: null,
    maxChars: DEFAULT_SECTION_MAX_CHARS,
    allowNarrative: true,
  },
  {
    key: 'EXPECTED_RESULTS',
    title: 'Resultados esperados',
    requirement: 'REQUIRED',
    helpText: null,
    legalBasis: null,
    defaultText: null,
    maxChars: DEFAULT_SECTION_MAX_CHARS,
    allowNarrative: true,
  },
  {
    key: 'NOTES',
    title: 'Observações',
    requirement: 'OPTIONAL',
    helpText: null,
    legalBasis: null,
    defaultText: null,
    maxChars: DEFAULT_SECTION_MAX_CHARS,
    allowNarrative: true,
  },
];

/** RN-AI-25: as seções narrativas da versão de template fixada (as computadas ficam de fora). */
export function dfdDraftSections(sections: readonly DfdTemplateSection[]): SectionSpec[] {
  return sections
    .filter((section) => section.allowNarrative)
    .map((section) => ({
      sectionKey: section.key,
      title: section.title,
      maxChars: section.maxChars,
      legalBasis: section.legalBasis,
      ...(section.requirement === 'OPTIONAL' ? { optional: true } : {}),
    }));
}

// --- Contexto ---------------------------------------------------------------------------------------

export interface DfdDraftSources {
  readonly process: {
    readonly id: string;
    readonly code: string | null;
    readonly title: string;
    readonly object: string;
    readonly description: string | null;
    readonly contractingType: string | null;
    readonly modality: string | null;
    readonly origin: string | null;
    readonly isPriceRegistration: boolean;
    readonly priority: Priority;
    readonly requestingSecretariat: string | null;
    readonly requestingDepartment: string | null;
    readonly targetDate: string | null;
    readonly estimatedValue: string | null;
    readonly isBudgetConfidential: boolean;
  };
  readonly items: readonly {
    readonly description: string;
    readonly unit: string | null;
    readonly quantity: string;
  }[];
  readonly dfd: {
    readonly documentId: string;
    readonly documentTypeCode: string;
    readonly draftRevision: number;
    readonly objectSummary: string;
    readonly priority: Priority;
    readonly requestDate: string;
    readonly expectedDate: string | null;
    readonly estimatedValue: string | null;
    readonly pcaStatus: PcaStatus;
    readonly pcaYear: number | null;
    readonly pcaItemCode: string | null;
  };
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly city: string | null;
    readonly state: string | null;
  } | null;
  /** `null` = documento sem template fixado (seções padrão do DFD, sem inputRef de template). */
  readonly template: {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly sections: readonly DfdTemplateSection[];
  } | null;
}

export interface DfdDraftContext {
  readonly parts: ContextPart[];
  readonly sections: SectionSpec[];
  readonly isBudgetConfidential: boolean;
  readonly warnings: AiOutputWarning[];
}

export const PCA_STATUS_LABELS: Readonly<Record<PcaStatus, string>> = {
  PLANNED: 'Prevista no Plano de Contratações Anual',
  NOT_PLANNED: 'Não prevista no Plano de Contratações Anual',
  NOT_APPLICABLE: 'Não se aplica',
};

const ORGANIZATION_TYPE_LABELS: Readonly<Record<OrganizationType, string>> = {
  DIRECT_ADMINISTRATION: 'Administração direta',
  FUND: 'Fundo',
  AUTARCHY: 'Autarquia',
  FOUNDATION: 'Fundação',
  PUBLIC_COMPANY: 'Empresa pública',
  MIXED_CAPITAL_COMPANY: 'Sociedade de economia mista',
  PUBLIC_CONSORTIUM: 'Consórcio público',
  LEGISLATIVE: 'Poder Legislativo',
  OTHER: 'Outro',
};

/** Rótulo do tipo do órgão (desconhecido = o próprio código). */
function organizationTypeLabel(type: string): string {
  return (ORGANIZATION_TYPE_LABELS as Readonly<Record<string, string>>)[type] ?? type;
}

/** Decimal(18,4) sem zeros à direita (`"120.0000"` → `"120"`, `"2.5000"` → `"2,5"`). */
export function formatQuantity(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? integer : `${integer},${trimmed}`;
}

/** Decimal(18,2) em reais pt-BR (`"15000.00"` → `"R$ 15.000,00"`). */
export function formatCurrency(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${grouped},${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/** `AAAA-MM-DD` → `DD/MM/AAAA`. */
function formatDate(value: string | null): string | null {
  if (value === null) return null;
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
}

export function assembleDfdDraftContext(sources: DfdDraftSources): DfdDraftContext {
  const { process, dfd, items, organization, template } = sources;
  const confidential = process.isBudgetConfidential;
  const warnings: AiOutputWarning[] = [];
  const missing = (input: string) =>
    warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input } });
  if (items.length === 0) missing('ITEMS');
  if (dfd.expectedDate === null) missing('EXPECTED_DATE');
  if (dfd.pcaStatus === 'PLANNED' && (dfd.pcaYear === null || dfd.pcaItemCode === null)) {
    missing('PCA_LINK');
  }
  if (confidential) warnings.push({ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' });

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
        secretariaRequisitante: process.requestingSecretariat,
        unidadeRequisitante: process.requestingDepartment,
        dataAlvo: formatDate(process.targetDate),
        valorEstimado:
          confidential || process.estimatedValue === null
            ? null
            : formatCurrency(process.estimatedValue),
      }),
    },
    {
      ref: { kind: 'CATALOG', id: null },
      label: 'Classificação da contratação',
      data: compact({
        tipoDeContratacao: process.contractingType,
        modalidade: process.modality,
        origemDaDemanda: process.origin,
      }),
    },
    {
      ref: {
        kind: 'DOCUMENT_DRAFT',
        id: dfd.documentId,
        documentTypeCode: dfd.documentTypeCode,
        revision: dfd.draftRevision,
      },
      label: 'Cabeçalho do DFD',
      data: compact({
        resumoDoObjeto: dfd.objectSummary,
        prioridade: PRIORITY_LABELS[dfd.priority],
        dataDaSolicitacao: formatDate(dfd.requestDate),
        dataPrevistaDaContratacao: formatDate(dfd.expectedDate),
        situacaoNoPca: PCA_STATUS_LABELS[dfd.pcaStatus],
        anoDoPca: dfd.pcaYear === null ? null : String(dfd.pcaYear),
        itemDoPca: dfd.pcaItemCode,
        valorEstimado:
          confidential || dfd.estimatedValue === null ? null : formatCurrency(dfd.estimatedValue),
      }),
    },
    {
      ref: { kind: 'PROCESS_ITEMS', id: process.id },
      label: 'Itens do DFD',
      data: items.map((item) =>
        compact({
          descricao: item.description,
          unidade: item.unit,
          quantidade: formatQuantity(item.quantity),
        }),
      ),
      // Muitos itens: o contexto pode cortá-los (CONTEXT_TRUNCATED) antes de falhar (FA-07).
      optional: true,
    },
  ];
  if (organization !== null) {
    parts.push({
      ref: { kind: 'ORGANIZATION', id: organization.id },
      label: 'Órgão',
      data: compact({
        nome: organization.name,
        tipo: organizationTypeLabel(organization.type),
        municipio: organization.city,
        uf: organization.state,
      }),
    });
  }
  const sectionDefinitions = template?.sections ?? DFD_DEFAULT_SECTIONS;
  const sections = dfdDraftSections(sectionDefinitions);
  const narrative = new Set(sections.map((section) => section.sectionKey));
  const guide = sectionDefinitions
    .filter((section) => narrative.has(section.key))
    .map((section) =>
      compact({
        secao: section.key,
        titulo: section.title,
        obrigatoria: section.requirement === 'OPTIONAL' ? 'Não' : 'Sim',
        orientacao: section.helpText,
        baseLegal: section.legalBasis,
        textoPadrao: section.defaultText,
      }),
    );
  parts.push({
    ref:
      template === null
        ? { kind: 'TEMPLATE_VERSION', id: null }
        : {
            kind: 'TEMPLATE_VERSION',
            id: template.versionId,
            versionNumber: template.versionNumber,
          },
    label: 'Guia de redação do modelo do órgão',
    data: guide,
  });
  return { parts, sections, isBudgetConfidential: confidential, warnings };
}
