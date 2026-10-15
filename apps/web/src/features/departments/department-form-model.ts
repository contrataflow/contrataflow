import { createDepartmentSchema, updateDepartmentSchema } from '@contrataflow/validation';
import type {
  CreateDepartmentInput,
  DepartmentDto,
  DepartmentType,
  UpdateDepartmentInput,
} from '@contrataflow/validation';

/*
 * Modelo do `DepartmentFormDialog` (SCR-032 · US-102): valores do formulário (texto), corpo do
 * DEP-03, patch do DEP-05 (só o que mudou; vazio limpa com `null`) e validação pelos MESMOS
 * schemas Zod da API (V-01..V-07 no front).
 */

export interface DepartmentFormValues {
  type: DepartmentType | '';
  name: string;
  acronym: string;
  code: string;
  email: string;
  phone: string;
  sortOrder: string;
  headUserId: string;
  deputyUserId: string;
}

export type DepartmentFormField = keyof DepartmentFormValues;

export const DEPARTMENT_FORM_FIELDS: readonly DepartmentFormField[] = [
  'type',
  'name',
  'acronym',
  'code',
  'email',
  'phone',
  'sortOrder',
  'headUserId',
  'deputyUserId',
];

const OPTIONAL_TEXT = ['acronym', 'code', 'email', 'phone', 'headUserId', 'deputyUserId'] as const;

export function initialValues(department?: DepartmentDto): DepartmentFormValues {
  return {
    type: department?.type ?? '',
    name: department?.name ?? '',
    acronym: department?.acronym ?? '',
    code: department?.code ?? '',
    email: department?.email ?? '',
    phone: department?.phone ?? '',
    sortOrder: String(department?.sortOrder ?? 0),
    headUserId: department?.headUserId ?? '',
    deputyUserId: department?.deputyUserId ?? '',
  };
}

function sortOrderOf(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** DEP-03: campos vazios ficam de fora; `parentId` nulo = raiz. */
export function buildCreateBody(
  values: DepartmentFormValues,
  organizationId: string,
  parentId: string | null,
): CreateDepartmentInput {
  const body: Record<string, unknown> = {
    organizationId,
    ...(parentId === null ? {} : { parentId }),
    type: values.type,
    name: values.name,
  };
  for (const field of OPTIONAL_TEXT) {
    if (values[field].trim() !== '') body[field] = values[field].trim();
  }
  const sortOrder = sortOrderOf(values.sortOrder);
  if (sortOrder !== undefined && sortOrder !== 0) body.sortOrder = sortOrder;
  return body as unknown as CreateDepartmentInput;
}

/** DEP-05: só o que mudou em relação à versão lida; opcional esvaziado → `null`. */
export function buildPatch(
  values: DepartmentFormValues,
  base: DepartmentDto,
): UpdateDepartmentInput {
  const patch: Record<string, unknown> = {};
  if (values.type !== base.type) patch.type = values.type;
  if (values.name.trim() !== base.name) patch.name = values.name;
  for (const field of OPTIONAL_TEXT) {
    const next = values[field].trim();
    const current = base[field] ?? '';
    if (field === 'acronym' ? next.toUpperCase() !== current : next !== current) {
      patch[field] = next === '' ? null : next;
    }
  }
  const sortOrder = sortOrderOf(values.sortOrder) ?? 0;
  if (sortOrder !== base.sortOrder) patch.sortOrder = sortOrder;
  return patch;
}

export type FieldMessages = Partial<Record<DepartmentFormField, string>>;

function issuesToMessages(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const messages: FieldMessages = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      DEPARTMENT_FORM_FIELDS.includes(field as DepartmentFormField)
    ) {
      messages[field as DepartmentFormField] ??= issue.message;
    }
  }
  return messages;
}

/** Validação do DEP-03 no front; `requiredMessage` personaliza "Informe o {campo}." (V-01). */
export function validateCreate(
  body: CreateDepartmentInput,
  requiredMessage: (field: 'type' | 'name') => string,
): FieldMessages {
  const result = createDepartmentSchema.safeParse(body);
  const messages = result.success ? {} : issuesToMessages(result.error.issues);
  if (body.type === ('' as DepartmentType)) messages.type = requiredMessage('type');
  if (typeof body.name === 'string' && body.name.trim() === '')
    messages.name = requiredMessage('name');
  return messages;
}

/** Validação do DEP-05 no front (o par titular/substituto resultante também é conferido). */
export function validatePatch(
  patch: UpdateDepartmentInput,
  values: DepartmentFormValues,
  requiredMessage: (field: 'type' | 'name') => string,
): FieldMessages {
  const result = updateDepartmentSchema.safeParse({
    ...patch,
    headUserId: values.headUserId.trim() || null,
    deputyUserId: values.deputyUserId.trim() || null,
  });
  const messages = result.success ? {} : issuesToMessages(result.error.issues);
  if (patch.name?.trim() === '') messages.name = requiredMessage('name');
  return messages;
}
