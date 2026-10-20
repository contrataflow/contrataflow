import { ALTERNATIVE_DECISION_LABELS, PRIORITY_LABELS } from '@contrataflow/validation';
import type {
  AiGenerationOutput,
  AiOutputWarning,
  AlternativeDecision,
  EtpConclusion,
  EtpEstimatedValueSource,
  ParcelingDecision,
  PcaStatus,
  PriceCalculationMethod,
  PriceDefaultMethod,
  Priority,
  RichTextNode,
  SectionRender,
  SectionRequirement,
  ToConfirmCategory,
} from '@contrataflow/validation';

import type { ContextPart } from './context-sanitizer.js';
import { PCA_STATUS_LABELS, formatCurrency, formatQuantity } from './dfd-draft-context.js';
import { findFacts } from './fact-set.js';
import { DEFAULT_SECTION_MAX_CHARS, toConfirmNode } from './output-converter.js';
import type { SectionSpec } from './output-converter.js';
import type { AiOutputPostProcessor } from './post-processing.js';

/*
 * Rascunho do ETP com IA (US-118 · RN-AI-33..37): a montagem do contexto (`EtpDraftContext`) e a
 * guarda das decisões (`EtpDecisionGuard`). Puro: as fontes chegam já lidas pelas fachadas de
 * leitura (D9). O DFD entra pela precedência aprovada → finalizada → rascunho (`DfdSourceResolver`
 * na fachada do `document`, com `USED_DRAFT_INPUTS`); cada parte vira um `inputRef` (RN-AI-34).
 * O valor estimado só vem da pesquisa de preços concluída (ou do valor do ETP vinculado a ela) —
 * nunca do custo de alternativa nem de valor manual (RN-AI-36); com orçamento sigiloso, nenhum
 * valor entra, nem em texto livre (DEC-030). As seções de renderização estruturada só recebem
 * texto complementar e, sem narrativa, ficam fora da proposta (RN-AI-37). O mesmo conjunto de fatos
 * enviado ao provedor alimenta o GroundingGuard ("Impacto técnico").
 */

// --- Seções -----------------------------------------------------------------------------------------

export interface EtpTemplateSection {
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

const ETP_BASE = 'Lei 14.133/2021, art. 18, §1º';

const defaultSection = (
  key: string,
  title: string,
  legalBasis: string | null,
  requirement: SectionRequirement = 'REQUIRED_OR_JUSTIFY',
): EtpTemplateSection => ({
  key,
  title,
  requirement,
  helpText: null,
  legalBasis,
  defaultText: null,
  maxChars: DEFAULT_SECTION_MAX_CHARS,
  render: 'TEXT',
  allowNarrative: true,
});

/** Seções do ETP semeado — só quando o documento não tem template fixado. */
export const ETP_DEFAULT_SECTIONS: readonly EtpTemplateSection[] = [
  defaultSection('NEED_DESCRIPTION', 'Descrição da necessidade', `${ETP_BASE}, I`, 'REQUIRED'),
  defaultSection('PROBLEM', 'Problema a ser resolvido', `${ETP_BASE}, I`, 'OPTIONAL'),
  defaultSection('OBJECTIVE', 'Objetivo da contratação', null, 'OPTIONAL'),
  defaultSection('PCA_ALIGNMENT', 'Alinhamento ao plano de contratações anual', `${ETP_BASE}, II`),
  defaultSection('REQUIREMENTS', 'Requisitos da contratação', `${ETP_BASE}, III`),
  defaultSection('MARKET_SURVEY', 'Levantamento de mercado', `${ETP_BASE}, V`),
  defaultSection('ALTERNATIVES', 'Alternativas avaliadas', `${ETP_BASE}, V`),
  defaultSection(
    'ESTIMATES',
    'Estimativas das quantidades e do valor',
    `${ETP_BASE}, IV e VI`,
    'REQUIRED',
  ),
  defaultSection('RECOMMENDED_SOLUTION', 'Descrição da solução como um todo', `${ETP_BASE}, VII`),
  defaultSection('PARCELING', 'Parcelamento da solução', `${ETP_BASE}, VIII`, 'REQUIRED'),
  defaultSection(
    'RELATED_CONTRACTS',
    'Contratações correlatas e interdependentes',
    `${ETP_BASE}, XI`,
  ),
  defaultSection('EXPECTED_RESULTS', 'Resultados pretendidos', `${ETP_BASE}, IX`),
  defaultSection('ENVIRONMENTAL_IMPACTS', 'Impactos ambientais', `${ETP_BASE}, XII`),
  defaultSection('PRIOR_MEASURES', 'Providências prévias à contratação', `${ETP_BASE}, X`),
  defaultSection('RISKS', 'Riscos da contratação', 'Lei 14.133/2021, art. 18, X'),
  defaultSection('CONCLUSION', 'Posicionamento conclusivo', `${ETP_BASE}, XIII`, 'REQUIRED'),
];

/**
 * RN-AI-37: as seções da proposta — as de texto e as estruturadas com `allowNarrative` (só texto
 * complementar); estruturada sem narrativa fica fora ("não coberta pela IA").
 */
export function etpDraftSections(sections: readonly EtpTemplateSection[]): SectionSpec[] {
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

// --- Fontes -----------------------------------------------------------------------------------------

/** O DFD como entrada (`AiChainSource` da fachada do `document`) e o seu cabeçalho atual. */
export interface EtpDraftDfd {
  readonly documentId: string;
  readonly documentTypeCode: string;
  readonly source: 'APPROVED_VERSION' | 'VERSION' | 'DRAFT';
  readonly versionNumber: number | null;
  readonly draftRevision: number | null;
  readonly sections: readonly { readonly key: string; readonly text: string }[];
  readonly header: {
    readonly objectSummary: string;
    readonly priority: Priority;
    readonly expectedDate: string | null;
    readonly pcaStatus: PcaStatus;
    readonly pcaYear: number | null;
    readonly pcaItemCode: string | null;
  } | null;
}

export interface EtpDraftSources {
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
  readonly dfd: EtpDraftDfd;
  readonly etp: {
    readonly documentId: string;
    readonly documentTypeCode: string;
    readonly draftRevision: number;
    readonly conclusion: EtpConclusion;
    readonly parcelingDecision: ParcelingDecision | null;
    readonly recommendedAlternativeId: string | null;
    readonly estimatedTotalValue: string | null;
    readonly estimatedValueSource: EtpEstimatedValueSource | null;
  };
  /** Linhas de item do ETP com a memória de cálculo (texto puro). */
  readonly items: readonly {
    readonly processItemId: string;
    readonly description: string;
    readonly unit: string | null;
    readonly quantity: string;
    readonly calculationMemo: string | null;
  }[];
  /** Alternativas cadastradas — sem o custo informado (RN-AI-34). */
  readonly alternatives: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly advantages: string | null;
    readonly disadvantages: string | null;
    readonly decision: AlternativeDecision;
    readonly decisionJustification: string | null;
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
  /** `null` = documento sem template fixado (seções padrão do ETP, sem inputRef de template). */
  readonly template: {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly sections: readonly EtpTemplateSection[];
  } | null;
}

export interface EtpDraftContext {
  readonly parts: ContextPart[];
  readonly sections: SectionSpec[];
  readonly isBudgetConfidential: boolean;
  readonly warnings: AiOutputWarning[];
  /** `EtpDecisionGuard` (RN-AI-35/36), antes do GroundingGuard. */
  readonly postProcessors: AiOutputPostProcessor[];
}

// --- Rótulos ----------------------------------------------------------------------------------------

const CONCLUSION_LABELS: Readonly<Record<EtpConclusion, string>> = {
  PENDING: 'Pendente — decisão da pessoa responsável pelo ETP',
  VIABLE: 'Contratação viável',
  NOT_VIABLE: 'Contratação não viável',
};

const PARCELING_LABELS: Readonly<Record<ParcelingDecision, string>> = {
  PARCELED: 'Solução parcelada',
  NOT_PARCELED: 'Solução não parcelada',
  NOT_APPLICABLE: 'Parcelamento não se aplica',
};

const METHOD_LABELS: Readonly<Record<PriceCalculationMethod | PriceDefaultMethod, string>> = {
  AUTO_CV: 'Média ou mediana conforme o coeficiente de variação',
  MEAN: 'Média',
  MEDIAN: 'Mediana',
  LOWEST: 'Menor preço',
  MANUAL: 'Valor definido com justificativa',
};

/** Tratamento da seção no guia (RN-AI-37). */
const COMPLEMENT = 'Texto complementar (a tabela e os valores vêm dos dados estruturados)';

export const VALUE_OMITTED = '[valor omitido]';

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
}

/** `AAAA-MM-DD` → `DD/MM/AAAA`. */
function formatDate(value: string | null): string | null {
  if (value === null) return null;
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

/** Orçamento sigiloso (DEC-030): valores monetários em texto livre viram `[valor omitido]`. */
export function withoutMoney(text: string): string {
  let out = '';
  let last = 0;
  for (const match of findFacts(text)) {
    if (match.kind !== 'MONEY') continue;
    out += text.slice(last, match.start) + VALUE_OMITTED;
    last = match.end;
  }
  return out + text.slice(last);
}

// --- Guarda das decisões (RN-AI-35/36) ----------------------------------------------------------------

export interface EtpPendingMark {
  readonly sectionKey: string;
  readonly label: string;
  readonly category: ToConfirmCategory;
}

export const CONCLUSION_PENDING = 'conclusão sobre a viabilidade';
export const SOLUTION_PENDING = 'solução escolhida';
export const PARCELING_PENDING = 'decisão sobre o parcelamento';
export const VALUE_PENDING = 'valor estimado da pesquisa de preços';

/** Marcações que a proposta precisa trazer, pelas decisões e pelo valor disponíveis. */
export function etpPendingMarks(input: {
  readonly conclusion: EtpConclusion;
  readonly hasRecommendedAlternative: boolean;
  readonly parcelingDecision: ParcelingDecision | null;
  readonly hasGroundedValue: boolean;
}): EtpPendingMark[] {
  const marks: EtpPendingMark[] = [];
  if (input.conclusion === 'PENDING') {
    marks.push({ sectionKey: 'CONCLUSION', label: CONCLUSION_PENDING, category: 'DECISION' });
  }
  if (!input.hasRecommendedAlternative) {
    marks.push({
      sectionKey: 'RECOMMENDED_SOLUTION',
      label: SOLUTION_PENDING,
      category: 'DECISION',
    });
  }
  if (input.parcelingDecision === null) {
    marks.push({ sectionKey: 'PARCELING', label: PARCELING_PENDING, category: 'DECISION' });
  }
  if (!input.hasGroundedValue) {
    marks.push({ sectionKey: 'ESTIMATES', label: VALUE_PENDING, category: 'VALUE' });
  }
  return marks;
}

function hasMark(nodes: readonly RichTextNode[] | undefined, label: string): boolean {
  return (nodes ?? []).some((node) => {
    if (node.type === 'toConfirm') {
      const current = node.attrs?.label;
      return typeof current === 'string' && current.toLowerCase().includes(label);
    }
    return hasMark(node.content, label);
  });
}

/**
 * `EtpDecisionGuard` (RN-AI-35/36): a IA não decide — com a decisão pendente, a seção da proposta
 * PRECISA trazer a marcação `[a confirmar]` correspondente (conclusão, solução escolhida,
 * parcelamento) e, sem valor da pesquisa de preços concluída, a do valor estimado. Faltando, a
 * marcação é acrescentada ao fim da seção, num parágrafo próprio. Determinístico e idempotente;
 * seção ausente da resposta (opcional omitida) fica como está.
 */
export class EtpDecisionGuard implements AiOutputPostProcessor {
  readonly name = 'etp-decision-guard';

  constructor(private readonly marks: readonly EtpPendingMark[]) {}

  process({ output }: { readonly output: AiGenerationOutput }): AiGenerationOutput {
    return {
      ...output,
      sections: output.sections.map((section) => {
        const missing = this.marks.filter(
          (mark) =>
            mark.sectionKey === section.sectionKey &&
            !hasMark((section.content as RichTextNode).content, mark.label),
        );
        if (missing.length === 0) return section;
        const doc = section.content as RichTextNode;
        const content: RichTextNode = {
          ...doc,
          content: [
            ...(doc.content ?? []),
            ...missing.map((mark) => ({
              type: 'paragraph',
              content: [toConfirmNode(mark.label, mark.category)],
            })),
          ],
        };
        return { ...section, content: content as typeof section.content };
      }),
    };
  }
}

// --- Contexto ---------------------------------------------------------------------------------------

export function assembleEtpDraftContext(sources: EtpDraftSources): EtpDraftContext {
  const { process, dfd, etp, items, alternatives, priceResearch, template } = sources;
  const confidential = process.isBudgetConfidential;
  const text = (value: string) => (confidential ? withoutMoney(value) : value);
  const textOrNull = (value: string | null) => (value === null ? null : text(value));
  const money = (value: string | null) =>
    confidential || value === null ? null : formatCurrency(value);

  const warnings: AiOutputWarning[] = [];
  if (dfd.source === 'DRAFT') {
    warnings.push({ code: 'USED_DRAFT_INPUTS', params: { input: dfd.documentTypeCode } });
  }
  if (priceResearch === null) warnings.push({ code: 'MISSING_PRICE_RESEARCH' });
  if (items.length === 0) {
    warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ETP_ITEMS' } });
  }
  if (alternatives.length === 0) {
    warnings.push({ code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ALTERNATIVES' } });
  }
  if (confidential) warnings.push({ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' });

  // RN-AI-36: só o total da pesquisa concluída ou o valor do ETP copiado dela (vínculo).
  const linkedValue =
    etp.estimatedValueSource === 'PRICE_RESEARCH' ? etp.estimatedTotalValue : null;
  const groundedValue = priceResearch?.totalEstimatedValue ?? linkedValue;
  const recommended = alternatives.find(
    (alternative) =>
      alternative.decision === 'RECOMMENDED' || alternative.id === etp.recommendedAlternativeId,
  );

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
      ref:
        dfd.source === 'DRAFT'
          ? {
              kind: 'DOCUMENT_DRAFT',
              id: dfd.documentId,
              documentTypeCode: dfd.documentTypeCode,
              revision: dfd.draftRevision ?? 0,
            }
          : {
              kind: 'DOCUMENT_VERSION',
              id: dfd.documentId,
              documentTypeCode: dfd.documentTypeCode,
              versionNumber: dfd.versionNumber ?? 1,
            },
      label: dfd.source === 'DRAFT' ? 'DFD (rascunho atual)' : 'DFD',
      data: compact({
        cabecalho:
          dfd.header === null
            ? null
            : compact({
                resumoDoObjeto: text(dfd.header.objectSummary),
                prioridade: PRIORITY_LABELS[dfd.header.priority],
                dataPrevistaDaContratacao: formatDate(dfd.header.expectedDate),
                situacaoNoPca: PCA_STATUS_LABELS[dfd.header.pcaStatus],
                anoDoPca: dfd.header.pcaYear === null ? null : String(dfd.header.pcaYear),
                itemDoPca: dfd.header.pcaItemCode,
              }),
        secoes: dfd.sections.map((section) => ({ secao: section.key, texto: text(section.text) })),
      }),
    },
    {
      ref: {
        kind: 'DOCUMENT_DRAFT',
        id: etp.documentId,
        documentTypeCode: etp.documentTypeCode,
        revision: etp.draftRevision,
      },
      label: 'Decisões já registradas no ETP (a IA não as altera)',
      data: compact({
        conclusao: CONCLUSION_LABELS[etp.conclusion],
        solucaoEscolhida: recommended?.name ?? 'Nenhuma alternativa escolhida — decisão pendente',
        parcelamento:
          etp.parcelingDecision === null
            ? 'Não decidido — decisão pendente'
            : PARCELING_LABELS[etp.parcelingDecision],
        valorEstimadoDaPesquisaDePrecos: priceResearch === null ? money(linkedValue) : null,
      }),
    },
    {
      ref: { kind: 'PROCESS_ITEMS', id: etp.documentId },
      label: 'Itens do ETP',
      data: items.map((item) =>
        compact({
          descricao: item.description,
          unidade: item.unit,
          quantidade: formatQuantity(item.quantity),
          memoriaDeCalculo: textOrNull(item.calculationMemo),
        }),
      ),
      // Muitos itens: o contexto pode cortá-los (CONTEXT_TRUNCATED) antes de falhar (FA-05).
      optional: true,
    },
    {
      ref: { kind: 'ETP_ALTERNATIVES', id: etp.documentId },
      label: 'Alternativas cadastradas',
      data: alternatives.map((alternative) =>
        compact({
          nome: alternative.name,
          descricao: text(alternative.description),
          vantagens: textOrNull(alternative.advantages),
          desvantagens: textOrNull(alternative.disadvantages),
          decisao: ALTERNATIVE_DECISION_LABELS[alternative.decision],
          justificativaDaDecisao: textOrNull(alternative.decisionJustification),
        }),
      ),
      optional: true,
    },
  ];
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

  const definitions = template?.sections ?? ETP_DEFAULT_SECTIONS;
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

  const marks = etpPendingMarks({
    conclusion: etp.conclusion,
    hasRecommendedAlternative: recommended !== undefined,
    parcelingDecision: etp.parcelingDecision,
    hasGroundedValue: !confidential && groundedValue !== null,
  });
  return {
    parts,
    sections,
    isBudgetConfidential: confidential,
    warnings,
    postProcessors: [new EtpDecisionGuard(marks)],
  };
}
