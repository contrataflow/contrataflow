import {
  documentTypeCreateSchema,
  documentTypeUpdateSchema,
  isValidNumberingMask,
  suggestDocumentTypeCode,
} from '@contrataflow/validation';
import type {
  ApprovalPolicy,
  Confidentiality,
  DocumentTypeDto,
  DocumentTypeUpdate,
} from '@contrataflow/validation';

/*
 * Modelo do formulário do SCR-108 (US-061): valores como o usuário os edita (texto) ⇄ corpos de
 * DTY-02/DTY-03 validados pelos MESMOS schemas da API (DEC-054). Funções puras, testáveis sem DOM.
 *
 * Política de aprovação: o formulário edita só o aprovador "Titular de unidade" resolvido na
 * solicitação (`REQUESTING_SECRETARIAT`/`REQUESTING_DEPARTMENT`). Aprovador por usuário, por perfil
 * ou unidade fixa exige os seletores `USR-02`/`ROL-02`/`DEP-02` (stories de usuários, perfis e
 * estrutura); uma política assim já gravada é preservada e mostrada em somente leitura.
 */

export type EditableResolution = 'REQUESTING_SECRETARIAT' | 'REQUESTING_DEPARTMENT';

export interface FormValues {
  kind: 'FREE_TEXT' | 'UPLOADED';
  name: string;
  code: string;
  description: string;
  allowMultiplePerProcess: boolean;
  numberingEnabled: boolean;
  numberingMask: string;
  requiresApproval: boolean;
  defaultConfidentiality: Confidentiality;
  sortOrder: string;
  approverResolution: EditableResolution;
  allowDeputy: boolean;
  slaDays: string;
  slaType: 'BUSINESS' | 'CALENDAR';
}

export const EMPTY_VALUES: FormValues = {
  kind: 'FREE_TEXT',
  name: '',
  code: '',
  description: '',
  allowMultiplePerProcess: true,
  numberingEnabled: true,
  numberingMask: '',
  requiresApproval: false,
  defaultConfidentiality: 'INTERNAL',
  sortOrder: '0',
  approverResolution: 'REQUESTING_SECRETARIAT',
  allowDeputy: true,
  slaDays: '',
  slaType: 'BUSINESS',
};

/** A política já gravada pode ser editada neste formulário (titular da unidade solicitante)? */
export function isEditablePolicy(policy: ApprovalPolicy | null): boolean {
  return (
    policy === null ||
    (policy.approverType === 'DEPARTMENT_HEAD' &&
      (policy.approverDepartmentResolution === 'REQUESTING_SECRETARIAT' ||
        policy.approverDepartmentResolution === 'REQUESTING_DEPARTMENT'))
  );
}

export function initialValues(type?: DocumentTypeDto): FormValues {
  if (!type) return EMPTY_VALUES;
  const policy = type.approvalPolicy;
  const editable = policy !== null && isEditablePolicy(policy);
  return {
    kind: type.kind === 'UPLOADED' ? 'UPLOADED' : 'FREE_TEXT',
    name: type.name,
    code: type.code,
    description: type.description ?? '',
    allowMultiplePerProcess: type.allowMultiplePerProcess,
    numberingEnabled: type.numberingEnabled,
    numberingMask: type.numberingMask ?? '',
    requiresApproval: type.requiresApproval,
    defaultConfidentiality: type.defaultConfidentiality,
    sortOrder: String(type.sortOrder),
    approverResolution:
      editable && policy.approverDepartmentResolution === 'REQUESTING_DEPARTMENT'
        ? 'REQUESTING_DEPARTMENT'
        : 'REQUESTING_SECRETARIAT',
    allowDeputy: policy?.allowDeputy ?? true,
    slaDays: policy?.slaDays === undefined ? '' : String(policy.slaDays),
    slaType: policy?.slaType ?? 'BUSINESS',
  };
}

/** Código sugerido a partir do nome, enquanto o usuário não o editou (US-061 · passo 3). */
export function suggestedCode(name: string): string {
  return suggestDocumentTypeCode(name);
}

export function policyOf(values: FormValues): ApprovalPolicy {
  const slaDays = values.slaDays.trim();
  return {
    approverType: 'DEPARTMENT_HEAD',
    approverDepartmentResolution: values.approverResolution,
    allowDeputy: values.allowDeputy,
    ...(slaDays === '' ? {} : { slaDays: Number(slaDays), slaType: values.slaType }),
  };
}

function sortOrderOf(values: FormValues): number | undefined {
  const text = values.sortOrder.trim();
  return text === '' ? undefined : Number(text);
}

/** Corpo candidato de DTY-02 (ainda não validado). */
export function buildCreateBody(values: FormValues): unknown {
  const sortOrder = sortOrderOf(values);
  return {
    kind: values.kind,
    code: values.code.trim(),
    name: values.name,
    ...(values.description.trim() === '' ? {} : { description: values.description }),
    allowMultiplePerProcess: values.allowMultiplePerProcess,
    numberingEnabled: values.numberingEnabled,
    ...(values.numberingEnabled && values.numberingMask.trim() !== ''
      ? { numberingMask: values.numberingMask.trim() }
      : {}),
    requiresApproval: values.requiresApproval,
    ...(values.requiresApproval ? { approvalPolicy: policyOf(values) } : {}),
    defaultConfidentiality: values.defaultConfidentiality,
    ...(sortOrder === undefined ? {} : { sortOrder }),
  };
}

/** Campo do formulário a que um caminho de erro da API/Zod se refere. */
export function formFieldOf(path: string): keyof FormValues | null {
  const [head, tail] = path.split('.');
  switch (head) {
    case 'approvalPolicy':
      if (tail === 'approverDepartmentResolution') return 'approverResolution';
      if (tail === 'slaDays') return 'slaDays';
      if (tail === 'slaType') return 'slaType';
      if (tail === 'allowDeputy') return 'allowDeputy';
      return 'requiresApproval';
    case 'kind':
    case 'name':
    case 'code':
    case 'description':
    case 'allowMultiplePerProcess':
    case 'numberingEnabled':
    case 'numberingMask':
    case 'requiresApproval':
    case 'defaultConfidentiality':
    case 'sortOrder':
      return head;
    default:
      return null;
  }
}

export type FieldMessages = Partial<Record<keyof FormValues, string>>;

/** Máscara conferida localmente antes do envio (V-06) — a API repete a conferência. */
function maskMessage(values: FormValues, message: string): FieldMessages {
  const mask = values.numberingMask.trim();
  return values.numberingEnabled && mask !== '' && !isValidNumberingMask(mask)
    ? { numberingMask: message }
    : {};
}

/** Validação da criação com `documentTypeCreateSchema` (V-01, V-02, V-07, V-11). */
export function validateCreate(values: FormValues, maskError: string): FieldMessages {
  const messages: FieldMessages = { ...maskMessage(values, maskError) };
  const parsed = documentTypeCreateSchema.safeParse(buildCreateBody(values));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = formFieldOf(issue.path.join('.'));
      if (field && messages[field] === undefined) messages[field] = issue.message;
    }
  }
  return messages;
}

export type DirtyFields = Partial<Record<keyof FormValues, boolean>>;

const PATCH_FIELDS = [
  'name',
  'description',
  'allowMultiplePerProcess',
  'numberingEnabled',
  'numberingMask',
  'requiresApproval',
  'defaultConfidentiality',
  'sortOrder',
] as const;

/**
 * Corpo de DTY-03 só com o que o usuário alterou e que o tipo permite (`editableFields`): campos
 * restritos de tipo de sistema nunca vão (RN-DOC-03). A política segue `requiresApproval` e os
 * campos do aprovador.
 */
export function buildPatch(
  values: FormValues,
  dirty: DirtyFields,
  type: DocumentTypeDto,
): DocumentTypeUpdate {
  const editable = new Set<string>(type.editableFields);
  const patch: Record<string, unknown> = {};
  for (const field of PATCH_FIELDS) {
    if (!dirty[field] || !editable.has(field)) continue;
    switch (field) {
      case 'description':
        patch.description = values.description.trim() === '' ? null : values.description;
        break;
      case 'numberingMask':
        patch.numberingMask =
          values.numberingMask.trim() === '' ? null : values.numberingMask.trim();
        break;
      case 'sortOrder':
        patch.sortOrder = Number(values.sortOrder);
        break;
      default:
        patch[field] = values[field];
    }
  }
  const policyDirty = [
    dirty.approverResolution,
    dirty.allowDeputy,
    dirty.slaDays,
    dirty.slaType,
  ].some(Boolean);
  if (editable.has('approvalPolicy') && isEditablePolicy(type.approvalPolicy)) {
    if (values.requiresApproval && (policyDirty || dirty.requiresApproval)) {
      patch.approvalPolicy = policyOf(values);
    }
  }
  return patch;
}

/** Validação da edição: o patch pelo `documentTypeUpdateSchema` + máscara e prazo. */
export function validatePatch(
  values: FormValues,
  patch: DocumentTypeUpdate,
  maskError: string,
): FieldMessages {
  const messages: FieldMessages = { ...maskMessage(values, maskError) };
  const parsed = documentTypeUpdateSchema.safeParse(patch);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = formFieldOf(issue.path.join('.'));
      if (field && messages[field] === undefined) messages[field] = issue.message;
    }
  }
  return messages;
}
