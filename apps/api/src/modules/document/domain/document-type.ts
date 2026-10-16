import type {
  ApprovalPolicy,
  Confidentiality,
  DocumentKind,
  DocumentTypeUpdate,
  DocumentTypeUpdatableField,
  SystemDocumentModule,
} from '@contrataflow/validation';
import {
  DOCUMENT_TYPE_UPDATABLE_FIELDS,
  NUMBERING_MASK_MESSAGE,
  numberingMaskProblem,
} from '@contrataflow/validation';

import type { AuditChange } from '#shared/audit/audit-trail.js';

/*
 * `DocumentType` (entities.md §4.7 · US-061 · RN-DOC-01..08). Funções puras sobre um registro
 * imutável: nada aqui lê banco, relógio ou contexto.
 */

export interface DocumentType {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: DocumentKind;
  readonly systemModule: SystemDocumentModule | null;
  readonly isSystem: boolean;
  readonly isActive: boolean;
  readonly allowMultiplePerProcess: boolean;
  readonly numberingEnabled: boolean;
  /** Nula = `numbering.document.defaultMask`. */
  readonly numberingMask: string | null;
  readonly requiresApproval: boolean;
  readonly approvalPolicy: ApprovalPolicy | null;
  readonly defaultTemplateId: string | null;
  readonly defaultConfidentiality: Confidentiality;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Violação de regra de negócio do tipo, traduzida em erro HTTP pela camada de aplicação. */
export type DocumentTypeViolation =
  | {
      readonly kind: 'FIELD';
      readonly field: string;
      readonly code: 'NOT_ALLOWED' | 'CONDITIONAL_REQUIRED';
      readonly message: string;
    }
  | { readonly kind: 'NUMBERING_MASK'; readonly field: 'numberingMask'; readonly message: string };

export class DocumentTypeRuleError extends Error {
  constructor(readonly violations: readonly DocumentTypeViolation[]) {
    super(`Tipo de documento fora das regras: ${violations.map((v) => v.kind).join(', ')}`);
    this.name = 'DocumentTypeRuleError';
  }
}

/** Texto sem espaços nas pontas; vazio vira `null`. */
function blankToNull(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

const NOT_ALLOWED_MESSAGE = 'Este campo não pode ser alterado.';
const POLICY_REQUIRED_MESSAGE = 'Defina quem aprova documentos deste tipo.';

/** Campos que o tipo aceita alterar (RN-DOC-03/04). */
export function editableFieldsOf(
  type: Pick<DocumentType, 'isSystem' | 'kind'>,
): readonly DocumentTypeUpdatableField[] {
  if (!type.isSystem) return DOCUMENT_TYPE_UPDATABLE_FIELDS;
  // Tipo de sistema: só o que o regulamento do órgão pode ajustar; `isActive` só nos
  // personalizáveis (`FREE_TEXT`/`UPLOADED`); `STRUCTURED` nunca se desativa (RN-DOC-04).
  return DOCUMENT_TYPE_UPDATABLE_FIELDS.filter(
    (field) =>
      field !== 'allowMultiplePerProcess' && (field !== 'isActive' || type.kind !== 'STRUCTURED'),
  );
}

/** Máscara informada (vazia = padrão do tenant): normalizada e validada (RN-DOC-05). */
function normalizeMask(mask: string | null | undefined): string | null {
  const trimmed = mask?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function maskViolation(mask: string | null): DocumentTypeViolation | null {
  return mask !== null && numberingMaskProblem(mask) !== null
    ? { kind: 'NUMBERING_MASK', field: 'numberingMask', message: NUMBERING_MASK_MESSAGE }
    : null;
}

/**
 * Política gravada: só os campos do tipo de aprovador escolhido (campos de outro tipo, vindos de
 * um formulário que trocou de opção, não ficam) e `slaType` padrão `BUSINESS` quando há prazo.
 */
export function normalizeApprovalPolicy(policy: ApprovalPolicy): ApprovalPolicy {
  const base = {
    approverType: policy.approverType,
    allowDeputy: policy.allowDeputy,
    ...(policy.slaDays === undefined
      ? {}
      : { slaDays: policy.slaDays, slaType: policy.slaType ?? ('BUSINESS' as const) }),
  };
  if (policy.approverType === 'USER') {
    return { ...base, ...(policy.approverUserId ? { approverUserId: policy.approverUserId } : {}) };
  }
  if (policy.approverType === 'ROLE') {
    return { ...base, ...(policy.approverRoleId ? { approverRoleId: policy.approverRoleId } : {}) };
  }
  return {
    ...base,
    ...(policy.approverDepartmentResolution
      ? { approverDepartmentResolution: policy.approverDepartmentResolution }
      : {}),
    ...(policy.approverDepartmentResolution === 'FIXED' && policy.approverFixedDepartmentId
      ? { approverFixedDepartmentId: policy.approverFixedDepartmentId }
      : {}),
  };
}

export interface CreateCustomInput {
  readonly kind: 'FREE_TEXT' | 'UPLOADED';
  readonly code: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly allowMultiplePerProcess: boolean;
  readonly numberingEnabled: boolean;
  readonly numberingMask?: string | null | undefined;
  readonly requiresApproval: boolean;
  readonly approvalPolicy?: ApprovalPolicy | null | undefined;
  readonly defaultConfidentiality: Confidentiality;
  readonly sortOrder?: number | undefined;
}

export interface CreateCustomContext {
  readonly id: string;
  readonly tenantId: string;
  readonly now: Date;
  readonly userId: string | null;
}

/** RN-DOC-01/02/05/06: tipo personalizado (nunca `STRUCTURED`, nunca de sistema). */
export function createCustomDocumentType(
  input: CreateCustomInput,
  context: CreateCustomContext,
): DocumentType {
  const violations: DocumentTypeViolation[] = [];
  const numberingMask = normalizeMask(input.numberingMask);
  const mask = maskViolation(numberingMask);
  if (mask) violations.push(mask);
  if (input.requiresApproval && !input.approvalPolicy) {
    violations.push({
      kind: 'FIELD',
      field: 'approvalPolicy',
      code: 'CONDITIONAL_REQUIRED',
      message: POLICY_REQUIRED_MESSAGE,
    });
  }
  if (violations.length > 0) throw new DocumentTypeRuleError(violations);

  return {
    id: context.id,
    tenantId: context.tenantId,
    code: input.code,
    name: input.name.trim(),
    description: blankToNull(input.description),
    kind: input.kind,
    systemModule: null,
    isSystem: false,
    isActive: true,
    allowMultiplePerProcess: input.allowMultiplePerProcess,
    numberingEnabled: input.numberingEnabled,
    numberingMask,
    requiresApproval: input.requiresApproval,
    approvalPolicy: input.approvalPolicy ? normalizeApprovalPolicy(input.approvalPolicy) : null,
    defaultTemplateId: null,
    defaultConfidentiality: input.defaultConfidentiality,
    sortOrder: input.sortOrder ?? 0,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    version: 1,
  };
}

export interface UpdateContext {
  readonly now: Date;
  readonly userId: string | null;
  /** Documentos já criados com o tipo (RN-DOC-04 · V-14). */
  readonly documentsCount: number;
}

export interface DocumentTypeUpdateResult {
  /** Tipo depois da alteração (versão + 1); o próprio tipo se nada mudou. */
  readonly next: DocumentType;
  /** Campos realmente alterados (vão no evento e na auditoria). */
  readonly changedFields: readonly string[];
  /** Alterações campo a campo (`approvalPolicy` por chave — RN-AUD-03). */
  readonly changes: readonly AuditChange[];
  /** O patch desativa um tipo que estava ativo (exige verificar uso em fluxos — RN-DOC-09). */
  readonly deactivates: boolean;
  /** O patch altera a política de aprovação ou liga a aprovação (exige validar o aprovador). */
  readonly policyNeedsValidation: boolean;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function policyChanges(before: ApprovalPolicy | null, after: ApprovalPolicy | null): AuditChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: AuditChange[] = [];
  for (const key of [...keys].sort()) {
    const old: unknown = (before as Record<string, unknown> | null)?.[key] ?? null;
    const next: unknown = (after as Record<string, unknown> | null)?.[key] ?? null;
    if (!sameJson(old, next)) out.push({ path: `approvalPolicy.${key}`, old, new: next });
  }
  return out;
}

/**
 * RN-DOC-03/04/05/06: aplica o patch ao tipo. Campo fora de `editableFieldsOf` → `NOT_ALLOWED`
 * (V-04/V-12/V-14); máscara inválida → `NUMBERING_MASK_INVALID`; aprovação ligada sem política →
 * `CONDITIONAL_REQUIRED` (V-07). Valor igual ao atual não conta como alteração.
 */
export function updateDocumentType(
  current: DocumentType,
  patch: DocumentTypeUpdate,
  context: UpdateContext,
): DocumentTypeUpdateResult {
  const violations: DocumentTypeViolation[] = [];
  const editable = new Set<string>(editableFieldsOf(current));
  const sent = (Object.keys(patch) as DocumentTypeUpdatableField[]).filter(
    (field) => patch[field] !== undefined,
  );

  for (const field of sent) {
    if (!editable.has(field)) {
      violations.push({ kind: 'FIELD', field, code: 'NOT_ALLOWED', message: NOT_ALLOWED_MESSAGE });
    }
  }
  if (
    sent.includes('allowMultiplePerProcess') &&
    editable.has('allowMultiplePerProcess') &&
    patch.allowMultiplePerProcess !== current.allowMultiplePerProcess &&
    context.documentsCount > 0
  ) {
    violations.push({
      kind: 'FIELD',
      field: 'allowMultiplePerProcess',
      code: 'NOT_ALLOWED',
      message: 'Não é possível mudar esta opção: já existem documentos deste tipo.',
    });
  }

  const numberingMask =
    patch.numberingMask === undefined ? current.numberingMask : normalizeMask(patch.numberingMask);
  if (patch.numberingMask !== undefined) {
    const mask = maskViolation(numberingMask);
    if (mask) violations.push(mask);
  }

  const requiresApproval = patch.requiresApproval ?? current.requiresApproval;
  // RN-DOC-06: desligar a aprovação mantém a última política (histórico); `null` explícito limpa.
  const approvalPolicy =
    patch.approvalPolicy === undefined
      ? current.approvalPolicy
      : patch.approvalPolicy === null
        ? null
        : normalizeApprovalPolicy(patch.approvalPolicy);
  if (requiresApproval && approvalPolicy === null) {
    violations.push({
      kind: 'FIELD',
      field: 'approvalPolicy',
      code: 'CONDITIONAL_REQUIRED',
      message: POLICY_REQUIRED_MESSAGE,
    });
  }
  if (violations.length > 0) throw new DocumentTypeRuleError(violations);

  const description =
    patch.description === undefined ? current.description : blankToNull(patch.description);
  const candidate = {
    name: patch.name?.trim() ?? current.name,
    description,
    allowMultiplePerProcess: patch.allowMultiplePerProcess ?? current.allowMultiplePerProcess,
    numberingEnabled: patch.numberingEnabled ?? current.numberingEnabled,
    numberingMask,
    requiresApproval,
    approvalPolicy,
    defaultConfidentiality: patch.defaultConfidentiality ?? current.defaultConfidentiality,
    sortOrder: patch.sortOrder ?? current.sortOrder,
    isActive: patch.isActive ?? current.isActive,
  };

  const changedFields: string[] = [];
  const changes: AuditChange[] = [];
  for (const field of DOCUMENT_TYPE_UPDATABLE_FIELDS) {
    if (sameJson(current[field], candidate[field])) continue;
    changedFields.push(field);
    if (field === 'approvalPolicy') {
      changes.push(...policyChanges(current.approvalPolicy, candidate.approvalPolicy));
    } else {
      changes.push({ path: field, old: current[field], new: candidate[field] });
    }
  }

  if (changedFields.length === 0) {
    return {
      next: current,
      changedFields,
      changes,
      deactivates: false,
      policyNeedsValidation: false,
    };
  }
  return {
    next: {
      ...current,
      ...candidate,
      updatedAt: context.now,
      updatedById: context.userId,
      version: current.version + 1,
    },
    changedFields,
    changes,
    deactivates: current.isActive && !candidate.isActive,
    policyNeedsValidation:
      candidate.requiresApproval &&
      candidate.approvalPolicy !== null &&
      (changedFields.includes('approvalPolicy') || changedFields.includes('requiresApproval')),
  };
}

/** O que DTY-04 confere do template escolhido como padrão (RN-TPL-19). */
export interface DefaultTemplateCandidate {
  readonly id: string;
  readonly documentTypeId: string;
  readonly isActive: boolean;
  readonly currentPublishedVersionId: string | null;
}

/** RN-TPL-19: o template é de outro tipo (`VALIDATION_ERROR`) ou não tem versão publicada. */
export class DefaultTemplateRuleError extends Error {
  constructor(readonly reason: 'OTHER_TYPE' | 'NOT_PUBLISHED') {
    super(`Template padrão recusado: ${reason}.`);
    this.name = 'DefaultTemplateRuleError';
  }
}

/**
 * `DocumentType.setDefaultTemplate` (DTY-04 · RN-TPL-19/20): template do mesmo tipo, ativo e com
 * versão publicada. Substitui o padrão anterior sem tocá-lo (ele segue disponível para ser
 * escolhido de novo). O mesmo template já padrão → `changed = false`.
 * @throws DefaultTemplateRuleError
 */
export function setDefaultTemplate(
  current: DocumentType,
  template: DefaultTemplateCandidate,
  context: { readonly now: Date; readonly userId: string | null },
): { readonly next: DocumentType; readonly changed: boolean; readonly changes: AuditChange[] } {
  if (template.documentTypeId !== current.id) throw new DefaultTemplateRuleError('OTHER_TYPE');
  if (!template.isActive || template.currentPublishedVersionId === null) {
    throw new DefaultTemplateRuleError('NOT_PUBLISHED');
  }
  if (current.defaultTemplateId === template.id) {
    return { next: current, changed: false, changes: [] };
  }
  return {
    next: {
      ...current,
      defaultTemplateId: template.id,
      updatedAt: context.now,
      updatedById: context.userId,
      version: current.version + 1,
    },
    changed: true,
    changes: [{ path: 'defaultTemplateId', old: current.defaultTemplateId, new: template.id }],
  };
}
