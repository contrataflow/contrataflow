import { z } from 'zod';

import { isValidCnpj, normalizeCnpj } from '../common/cnpj.js';
import { isValidCpf, maskCpf, normalizeCpf } from '../common/cpf.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';
import { pageQuerySchema } from '../http/pagination.js';
import { adminEmailSchema } from '../tenancy/tenant.js';

/*
 * Fornecedores do tenant (US-025 · entities.md §4 `Supplier` · api/07-price-research-suppliers.md
 * SUP-01..06 · RN-PRICE-14..20). Schemas compartilhados pela API (corpo/query/resposta) e pelo
 * SCR-107. O número do documento é validado pelo tipo (dígito verificador de CNPJ numérico ou
 * alfanumérico — IN RFB 2.229/2024 — e de CPF) e normalizado pela aplicação (`normalizeSupplierDocument`).
 */

const SELECT_MESSAGE = 'Selecione um valor válido.';

/** entities.md §2 — `SupplierDocumentType`. */
export const SUPPLIER_DOCUMENT_TYPES = ['CNPJ', 'CPF', 'FOREIGN'] as const;
export type SupplierDocumentType = (typeof SUPPLIER_DOCUMENT_TYPES)[number];

/** RN-PRICE-18: documento estrangeiro livre, até 20 caracteres. */
export const FOREIGN_DOCUMENT_MAX = 20;

export const SUPPLIER_LEGAL_NAME_MIN = 2;
export const SUPPLIER_LEGAL_NAME_MAX = 250;
export const SUPPLIER_NOTES_MAX = 5_000;

export const CNPJ_SUPPLIER_INVALID_MESSAGE = 'CNPJ inválido. Verifique o número digitado.';
export const CPF_SUPPLIER_INVALID_MESSAGE = 'CPF inválido. Verifique o número digitado.';
export const SUPPLIER_DOCUMENT_IMMUTABLE_MESSAGE =
  'Documento não pode ser alterado. Cadastre um novo fornecedor.';

/** Número do documento sem máscara: CNPJ (maiúsculas), CPF (dígitos) ou estrangeiro (trim). */
export function normalizeSupplierDocument(type: SupplierDocumentType, raw: string): string {
  switch (type) {
    case 'CNPJ':
      return normalizeCnpj(raw);
    case 'CPF':
      return normalizeCpf(raw);
    case 'FOREIGN':
      return raw.trim().replace(/\s+/g, ' ');
  }
}

/** Erro de formato/dígito do número (já normalizado) para o tipo; `null` = válido. */
export function supplierDocumentIssue(
  type: SupplierDocumentType,
  normalized: string,
): { readonly code: 'INVALID_CNPJ' | 'INVALID_CPF' | 'TOO_LONG'; readonly message: string } | null {
  switch (type) {
    case 'CNPJ':
      return isValidCnpj(normalized)
        ? null
        : { code: 'INVALID_CNPJ', message: CNPJ_SUPPLIER_INVALID_MESSAGE };
    case 'CPF':
      return isValidCpf(normalized)
        ? null
        : { code: 'INVALID_CPF', message: CPF_SUPPLIER_INVALID_MESSAGE };
    case 'FOREIGN':
      return normalized.length > FOREIGN_DOCUMENT_MAX
        ? {
            code: 'TOO_LONG',
            message: `Informe no máximo ${FOREIGN_DOCUMENT_MAX} caracteres.`,
          }
        : null;
  }
}

/** Número exibido/guardado em `documentNumber`: CPF mascarado; CNPJ e estrangeiro em claro. */
export function displaySupplierDocument(type: SupplierDocumentType, normalized: string): string {
  return type === 'CPF' ? maskCpf(normalized) : normalized;
}

/** RN-PRICE-14 + V-05: `http(s)://` com host. */
export const SUPPLIER_WEBSITE_MESSAGE = 'Informe um website válido.';

const supplierWebsiteSchema = z
  .string()
  .trim()
  .max(255, { error: 'Informe no máximo 255 caracteres.' })
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && url.hostname.length > 0;
      } catch {
        return false;
      }
    },
    { message: SUPPLIER_WEBSITE_MESSAGE, params: { code: 'INVALID_FORMAT' } },
  );

const addressPart = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Informe no máximo ${max} caracteres.` });
const stateSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, { error: 'Informe a UF com 2 letras.' })
  .transform((value) => value.toUpperCase());
/** CEP com ou sem máscara → 8 dígitos. */
const zipCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[.\-\s]/g, ''))
  .refine((value) => /^\d{8}$/.test(value), {
    message: 'Informe o CEP com 8 dígitos.',
    params: { code: 'INVALID_FORMAT' },
  });

/** Campos opcionais de contato, endereço e observações (`null` limpa, no SUP-04). */
const optionalFields = {
  tradeName: addressPart(250).nullish(),
  email: adminEmailSchema.nullish(),
  phone: addressPart(20).nullish(),
  website: supplierWebsiteSchema.nullish(),
  contactName: addressPart(150).nullish(),
  addressStreet: addressPart(200).nullish(),
  addressNumber: addressPart(20).nullish(),
  addressComplement: addressPart(100).nullish(),
  addressDistrict: addressPart(100).nullish(),
  addressCity: addressPart(100).nullish(),
  addressState: stateSchema.nullish(),
  addressZipCode: zipCodeSchema.nullish(),
  notes: addressPart(SUPPLIER_NOTES_MAX).nullish(),
};

const documentTypeSchema = z
  .string({ error: 'Informe o tipo de documento.' })
  .pipe(z.enum(SUPPLIER_DOCUMENT_TYPES, { error: SELECT_MESSAGE }))
  .meta({ enum: [...SUPPLIER_DOCUMENT_TYPES] });

const documentNumberSchema = z
  .string({ error: 'Informe o número do documento.' })
  .trim()
  .min(1, { error: 'Informe o número do documento.' })
  .max(30, { error: 'Informe no máximo 30 caracteres.' });

const legalNameSchema = trimmedString({
  min: SUPPLIER_LEGAL_NAME_MIN,
  max: SUPPLIER_LEGAL_NAME_MAX,
});

/** RN-PRICE-15/16/18 (V-02/V-03): o número confere com o tipo escolhido. */
function documentMatchesType(
  value: { documentType?: SupplierDocumentType | undefined; documentNumber?: string | undefined },
  ctx: z.RefinementCtx<typeof value>,
): void {
  if (value.documentType === undefined || value.documentNumber === undefined) return;
  const issue = supplierDocumentIssue(
    value.documentType,
    normalizeSupplierDocument(value.documentType, value.documentNumber),
  );
  if (issue) {
    ctx.addIssue({
      code: 'custom',
      path: ['documentNumber'],
      message: issue.message,
      params: { code: issue.code },
    });
  }
}

/** SUP-02. `documentType`/`documentNumber` são imutáveis depois da criação (RN-PRICE-14). */
export const createSupplierSchema = z
  .object({
    documentType: documentTypeSchema,
    documentNumber: documentNumberSchema,
    legalName: legalNameSchema,
    ...optionalFields,
  })
  .superRefine(documentMatchesType);
export type CreateSupplier = z.output<typeof createSupplierSchema>;
export type CreateSupplierInput = z.input<typeof createSupplierSchema>;

/**
 * SUP-04: campos de SUP-02 opcionais (`null` limpa um opcional) + `isActive` (inativar/reativar —
 * RN-PRICE-20). `documentType`/`documentNumber` só são aceitos iguais aos atuais (422 `NOT_ALLOWED`
 * se diferirem — V-07).
 */
export const updateSupplierSchema = z.object({
  documentType: documentTypeSchema.optional(),
  documentNumber: documentNumberSchema.optional(),
  legalName: legalNameSchema.optional(),
  ...optionalFields,
  isActive: z.boolean({ error: 'Informe verdadeiro ou falso.' }).optional(),
});
export type UpdateSupplier = z.output<typeof updateSupplierSchema>;
export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>;

export const supplierIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** SUP-01 (query): `q` com no mínimo 2 caracteres (api.md §1.2). */
export const supplierListQuerySchema = pageQuerySchema.extend({
  q: z
    .string()
    .trim()
    .min(2, { error: 'Informe ao menos 2 caracteres para buscar.' })
    .max(120, { error: 'Informe no máximo 120 caracteres.' })
    .optional(),
  isActive: booleanQuery,
});
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

/** SUP-06 (query). */
export const supplierLookupQuerySchema = z.strictObject({
  documentNumber: z
    .string({ error: 'Informe o número do documento.' })
    .trim()
    .min(1, { error: 'Informe o número do documento.' })
    .max(30, { error: 'Informe no máximo 30 caracteres.' }),
});
export type SupplierLookupQuery = z.infer<typeof supplierLookupQuerySchema>;

/** `Supplier` da resposta (SUP-01..06): o CPF sempre mascarado (RN-PRICE-16). */
export const supplierSchema = z.object({
  id: z.uuid(),
  documentType: z.enum(SUPPLIER_DOCUMENT_TYPES),
  documentNumber: z.string(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  contactName: z.string().nullable(),
  addressStreet: z.string().nullable(),
  addressNumber: z.string().nullable(),
  addressComplement: z.string().nullable(),
  addressDistrict: z.string().nullable(),
  addressCity: z.string().nullable(),
  addressState: z.string().nullable(),
  addressZipCode: z.string().nullable(),
  isActive: z.boolean(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.int(),
});
export type SupplierDto = z.infer<typeof supplierSchema>;
