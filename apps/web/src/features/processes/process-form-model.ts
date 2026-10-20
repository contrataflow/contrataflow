import {
  CREATE_PROCESS_STEP_FIELDS,
  PCA_STATUSES,
  PRIORITIES,
  PROCESS_MESSAGES,
  createProcessSchema,
  pcaIssues,
  processDateIssues,
} from '@contrataflow/validation';
import type {
  CreateProcessInput,
  DepartmentDto,
  PcaStatus,
  PermissionScopeDto,
  Priority,
} from '@contrataflow/validation';

import { parseMoneyText, toDecimalMoney } from './money';

/*
 * Modelo do wizard SCR-005 (US-001): valores do formulário (texto), validação POR PASSO com os
 * MESMOS schemas Zod da API (`createProcessSchema.shape` + `pcaIssues`/`processDateIssues`),
 * corpo do PRC-02 (campos vazios ficam de fora; valor estimado como string decimal), opções de
 * secretaria/setor (RN-PROC-02) filtradas pelo escopo de `PROCESS_CREATE` (FA-08) e o rascunho
 * local em `sessionStorage` (FA-01).
 */

export const WIZARD_STEPS = ['identification', 'origin', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface ProcessFormValues {
  title: string;
  object: string;
  description: string;
  contractingTypeId: string;
  modalityId: string;
  isPriceRegistration: boolean;
  organizationId: string;
  requestingSecretariatId: string;
  requestingDepartmentId: string;
  priority: Priority | '';
  targetDate: string;
  /** Texto digitado em reais ("15.000,50"); a API recebe a string decimal (`buildCreateBody`). */
  estimatedValue: string;
  originId: string;
  pcaStatus: PcaStatus | '';
  pcaYear: string;
  pcaItemCode: string;
  pcaJustification: string;
  internalCode: string;
  notes: string;
}

export type ProcessFormField = keyof ProcessFormValues;
export type FieldMessages = Partial<Record<ProcessFormField, string>>;

/** Campos de cada passo — os mesmos de `CREATE_PROCESS_STEP_FIELDS` (validation). */
export const STEP_FIELDS: Readonly<Record<WizardStep, readonly ProcessFormField[]>> =
  CREATE_PROCESS_STEP_FIELDS;

/** Valores iniciais: prioridade `MEDIUM` e exercício do PCA = ano corrente (RN-PROC-12). */
export function initialValues(currentYear: number): ProcessFormValues {
  return {
    title: '',
    object: '',
    description: '',
    contractingTypeId: '',
    modalityId: '',
    isPriceRegistration: false,
    organizationId: '',
    requestingSecretariatId: '',
    requestingDepartmentId: '',
    priority: 'MEDIUM',
    targetDate: '',
    estimatedValue: '',
    originId: '',
    pcaStatus: '',
    pcaYear: String(currentYear),
    pcaItemCode: '',
    pcaJustification: '',
    internalCode: '',
    notes: '',
  };
}

/**
 * `useWatch` devolve os valores como parciais: o que faltar (ou vier com outro tipo) cai no valor
 * inicial.
 */
export function completeValues(
  watched: Readonly<Record<string, unknown>>,
  currentYear: number,
): ProcessFormValues {
  const base = initialValues(currentYear);
  const values: Record<string, unknown> = { ...base };
  for (const [key, fallback] of Object.entries(base)) {
    const value = watched[key];
    if (typeof value === typeof fallback) values[key] = value;
  }
  return values as unknown as ProcessFormValues;
}

/** Data de hoje no fuso do navegador (`YYYY-MM-DD`). */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

export interface ValidationContext {
  /** Hoje (`YYYY-MM-DD`), para o prazo alvo (RN-PROC-11). */
  readonly today: string;
  readonly currentYear: number;
  /** `process.requireInternalCode` (FA-09). */
  readonly requireInternalCode: boolean;
}

export function validationContext(
  requireInternalCode: boolean,
  now: Date = new Date(),
): ValidationContext {
  return { today: localToday(now), currentYear: now.getFullYear(), requireInternalCode };
}

const trimmedOrUndefined = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

function yearOf(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Entrada do schema por campo: vazio vira ausente; o que não se aplica à situação do PCA sai. */
function schemaInput(values: ProcessFormValues): Record<string, unknown> {
  const planned = values.pcaStatus === 'PLANNED';
  return {
    title: values.title,
    object: values.object,
    description: trimmedOrUndefined(values.description),
    contractingTypeId: values.contractingTypeId,
    modalityId: trimmedOrUndefined(values.modalityId),
    isPriceRegistration: values.isPriceRegistration,
    organizationId: trimmedOrUndefined(values.organizationId),
    requestingSecretariatId: values.requestingSecretariatId,
    requestingDepartmentId: values.requestingDepartmentId,
    priority: values.priority,
    targetDate: trimmedOrUndefined(values.targetDate),
    estimatedValue: parseMoneyText(values.estimatedValue),
    originId: values.originId,
    pcaStatus: values.pcaStatus,
    pcaYear: planned ? yearOf(values.pcaYear) : undefined,
    pcaItemCode: planned ? trimmedOrUndefined(values.pcaItemCode) : undefined,
    pcaJustification:
      values.pcaStatus === 'NOT_PLANNED' ? trimmedOrUndefined(values.pcaJustification) : undefined,
    internalCode: trimmedOrUndefined(values.internalCode),
    notes: trimmedOrUndefined(values.notes),
  };
}

/** Valida os campos de UM passo (V-01..V-09) e devolve a primeira mensagem de cada campo. */
export function validateStep(
  step: WizardStep,
  values: ProcessFormValues,
  context: ValidationContext,
): FieldMessages {
  const input = schemaInput(values);
  const messages: FieldMessages = {};
  for (const field of STEP_FIELDS[step]) {
    const result = createProcessSchema.shape[field].safeParse(input[field]);
    const message = result.success ? undefined : result.error.issues[0]?.message;
    if (message !== undefined) messages[field] = message;
  }
  if (step === 'origin') {
    const body = {
      pcaStatus: values.pcaStatus === '' ? undefined : values.pcaStatus,
      pcaYear: yearOf(values.pcaYear),
      pcaJustification: values.pcaJustification,
      targetDate: trimmedOrUndefined(values.targetDate),
    };
    for (const issue of pcaIssues(body)) messages[issue.path] ??= issue.message;
    for (const issue of processDateIssues(body, context)) messages[issue.path] ??= issue.message;
  }
  if (step === 'review' && context.requireInternalCode && values.internalCode.trim() === '') {
    messages.internalCode = PROCESS_MESSAGES.internalCodeRequired;
  }
  return messages;
}

/** Primeiro passo com erro (ou `null`): usado para impedir "Criar processo" com dados inválidos. */
export function firstInvalidStep(
  values: ProcessFormValues,
  context: ValidationContext,
): WizardStep | null {
  return (
    WIZARD_STEPS.find((step) => Object.keys(validateStep(step, values, context)).length > 0) ?? null
  );
}

/** Primeiro campo com erro, na ordem do formulário. */
export function firstErrorField(
  step: WizardStep,
  messages: FieldMessages,
): ProcessFormField | undefined {
  return STEP_FIELDS[step].find((field) => messages[field] !== undefined);
}

/** Passo a que pertence o campo (para devolver a pessoa ao passo certo após um 422). */
export function stepOfField(field: string): WizardStep | null {
  return (
    WIZARD_STEPS.find((step) => (STEP_FIELDS[step] as readonly string[]).includes(field)) ?? null
  );
}

export function isFormField(field: string): field is ProcessFormField {
  return WIZARD_STEPS.some((step) => (STEP_FIELDS[step] as readonly string[]).includes(field));
}

/** Corpo de `POST /processes` (PRC-02): campos vazios de fora; valor estimado como decimal. */
export function buildCreateBody(
  values: ProcessFormValues,
  options: { readonly confirmDuplicate?: boolean } = {},
): CreateProcessInput {
  const planned = values.pcaStatus === 'PLANNED';
  const optional: Record<string, unknown> = {
    description: trimmedOrUndefined(values.description),
    modalityId: trimmedOrUndefined(values.modalityId),
    organizationId: trimmedOrUndefined(values.organizationId),
    targetDate: trimmedOrUndefined(values.targetDate),
    estimatedValue: toDecimalMoney(values.estimatedValue) ?? undefined,
    pcaYear: planned ? yearOf(values.pcaYear) : undefined,
    pcaItemCode: planned ? trimmedOrUndefined(values.pcaItemCode) : undefined,
    pcaJustification:
      values.pcaStatus === 'NOT_PLANNED' ? trimmedOrUndefined(values.pcaJustification) : undefined,
    internalCode: trimmedOrUndefined(values.internalCode),
    notes: trimmedOrUndefined(values.notes),
    ...(options.confirmDuplicate === true ? { confirmDuplicate: true } : {}),
  };
  const present = Object.fromEntries(
    Object.entries(optional).filter(([, value]) => value !== undefined),
  );
  return {
    title: values.title.trim(),
    object: values.object.trim(),
    contractingTypeId: values.contractingTypeId,
    isPriceRegistration: values.isPriceRegistration,
    requestingSecretariatId: values.requestingSecretariatId,
    requestingDepartmentId: values.requestingDepartmentId,
    priority: values.priority,
    originId: values.originId,
    pcaStatus: values.pcaStatus,
    ...present,
  };
}

/** Corpo de PRC-03 (`check-duplicates`). */
export function buildDuplicateCheckBody(values: ProcessFormValues) {
  return {
    title: values.title.trim(),
    object: values.object.trim(),
    requestingDepartmentId: values.requestingDepartmentId,
  };
}

/** Corpo de WF-06 (`workflows/resolve`): `estimatedValue` só quando válido. */
export function buildResolveBody(values: ProcessFormValues) {
  const estimatedValue = toDecimalMoney(values.estimatedValue);
  return {
    contractingTypeId: values.contractingTypeId,
    ...(values.modalityId === '' ? {} : { modalityId: values.modalityId }),
    originId: values.originId,
    ...(estimatedValue === null ? {} : { estimatedValue }),
    organizationId: values.organizationId,
    isPriceRegistration: values.isPriceRegistration,
  };
}

/** Há conteúdo digitado pela pessoa (os pré-preenchidos não contam)? Decide rascunho e confirmação. */
export function hasUserContent(values: ProcessFormValues): boolean {
  return (
    [
      values.title,
      values.object,
      values.description,
      values.contractingTypeId,
      values.modalityId,
      values.targetDate,
      values.estimatedValue,
      values.originId,
      values.pcaStatus,
      values.pcaItemCode,
      values.pcaJustification,
      values.internalCode,
      values.notes,
    ].some((text) => text.trim() !== '') || values.isPriceRegistration
  );
}

// ---------------------------------------------------------------------------------------------
// Secretaria, setor e escopo (RN-PROC-02/03 · FA-05 · FA-08)
// ---------------------------------------------------------------------------------------------

/** RN-PROC-02: "Secretaria" = unidades ativas do órgão tipo `SECRETARIAT`/`BOARD` mais as raízes. */
export function secretariatCandidates(
  departments: readonly DepartmentDto[],
  organizationId: string,
): DepartmentDto[] {
  return departments.filter(
    (unit) =>
      unit.isActive &&
      unit.organizationId === organizationId &&
      (unit.isSecretariat ||
        unit.parentId === null ||
        unit.type === 'SECRETARIAT' ||
        unit.type === 'BOARD'),
  );
}

/** RN-PROC-02: a própria secretaria ou unidade ativa da subárvore dela (`path` prefixado). */
export function sectorCandidates(
  departments: readonly DepartmentDto[],
  secretariat: DepartmentDto,
): DepartmentDto[] {
  return departments.filter(
    (unit) =>
      unit.isActive &&
      unit.organizationId === secretariat.organizationId &&
      unit.path.startsWith(secretariat.path),
  );
}

export interface ScopeContext {
  /** Escopos de `PROCESS_CREATE` (ME-03); vazio = desconhecido (a API decide). */
  readonly scopes: readonly PermissionScopeDto[];
  /** Lotações do usuário (ME-01); `null` = desconhecidas. */
  readonly ownDepartmentIds: readonly string[] | null;
  readonly departments: readonly DepartmentDto[];
}

/** FA-08: o escopo de `PROCESS_CREATE` cobre a unidade? Sem escopos conhecidos, não filtra. */
export function coversDepartment(unit: DepartmentDto, context: ScopeContext): boolean {
  if (context.scopes.length === 0) return true;
  const byId = new Map(context.departments.map((item) => [item.id, item]));
  return context.scopes.some((scope) => {
    if (scope.type === 'TENANT') return true;
    if (scope.type === 'ORGANIZATION') return scope.organizationId === unit.organizationId;
    if (scope.type === 'DEPARTMENT') {
      const root = scope.departmentId === undefined ? undefined : byId.get(scope.departmentId);
      if (!root) return false;
      return unit.id === root.id || (scope.includeSubtree && unit.path.startsWith(root.path));
    }
    // OWN_DEPARTMENTS: lotações desconhecidas → a API decide.
    if (context.ownDepartmentIds === null) return true;
    return context.ownDepartmentIds.some((ownId) => {
      const own = byId.get(ownId);
      if (!own) return false;
      return unit.id === own.id || (scope.includeSubtree && unit.path.startsWith(own.path));
    });
  });
}

/** Secretarias que têm ao menos um setor coberto pelo escopo. */
export function secretariatOptions(
  departments: readonly DepartmentDto[],
  organizationId: string,
  scope: ScopeContext,
): DepartmentDto[] {
  return secretariatCandidates(departments, organizationId).filter((secretariat) =>
    sectorCandidates(departments, secretariat).some((unit) => coversDepartment(unit, scope)),
  );
}

export interface SectorOption {
  readonly department: DepartmentDto;
  /** Níveis abaixo da secretaria (indentação). */
  readonly level: number;
  /** Lotação do usuário (FA-05: vai para o topo da lista). */
  readonly own: boolean;
}

/** Setores da secretaria cobertos pelo escopo, na ordem da árvore; as lotações vêm destacadas. */
export function sectorOptions(
  departments: readonly DepartmentDto[],
  secretariat: DepartmentDto | undefined,
  scope: ScopeContext,
): SectorOption[] {
  if (!secretariat) return [];
  const own = new Set(scope.ownDepartmentIds ?? []);
  return sectorCandidates(departments, secretariat)
    .filter((unit) => coversDepartment(unit, scope))
    .map((unit) => ({
      department: unit,
      level: Math.max(0, unit.depth - secretariat.depth),
      own: own.has(unit.id),
    }));
}

/** Menor `path` que prefixa a unidade entre as secretarias candidatas (a mais próxima = mais longa). */
function nearestSecretariat(
  unit: DepartmentDto,
  secretariats: readonly DepartmentDto[],
): DepartmentDto | undefined {
  return secretariats
    .filter((secretariat) => unit.path.startsWith(secretariat.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export interface Lotation {
  readonly id: string;
  readonly isPrimary: boolean;
}

/**
 * Pré-preenchimento (passo 2): secretaria e setor da lotação principal do usuário, quando ela está
 * entre as opções cobertas pelo escopo. Sem a principal informada (o ME-03 só lista as lotações),
 * pré-preenche apenas quando há UMA lotação elegível — com várias, a pessoa escolhe (FA-05: elas
 * aparecem no topo da lista). Devolve `null` se não houver como inferir.
 */
export function prefillFromLotation(
  departments: readonly DepartmentDto[],
  organizationId: string,
  lotations: readonly Lotation[],
  scope: ScopeContext,
): { readonly secretariatId: string; readonly departmentId: string } | null {
  const secretariats = secretariatOptions(departments, organizationId, scope);
  const eligible = lotations.flatMap((lotation) => {
    const unit = departments.find(
      (item) => item.id === lotation.id && item.isActive && item.organizationId === organizationId,
    );
    if (!unit || !coversDepartment(unit, scope)) return [];
    const secretariat = nearestSecretariat(unit, secretariats);
    return secretariat ? [{ lotation, secretariatId: secretariat.id, departmentId: unit.id }] : [];
  });
  const chosen =
    eligible.find((candidate) => candidate.lotation.isPrimary) ??
    (eligible.length === 1 ? eligible[0] : undefined);
  return chosen ? { secretariatId: chosen.secretariatId, departmentId: chosen.departmentId } : null;
}

// ---------------------------------------------------------------------------------------------
// Rascunho local (FA-01): `sessionStorage` por usuário + instituição
// ---------------------------------------------------------------------------------------------

export interface WizardDraft {
  readonly version: 1;
  readonly step: WizardStep;
  readonly values: ProcessFormValues;
}

/** Mesmo padrão dos demais armazenamentos locais por tenant: `cf:{tenantId}:{userId}:…`. */
export function draftStorageKey(tenantId: string, userId: string): string {
  return `cf:${tenantId}:${userId}:process-draft`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Só aceita o que o formulário conhece e com o tipo certo; o resto cai no valor inicial. */
export function parseDraft(raw: string | null, currentYear: number): WizardDraft | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.values)) return null;
  const step = WIZARD_STEPS.find((candidate) => candidate === parsed.step);
  if (!step) return null;
  const base = initialValues(currentYear);
  const saved = parsed.values;
  const values = { ...base } as Record<string, string | boolean>;
  for (const [key, fallback] of Object.entries(base)) {
    const value = saved[key];
    if (typeof value === typeof fallback) values[key] = value as string | boolean;
  }
  const merged = values as unknown as ProcessFormValues;
  const priority = PRIORITIES.find((item) => item === merged.priority) ?? 'MEDIUM';
  const pcaStatus = PCA_STATUSES.find((item) => item === merged.pcaStatus) ?? '';
  return { version: 1, step, values: { ...merged, priority, pcaStatus } };
}

export function loadDraft(key: string, currentYear: number): WizardDraft | null {
  try {
    return parseDraft(sessionStore()?.getItem(key) ?? null, currentYear);
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: WizardDraft): void {
  try {
    sessionStore()?.setItem(key, JSON.stringify(draft));
  } catch {
    // Armazenamento cheio ou bloqueado: o rascunho é uma conveniência.
  }
}

export function clearDraft(key: string): void {
  try {
    sessionStore()?.removeItem(key);
  } catch {
    // Idem.
  }
}
