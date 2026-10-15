import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';

/*
 * Tipos de documento (US-061 · entities.md §4.7/§5.7 · api/03-documents.md DTY-01..03). Schemas
 * compartilhados pela API (corpo/query/resposta) e pelo SCR-108 (`documentTypeCreateSchema`).
 */

export const DOCUMENT_KINDS = ['STRUCTURED', 'FREE_TEXT', 'UPLOADED'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
/** Naturezas que o tenant pode criar (RN-DOC-01). */
export const CUSTOM_DOCUMENT_KINDS = ['FREE_TEXT', 'UPLOADED'] as const;

export const SYSTEM_DOCUMENT_MODULES = [
  'DFD',
  'ETP',
  'TERM_OF_REFERENCE',
  'RISK_MAP',
  'PRICE_RESEARCH',
] as const;
export type SystemDocumentModule = (typeof SYSTEM_DOCUMENT_MODULES)[number];

export const CONFIDENTIALITIES = ['PUBLIC', 'INTERNAL', 'RESTRICTED'] as const;
export type Confidentiality = (typeof CONFIDENTIALITIES)[number];

export const APPROVER_TYPES = ['USER', 'ROLE', 'DEPARTMENT_HEAD'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

export const DEPARTMENT_RESOLUTIONS = [
  'FIXED',
  'REQUESTING_SECRETARIAT',
  'REQUESTING_DEPARTMENT',
] as const;
export type DepartmentResolution = (typeof DEPARTMENT_RESOLUTIONS)[number];

export const DAY_COUNT_TYPES = ['BUSINESS', 'CALENDAR'] as const;
export type DayCountType = (typeof DAY_COUNT_TYPES)[number];

/** RN-DOC-02. */
export const DOCUMENT_TYPE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

export const documentTypeCodeSchema = z
  .string({ error: 'Informe o código do tipo.' })
  .regex(DOCUMENT_TYPE_CODE_PATTERN, {
    error: 'Use letras maiúsculas, números e _ (ex.: PARECER_TECNICO).',
  });

const nameSchema = trimmedString({ min: 3, max: 120 });
const descriptionSchema = z
  .string()
  .trim()
  .max(2000, { error: 'Informe no máximo 2.000 caracteres.' });
const sortOrderSchema = z
  .number()
  .int()
  .min(0, { error: 'A ordem deve estar entre 0 e 999.' })
  .max(999, { error: 'A ordem deve estar entre 0 e 999.' });

const SLA_MESSAGE = 'O prazo deve estar entre 1 e 365 dias.';

/** `ApprovalPolicy` (entities.md §5.7) com as condicionais sintáticas de RN-DOC-07. */
export const approvalPolicySchema = z
  .strictObject({
    approverType: z.enum(APPROVER_TYPES),
    approverUserId: uuidV7Schema.optional(),
    approverRoleId: uuidV7Schema.optional(),
    approverDepartmentResolution: z.enum(DEPARTMENT_RESOLUTIONS).optional(),
    approverFixedDepartmentId: uuidV7Schema.optional(),
    allowDeputy: z.boolean(),
    slaDays: z
      .number()
      .int({ error: SLA_MESSAGE })
      .min(1, { error: SLA_MESSAGE })
      .max(365, { error: SLA_MESSAGE })
      .optional(),
    slaType: z.enum(DAY_COUNT_TYPES).optional(),
  })
  .superRefine((policy, ctx) => {
    const required = (field: string, present: boolean) => {
      if (present) return;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: 'Campo obrigatório nesta situação.',
        params: { code: 'CONDITIONAL_REQUIRED' },
      });
    };
    if (policy.approverType === 'USER') required('approverUserId', Boolean(policy.approverUserId));
    if (policy.approverType === 'ROLE') required('approverRoleId', Boolean(policy.approverRoleId));
    if (policy.approverType === 'DEPARTMENT_HEAD') {
      required('approverDepartmentResolution', Boolean(policy.approverDepartmentResolution));
      if (policy.approverDepartmentResolution === 'FIXED') {
        required('approverFixedDepartmentId', Boolean(policy.approverFixedDepartmentId));
      }
    }
  });

export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

const confidentialitySchema = z.enum(CONFIDENTIALITIES);

/** DTY-02 (corpo). `kind = STRUCTURED` não é aceito (V-03 → `INVALID_ENUM`). */
export const documentTypeCreateSchema = z
  .strictObject({
    kind: z.enum(CUSTOM_DOCUMENT_KINDS),
    code: documentTypeCodeSchema,
    name: nameSchema,
    description: descriptionSchema.optional(),
    allowMultiplePerProcess: z.boolean(),
    numberingEnabled: z.boolean(),
    numberingMask: z.string().nullish(),
    requiresApproval: z.boolean(),
    approvalPolicy: approvalPolicySchema.nullish(),
    defaultConfidentiality: confidentialitySchema,
    sortOrder: sortOrderSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.requiresApproval && !value.approvalPolicy) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvalPolicy'],
        message: 'Defina quem aprova documentos deste tipo.',
        params: { code: 'CONDITIONAL_REQUIRED' },
      });
    }
  });
export type DocumentTypeCreate = z.infer<typeof documentTypeCreateSchema>;

/** Campos editáveis por DTY-03 (RN-DOC-03); `code`/`kind` e demais são `NOT_ALLOWED` (V-04). */
export const DOCUMENT_TYPE_UPDATABLE_FIELDS = [
  'name',
  'description',
  'allowMultiplePerProcess',
  'numberingEnabled',
  'numberingMask',
  'requiresApproval',
  'approvalPolicy',
  'defaultConfidentiality',
  'sortOrder',
  'isActive',
] as const;
export type DocumentTypeUpdatableField = (typeof DOCUMENT_TYPE_UPDATABLE_FIELDS)[number];

export const documentTypeUpdateSchema = z
  .strictObject({
    name: nameSchema,
    description: descriptionSchema.nullable(),
    allowMultiplePerProcess: z.boolean(),
    numberingEnabled: z.boolean(),
    numberingMask: z.string().nullable(),
    requiresApproval: z.boolean(),
    approvalPolicy: approvalPolicySchema.nullable(),
    defaultConfidentiality: confidentialitySchema,
    sortOrder: sortOrderSchema,
    isActive: z.boolean(),
  })
  .partial();
export type DocumentTypeUpdate = z.infer<typeof documentTypeUpdateSchema>;

export const documentTypeIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** DTY-01 (query): `kind` aceita lista separada por vírgula (OU). */
export const documentTypeListQuerySchema = z.strictObject({
  includeInactive: booleanQuery,
  kind: z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()))
    .pipe(z.array(z.enum(DOCUMENT_KINDS)).min(1))
    .optional(),
  q: z.string().trim().max(120).optional(),
});
export type DocumentTypeListQuery = z.infer<typeof documentTypeListQuerySchema>;

/** `DocumentType` da resposta (DTY-01..03). */
export const documentTypeSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(DOCUMENT_KINDS),
  systemModule: z.enum(SYSTEM_DOCUMENT_MODULES).nullable(),
  isSystem: z.boolean(),
  isActive: z.boolean(),
  allowMultiplePerProcess: z.boolean(),
  numberingEnabled: z.boolean(),
  numberingMask: z.string().nullable(),
  /** Prévia do próximo número (SET-04); `null` com a numeração desligada. */
  nextNumberPreview: z.string().nullable(),
  requiresApproval: z.boolean(),
  approvalPolicy: approvalPolicySchema.nullable(),
  defaultConfidentiality: z.enum(CONFIDENTIALITIES),
  defaultTemplate: z
    .object({ id: z.uuid(), name: z.string(), versionNumber: z.number().int() })
    .nullable(),
  sortOrder: z.number().int(),
  /** Campos que o chamador pode alterar neste tipo (RN-DOC-03). */
  editableFields: z.array(z.enum(DOCUMENT_TYPE_UPDATABLE_FIELDS)),
  version: z.number().int(),
});
export type DocumentTypeDto = z.infer<typeof documentTypeSchema>;
