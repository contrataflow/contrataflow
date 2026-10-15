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
