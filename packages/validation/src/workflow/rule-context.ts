import { z } from 'zod';

/*
 * `RuleContext` v1 (entities.md §5.4 · DEC-016 · ADR-008): o único dado que as regras de workflow
 * (`REQUIRED_FIELD`, `CONDITION`) e a aplicabilidade podem ler. Somente caminhos deste schema são
 * aceitos na escrita e na publicação (US-040 · RN-WF-17); o avaliador do motor (US-041) monta o
 * contexto com este mesmo schema. Campo novo = nova versão do contexto.
 */

export const RULE_CONTEXT_VERSION = 1;

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();

/** Estado de um tipo de documento no processo (`documents.<CÓDIGO>`). */
export const ruleContextDocumentSchema = z.object({
  exists: z.boolean(),
  count: z.number().int(),
  status: nullableString,
  isComplete: z.boolean(),
  versionNumber: nullableNumber,
  approvedAt: nullableString,
});

export const ruleContextSchema = z.object({
  version: z.literal(RULE_CONTEXT_VERSION),
  now: z.string(),
  process: z.object({
    status: z.string(),
    priority: z.string(),
    estimatedValue: nullableNumber,
    contractingTypeCode: z.string(),
    modalityCode: nullableString,
    originCode: z.string(),
    isPriceRegistration: z.boolean(),
    isBudgetConfidential: z.boolean(),
    pcaStatus: z.string(),
    organizationId: z.string(),
    requestingSecretariatId: z.string(),
    requestingDepartmentId: z.string(),
    tags: z.array(z.string()),
    targetDate: nullableString,
    year: z.number().int(),
    itemsCount: z.number().int(),
    hasLots: z.boolean(),
  }),
  documents: z.record(z.string(), ruleContextDocumentSchema),
  priceResearch: z.object({
    exists: z.boolean(),
    completed: z.boolean(),
    totalEstimatedValue: nullableNumber,
    itemsBelowMinimum: z.number().int(),
    itemsWithOutliers: z.number().int(),
    itemsWithoutValidQuotes: z.number().int(),
  }),
  risks: z.object({
    count: z.number().int(),
    highOrExtremeCount: z.number().int(),
    withoutTreatmentCount: z.number().int(),
  }),
  stage: z.object({
    key: z.string(),
    enteredAt: z.string(),
    businessDaysInStage: z.number().int(),
  }),
});
export type RuleContextV1 = z.infer<typeof ruleContextSchema>;

const OBJECT_SECTIONS = ['process', 'priceResearch', 'risks', 'stage'] as const;

/** Caminhos folha estáticos do RuleContext v1 (`process.estimatedValue`, `risks.count`…). */
export const RULE_CONTEXT_V1_PATHS: readonly string[] = Object.freeze([
  'version',
  'now',
  ...OBJECT_SECTIONS.flatMap((section) =>
    Object.keys(ruleContextSchema.shape[section].shape).map((field) => `${section}.${field}`),
  ),
]);

/** Campos de `documents.<CÓDIGO>.<campo>` (o código segue o formato de `DocumentType.code`). */
export const RULE_CONTEXT_DOCUMENT_FIELDS: readonly string[] = Object.freeze(
  Object.keys(ruleContextDocumentSchema.shape),
);

const STATIC_PATHS = new Set(RULE_CONTEXT_V1_PATHS);
const DOCUMENT_PATH = new RegExp(
  `^documents\\.[A-Z][A-Z0-9_]{1,39}\\.(${RULE_CONTEXT_DOCUMENT_FIELDS.join('|')})$`,
);

/** O caminho (notação de ponto) é uma folha do RuleContext v1. */
export function isRuleContextPath(path: string): boolean {
  return STATIC_PATHS.has(path) || DOCUMENT_PATH.test(path);
}

/**
 * Caminho aceito na `applicabilityRule` do workflow (RN-WF-35/39): só `process.*` — na resolução
 * o processo ainda não existe, não há documentos, pesquisa, riscos nem etapa.
 */
export function isApplicabilityPath(path: string): boolean {
  return path.startsWith('process.') && STATIC_PATHS.has(path);
}

// ---------------------------------------------------------------------------------------------
// Schema exposto ao editor de regras (WF-19 · US-044)
// ---------------------------------------------------------------------------------------------

export const RULE_CONTEXT_FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'list'] as const;
export type RuleContextFieldType = (typeof RULE_CONTEXT_FIELD_TYPES)[number];

export interface RuleContextField {
  readonly path: string;
  readonly label: string;
  readonly type: RuleContextFieldType;
}

type FieldSpec = readonly [label: string, type: RuleContextFieldType];

/** Rótulo e tipo de cada folha estática (exceto `version`, que não interessa a uma regra). */
const STATIC_FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  now: ['Data e hora da avaliação', 'date'],
  'process.status': ['Processo — situação', 'string'],
  'process.priority': ['Processo — prioridade', 'string'],
  'process.estimatedValue': ['Processo — valor estimado', 'number'],
  'process.contractingTypeCode': ['Processo — tipo de contratação', 'string'],
  'process.modalityCode': ['Processo — modalidade', 'string'],
  'process.originCode': ['Processo — origem', 'string'],
  'process.isPriceRegistration': ['Processo — registro de preços', 'boolean'],
  'process.isBudgetConfidential': ['Processo — orçamento sigiloso', 'boolean'],
  'process.pcaStatus': ['Processo — situação no PCA', 'string'],
  'process.organizationId': ['Processo — órgão', 'string'],
  'process.requestingSecretariatId': ['Processo — secretaria requisitante', 'string'],
  'process.requestingDepartmentId': ['Processo — unidade requisitante', 'string'],
  'process.tags': ['Processo — etiquetas', 'list'],
  'process.targetDate': ['Processo — data desejada', 'date'],
  'process.year': ['Processo — ano', 'number'],
  'process.itemsCount': ['Processo — quantidade de itens', 'number'],
  'process.hasLots': ['Processo — possui lotes', 'boolean'],
  'priceResearch.exists': ['Pesquisa de preços — existe', 'boolean'],
  'priceResearch.completed': ['Pesquisa de preços — concluída', 'boolean'],
  'priceResearch.totalEstimatedValue': ['Pesquisa de preços — valor total estimado', 'number'],
  'priceResearch.itemsBelowMinimum': ['Pesquisa de preços — itens abaixo do mínimo', 'number'],
  'priceResearch.itemsWithOutliers': ['Pesquisa de preços — itens com discrepantes', 'number'],
  'priceResearch.itemsWithoutValidQuotes': [
    'Pesquisa de preços — itens sem cotações válidas',
    'number',
  ],
  'risks.count': ['Riscos — quantidade', 'number'],
  'risks.highOrExtremeCount': ['Riscos — altos ou extremos', 'number'],
  'risks.withoutTreatmentCount': ['Riscos — sem tratamento', 'number'],
  'stage.key': ['Etapa atual — chave', 'string'],
  'stage.enteredAt': ['Etapa atual — entrada', 'date'],
  'stage.businessDaysInStage': ['Etapa atual — dias úteis na etapa', 'number'],
};

const DOCUMENT_FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  exists: ['existe', 'boolean'],
  count: ['quantidade', 'number'],
  status: ['situação', 'string'],
  isComplete: ['completo', 'boolean'],
  versionNumber: ['número da versão', 'number'],
  approvedAt: ['data da aprovação', 'date'],
};

/**
 * Campos do RuleContext v1 para o construtor de regras (WF-19): as folhas estáticas e, para cada
 * tipo de documento informado, `documents.<CÓDIGO>.<campo>` — em ordem estável.
 */
export function ruleContextFields(documentTypeCodes: readonly string[]): RuleContextField[] {
  const fields: RuleContextField[] = RULE_CONTEXT_V1_PATHS.filter((path) => path !== 'version').map(
    (path) => {
      const [label, type] = STATIC_FIELD_SPECS[path] ?? [path, 'string'];
      return { path, label, type };
    },
  );
  for (const code of [...new Set(documentTypeCodes)].sort()) {
    for (const field of RULE_CONTEXT_DOCUMENT_FIELDS) {
      const [label, type] = DOCUMENT_FIELD_SPECS[field] ?? [field, 'string'];
      const path = `documents.${code}.${field}`;
      if (isRuleContextPath(path))
        fields.push({ path, label: `Documento ${code} — ${label}`, type });
    }
  }
  return fields;
}

/** Resposta do WF-19. */
export const ruleContextSchemaDtoSchema = z
  .object({
    version: z.literal(RULE_CONTEXT_VERSION),
    fields: z.array(
      z.object({ path: z.string(), label: z.string(), type: z.enum(RULE_CONTEXT_FIELD_TYPES) }),
    ),
  })
  .meta({ id: 'RuleContextSchema' });
export type RuleContextSchemaDto = z.infer<typeof ruleContextSchemaDtoSchema>;
