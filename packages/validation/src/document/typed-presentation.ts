import type { SystemDocumentModule } from './document-type.js';
import { SYSTEM_MODULE_SECTION_KEYS, TYPED_HEADER_FIELDS } from './template.js';

/*
 * Apresentação em português do cabeçalho tipado e das coleções do snapshot (US-067 · US-109): o PDF
 * e o visualizador usam o MESMO dicionário, então nenhuma chave técnica (`requestDate`,
 * `pcaStatus`…) nem valor cru (`URGENT`, `650000.00`, `2026-11-06`) chega ao leitor. Os módulos
 * tipados gravam no snapshot os nomes que resolveram (`responsibleName`, `selectionCriterionName`…)
 * ao lado dos ids; aqui só se formata. Chave sem entrada no dicionário NÃO é impressa (nunca se
 * "humaniza" uma chave em inglês) — o teste de completude falha se entrar campo novo sem rótulo.
 * Sigilo (POL-09): `<campo>Masked: true` vira "Valor sigiloso". Funções puras.
 */

export const PRESENTATION_MASKED_LABEL = 'Valor sigiloso';
export const PRESENTATION_EMPTY_VALUE = '—';

export type PresentationKind =
  | 'text'
  | 'date'
  | 'money'
  | 'decimal'
  | 'integer'
  | 'percent'
  | 'months'
  | 'days'
  | 'bool'
  | 'enum'
  /** Nome resolvido pelo módulo em `nameKey` (o id nunca é impresso). */
  | 'ref';

export interface PresentationField {
  readonly key: string;
  readonly label: string;
  readonly kind: PresentationKind;
  readonly options?: Readonly<Record<string, string>>;
  readonly nameKey?: string;
}

const field = (
  key: string,
  label: string,
  kind: PresentationKind = 'text',
  extra: { options?: Readonly<Record<string, string>>; nameKey?: string } = {},
): PresentationField => ({ key, label, kind, ...extra });

const PRIORITY_LABELS = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', URGENT: 'Urgente' } as const;
const PCA_STATUS_LABELS = {
  PLANNED: 'Previsto no PCA',
  NOT_PLANNED: 'Não previsto no PCA',
  NOT_APPLICABLE: 'Não se aplica',
} as const;
const VALUE_SOURCE_LABELS = {
  MANUAL: 'Informado manualmente',
  DFD: 'DFD',
  ETP: 'ETP',
  PRICE_RESEARCH: 'Pesquisa de preços',
  TERM: 'Termo de referência',
} as const;
const RISK_LEVEL_LABELS = {
  LOW: 'Baixo',
  MEDIUM: 'Médio',
  HIGH: 'Alto',
  EXTREME: 'Extremo',
} as const;

/** Campos do cabeçalho tipado por módulo, na ordem em que saem no documento. */
export const TYPED_HEADER_PRESENTATION: Readonly<
  Record<SystemDocumentModule, readonly PresentationField[]>
> = {
  DFD: [
    field('requestDate', 'Data do pedido', 'date'),
    field('requestingDepartmentId', 'Unidade requisitante', 'ref', {
      nameKey: 'requestingDepartmentName',
    }),
    field('responsibleId', 'Responsável', 'ref', { nameKey: 'responsibleName' }),
    field('objectSummary', 'Resumo do objeto'),
    field('priority', 'Prioridade', 'enum', { options: PRIORITY_LABELS }),
    field('expectedDate', 'Data prevista da contratação', 'date'),
    field('estimatedValue', 'Valor estimado', 'money'),
    field('pcaStatus', 'Situação no PCA', 'enum', { options: PCA_STATUS_LABELS }),
    field('pcaYear', 'Ano do PCA', 'integer'),
    field('pcaItemCode', 'Item do PCA'),
    field('pcaJustification', 'Justificativa para a ausência no PCA'),
  ],
  ETP: [
    field('conclusion', 'Conclusão', 'enum', {
      options: {
        PENDING: 'Pendente',
        VIABLE: 'Contratação viável',
        NOT_VIABLE: 'Contratação inviável',
      },
    }),
    field('parcelingDecision', 'Decisão sobre o parcelamento', 'enum', {
      options: {
        PARCELED: 'Parcelar a contratação',
        NOT_PARCELED: 'Não parcelar a contratação',
        NOT_APPLICABLE: 'Não se aplica',
      },
    }),
    field('recommendedAlternativeId', 'Alternativa recomendada', 'ref', {
      nameKey: 'recommendedAlternativeName',
    }),
    field('estimatedTotalValue', 'Valor total estimado', 'money'),
    field('estimatedValueSource', 'Origem do valor estimado', 'enum', {
      options: VALUE_SOURCE_LABELS,
    }),
    field('priceResearchId', 'Pesquisa de preços', 'ref', { nameKey: 'priceResearchLabel' }),
  ],
  TERM_OF_REFERENCE: [
    field('objectDefinition', 'Definição do objeto'),
    field('contractDurationMonths', 'Vigência do contrato', 'months'),
    field('executionDeadline', 'Prazo de execução', 'integer'),
    field('executionDeadlineType', 'Contagem do prazo', 'enum', {
      options: { BUSINESS: 'Dias úteis', CALENDAR: 'Dias corridos' },
    }),
    field('deliveryLocation', 'Local de entrega'),
    field('paymentTermDays', 'Prazo de pagamento', 'days'),
    field('productWarrantyMonths', 'Garantia do objeto', 'months'),
    field('contractGuaranteePercent', 'Garantia contratual', 'percent'),
    field('allowsSubcontracting', 'Permite subcontratação', 'bool'),
    field('selectionCriterionId', 'Critério de julgamento', 'ref', {
      nameKey: 'selectionCriterionName',
    }),
    field('awardType', 'Tipo de adjudicação', 'enum', {
      options: { BY_ITEM: 'Por item', BY_LOT: 'Por lote', GLOBAL: 'Global' },
    }),
    field('estimatedTotalValue', 'Valor total estimado', 'money'),
    field('estimatedValueSource', 'Origem do valor estimado', 'enum', {
      options: VALUE_SOURCE_LABELS,
    }),
    field('priceResearchId', 'Pesquisa de preços', 'ref', { nameKey: 'priceResearchLabel' }),
  ],
  RISK_MAP: [
    field('riskCount', 'Riscos identificados', 'integer'),
    field('treatmentCount', 'Ações de tratamento', 'integer'),
    field('scaleMax', 'Escala máxima de probabilidade e impacto', 'integer'),
  ],
  PRICE_RESEARCH: [
    field('referenceDate', 'Data de referência', 'date'),
    field('defaultMethod', 'Método padrão', 'enum', {
      options: {
        AUTO_CV: 'Automático (conforme o coeficiente de variação)',
        MEAN: 'Média',
        MEDIAN: 'Mediana',
        LOWEST: 'Menor preço',
      },
    }),
    field('cvThresholdPercent', 'Limite do coeficiente de variação', 'percent'),
    field('minQuotations', 'Mínimo de cotações', 'integer'),
    field('directQuoteMaxAgeDays', 'Idade máxima da cotação direta', 'days'),
    field('similarContractMaxAgeDays', 'Idade máxima do contrato similar', 'days'),
    field('outlierLowerPercent', 'Limite inferior de valores atípicos', 'percent'),
    field('outlierUpperPercent', 'Limite superior de valores atípicos', 'percent'),
    field('unitPriceDecimals', 'Casas decimais do preço unitário', 'integer'),
    field('roundingMode', 'Arredondamento', 'enum', {
      options: { HALF_UP: 'Meio para cima', HALF_EVEN: 'Meio para o par (bancário)' },
    }),
  ],
};

export interface PresentationCollection {
  readonly title: string;
  readonly columns: readonly PresentationField[];
}

/** Coleções do snapshot (nome → título e colunas em pt-BR); coluna fora da lista não é impressa. */
export const TYPED_COLLECTION_PRESENTATION: Readonly<Record<string, PresentationCollection>> = {
  items: {
    title: 'Itens',
    columns: [
      field('sequence', 'Nº', 'integer'),
      field('lotNumber', 'Lote', 'integer'),
      field('description', 'Descrição'),
      field('unit', 'Unidade'),
      field('quantity', 'Quantidade', 'decimal'),
      field('specification', 'Especificação'),
      field('acceptanceCriteria', 'Critérios de aceitação'),
      field('notes', 'Observações'),
    ],
  },
  alternatives: {
    title: 'Alternativas analisadas',
    columns: [
      field('name', 'Alternativa'),
      field('description', 'Descrição'),
      field('advantages', 'Vantagens'),
      field('disadvantages', 'Desvantagens'),
      field('estimatedCost', 'Custo estimado', 'money'),
      field('riskLevel', 'Nível de risco', 'enum', { options: RISK_LEVEL_LABELS }),
      field('decision', 'Situação', 'enum', {
        options: {
          UNDER_ANALYSIS: 'Em análise',
          RECOMMENDED: 'Recomendada',
          DISCARDED: 'Descartada',
        },
      }),
      field('decisionJustification', 'Justificativa da decisão'),
      field('observations', 'Observações'),
    ],
  },
  risks: {
    title: 'Riscos',
    columns: [
      field('code', 'Código'),
      field('title', 'Título'),
      field('description', 'Descrição'),
      field('category', 'Categoria'),
      field('phase', 'Fase'),
      field('cause', 'Causa'),
      field('consequence', 'Consequência'),
      field('probability', 'Probabilidade', 'integer'),
      field('impact', 'Impacto', 'integer'),
      field('score', 'Pontuação', 'integer'),
      field('level', 'Nível'),
      field('residualScore', 'Pontuação residual', 'integer'),
      field('residualLevel', 'Nível residual'),
      field('status', 'Situação'),
      field('owner', 'Responsável'),
    ],
  },
  treatments: {
    title: 'Ações de tratamento',
    columns: [
      field('riskCode', 'Risco'),
      field('type', 'Tipo'),
      field('description', 'Descrição'),
      field('responsible', 'Responsável'),
      field('dueDate', 'Prazo', 'date'),
      field('status', 'Situação'),
      field('completedAt', 'Concluída em', 'date'),
      field('notes', 'Observações'),
    ],
  },
  matrix: {
    title: 'Matriz de riscos',
    columns: [
      field('probability', 'Probabilidade', 'integer'),
      field('impact', 'Impacto', 'integer'),
      field('score', 'Pontuação', 'integer'),
      field('level', 'Nível'),
      field('risks', 'Riscos'),
    ],
  },
};

// --- Formatação ---------------------------------------------------------------------------------

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** Decimal com ponto → pt-BR (`1234.5000` → `1.234,5`), sem passar por `float`. */
export function formatDecimalPtBr(value: string, minDecimals = 0, maxDecimals = 4): string {
  if (!DECIMAL.test(value)) return value;
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  let digits = fraction.slice(0, Math.max(maxDecimals, minDecimals));
  while (digits.length > minDecimals && digits.endsWith('0')) digits = digits.slice(0, -1);
  digits = digits.padEnd(minDecimals, '0');
  let grouped = '';
  for (let index = 0; index < integer.length; index += 1) {
    const fromEnd = integer.length - index;
    grouped += integer.charAt(index) + (fromEnd > 1 && (fromEnd - 1) % 3 === 0 ? '.' : '');
  }
  return `${negative ? '-' : ''}${grouped}${digits === '' ? '' : `,${digits}`}`;
}

export function formatMoneyPtBr(value: string | number): string {
  const text = typeof value === 'number' ? value.toFixed(2) : value;
  if (!DECIMAL.test(text)) return text;
  const negative = text.startsWith('-');
  const formatted = formatDecimalPtBr(negative ? text.slice(1) : text, 2, 2);
  return `${negative ? '-' : ''}R$ ${formatted}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** `AAAA-MM-DD` (ou data-hora ISO) → `DD/MM/AAAA`. */
export function formatDatePtBr(value: string): string {
  const match = ISO_DATE.exec(value);
  return match === null ? value : `${match[3] ?? ''}/${match[2] ?? ''}/${match[1] ?? ''}`;
}

function plural(count: string, one: string, many: string): string {
  return `${count} ${count === '1' ? one : many}`;
}

function formatValue(spec: PresentationField, value: unknown, record: Record<string, unknown>) {
  if (spec.kind === 'ref') {
    const name = spec.nameKey === undefined ? null : record[spec.nameKey];
    return typeof name === 'string' && name !== '' ? name : PRESENTATION_EMPTY_VALUE;
  }
  if (value === null || value === undefined || value === '') return PRESENTATION_EMPTY_VALUE;
  if (spec.kind === 'bool') return value === true ? 'Sim' : 'Não';
  if (typeof value !== 'string' && typeof value !== 'number') return PRESENTATION_EMPTY_VALUE;
  const text = String(value);
  switch (spec.kind) {
    case 'date':
      return formatDatePtBr(text);
    case 'money':
      return formatMoneyPtBr(text);
    case 'decimal':
      return formatDecimalPtBr(text);
    case 'integer':
      return formatDecimalPtBr(text, 0, 0);
    case 'percent':
      return `${formatDecimalPtBr(text, 0, 2)}%`;
    case 'months':
      return plural(formatDecimalPtBr(text, 0, 0), 'mês', 'meses');
    case 'days':
      return plural(formatDecimalPtBr(text, 0, 0), 'dia', 'dias');
    case 'enum':
      return spec.options?.[text] ?? PRESENTATION_EMPTY_VALUE;
    default:
      return text;
  }
}

/** Valor já formatado de um campo do registro, com o sigilo (POL-09) aplicado. */
export function presentFieldValue(
  spec: PresentationField,
  record: Record<string, unknown>,
): string {
  if (record[`${spec.key}Masked`] === true) return PRESENTATION_MASKED_LABEL;
  return formatValue(spec, record[spec.key], record);
}

export interface PresentedRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** Linhas do cabeçalho tipado em pt-BR (só os campos do dicionário, na ordem dele). */
export function presentTypedHeader(
  module: SystemDocumentModule,
  header: Readonly<Record<string, unknown>>,
): PresentedRow[] {
  const record = { ...header };
  return TYPED_HEADER_PRESENTATION[module]
    .filter((spec) => spec.key in record || `${spec.key}Masked` in record)
    .map((spec) => ({
      key: spec.key,
      label: spec.label,
      value: presentFieldValue(spec, record),
    }));
}

export interface PresentedCollection {
  readonly name: string;
  readonly title: string;
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly rows: readonly (readonly string[])[];
}

/** Tabela da coleção em pt-BR; `null` = sem dicionário (não impressa) ou sem linhas/colunas. */
export function presentCollection(
  name: string,
  items: readonly unknown[],
): PresentedCollection | null {
  const spec = TYPED_COLLECTION_PRESENTATION[name];
  if (spec === undefined) return null;
  const records = items.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
  if (records.length === 0) return null;
  const columns = spec.columns.filter((column) =>
    records.some(
      (record) =>
        (record[column.key] !== undefined && record[column.key] !== null) ||
        record[`${column.key}Masked`] === true,
    ),
  );
  if (columns.length === 0) return null;
  return {
    name,
    title: spec.title,
    columns: columns.map(({ key, label }) => ({ key, label })),
    rows: records.map((record) => columns.map((column) => presentFieldValue(column, record))),
  };
}

// --- Seções sem template ------------------------------------------------------------------------

/** Títulos das seções dos módulos estruturados, para quando o template não as define. */
export const SECTION_KEY_LABELS: Readonly<Record<string, string>> = {
  JUSTIFICATION: 'Justificativa da contratação',
  EXPECTED_RESULTS: 'Resultados esperados',
  NOTES: 'Observações',
  NEED_DESCRIPTION: 'Descrição da necessidade',
  PROBLEM: 'Problema a ser resolvido',
  OBJECTIVE: 'Objetivo da contratação',
  PCA_ALIGNMENT: 'Alinhamento com o PCA',
  REQUIREMENTS: 'Requisitos da contratação',
  MARKET_SURVEY: 'Levantamento de mercado',
  ALTERNATIVES: 'Alternativas analisadas',
  ESTIMATES: 'Estimativa de quantidades e valores',
  RECOMMENDED_SOLUTION: 'Solução recomendada',
  PARCELING: 'Justificativa do parcelamento',
  RELATED_CONTRACTS: 'Contratações relacionadas',
  ENVIRONMENTAL_IMPACTS: 'Impactos ambientais',
  PRIOR_MEASURES: 'Providências prévias',
  RISKS: 'Análise de riscos',
  CONCLUSION: 'Conclusão',
  OBJECT: 'Objeto',
  SPECIFICATIONS: 'Especificações',
  ACCEPTANCE_CRITERIA: 'Critérios de aceitação',
  CONTRACTOR_OBLIGATIONS: 'Obrigações da contratada',
  CONTRACTING_PARTY_OBLIGATIONS: 'Obrigações da contratante',
  DEADLINES: 'Prazos',
  DELIVERY: 'Entrega',
  PAYMENT: 'Pagamento',
  OVERSIGHT: 'Fiscalização',
  GUARANTEES: 'Garantias',
  SANCTIONS: 'Sanções',
  SELECTION_CRITERIA: 'Critérios de seleção',
  ESTIMATED_VALUE: 'Valor estimado',
  BUDGET_ADEQUACY: 'Adequação orçamentária',
  INTRODUCTION: 'Introdução',
  METHODOLOGY: 'Metodologia',
  PRICE_SUMMARY: 'Mapa comparativo de preços',
};

/** Título pt-BR da seção sem definição no template (nunca a chave técnica). */
export function sectionKeyLabel(key: string): string {
  return SECTION_KEY_LABELS[key] ?? 'Seção';
}

/** Chaves de seção dos módulos sem rótulo (usado pelo teste de completude). */
export function sectionKeysWithoutLabel(): string[] {
  return Object.values(SYSTEM_MODULE_SECTION_KEYS)
    .flat()
    .filter((key) => SECTION_KEY_LABELS[key] === undefined);
}

/** Campos de `TYPED_HEADER_FIELDS` sem entrada no dicionário (usado pelo teste de completude). */
export function headerFieldsWithoutLabel(): string[] {
  return (Object.keys(TYPED_HEADER_FIELDS) as SystemDocumentModule[]).flatMap((module) =>
    TYPED_HEADER_FIELDS[module]
      .filter((key) => !TYPED_HEADER_PRESENTATION[module].some((spec) => spec.key === key))
      .map((key) => `${module}.${key}`),
  );
}

/**
 * Chaves do cabeçalho gravadas só para apresentação (o nome resolvido de um id): fora da
 * comparação de versões, onde o id já diz tudo.
 */
export const HEADER_DERIVED_KEYS: ReadonlySet<string> = new Set(
  Object.values(TYPED_HEADER_PRESENTATION)
    .flat()
    .flatMap((spec) => (spec.nameKey === undefined ? [] : [spec.nameKey])),
);
