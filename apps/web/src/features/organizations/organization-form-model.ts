import {
  createOrganizationSchema,
  normalizeCnpj,
  updateOrganizationSchema,
} from '@contrataflow/validation';
import type {
  CreateOrganizationInput,
  OrganizationDto,
  OrganizationType,
  UpdateOrganizationInput,
} from '@contrataflow/validation';

/*
 * Modelo do formulário de órgão (US-101 · SCR-032): valores em texto (campos vazios = ausentes),
 * conversão para o corpo de ORG-02/ORG-04 e validação com os MESMOS schemas Zod da API
 * (`createOrganizationSchema`/`updateOrganizationSchema`). Edição envia só o que mudou.
 */

export const OPTIONAL_FIELDS = [
  'email',
  'phone',
  'website',
  'addressStreet',
  'addressNumber',
  'addressComplement',
  'addressDistrict',
  'addressCity',
  'addressState',
  'addressZipCode',
  'ibgeCityCode',
] as const;
export type OptionalField = (typeof OPTIONAL_FIELDS)[number];

export const REQUIRED_FIELDS = ['name', 'shortName', 'cnpj', 'type'] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export interface FormValues {
  name: string;
  shortName: string;
  /** Com máscara de exibição (`11.222.333/0001-81`). */
  cnpj: string;
  type: OrganizationType | '';
  isActive: boolean;
  email: string;
  phone: string;
  website: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement: string;
  addressDistrict: string;
  addressCity: string;
  addressState: string;
  addressZipCode: string;
  ibgeCityCode: string;
}

export type FormField = keyof FormValues;
export type FieldProblems = Partial<Record<FormField | 'logoAttachmentId', string>>;

/** Nomes dos campos obrigatórios na mensagem "Informe o campo {field}." (V-01). */
export type RequiredLabels = Readonly<Record<RequiredField, string>>;

const CNPJ_MASK_GROUPS: readonly [number, number][] = [
  [0, 2],
  [2, 5],
  [5, 8],
  [8, 12],
  [12, 14],
];

/**
 * Máscara progressiva `XX.XXX.XXX/XXXX-XX` sobre o CNPJ normalizado (14 posições; letras em
 * maiúsculas — CNPJ alfanumérico). Texto além de 14 posições é descartado.
 */
export function formatCnpj(value: string): string {
  const raw = normalizeCnpj(value)
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 14);
  const [a = '', b = '', c = '', d = '', e = ''] = CNPJ_MASK_GROUPS.map(([from, to]) =>
    raw.slice(from, to),
  );
  let out = a;
  if (b) out += `.${b}`;
  if (c) out += `.${c}`;
  if (d) out += `/${d}`;
  if (e) out += `-${e}`;
  return out;
}

export function emptyValues(): FormValues {
  return {
    name: '',
    shortName: '',
    cnpj: '',
    type: '',
    isActive: true,
    email: '',
    phone: '',
    website: '',
    addressStreet: '',
    addressNumber: '',
    addressComplement: '',
    addressDistrict: '',
    addressCity: '',
    addressState: '',
    addressZipCode: '',
    ibgeCityCode: '',
  };
}

export function initialValues(organization?: OrganizationDto): FormValues {
  if (!organization) return emptyValues();
  return {
    name: organization.name,
    shortName: organization.shortName,
    cnpj: formatCnpj(organization.cnpj),
    type: organization.type,
    isActive: organization.isActive,
    email: organization.email ?? '',
    phone: organization.phone ?? '',
    website: organization.website ?? '',
    addressStreet: organization.addressStreet ?? '',
    addressNumber: organization.addressNumber ?? '',
    addressComplement: organization.addressComplement ?? '',
    addressDistrict: organization.addressDistrict ?? '',
    addressCity: organization.addressCity ?? '',
    addressState: organization.addressState ?? '',
    addressZipCode: organization.addressZipCode ?? '',
    ibgeCityCode: organization.ibgeCityCode ?? '',
  };
}

/** Corpo de ORG-02: campos opcionais vazios saem do corpo. */
export function buildCreateBody(values: FormValues): CreateOrganizationInput {
  const body: Record<string, unknown> = {
    name: values.name,
    shortName: values.shortName,
    cnpj: values.cnpj,
    type: values.type === '' ? undefined : values.type,
  };
  for (const field of OPTIONAL_FIELDS) {
    const value = values[field].trim();
    if (value !== '') body[field] = value;
  }
  return body as CreateOrganizationInput;
}

/** Valor normalizado de um campo, para comparar o formulário com o órgão carregado. */
function normalized(field: FormField, value: string | boolean): string | boolean {
  if (typeof value === 'boolean') return value;
  const text = value.trim();
  if (field === 'cnpj') return normalizeCnpj(text);
  if (field === 'shortName' || field === 'addressState') return text.toUpperCase();
  if (field === 'email') return text.toLowerCase();
  if (field === 'addressZipCode') return text.replace(/[.\-\s]/g, '');
  return text;
}

/**
 * Corpo de ORG-04 com SÓ o que mudou em relação ao órgão carregado; campo opcional esvaziado vai
 * como `null`. `isActive` só entra se a pessoa o alterou.
 */
export function buildPatch(values: FormValues, base: OrganizationDto): UpdateOrganizationInput {
  const before = initialValues(base);
  const patch: Record<string, unknown> = {};
  for (const field of REQUIRED_FIELDS) {
    if (normalized(field, values[field]) !== normalized(field, before[field])) {
      patch[field] = values[field];
    }
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

/** ORG-02 no cliente: campos obrigatórios vazios → "Informe o campo …" (V-01); o resto, do Zod. */
export function validateCreate(
  values: FormValues,
  requiredMessage: (field: RequiredField) => string,
): FieldProblems {
  const result = createOrganizationSchema.safeParse(buildCreateBody(values));
  const problems = result.success ? {} : problemsOf(result.error.issues);
  for (const field of REQUIRED_FIELDS) {
    if (values[field].trim() === '') problems[field] = requiredMessage(field);
  }
  return problems;
}

/** ORG-04 no cliente: valida só o que vai no corpo. */
export function validatePatch(
  patch: UpdateOrganizationInput,
  requiredMessage: (field: RequiredField) => string,
): FieldProblems {
  const result = updateOrganizationSchema.safeParse(patch);
  const problems = result.success ? {} : problemsOf(result.error.issues);
  for (const field of REQUIRED_FIELDS) {
    const sent = (patch as Record<string, unknown>)[field];
    if (typeof sent === 'string' && sent.trim() === '') problems[field] = requiredMessage(field);
  }
  return problems;
}
