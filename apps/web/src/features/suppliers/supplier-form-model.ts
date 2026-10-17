import {
  SUPPLIER_DOCUMENT_TYPES,
  createSupplierSchema,
  maskCpf,
  normalizeCnpj,
  normalizeCpf,
  normalizeSupplierDocument,
  supplierDocumentIssue,
  updateSupplierSchema,
} from '@contrataflow/validation';
import type {
  CreateSupplierInput,
  SupplierDocumentType,
  SupplierDto,
  UpdateSupplierInput,
} from '@contrataflow/validation';

/*
 * Modelo do formulário de fornecedor (US-025 · SCR-107): valores em texto (campos vazios =
 * ausentes), máscara do documento por tipo, conversão para o corpo de SUP-02/SUP-04 e validação com
 * os MESMOS schemas Zod da API (`createSupplierSchema`/`updateSupplierSchema`). A edição envia só o
 * que mudou — o documento é imutável e nunca vai no corpo (RN-PRICE-14).
 */

export { SUPPLIER_DOCUMENT_TYPES };

export const OPTIONAL_FIELDS = [
  'tradeName',
  'email',
  'phone',
  'website',
  'contactName',
  'addressStreet',
  'addressNumber',
  'addressComplement',
  'addressDistrict',
  'addressCity',
  'addressState',
  'addressZipCode',
  'notes',
] as const;
export type OptionalField = (typeof OPTIONAL_FIELDS)[number];

export const REQUIRED_FIELDS = ['documentType', 'documentNumber', 'legalName'] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export interface FormValues {
  documentType: SupplierDocumentType;
  /** Com máscara de exibição (CNPJ `00.000.000/0000-00`, CPF `000.000.000-00`). */
  documentNumber: string;
  legalName: string;
  isActive: boolean;
  tradeName: string;
  email: string;
  phone: string;
  website: string;
  contactName: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement: string;
  addressDistrict: string;
  addressCity: string;
  addressState: string;
  addressZipCode: string;
  notes: string;
}

export type FormField = keyof FormValues;
export type FieldProblems = Partial<Record<FormField, string>>;

/** Tamanho do documento sem máscara por tipo; estrangeiro não tem tamanho fixo. */
const CNPJ_LENGTH = 14;
const CPF_LENGTH = 11;
const FOREIGN_MAX = 20;

/** Máscara progressiva `XX.XXX.XXX/XXXX-XX` (aceita o CNPJ alfanumérico). */
export function formatCnpj(value: string): string {
  const raw = normalizeCnpj(value)
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, CNPJ_LENGTH);
  const groups = [
    raw.slice(0, 2),
    raw.slice(2, 5),
    raw.slice(5, 8),
    raw.slice(8, 12),
    raw.slice(12),
  ];
  const [a = '', b = '', c = '', d = '', e = ''] = groups;
  let out = a;
  if (b) out += `.${b}`;
  if (c) out += `.${c}`;
  if (d) out += `/${d}`;
  if (e) out += `-${e}`;
  return out;
}

/** Máscara progressiva `000.000.000-00` sobre os dígitos digitados. */
export function formatCpf(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, CPF_LENGTH);
  const [a, b, c, d] = [
    digits.slice(0, 3),
    digits.slice(3, 6),
    digits.slice(6, 9),
    digits.slice(9),
  ];
  let out = a;
  if (b) out += `.${b}`;
  if (c) out += `.${c}`;
  if (d) out += `-${d}`;
  return out;
}

/** Máscara do número conforme o tipo; estrangeiro fica como digitado (até 20 caracteres). */
export function formatDocument(type: SupplierDocumentType, value: string): string {
  switch (type) {
    case 'CNPJ':
      return formatCnpj(value);
    case 'CPF':
      return formatCpf(value);
    case 'FOREIGN':
      return value.slice(0, FOREIGN_MAX);
  }
}

/** O número tem o tamanho completo do tipo (momento de conferir o dígito verificador). */
export function isDocumentComplete(type: SupplierDocumentType, value: string): boolean {
  switch (type) {
    case 'CNPJ':
      return normalizeCnpj(value).length === CNPJ_LENGTH;
    case 'CPF':
      return normalizeCpf(value).length === CPF_LENGTH;
    case 'FOREIGN':
      return value.trim().length > 0;
  }
}

/** Código de erro do dígito verificador/tamanho do número no tipo (V-02/V-03), ou `null`. */
export function documentProblem(
  type: SupplierDocumentType,
  value: string,
): 'INVALID_CNPJ' | 'INVALID_CPF' | 'TOO_LONG' | null {
  if (!isDocumentComplete(type, value)) {
    return type === 'FOREIGN' ? null : type === 'CNPJ' ? 'INVALID_CNPJ' : 'INVALID_CPF';
  }
  return supplierDocumentIssue(type, normalizeSupplierDocument(type, value))?.code ?? null;
}

export function emptyValues(): FormValues {
  return {
    documentType: 'CNPJ',
    documentNumber: '',
    legalName: '',
    isActive: true,
    tradeName: '',
    email: '',
    phone: '',
    website: '',
    contactName: '',
    addressStreet: '',
    addressNumber: '',
    addressComplement: '',
    addressDistrict: '',
    addressCity: '',
    addressState: '',
    addressZipCode: '',
    notes: '',
  };
}

export function initialValues(supplier?: SupplierDto): FormValues {
  if (!supplier) return emptyValues();
  return {
    documentType: supplier.documentType,
    // CNPJ ganha a máscara; o CPF já vem mascarado da API (`***.444.777-**`); estrangeiro, como está.
    documentNumber:
      supplier.documentType === 'CNPJ'
        ? formatCnpj(supplier.documentNumber)
        : supplier.documentNumber,
    legalName: supplier.legalName,
    isActive: supplier.isActive,
    tradeName: supplier.tradeName ?? '',
    email: supplier.email ?? '',
    phone: supplier.phone ?? '',
    website: supplier.website ?? '',
    contactName: supplier.contactName ?? '',
    addressStreet: supplier.addressStreet ?? '',
    addressNumber: supplier.addressNumber ?? '',
    addressComplement: supplier.addressComplement ?? '',
    addressDistrict: supplier.addressDistrict ?? '',
    addressCity: supplier.addressCity ?? '',
    addressState: supplier.addressState ?? '',
    addressZipCode: supplier.addressZipCode ?? '',
    notes: supplier.notes ?? '',
  };
}

/** Corpo de SUP-02: campos opcionais vazios saem do corpo. */
export function buildCreateBody(values: FormValues): CreateSupplierInput {
  const body: Record<string, unknown> = {
    documentType: values.documentType,
    documentNumber: values.documentNumber,
    legalName: values.legalName,
  };
  for (const field of OPTIONAL_FIELDS) {
    const value = values[field].trim();
    if (value !== '') body[field] = value;
  }
  return body as CreateSupplierInput;
}

/** Valor normalizado de um campo, para comparar o formulário com o fornecedor carregado. */
function normalized(field: FormField, value: string | boolean): string | boolean {
  if (typeof value === 'boolean') return value;
  const text = value.trim();
  if (field === 'addressState') return text.toUpperCase();
  if (field === 'email') return text.toLowerCase();
  if (field === 'addressZipCode') return text.replace(/[.\-\s]/g, '');
  return text;
}

/**
 * Corpo de SUP-04 com SÓ o que mudou em relação ao fornecedor carregado; campo opcional esvaziado
 * vai como `null`. O documento (tipo e número) nunca entra: é imutável. `isActive` só entra se a
 * pessoa o alterou.
 */
export function buildPatch(values: FormValues, base: SupplierDto): UpdateSupplierInput {
  const before = initialValues(base);
  const patch: Record<string, unknown> = {};
  if (normalized('legalName', values.legalName) !== normalized('legalName', before.legalName)) {
    patch.legalName = values.legalName;
  }
  for (const field of OPTIONAL_FIELDS) {
    if (normalized(field, values[field]) === normalized(field, before[field])) continue;
    const value = values[field].trim();
    patch[field] = value === '' ? null : value;
  }
  if (values.isActive !== before.isActive) patch.isActive = values.isActive;
  return patch;
}

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function problemsOf(issues: readonly IssueLike[]): FieldProblems {
  const problems: FieldProblems = {};
  for (const issue of issues) {
    const field = String(issue.path[0] ?? '') as FormField;
    if (field !== ('' as FormField)) problems[field] ??= issue.message;
  }
  return problems;
}

/** SUP-02 no cliente: obrigatórios vazios → "Informe o campo …" (V-01); o resto, do Zod. */
export function validateCreate(
  values: FormValues,
  requiredMessage: (field: RequiredField) => string,
): FieldProblems {
  const result = createSupplierSchema.safeParse(buildCreateBody(values));
  const problems = result.success ? {} : problemsOf(result.error.issues);
  for (const field of REQUIRED_FIELDS) {
    if (values[field].trim() === '') problems[field] = requiredMessage(field);
  }
  return problems;
}

/** SUP-04 no cliente: valida só o que vai no corpo. */
export function validatePatch(
  patch: UpdateSupplierInput,
  requiredMessage: (field: RequiredField) => string,
): FieldProblems {
  const result = updateSupplierSchema.safeParse(patch);
  const problems = result.success ? {} : problemsOf(result.error.issues);
  const legalName = (patch as Record<string, unknown>).legalName;
  if (typeof legalName === 'string' && legalName.trim() === '') {
    problems.legalName = requiredMessage('legalName');
  }
  return problems;
}

/** Documento exibível na lista: CNPJ mascarado; CPF já mascarado pela API; estrangeiro como está. */
export function displayDocument(supplier: Pick<SupplierDto, 'documentType' | 'documentNumber'>) {
  if (supplier.documentType === 'CNPJ') return formatCnpj(supplier.documentNumber);
  if (supplier.documentType === 'CPF') return maskCpf(supplier.documentNumber);
  return supplier.documentNumber;
}
