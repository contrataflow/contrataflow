import { PRIORITY_LABELS, RISK_PHASE_LABELS } from '@contrataflow/validation';
import type {
  AiGenerationOutput,
  AiOutputWarning,
  AwardType,
  DayCountType,
  EtpEstimatedValueSource,
  PcaStatus,
  PriceCalculationMethod,
  PriceDefaultMethod,
  Priority,
  RiskPhase,
  SectionRequirement,
  TermEstimatedValueSource,
  ToConfirmCategory,
} from '@contrataflow/validation';

import type { ContextPart } from './context-sanitizer.js';
import { PCA_STATUS_LABELS, formatCurrency, formatQuantity } from './dfd-draft-context.js';
import {
  EtpDecisionGuard,
  VALUE_PENDING,
  etpDraftSections,
  withoutMoney,
} from './etp-draft-context.js';
import type { EtpPendingMark, EtpTemplateSection } from './etp-draft-context.js';
import { DEFAULT_SECTION_MAX_CHARS } from './output-converter.js';
import type { SectionSpec } from './output-converter.js';
import type { AiOutputPostProcessor, PostProcessingInput } from './post-processing.js';

/*
 * Rascunho do TR com IA (US-120 · RN-AI-43..46): a montagem do contexto (`TermDraftContext`) e a
 * guarda das condições (`TermConditionGuard`). Puro: as fontes chegam já lidas pelas fachadas de
 * leitura (D9). O ETP entra pela precedência aprovada → finalizada → rascunho (RN-AI-33, com
 * `USED_DRAFT_INPUTS`); DFD e riscos são opcionais (`MISSING_OPTIONAL_INPUT`). Prazos, vigência,
 * pagamento, garantias e local de entrega vêm SÓ dos campos tipados do TR (RN-AI-44): ausentes, a
 * guarda garante o `[a confirmar: …]` na seção que os cita. Percentual ou valor de multa que não
 * esteja nas entradas vira `[a confirmar]` pelo GroundingGuard (RN-AI-45). O valor estimado só vem
 * da pesquisa de preços concluída, do vínculo do TR com ela ou do valor importado de um ETP
 * vinculado a ela — nunca manual (RN-AI-46, lacuna 3); com orçamento sigiloso, nenhum valor entra,
 * nem em texto livre (DEC-030). Cada parte vira um `inputRef`; o mesmo conjunto de fatos enviado
 * ao provedor alimenta o GroundingGuard.
 */

// --- Seções -----------------------------------------------------------------------------------------

const LEI = 'Lei 14.133/2021';
const TR_BASE = `${LEI}, art. 6º, XXIII`;

const defaultSection = (
  key: string,
  title: string,
  legalBasis: string,
  options: { requirement?: SectionRequirement; render?: EtpTemplateSection['render'] } = {},
): EtpTemplateSection => ({
  key,
  title,
  requirement: options.requirement ?? 'REQUIRED',
  helpText: null,
  legalBasis,
  defaultText: null,
  maxChars: DEFAULT_SECTION_MAX_CHARS,
  render: options.render ?? 'TEXT',
  allowNarrative: true,
});

/** Seções do TR semeado (US-036) — só quando o documento não tem template fixado. */
export const TERM_DEFAULT_SECTIONS: readonly EtpTemplateSection[] = [
  defaultSection('OBJECT', 'Definição do objeto', `${TR_BASE}, a`),
  defaultSection('JUSTIFICATION', 'Fundamentação da contratação', `${TR_BASE}, b`),
  defaultSection('SPECIFICATIONS', 'Descrição da solução e especificações', `${TR_BASE}, c`, {
    render: 'ITEMS_TABLE',
  }),
  defaultSection('ACCEPTANCE_CRITERIA', 'Critérios de recebimento', `${TR_BASE}, g`),
  defaultSection('CONTRACTOR_OBLIGATIONS', 'Obrigações da contratada', `${TR_BASE}, e`),
  defaultSection('CONTRACTING_PARTY_OBLIGATIONS', 'Obrigações da contratante', `${TR_BASE}, e`),
  defaultSection('DEADLINES', 'Prazos de execução', `${TR_BASE}, a`),
  defaultSection('DELIVERY', 'Modelo de execução e entrega', `${TR_BASE}, e`, {
    requirement: 'REQUIRED_OR_JUSTIFY',
  }),
  defaultSection('PAYMENT', 'Critérios de pagamento', `${TR_BASE}, g`),
  defaultSection('OVERSIGHT', 'Gestão e fiscalização do contrato', `${TR_BASE}, f`),
  defaultSection('GUARANTEES', 'Garantias', `${LEI}, arts. 96 a 102`, {
    requirement: 'REQUIRED_OR_JUSTIFY',
  }),
  defaultSection('SANCTIONS', 'Sanções administrativas', `${LEI}, arts. 155 a 163`),
  defaultSection(
    'SELECTION_CRITERIA',
    'Forma e critérios de seleção do fornecedor',
    `${TR_BASE}, h`,
  ),
  defaultSection('ESTIMATED_VALUE', 'Estimativa do valor da contratação', `${TR_BASE}, i`, {
    render: 'ESTIMATED_VALUE',
  }),
  defaultSection('BUDGET_ADEQUACY', 'Adequação orçamentária', `${TR_BASE}, j`, {
    requirement: 'REQUIRED_OR_JUSTIFY',
  }),
];

// --- Fontes -----------------------------------------------------------------------------------------

/** Documento da cadeia como entrada (`AiChainSource` da fachada do `document`). */
export interface TermDraftChainSource {
  readonly documentId: string;
  readonly documentTypeCode: string;
  readonly source: 'APPROVED_VERSION' | 'VERSION' | 'DRAFT';
  readonly versionNumber: number | null;
  readonly draftRevision: number | null;
  readonly sections: readonly { readonly key: string; readonly text: string }[];
}

/** As condições contratuais tipadas do TR (US-038), com os rótulos já resolvidos. */
export interface TermDraftConditions {
  readonly contractDurationMonths: number | null;
  readonly executionDeadline: number | null;
  readonly executionDeadlineType: DayCountType | null;
  readonly deliveryLocation: string | null;
  readonly paymentTermDays: number | null;
  readonly productWarrantyMonths: number | null;
  /** Decimal(9,4) como string. */
  readonly contractGuaranteePercent: string | null;
  readonly allowsSubcontracting: boolean | null;
  /** Rótulo do critério de julgamento (catálogo); `null` = não informado. */
  readonly selectionCriterion: string | null;
  readonly awardType: AwardType | null;
}

export interface TermDraftSources {
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
    readonly pcaStatus: PcaStatus;
    readonly pcaYear: number | null;
    readonly pcaItemCode: string | null;
    readonly requestingSecretariat: string | null;
    readonly requestingDepartment: string | null;
    readonly isBudgetConfidential: boolean;
  };
  /** O ETP (obrigatório — RN-AI-43) e o seu valor estimado, para o vínculo da RN-AI-46. */
  readonly etp: TermDraftChainSource & {
    readonly estimatedTotalValue: string | null;
    readonly estimatedValueSource: EtpEstimatedValueSource | null;
  };
  /** `null` = processo sem DFD não cancelado (`MISSING_OPTIONAL_INPUT`). */
  readonly dfd: TermDraftChainSource | null;
  /** Riscos e tratamentos do processo — sem responsáveis, prazos nem pessoas. */
  readonly risks: readonly {
    readonly title: string;
    readonly description: string | null;
    readonly category: string | null;
    readonly phase: RiskPhase;
    readonly treatments: readonly string[];
  }[];
  readonly term: {
    readonly documentId: string;
    readonly documentTypeCode: string;
    readonly draftRevision: number;
    readonly conditions: TermDraftConditions;
    /** Decimal(18,2) como string. */
    readonly estimatedTotalValue: string | null;
    readonly estimatedValueSource: TermEstimatedValueSource | null;
  };
  /** Itens do TR com a especificação e os critérios de aceitação (texto puro). */
  readonly items: readonly {
    readonly processItemId: string;
    readonly description: string;
    readonly unit: string | null;
    readonly quantity: string;
    readonly specification: string | null;
    readonly acceptanceCriteria: string | null;
  }[];
  /** Pesquisa de preços CONCLUÍDA; `null` = sem pesquisa concluída (`MISSING_PRICE_RESEARCH`). */
  readonly priceResearch: {
    readonly id: string;
    readonly code: string | null;
    readonly totalEstimatedValue: string;
    readonly defaultMethod: PriceDefaultMethod;
    readonly items: readonly {
      readonly processItemId: string;
      readonly quantity: string;
      readonly method: PriceCalculationMethod | null;
      readonly validQuotationsCount: number;
      readonly unitPrice: string | null;
      readonly totalPrice: string | null;
    }[];
  } | null;
  /** `null` = documento sem template fixado (seções padrão do TR, sem inputRef de template). */
  readonly template: {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly sections: readonly EtpTemplateSection[];
  } | null;
}

export interface TermDraftContext {
  readonly parts: ContextPart[];
  readonly sections: SectionSpec[];
  readonly isBudgetConfidential: boolean;
  readonly warnings: AiOutputWarning[];
  /** `TermConditionGuard` (RN-AI-44/46), antes do GroundingGuard. */
  readonly postProcessors: AiOutputPostProcessor[];
}

// --- Rótulos ----------------------------------------------------------------------------------------

const DAY_COUNT_LABELS: Readonly<Record<DayCountType, string>> = {
  BUSINESS: 'úteis',
  CALENDAR: 'corridos',
};

const AWARD_TYPE_LABELS: Readonly<Record<AwardType, string>> = {
  BY_ITEM: 'Por item',
  BY_LOT: 'Por lote',
  GLOBAL: 'Global',
};

const METHOD_LABELS: Readonly<Record<PriceCalculationMethod | PriceDefaultMethod, string>> = {
  AUTO_CV: 'Média ou mediana conforme o coeficiente de variação',
  MEAN: 'Média',
  MEDIAN: 'Mediana',
  LOWEST: 'Menor preço',
  MANUAL: 'Valor definido com justificativa',
};

/** Tratamento da seção no guia (RN-AI-37 da US-118). */
const COMPLEMENT = 'Texto complementar (a tabela e os valores vêm dos dados estruturados)';

const plural = (value: number, one: string, many: string) =>
  `${String(value)} ${value === 1 ? one : many}`;

/** `"5.5"` → `"5,5%"` (o `numeric(9,4)` já normalizado). */
function formatPercent(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  const digits = fraction.replace(/0+$/, '');
  return `${integer}${digits === '' ? '' : `,${digits}`}%`;
}

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
}

// --- Condições e marcações pendentes (RN-AI-44/46) -----------------------------------------------------

export const DURATION_PENDING = 'vigência do contrato';
export const EXECUTION_PENDING = 'prazo de execução ou entrega';
export const PAYMENT_PENDING = 'prazo de pagamento';
export const WARRANTY_PENDING = 'garantia do objeto';
export const GUARANTEE_PENDING = 'garantia contratual';
export const LOCATION_PENDING = 'local de entrega';
export const SUBCONTRACTING_PENDING = 'possibilidade de subcontratação';
export const CRITERION_PENDING = 'critério de julgamento';
export const AWARD_PENDING = 'forma de adjudicação';
export const BUDGET_PENDING = 'dotação orçamentária';
export { VALUE_PENDING };

const mark = (sectionKey: string, label: string, category: ToConfirmCategory): EtpPendingMark => ({
  sectionKey,
  label,
  category,
});

/**
 * RN-AI-44 (tabela "Condições tipadas e onde aparecem"): as marcações que a proposta precisa
 * trazer pelas condições ausentes; RN-AI-46: a do valor estimado sem valor da pesquisa (ou com
 * sigilo); lacuna 4: a dotação orçamentária, que o MVP 1 não registra.
 */
export function termPendingMarks(input: {
  readonly conditions: TermDraftConditions;
  readonly hasGroundedValue: boolean;
}): EtpPendingMark[] {
  const { conditions } = input;
  const marks: EtpPendingMark[] = [];
  if (conditions.contractDurationMonths === null) {
    marks.push(
      mark('OBJECT', DURATION_PENDING, 'DEADLINE'),
      mark('DEADLINES', DURATION_PENDING, 'DEADLINE'),
    );
  }
  if (conditions.executionDeadline === null) {
    marks.push(
      mark('DEADLINES', EXECUTION_PENDING, 'DEADLINE'),
      mark('DELIVERY', EXECUTION_PENDING, 'DEADLINE'),
    );
  }
  if (conditions.paymentTermDays === null) {
    marks.push(mark('PAYMENT', PAYMENT_PENDING, 'DEADLINE'));
  }
  if (conditions.productWarrantyMonths === null) {
    marks.push(mark('GUARANTEES', WARRANTY_PENDING, 'DEADLINE'));
  }
  if (conditions.contractGuaranteePercent === null) {
    marks.push(mark('GUARANTEES', GUARANTEE_PENDING, 'VALUE'));
  }
  if (conditions.deliveryLocation === null) {
    marks.push(mark('DELIVERY', LOCATION_PENDING, 'DATA'));
  }
  if (conditions.allowsSubcontracting === null) {
    marks.push(mark('CONTRACTOR_OBLIGATIONS', SUBCONTRACTING_PENDING, 'DECISION'));
  }
  if (conditions.selectionCriterion === null) {
    marks.push(mark('SELECTION_CRITERIA', CRITERION_PENDING, 'DECISION'));
  }
  if (conditions.awardType === null) {
    marks.push(mark('SELECTION_CRITERIA', AWARD_PENDING, 'DECISION'));
  }
  if (!input.hasGroundedValue) marks.push(mark('ESTIMATED_VALUE', VALUE_PENDING, 'VALUE'));
  marks.push(mark('BUDGET_ADEQUACY', BUDGET_PENDING, 'DATA'));
  return marks;
}

/**
 * `TermConditionGuard` (RN-AI-44/46): com a condição tipada ausente, a seção da proposta que a cita
 * PRECISA trazer o `[a confirmar]` correspondente; faltando, ele é acrescentado ao fim da seção
 * (mesma mecânica determinística e idempotente da guarda das decisões do ETP). Nunca escreve no TR.
 */
export class TermConditionGuard implements AiOutputPostProcessor {
  readonly name = 'term-condition-guard';
  private readonly guard: EtpDecisionGuard;

  constructor(marks: readonly EtpPendingMark[]) {
    this.guard = new EtpDecisionGuard(marks);
  }

  process(input: PostProcessingInput): AiGenerationOutput {
    return this.guard.process(input);
  }
}

/** As condições como texto do contexto ("12 meses", "30 dias", "5%") — fatos para o GroundingGuard. */
function conditionsData(
  conditions: TermDraftConditions,
  text: (value: string) => string,
): Record<string, unknown> {
  const missing = termPendingMarks({ conditions, hasGroundedValue: true })
    .filter((entry) => entry.sectionKey !== 'BUDGET_ADEQUACY')
    .map((entry) => entry.label);
  return compact({
    vigenciaDoContrato:
      conditions.contractDurationMonths === null
        ? null
        : plural(conditions.contractDurationMonths, 'mês', 'meses'),
    prazoDeExecucaoOuEntrega:
      conditions.executionDeadline === null
        ? null
        : `${plural(conditions.executionDeadline, 'dia', 'dias')}${
            conditions.executionDeadlineType === null
              ? ''
              : ` ${DAY_COUNT_LABELS[conditions.executionDeadlineType]}`
          }`,
    prazoDePagamento:
      conditions.paymentTermDays === null
        ? null
        : plural(conditions.paymentTermDays, 'dia', 'dias'),
    garantiaDoObjeto:
      conditions.productWarrantyMonths === null
        ? null
        : conditions.productWarrantyMonths === 0
          ? 'Sem garantia do objeto além da legal'
          : plural(conditions.productWarrantyMonths, 'mês', 'meses'),
    garantiaContratual:
      conditions.contractGuaranteePercent === null
        ? null
        : `${formatPercent(conditions.contractGuaranteePercent)} do valor do contrato`,
    localDeEntrega: conditions.deliveryLocation === null ? null : text(conditions.deliveryLocation),
    subcontratacao:
      conditions.allowsSubcontracting === null
        ? null
        : conditions.allowsSubcontracting
          ? 'Permitida'
          : 'Não permitida',
    criterioDeJulgamento: conditions.selectionCriterion,
    formaDeAdjudicacao:
      conditions.awardType === null ? null : AWARD_TYPE_LABELS[conditions.awardType],
    naoInformadas: [...new Set(missing)].map((label) => `[a confirmar: ${label}]`),
  });
}

// --- Contexto ---------------------------------------------------------------------------------------

const chainRef = (source: TermDraftChainSource): ContextPart['ref'] =>
  source.source === 'DRAFT'
    ? {
        kind: 'DOCUMENT_DRAFT',
        id: source.documentId,
        documentTypeCode: source.documentTypeCode,
        revision: source.draftRevision ?? 0,
      }
    : {
        kind: 'DOCUMENT_VERSION',
        id: source.documentId,
        documentTypeCode: source.documentTypeCode,
        versionNumber: source.versionNumber ?? 1,
      };

export function assembleTermDraftContext(sources: TermDraftSources): TermDraftContext {
  const { process, etp, dfd, risks, term, items, priceResearch, template } = sources;
  const confidential = process.isBudgetConfidential;
  const text = (value: string) => (confidential ? withoutMoney(value) : value);
  const textOrNull = (value: string | null) => (value === null ? null : text(value));
  const money = (value: string | null) =>
    confidential || value === null ? null : formatCurrency(value);

  const warnings: AiOutputWarning[] = [];
  if (etp.source === 'DRAFT') {
    warnings.push({ code: 'USED_DRAFT_INPUTS', params: { input: etp.documentTypeCode } });
  }
  if (dfd === null) {
    warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input: 'DFD' } });
  } else if (dfd.source === 'DRAFT') {
    warnings.push({ code: 'USED_DRAFT_INPUTS', params: { input: dfd.documentTypeCode } });
  }
  if (risks.length === 0) {
    warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input: 'RISKS' } });
  }
  if (items.length === 0) {
    warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input: 'TERM_ITEMS' } });
  }
  if (priceResearch === null) warnings.push({ code: 'MISSING_PRICE_RESEARCH' });
  if (confidential) warnings.push({ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' });

  // RN-AI-46 (lacuna 3): o total da pesquisa concluída; senão o valor do TR vinculado à pesquisa
  // ou importado de um ETP vinculado a ela — nunca o manual.
  const linkedValue =
    term.estimatedValueSource === 'PRICE_RESEARCH' ||
    (term.estimatedValueSource === 'ETP' && etp.estimatedValueSource === 'PRICE_RESEARCH')
      ? term.estimatedTotalValue
      : null;
  const groundedValue = priceResearch?.totalEstimatedValue ?? linkedValue;

  const parts: ContextPart[] = [
    {
      ref: { kind: 'PROCESS', id: process.id },
      label: 'Processo',
      data: compact({
        codigo: process.code,
        titulo: process.title,
        objeto: text(process.object),
        descricao: textOrNull(process.description),
        prioridade: PRIORITY_LABELS[process.priority],
        registroDePrecos: process.isPriceRegistration ? 'Sim' : 'Não',
        secretariaRequisitante: process.requestingSecretariat,
        unidadeRequisitante: process.requestingDepartment,
        situacaoNoPca: PCA_STATUS_LABELS[process.pcaStatus],
        anoDoPca: process.pcaYear === null ? null : String(process.pcaYear),
        itemDoPca: process.pcaItemCode,
      }),
    },
    {
      ref: { kind: 'CATALOG', id: null },
      label: 'Classificação da contratação',
      data: compact({ tipoDeContratacao: process.contractingType, modalidade: process.modality }),
    },
    {
      ref: chainRef(etp),
      label: etp.source === 'DRAFT' ? 'ETP (rascunho atual)' : 'ETP',
      data: {
        secoes: etp.sections.map((section) => ({ secao: section.key, texto: text(section.text) })),
      },
    },
    {
      ref: { kind: 'TERM_CONDITIONS', id: term.documentId },
      label: 'Condições contratuais do TR (a IA não as altera)',
      data: compact({
        ...conditionsData(term.conditions, text),
        valorEstimadoVinculado: priceResearch === null ? money(linkedValue) : null,
      }),
    },
    {
      ref: { kind: 'PROCESS_ITEMS', id: term.documentId },
      label: 'Itens do TR',
      data: items.map((item) =>
        compact({
          descricao: item.description,
          unidade: item.unit,
          quantidade: formatQuantity(item.quantity),
          especificacao: textOrNull(item.specification),
          criteriosDeAceitacao: textOrNull(item.acceptanceCriteria),
        }),
      ),
      // Muitos itens: o contexto pode cortá-los (CONTEXT_TRUNCATED) antes de falhar (FA-05).
      optional: true,
    },
  ];
  if (dfd !== null) {
    parts.push({
      ref: chainRef(dfd),
      label: dfd.source === 'DRAFT' ? 'DFD (rascunho atual)' : 'DFD',
      data: {
        secoes: dfd.sections.map((section) => ({ secao: section.key, texto: text(section.text) })),
      },
      optional: true,
    });
  }
  if (risks.length > 0) {
    parts.push({
      ref: { kind: 'RISKS', id: process.id },
      label: 'Riscos e tratamentos do processo',
      data: risks.map((risk) =>
        compact({
          titulo: text(risk.title),
          descricao: textOrNull(risk.description),
          categoria: risk.category,
          fase: RISK_PHASE_LABELS[risk.phase],
          tratamentos: risk.treatments.length === 0 ? null : risk.treatments.map(text),
        }),
      ),
      optional: true,
    });
  }
  if (priceResearch !== null) {
    const descriptions = new Map(items.map((item) => [item.processItemId, item]));
    parts.push({
      ref: { kind: 'PRICE_RESEARCH', id: priceResearch.id },
      label: 'Pesquisa de preços concluída',
      data: compact({
        codigo: priceResearch.code,
        metodoPadrao: METHOD_LABELS[priceResearch.defaultMethod],
        valorEstimadoTotal: money(priceResearch.totalEstimatedValue),
        itens: priceResearch.items.map((item) =>
          compact({
            descricao: descriptions.get(item.processItemId)?.description ?? null,
            unidade: descriptions.get(item.processItemId)?.unit ?? null,
            quantidade: formatQuantity(item.quantity),
            metodo: item.method === null ? null : METHOD_LABELS[item.method],
            cotacoesValidas: String(item.validQuotationsCount),
            valorUnitario: money(item.unitPrice),
            valorTotal: money(item.totalPrice),
          }),
        ),
      }),
    });
  }

  const definitions = template?.sections ?? TERM_DEFAULT_SECTIONS;
  const sections = etpDraftSections(definitions);
  const covered = new Set(sections.map((section) => section.sectionKey));
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
    data: definitions
      .filter((section) => covered.has(section.key))
      .map((section) =>
        compact({
          secao: section.key,
          titulo: section.title,
          obrigatoria: section.requirement === 'OPTIONAL' ? 'Não' : 'Sim',
          tratamento: section.render === 'TEXT' ? null : COMPLEMENT,
          orientacao: section.helpText,
          baseLegal: section.legalBasis,
          textoPadrao: section.defaultText,
        }),
      ),
  });

  const marks = termPendingMarks({
    conditions: term.conditions,
    hasGroundedValue: !confidential && groundedValue !== null,
  });
  return {
    parts,
    sections,
    isBudgetConfidential: confidential,
    warnings,
    postProcessors: [new TermConditionGuard(marks)],
  };
}
