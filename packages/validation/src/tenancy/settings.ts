import {
  AI_MONTHLY_TOKEN_LIMIT_CEILING,
  AI_MONTHLY_TOKEN_LIMIT_DEFAULT,
  AI_MONTHLY_TOKEN_LIMIT_MIN,
  AI_USER_DAILY_REQUEST_LIMIT_DEFAULT,
  AI_USER_DAILY_REQUEST_LIMIT_MAX,
  AI_USER_DAILY_REQUEST_LIMIT_MIN,
} from '@contrataflow/types';
import { z } from 'zod';

import { DOCUMENT_TYPE_CODE_PATTERN } from '../document/document-type.js';
import {
  DEFAULT_DOCUMENT_NUMBERING_MASK,
  DEFAULT_PROCESS_NUMBERING_MASK,
  DOCUMENT_SETTING_MASK_RULES,
  isValidNumberingMask,
  PROCESS_MASK_RULES,
} from '../document/numbering-mask.js';
import { dataEnvelope } from '../http/envelope.js';

/*
 * Registro tipado de configurações do tenant (US-103 · entities.md §6 · RN-TEN-52..58): fonte única
 * de chaves válidas, schema Zod, valor padrão, grupo da SCR-041 e indicação de leitura pública.
 * Compartilhado pela API (validação e seeder) e pelo front (SCR-041 valida cada campo com o mesmo
 * schema). Cada definição nomeia o módulo dono (padrão "registro por módulo"); a API monta o
 * `SettingsRegistry` a partir desta lista e recusa chave duplicada no boot.
 */

export const SETTING_GROUPS = [
  'labels',
  'branding',
  'numbering',
  'process',
  'access',
  'approval',
  'security',
  'deadlines',
  'calendar',
  'priceResearch',
  'risk',
  'uploads',
  'notifications',
  'features',
  'ai',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** Código de violação próprio de um módulo em vez do genérico `VALIDATION_ERROR` (RN-TEN-53). */
export type SettingViolationCode = 'NUMBERING_MASK_INVALID';

export interface SettingDefinition<T = unknown> {
  readonly key: string;
  readonly group: SettingGroup;
  /** Módulo dono da chave (DEC-040). */
  readonly module: string;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  /** Exposta em `SET-03` a qualquer vínculo ativo (RN-TEN-56: grupos `labels` e `branding`). */
  readonly isPublic: boolean;
  readonly violationCode?: SettingViolationCode;
}

/** Tamanho máximo da plataforma para um arquivo (storage.md §8), em MB. */
export const PLATFORM_MAX_FILE_SIZE_MB = 100;

/** Allowlist da plataforma no MVP 1 (storage.md §7); o tenant só pode restringir. */
export const PLATFORM_UPLOAD_EXTENSIONS = [
  'pdf',
  'docx',
  'xlsx',
  'odt',
  'ods',
  'csv',
  'txt',
  'png',
  'jpg',
  'jpeg',
] as const;

export const SETTING_FEATURE_KEY = /^features\.[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const MFA_POLICY_VALUES = ['NONE', 'ADMINS', 'ALL'] as const;
export const PRICE_DEFAULT_METHODS = ['AUTO_CV', 'MEAN', 'MEDIAN', 'LOWEST'] as const;
export const RISK_LEVEL_VALUES = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] as const;

/** Luminância relativa WCAG 2.x de uma cor `#RRGGBB`. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste da cor contra branco (texto branco sobre a cor da marca): mínimo AA = 4,5. */
export function contrastAgainstWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

const label = z.string().trim().min(1).max(60);

const primaryColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .transform((value) => value.toUpperCase())
  .refine((value) => contrastAgainstWhite(value) >= 4.5);

/** RN-TEN-67: `{seq:1..6}` e `{year}`; `{type}` só nas máscaras de documento. */
const processNumberingMask = z
  .string()
  .refine((mask) => isValidNumberingMask(mask, PROCESS_MASK_RULES));
const documentNumberingMask = z
  .string()
  .refine((mask) => isValidNumberingMask(mask, DOCUMENT_SETTING_MASK_RULES));

const scaleLabels = (max: number) => z.array(z.string().trim().min(1).max(40)).length(max);

const riskScale = z
  .strictObject({
    max: z.union([z.literal(3), z.literal(4), z.literal(5)]),
    probabilityLabels: z.array(z.string().trim().min(1).max(40)).min(3).max(5),
    impactLabels: z.array(z.string().trim().min(1).max(40)).min(3).max(5),
  })
  .refine(
    (scale) =>
      scaleLabels(scale.max).safeParse(scale.probabilityLabels).success &&
      scaleLabels(scale.max).safeParse(scale.impactLabels).success,
  );

/** Faixas contíguas e sem lacunas, a partir do escore 1, cada nível no máximo uma vez. */
const riskThresholds = z
  .array(
    z.strictObject({
      level: z.enum(RISK_LEVEL_VALUES),
      minScore: z.number().int().min(1).max(25),
      maxScore: z.number().int().min(1).max(25),
    }),
  )
  .min(1)
  .max(4)
  .refine((bands) => {
    const sorted = [...bands].sort((a, b) => a.minScore - b.minScore);
    if (sorted[0]?.minScore !== 1) return false;
    if (new Set(sorted.map((band) => band.level)).size !== sorted.length) return false;
    return sorted.every(
      (band, index) =>
        band.maxScore >= band.minScore &&
        (index === 0 || band.minScore === (sorted[index - 1]?.maxScore ?? 0) + 1),
    );
  });

/** `risk.scale` e `risk.levelThresholds` (DEC-021): lidos pelo módulo `risk` (US-033). */
export const riskScaleSettingSchema = riskScale;
export type RiskScaleSetting = z.infer<typeof riskScale>;
export const riskLevelThresholdsSettingSchema = riskThresholds;
export type RiskLevelThreshold = z.infer<typeof riskThresholds>[number];

const int = (min: number, max: number) => z.number().int().min(min).max(max);

function define<T>(definition: SettingDefinition<T>): SettingDefinition {
  return definition;
}

/** Chaves fixas de entities.md §6 (`features.<flag>` é dinâmica — `SETTING_FEATURE_KEY`). */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  define({
    key: 'labels.secretariat',
    group: 'labels',
    module: 'organization',
    schema: label,
    defaultValue: 'Secretaria',
    isPublic: true,
  }),
  define({
    key: 'labels.department',
    group: 'labels',
    module: 'organization',
    schema: label,
    defaultValue: 'Setor',
    isPublic: true,
  }),
  define({
    key: 'branding.primaryColor',
    group: 'branding',
    module: 'tenancy',
    schema: primaryColor,
    defaultValue: '#005BF9',
    isPublic: true,
  }),
  define({
    key: 'branding.logoAttachmentId',
    group: 'branding',
    module: 'tenancy',
    schema: z.uuid().nullable(),
    defaultValue: null,
    isPublic: true,
  }),
  define({
    key: 'numbering.process.mask',
    group: 'numbering',
    module: 'catalog',
    schema: processNumberingMask,
    defaultValue: DEFAULT_PROCESS_NUMBERING_MASK,
    isPublic: false,
    violationCode: 'NUMBERING_MASK_INVALID',
  }),
  define({
    key: 'numbering.process.scope',
    group: 'numbering',
    module: 'catalog',
    schema: z.enum(['TENANT', 'ORGANIZATION']),
    defaultValue: 'TENANT',
    isPublic: false,
  }),
  define({
    key: 'numbering.process.assignOn',
    group: 'numbering',
    module: 'catalog',
    schema: z.enum(['CREATE', 'START']),
    defaultValue: 'CREATE',
    isPublic: false,
  }),
  define({
    key: 'numbering.document.defaultMask',
    group: 'numbering',
    module: 'catalog',
    schema: documentNumberingMask,
    defaultValue: DEFAULT_DOCUMENT_NUMBERING_MASK,
    isPublic: false,
    violationCode: 'NUMBERING_MASK_INVALID',
  }),
  define({
    key: 'process.duplicateDetectionWindowMinutes',
    group: 'process',
    module: 'process',
    schema: int(0, 1440),
    defaultValue: 10,
    isPublic: false,
  }),
  define({
    key: 'process.requireInternalCode',
    group: 'process',
    module: 'process',
    schema: z.boolean(),
    defaultValue: false,
    // RN-TEN-56: o wizard de criação (US-001 FA-09) torna o campo obrigatório no passo 3.
    isPublic: true,
  }),
  define({
    key: 'access.historicalDepartmentsCanView',
    group: 'access',
    module: 'access',
    schema: z.boolean(),
    defaultValue: true,
    isPublic: false,
  }),
  define({
    key: 'approval.preventSelfApproval',
    group: 'approval',
    module: 'approval',
    schema: z.boolean(),
    defaultValue: true,
    isPublic: false,
  }),
  define({
    key: 'security.mfaPolicy',
    group: 'security',
    module: 'identity',
    schema: z.enum(MFA_POLICY_VALUES),
    defaultValue: 'ADMINS',
    isPublic: false,
  }),
  define({
    key: 'security.sessionIdleMinutes',
    group: 'security',
    module: 'identity',
    schema: int(5, 120),
    defaultValue: 30,
    isPublic: false,
  }),
  define({
    key: 'security.sessionAbsoluteHours',
    group: 'security',
    module: 'identity',
    schema: int(1, 24),
    defaultValue: 12,
    isPublic: false,
  }),
  define({
    key: 'security.externalMembershipMaxDays',
    group: 'security',
    module: 'identity',
    schema: int(1, 365),
    defaultValue: 180,
    isPublic: false,
  }),
  define({
    key: 'deadlines.warnBeforeBusinessDays',
    group: 'deadlines',
    module: 'workflow',
    schema: int(0, 10),
    defaultValue: 2,
    isPublic: false,
  }),
  define({
    key: 'calendar.optionalHolidaysAreNonBusiness',
    group: 'calendar',
    module: 'catalog',
    schema: z.boolean(),
    defaultValue: false,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.defaultMethod',
    group: 'priceResearch',
    module: 'price-research',
    schema: z.enum(PRICE_DEFAULT_METHODS),
    defaultValue: 'AUTO_CV',
    isPublic: false,
  }),
  define({
    key: 'priceResearch.cvThresholdPercent',
    group: 'priceResearch',
    module: 'price-research',
    schema: z.number().gt(0).max(1000),
    defaultValue: 25,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.minQuotations',
    group: 'priceResearch',
    module: 'price-research',
    schema: int(1, 10),
    defaultValue: 3,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.directQuoteMaxAgeDays',
    group: 'priceResearch',
    module: 'price-research',
    schema: int(1, 3650),
    defaultValue: 180,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.similarContractMaxAgeDays',
    group: 'priceResearch',
    module: 'price-research',
    schema: int(1, 3650),
    defaultValue: 365,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.outlierLowerPercent',
    group: 'priceResearch',
    module: 'price-research',
    schema: z.number().gt(0).max(100),
    defaultValue: 70,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.outlierUpperPercent',
    group: 'priceResearch',
    module: 'price-research',
    schema: z.number().min(100).max(1000),
    defaultValue: 130,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.unitPriceDecimals',
    group: 'priceResearch',
    module: 'price-research',
    schema: z.union([z.literal(2), z.literal(4)]),
    defaultValue: 2,
    isPublic: false,
  }),
  define({
    key: 'priceResearch.roundingMode',
    group: 'priceResearch',
    module: 'price-research',
    schema: z.enum(['HALF_UP', 'HALF_EVEN']),
    defaultValue: 'HALF_UP',
    isPublic: false,
  }),
  define({
    key: 'risk.scale',
    group: 'risk',
    module: 'risk',
    schema: riskScale,
    defaultValue: {
      max: 5,
      probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
      impactLabels: ['Muito baixo', 'Baixo', 'Médio', 'Alto', 'Muito alto'],
    },
    isPublic: false,
  }),
  define({
    key: 'risk.levelThresholds',
    group: 'risk',
    module: 'risk',
    schema: riskThresholds,
    defaultValue: [
      { level: 'LOW', minScore: 1, maxScore: 4 },
      { level: 'MEDIUM', minScore: 5, maxScore: 9 },
      { level: 'HIGH', minScore: 10, maxScore: 16 },
      { level: 'EXTREME', minScore: 17, maxScore: 25 },
    ],
    isPublic: false,
  }),
  define({
    key: 'uploads.maxFileSizeMb',
    group: 'uploads',
    module: 'files',
    schema: int(1, PLATFORM_MAX_FILE_SIZE_MB),
    defaultValue: 50,
    isPublic: false,
  }),
  define({
    key: 'uploads.allowedExtensions',
    group: 'uploads',
    module: 'files',
    schema: z
      .array(z.enum(PLATFORM_UPLOAD_EXTENSIONS))
      .min(1)
      .refine((extensions) => new Set(extensions).size === extensions.length),
    defaultValue: [...PLATFORM_UPLOAD_EXTENSIONS],
    isPublic: false,
  }),
  define({
    key: 'notifications.emailEnabled',
    group: 'notifications',
    module: 'notification',
    schema: z.boolean(),
    defaultValue: true,
    isPublic: false,
  }),
  // US-116 (RN-AI-16..19 · DEC-079): IA opt-in do órgão, termos aceitos e limites de uso. O teto
  // do limite mensal é o da plataforma (`AI_TENANT_MAX_MONTHLY_TOKENS`), conferido pela API; ligar
  // exige o aceite da versão vigente dos termos (422 `AI_TERMS_NOT_ACCEPTED`). Nunca públicas.
  define({
    key: 'ai.enabled',
    group: 'ai',
    module: 'ai',
    schema: z.boolean(),
    defaultValue: false,
    isPublic: false,
  }),
  define({
    key: 'ai.termsAcceptedVersion',
    group: 'ai',
    module: 'ai',
    schema: z.string().trim().min(1).max(20).nullable(),
    defaultValue: null,
    isPublic: false,
  }),
  define({
    key: 'ai.monthlyTokenLimit',
    group: 'ai',
    module: 'ai',
    schema: int(AI_MONTHLY_TOKEN_LIMIT_MIN, AI_MONTHLY_TOKEN_LIMIT_CEILING),
    defaultValue: AI_MONTHLY_TOKEN_LIMIT_DEFAULT,
    isPublic: false,
  }),
  define({
    key: 'ai.userDailyRequestLimit',
    group: 'ai',
    module: 'ai',
    schema: int(AI_USER_DAILY_REQUEST_LIMIT_MIN, AI_USER_DAILY_REQUEST_LIMIT_MAX),
    defaultValue: AI_USER_DAILY_REQUEST_LIMIT_DEFAULT,
    isPublic: false,
  }),
];

/** Esquema de uma flag `features.<nome>` (DEC-059): booleano, padrão desligada, nunca pública. */
export const FEATURE_FLAG_SCHEMA = z.boolean();

/**
 * Máscara própria de um tipo de documento nas configurações (`numbering.document.<TYPE>.mask` —
 * RN-TEN-72): chave dinâmica como `features.<flag>`, sem padrão (ausente = `defaultMask`), nunca
 * pública e não semeada.
 */
export const SETTING_DOCUMENT_MASK_KEY = new RegExp(
  `^numbering\\.document\\.(${DOCUMENT_TYPE_CODE_PATTERN.source.slice(1, -1)})\\.mask$`,
);
export const DOCUMENT_MASK_SETTING_SCHEMA = documentNumberingMask;

/** Chave da máscara própria do tipo nas configurações (`numbering.document.<TYPE>.mask`). */
export function documentMaskSettingKey(documentTypeCode: string): string {
  return `numbering.document.${documentTypeCode}.mask`;
}

/** Schema Zod da chave (fixa ou dinâmica); `null` fora do registro — usado também pelo front. */
export function settingSchemaOf(key: string): z.ZodType | null {
  const fixed = SETTING_DEFINITIONS.find((definition) => definition.key === key);
  if (fixed) return fixed.schema;
  if (SETTING_DOCUMENT_MASK_KEY.test(key)) return DOCUMENT_MASK_SETTING_SCHEMA;
  return SETTING_FEATURE_KEY.test(key) ? FEATURE_FLAG_SCHEMA : null;
}

/** Grupo da SCR-041 de uma chave (prefixo antes do primeiro ponto). */
export function settingGroupOf(key: string): SettingGroup | null {
  const prefix = key.split('.')[0] ?? '';
  return (SETTING_GROUPS as readonly string[]).includes(prefix) ? (prefix as SettingGroup) : null;
}

/*
 * Contratos HTTP (SET-01..03 · api/14-tenant-administration.md).
 */

export const SETTING_KEY_MAX_LENGTH = 120;

const settingKey = z.string().min(1).max(SETTING_KEY_MAX_LENGTH);

/** Valor e versão de uma chave (SET-01/SET-02). */
export const settingEntrySchema = z.object({
  value: z.unknown(),
  version: z.number().int().min(0),
});
export type SettingEntryDto = z.infer<typeof settingEntrySchema>;

export const settingsMapSchema = z.record(settingKey, settingEntrySchema);
export type SettingsMapDto = z.infer<typeof settingsMapSchema>;

export const settingsResponseSchema = dataEnvelope(settingsMapSchema);

/**
 * `meta` do SET-01 (US-116 · DEC-079): versão vigente dos termos de uso da IA (`AI_TERMS_VERSION`),
 * provedor da plataforma e teto do limite mensal (`AI_TENANT_MAX_MONTHLY_TOKENS`).
 */
export const settingsMetaSchema = z.object({
  aiTerms: z.object({
    currentVersion: z.string(),
    provider: z.string(),
    maxMonthlyTokens: z.number().int().min(1),
  }),
});
export type SettingsMetaDto = z.infer<typeof settingsMetaSchema>;

export const settingsWithMetaResponseSchema = z.object({
  data: settingsMapSchema,
  meta: settingsMetaSchema,
});

/** SET-03: só valores das chaves públicas. */
export const publicSettingsResponseSchema = dataEnvelope(z.record(settingKey, z.unknown()));

/**
 * Corpo do SET-02 (RN-TEN-54). `values` e `expectedVersions` são conferidos chave a chave pela API
 * (chave desconhecida, versão ausente), por isso o schema só garante a forma.
 */
export const updateSettingsSchema = z.object({
  values: z.record(settingKey, z.unknown()),
  expectedVersions: z.record(settingKey, z.number().int().min(0)).default({}),
});
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
