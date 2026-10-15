import { z } from 'zod';

import { CONFIDENTIALITIES, DOCUMENT_KINDS, SYSTEM_DOCUMENT_MODULES } from './document-type.js';
import type { DocumentKind, SystemDocumentModule } from './document-type.js';
import { richTextDocSchema } from './rich-text.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';

/*
 * Templates de documento (US-107 · entities.md §4.7/§5.1/§5.2/§5.8 · api/04-templates.md
 * TPL-01..04/07/08). Fonte única dos schemas e catálogos usados pela API (corpo, resposta e o
 * `TemplateContentValidator`) e pelas telas SCR-033/SCR-114.
 */

export const TEMPLATE_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type TemplateVersionStatus = (typeof TEMPLATE_VERSION_STATUSES)[number];

export const SECTION_REQUIREMENTS = ['REQUIRED', 'REQUIRED_OR_JUSTIFY', 'OPTIONAL'] as const;
export type SectionRequirement = (typeof SECTION_REQUIREMENTS)[number];

export const SECTION_RENDERS = [
  'TEXT',
  'ITEMS_TABLE',
  'ALTERNATIVES_TABLE',
  'RISK_MATRIX',
  'RISK_LIST',
  'PRICE_SUMMARY',
  'ESTIMATED_VALUE',
] as const;
export type SectionRender = (typeof SECTION_RENDERS)[number];

/** RN-TPL-04: chave da seção em `SCREAMING_SNAKE_CASE`. */
export const SECTION_KEY_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
export const SECTION_KEY_MAX_LENGTH = 60;
/** RN-TPL-04: `maxChars` quando omitido. */
export const DEFAULT_SECTION_MAX_CHARS = 50_000;
export const MAX_TEMPLATE_SECTIONS = 200;

/**
 * RN-TPL-05: módulos estruturados em que cada bloco especial é aceito (`TEXT` vale em todos; tipos
 * `FREE_TEXT`/`UPLOADED` só aceitam `TEXT`). Valor estimado e resumo de preços cabem na pesquisa
 * de preço e nos demais módulos que representam valor estimado (DFD, ETP, TR).
 */
export const SECTION_RENDER_MODULES: Readonly<
  Record<Exclude<SectionRender, 'TEXT'>, readonly SystemDocumentModule[]>
> = {
  ITEMS_TABLE: ['DFD', 'ETP', 'TERM_OF_REFERENCE'],
  ALTERNATIVES_TABLE: ['DFD', 'ETP', 'TERM_OF_REFERENCE'],
  RISK_MATRIX: ['RISK_MAP'],
  RISK_LIST: ['RISK_MAP'],
  PRICE_SUMMARY: ['PRICE_RESEARCH', 'DFD', 'ETP', 'TERM_OF_REFERENCE'],
  ESTIMATED_VALUE: ['PRICE_RESEARCH', 'DFD', 'ETP', 'TERM_OF_REFERENCE'],
};

/** RN-TPL-05: o bloco é compatível com o tipo de documento? */
export function isRenderAllowed(
  render: SectionRender,
  type: { readonly kind: DocumentKind; readonly systemModule: SystemDocumentModule | null },
): boolean {
  if (render === 'TEXT') return true;
  if (type.kind !== 'STRUCTURED' || type.systemModule === null) return false;
  return SECTION_RENDER_MODULES[render].includes(type.systemModule);
}

/** Catálogo de variáveis de template (entities.md §5.2). */
export const TEMPLATE_VARIABLES = [
  'tenant.name',
  'organization.name',
  'organization.cnpj',
  'organization.address',
  'process.code',
  'process.title',
  'process.object',
  'process.requestingSecretariat',
  'process.requestingDepartment',
  'document.code',
  'document.title',
  'document.version',
  'document.date',
  'document.hash',
  'today',
  'user.name',
  'page',
  'pages',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** Variáveis que só existem na renderização do PDF (US-109): fora das seções (RN-TPL-06). */
export const RENDER_ONLY_TEMPLATE_VARIABLES = [
  'document.version',
  'document.hash',
  'page',
  'pages',
] as const satisfies readonly TemplateVariable[];

/** RN-TPL-06: variáveis aceitas em `defaultContent`/`helpText`. */
export const SECTION_TEMPLATE_VARIABLES: readonly TemplateVariable[] = TEMPLATE_VARIABLES.filter(
  (variable) => !(RENDER_ONLY_TEMPLATE_VARIABLES as readonly string[]).includes(variable),
);

/** Variáveis `{{...}}` citadas no texto, na ordem e sem repetição (espaços internos ignorados). */
export function templateVariablesIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) found.add(match[1] ?? '');
  return [...found];
}

/** Mensagem pt-BR da variável desconhecida (V-05). */
export function unknownVariableMessage(variable: string): string {
  return `A variável {{${variable}}} não é reconhecida.`;
}

/**
 * Chaves das seções de cada módulo estruturado (entities.md §4.8): referência para o editor e para
 * o mapeamento TR ← ETP quando o tenant ainda não tem template ETP padrão publicado.
 */
export const SYSTEM_MODULE_SECTION_KEYS: Readonly<Record<SystemDocumentModule, readonly string[]>> =
  {
    DFD: ['JUSTIFICATION', 'EXPECTED_RESULTS', 'NOTES'],
    ETP: [
      'NEED_DESCRIPTION',
      'PROBLEM',
      'OBJECTIVE',
      'PCA_ALIGNMENT',
      'REQUIREMENTS',
      'MARKET_SURVEY',
      'ALTERNATIVES',
      'ESTIMATES',
      'RECOMMENDED_SOLUTION',
      'PARCELING',
      'RELATED_CONTRACTS',
      'EXPECTED_RESULTS',
      'ENVIRONMENTAL_IMPACTS',
      'PRIOR_MEASURES',
      'RISKS',
      'CONCLUSION',
    ],
    TERM_OF_REFERENCE: [
      'OBJECT',
      'JUSTIFICATION',
      'SPECIFICATIONS',
      'ACCEPTANCE_CRITERIA',
      'CONTRACTOR_OBLIGATIONS',
      'CONTRACTING_PARTY_OBLIGATIONS',
      'DEADLINES',
      'DELIVERY',
      'PAYMENT',
      'OVERSIGHT',
      'GUARANTEES',
      'SANCTIONS',
      'SELECTION_CRITERIA',
      'ESTIMATED_VALUE',
    ],
    RISK_MAP: ['INTRODUCTION', 'METHODOLOGY', 'NOTES'],
    PRICE_RESEARCH: ['METHODOLOGY', 'CONCLUSION', 'PRICE_SUMMARY'],
  };

/**
 * RN-TPL-07: campos do cabeçalho tipado de cada módulo (entities.md §4.8) — as chaves aceitas em
 * `fieldConfig`. O mapa de riscos não tem cabeçalho tipado.
 */
export const TYPED_HEADER_FIELDS: Readonly<Record<SystemDocumentModule, readonly string[]>> = {
  DFD: [
    'requestingDepartmentId',
    'responsibleId',
    'requestDate',
    'objectSummary',
    'priority',
    'expectedDate',
    'estimatedValue',
    'pcaStatus',
    'pcaYear',
    'pcaItemCode',
    'pcaJustification',
  ],
  ETP: [
    'parcelingDecision',
    'conclusion',
    'estimatedTotalValue',
    'estimatedValueSource',
    'priceResearchId',
  ],
  TERM_OF_REFERENCE: [
    'objectDefinition',
    'contractDurationMonths',
    'executionDeadline',
    'executionDeadlineType',
    'deliveryLocation',
    'paymentTermDays',
    'productWarrantyMonths',
    'contractGuaranteePercent',
    'allowsSubcontracting',
    'selectionCriterionId',
    'awardType',
    'estimatedTotalValue',
    'estimatedValueSource',
    'priceResearchId',
  ],
  RISK_MAP: [],
  PRICE_RESEARCH: [
    'referenceDate',
    'defaultMethod',
    'cvThresholdPercent',
    'minQuotations',
    'directQuoteMaxAgeDays',
    'similarContractMaxAgeDays',
    'outlierLowerPercent',
    'outlierUpperPercent',
    'unitPriceDecimals',
    'roundingMode',
  ],
};

// ─── SectionDefinition (§5.1) ────────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z.string().max(max, { error: `Informe no máximo ${max.toLocaleString('pt-BR')} caracteres.` });

export const MIN_GREATER_THAN_MAX_MESSAGE = 'O mínimo não pode ser maior que o máximo.';

/**
 * `SectionDefinition` (`sectionDefinitionSchema`). O formato e a unicidade da chave, o bloco × tipo
 * e as variáveis são regras de conteúdo (`TEMPLATE_INVALID`, RN-TPL-04..06) conferidas pelo
 * `TemplateContentValidator`; aqui ficam os limites de campo (`VALIDATION_ERROR`, V-10).
 */
export const sectionDefinitionSchema = z
  .strictObject({
    key: z
      .string({ error: 'Informe a chave da seção.' })
      .trim()
      .min(1, { error: 'Informe a chave da seção.' })
      .max(SECTION_KEY_MAX_LENGTH, {
        error: `Informe no máximo ${SECTION_KEY_MAX_LENGTH} caracteres.`,
      }),
    title: trimmedString({ max: 150 }),
    order: z.number().int().min(1, { error: 'A ordem começa em 1.' }),
    requirement: z.enum(SECTION_REQUIREMENTS).default('REQUIRED'),
    helpText: optionalText(2000).optional(),
    legalBasis: optionalText(300).optional(),
    defaultContent: richTextDocSchema.optional(),
    minChars: z
      .number()
      .int()
      .min(0, { error: 'Informe um número maior ou igual a 0.' })
      .optional(),
    maxChars: z
      .number()
      .int()
      .min(1, { error: 'Informe um número maior ou igual a 1.' })
      .max(1_000_000, { error: 'Informe no máximo 1.000.000.' })
      .default(DEFAULT_SECTION_MAX_CHARS),
    render: z.enum(SECTION_RENDERS).default('TEXT'),
    allowNarrative: z.boolean().default(true),
  })
  .superRefine((section, ctx) => {
    if (section.minChars !== undefined && section.minChars > section.maxChars) {
      ctx.addIssue({
        code: 'custom',
        path: ['minChars'],
        message: MIN_GREATER_THAN_MAX_MESSAGE,
        params: { code: 'OUT_OF_RANGE' },
      });
    }
  });
export type SectionDefinitionInput = z.input<typeof sectionDefinitionSchema>;
export type SectionDefinition = z.output<typeof sectionDefinitionSchema>;

// ─── fieldConfig e importMappings (§5.8) ─────────────────────────────────────────────────────

export const fieldConfigEntrySchema = z.strictObject({
  label: trimmedString({ max: 150 }).optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
});
export type FieldConfigEntry = z.infer<typeof fieldConfigEntrySchema>;

export const fieldConfigSchema = z.record(z.string().min(1).max(60), fieldConfigEntrySchema);
export type FieldConfig = z.infer<typeof fieldConfigSchema>;

export const IMPORT_MAPPING_MODES = ['REPLACE', 'APPEND'] as const;

export const importMappingsSchema = z
  .strictObject({
    fromDocumentType: z.literal('ETP'),
    sections: z
      .array(
        z.strictObject({
          target: z.string().trim().min(1).max(SECTION_KEY_MAX_LENGTH),
          sources: z.array(z.string().trim().min(1).max(SECTION_KEY_MAX_LENGTH)).min(1).max(20),
          mode: z.enum(IMPORT_MAPPING_MODES),
        }),
      )
      .max(MAX_TEMPLATE_SECTIONS),
    fields: z
      .array(
        z.strictObject({
          target: z.string().trim().min(1).max(60),
          source: z.string().trim().min(1).max(60),
        }),
      )
      .max(100),
    items: z.strictObject({
      copyQuantities: z.boolean(),
      copyCalculationMemoToNotes: z.boolean(),
    }),
  })
  .meta({ id: 'ImportMappings' });
export type ImportMappings = z.infer<typeof importMappingsSchema>;

/** Mapeamento padrão semeado no template de TR (entities.md §5.8 · RN-TPL-02). */
export const DEFAULT_TR_IMPORT_MAPPINGS: ImportMappings = {
  fromDocumentType: 'ETP',
  sections: [
    { target: 'OBJECT', sources: ['RECOMMENDED_SOLUTION'], mode: 'REPLACE' },
    {
      target: 'JUSTIFICATION',
      sources: ['NEED_DESCRIPTION', 'PROBLEM', 'OBJECTIVE'],
      mode: 'APPEND',
    },
    { target: 'SPECIFICATIONS', sources: ['REQUIREMENTS'], mode: 'REPLACE' },
    { target: 'ESTIMATED_VALUE', sources: ['ESTIMATES'], mode: 'REPLACE' },
  ],
  fields: [
    { target: 'estimatedTotalValue', source: 'estimatedTotalValue' },
    { target: 'priceResearchId', source: 'priceResearchId' },
  ],
  items: { copyQuantities: true, copyCalculationMemoToNotes: false },
};

// ─── LayoutDefinition (§5.2) ─────────────────────────────────────────────────────────────────

export const TEMPLATE_FONT_FAMILIES = [
  'Inter',
  'Arial',
  'Times New Roman',
  'Liberation Serif',
] as const;

export const layoutDefinitionSchema = z
  .object({
    pageSize: z.literal('A4'),
    orientation: z.enum(['portrait', 'landscape']),
    marginsMm: z.object({
      top: z.number(),
      right: z.number(),
      bottom: z.number(),
      left: z.number(),
    }),
    fontFamily: z.enum(TEMPLATE_FONT_FAMILIES),
    fontSizePt: z.number(),
    lineHeight: z.number(),
    header: richTextDocSchema.optional(),
    footer: richTextDocSchema.optional(),
    logo: z
      .object({
        attachmentId: z.uuid(),
        position: z.enum(['left', 'center', 'right']),
        maxHeightMm: z.number(),
      })
      .optional(),
    showPageNumbers: z.boolean(),
    showDocumentHashInFooter: z.boolean(),
    draftWatermark: z.boolean(),
  })
  .meta({ id: 'LayoutDefinition' });
export type LayoutDefinition = z.infer<typeof layoutDefinitionSchema>;

/** RN-TPL-02: layout da versão 1 (constantes da aplicação; refinável na US-109). */
export const DEFAULT_TEMPLATE_LAYOUT: LayoutDefinition = {
  pageSize: 'A4',
  orientation: 'portrait',
  marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
  fontFamily: 'Inter',
  fontSizePt: 11,
  lineHeight: 1.15,
  showPageNumbers: true,
  showDocumentHashInFooter: true,
  draftWatermark: true,
};

// ─── Requisições (TPL-01/02/04/08) ───────────────────────────────────────────────────────────

const templateNameSchema = trimmedString({ min: 3, max: 150 });
const templateDescriptionSchema = z
  .string()
  .trim()
  .max(2000, { error: 'Informe no máximo 2.000 caracteres.' });

/** TPL-02 (corpo). */
export const templateCreateSchema = z.strictObject({
  name: templateNameSchema,
  documentTypeId: uuidV7Schema,
  description: templateDescriptionSchema.optional(),
});
export type TemplateCreate = z.infer<typeof templateCreateSchema>;

/** TPL-04 (corpo): `documentTypeId` é imutável (RN-TPL-01) e fica fora do schema estrito. */
export const templateUpdateSchema = z
  .strictObject({
    name: templateNameSchema,
    description: templateDescriptionSchema.nullable(),
    isActive: z.boolean(),
  })
  .partial();
export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;

export const CHANGE_NOTES_MAX_LENGTH = 1000;

/** TPL-08 (corpo, conteúdo — US-107). O layout (`layout`) entra com a US-109. */
export const templateVersionUpdateSchema = z
  .strictObject({
    sections: z
      .array(sectionDefinitionSchema)
      .max(MAX_TEMPLATE_SECTIONS, { error: `Informe no máximo ${MAX_TEMPLATE_SECTIONS} seções.` }),
    fieldConfig: fieldConfigSchema,
    importMappings: importMappingsSchema.nullable(),
    changeNotes: z
      .string()
      .trim()
      .max(CHANGE_NOTES_MAX_LENGTH, { error: 'Informe no máximo 1.000 caracteres.' })
      .nullable(),
  })
  .partial();
export type TemplateVersionUpdateInput = z.input<typeof templateVersionUpdateSchema>;
export type TemplateVersionUpdate = z.output<typeof templateVersionUpdateSchema>;

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** TPL-01 (query). */
export const templateListQuerySchema = z.strictObject({
  documentTypeId: uuidV7Schema.optional(),
  q: z.string().trim().max(150).optional(),
  isActive: booleanQuery,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type TemplateListQuery = z.output<typeof templateListQuerySchema>;

export const templateIdParamsSchema = z.strictObject({ id: uuidV7Schema });
export const templateVersionIdParamsSchema = z.strictObject({ versionId: uuidV7Schema });

// ─── Respostas ───────────────────────────────────────────────────────────────────────────────

const templateDocumentTypeSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  systemModule: z.enum(SYSTEM_DOCUMENT_MODULES).nullable(),
  defaultConfidentiality: z.enum(CONFIDENTIALITIES),
});

export const templateVersionSummarySchema = z.object({
  id: z.uuid(),
  versionNumber: z.number().int(),
  status: z.enum(TEMPLATE_VERSION_STATUSES),
  sectionCount: z.number().int(),
  updatedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
});
export type TemplateVersionSummary = z.infer<typeof templateVersionSummarySchema>;

/** `Template` da resposta de TPL-01..04. */
export const templateSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    documentTypeId: z.uuid(),
    documentType: templateDocumentTypeSchema,
    isActive: z.boolean(),
    isSystem: z.boolean(),
    /** Rascunho em edição (no máximo um — RN-TPL-10). */
    draftVersion: templateVersionSummarySchema.nullable(),
    currentPublishedVersion: templateVersionSummarySchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int(),
  })
  .meta({ id: 'Template' });
export type TemplateDto = z.infer<typeof templateSchema>;

/** `TemplateVersion` da resposta de TPL-07/08. */
export const templateVersionSchema = z
  .object({
    id: z.uuid(),
    templateId: z.uuid(),
    templateName: z.string(),
    versionNumber: z.number().int(),
    status: z.enum(TEMPLATE_VERSION_STATUSES),
    documentType: templateDocumentTypeSchema,
    sections: z.array(sectionDefinitionSchema),
    fieldConfig: fieldConfigSchema,
    importMappings: importMappingsSchema.nullable(),
    layout: layoutDefinitionSchema,
    changeNotes: z.string().nullable(),
    /**
     * Origem do mapeamento TR ← ETP (só TR): seções do template ETP padrão publicado do tenant (ou
     * as seções de referência do ETP, enquanto não houver) e campos do cabeçalho do ETP.
     */
    importSources: z
      .object({ sectionKeys: z.array(z.string()), fieldKeys: z.array(z.string()) })
      .nullable(),
    publishedAt: z.iso.datetime().nullable(),
    retiredAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int(),
  })
  .meta({ id: 'TemplateVersion' });
export type TemplateVersionDto = z.infer<typeof templateVersionSchema>;
