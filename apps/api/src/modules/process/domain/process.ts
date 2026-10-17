import type { FieldErrorCode } from '@contrataflow/types';
import { PROCESS_MESSAGES, pcaIssues, processDateIssues } from '@contrataflow/validation';
import type {
  CreateProcess,
  CreationChannel,
  EstimatedValueSource,
  PcaStatus,
  Priority,
  ProcessStatus,
} from '@contrataflow/validation';
import { Decimal } from 'decimal.js';

/*
 * Agregado `Process` (US-001 · DEC-010 · entities.md §4.4): a fábrica aplica RN-PROC-01..12 sobre o
 * corpo já validado pelo schema (`createProcessSchema`) — campos opcionais vazios viram `null`, a
 * situação no PCA descarta o que não se aplica, as regras que dependem do relógio do tenant
 * (prazo alvo, exercício do PCA) e o código interno obrigatório por configuração — e monta o
 * processo em `DRAFT` com a numeração (ou sem ela, na autuação — FA-03), a versão de workflow
 * fixada e a etapa inicial. Puro: referências (catálogos, unidades), autorização, unicidade e
 * duplicidade são conferidas pelo caso de uso.
 */

export interface ProcessIssue {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

/** Corpo que não atende às regras de negócio (422 `VALIDATION_ERROR` com os campos). */
export class ProcessValidationError extends Error {
  constructor(readonly issues: readonly ProcessIssue[]) {
    super('Processo inválido.');
    this.name = 'ProcessValidationError';
  }
}

export interface Process {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly number: number | null;
  readonly year: number;
  readonly code: string | null;
  readonly internalCode: string | null;
  readonly title: string;
  readonly object: string;
  readonly description: string | null;
  readonly contractingTypeId: string;
  readonly modalityId: string | null;
  readonly isPriceRegistration: boolean;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly currentDepartmentId: string;
  readonly currentResponsibleId: string | null;
  readonly priority: Priority;
  readonly status: ProcessStatus;
  readonly workflowVersionId: string;
  readonly currentStageId: string | null;
  readonly currentWorkflowStageId: string | null;
  readonly currentStageDueAt: Date | null;
  readonly openedAt: Date | null;
  /** `YYYY-MM-DD`. */
  readonly targetDate: string | null;
  /** Decimal com 2 casas (`"15000.00"`). */
  readonly estimatedValue: string | null;
  readonly estimatedValueSource: EstimatedValueSource | null;
  readonly isBudgetConfidential: boolean;
  readonly originId: string;
  readonly creationChannel: CreationChannel;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
  readonly notes: string | null;
  readonly duplicatedFromId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Dados do processo depois das regras de RN-PROC-01..12 (antes de numerar e posicionar). */
export interface ProcessDraft {
  readonly title: string;
  readonly object: string;
  readonly description: string | null;
  readonly contractingTypeId: string;
  readonly modalityId: string | null;
  readonly isPriceRegistration: boolean;
  readonly organizationId: string | null;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly priority: Priority;
  readonly targetDate: string | null;
  readonly estimatedValue: string | null;
  readonly originId: string;
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
  readonly internalCode: string | null;
  readonly notes: string | null;
  readonly confirmDuplicate: boolean;
}

export interface DraftContext {
  /** Hoje (`YYYY-MM-DD`) no fuso do tenant (RN-PROC-11). */
  readonly today: string;
  /** Ano corrente no fuso do tenant (RN-PROC-12). */
  readonly currentYear: number;
  /** `process.requireInternalCode` (RN-PROC-09 · FA-09). */
  readonly requireInternalCode: boolean;
}

export function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** RN-PROC-12 (DEC-029): só os campos da situação escolhida são gravados. */
export function pcaReference(input: {
  readonly pcaStatus: PcaStatus;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
}): Pick<ProcessDraft, 'pcaStatus' | 'pcaYear' | 'pcaItemCode' | 'pcaJustification'> {
  switch (input.pcaStatus) {
    case 'PLANNED':
      return {
        pcaStatus: 'PLANNED',
        pcaYear: input.pcaYear,
        pcaItemCode: input.pcaItemCode,
        pcaJustification: null,
      };
    case 'NOT_PLANNED':
      return {
        pcaStatus: 'NOT_PLANNED',
        pcaYear: null,
        pcaItemCode: null,
        pcaJustification: input.pcaJustification,
      };
    case 'NOT_APPLICABLE':
      return {
        pcaStatus: 'NOT_APPLICABLE',
        pcaYear: null,
        pcaItemCode: null,
        pcaJustification: null,
      };
  }
}

/** RN-PROC-10: valor com exatamente 2 casas (`"1500"` → `"1500.00"`). */
export function moneyOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return new Decimal(value).toFixed(2);
}

/**
 * RN-PROC-01..12 sobre o corpo do PRC-02: normaliza e confere as regras que o schema não cobre.
 * @throws ProcessValidationError com todos os campos inválidos
 */
export function draftProcess(body: CreateProcess, context: DraftContext): ProcessDraft {
  const pca = pcaReference({
    pcaStatus: body.pcaStatus,
    pcaYear: body.pcaYear ?? null,
    pcaItemCode: textOrNull(body.pcaItemCode),
    pcaJustification: textOrNull(body.pcaJustification),
  });
  const draft: ProcessDraft = {
    title: body.title.trim(),
    object: body.object.trim(),
    description: textOrNull(body.description),
    contractingTypeId: body.contractingTypeId,
    modalityId: body.modalityId ?? null,
    isPriceRegistration: body.isPriceRegistration,
    organizationId: body.organizationId ?? null,
    requestingSecretariatId: body.requestingSecretariatId,
    requestingDepartmentId: body.requestingDepartmentId,
    priority: body.priority,
    targetDate: body.targetDate ?? null,
    estimatedValue: moneyOf(body.estimatedValue),
    originId: body.originId,
    ...pca,
    internalCode: textOrNull(body.internalCode),
    notes: textOrNull(body.notes),
    confirmDuplicate: body.confirmDuplicate,
  };

  const issues: ProcessIssue[] = [
    ...pcaIssues(draft).map((issue) => ({
      field: issue.path,
      code: 'CONDITIONAL_REQUIRED' as const,
      message: issue.message,
    })),
    ...processDateIssues(draft, context).map((issue) => ({
      field: issue.path,
      code: issue.path === 'targetDate' ? ('DATE_IN_PAST' as const) : ('OUT_OF_RANGE' as const),
      message: issue.message,
    })),
  ];
  if (context.requireInternalCode && draft.internalCode === null) {
    issues.push({
      field: 'internalCode',
      code: 'CONDITIONAL_REQUIRED',
      message: PROCESS_MESSAGES.internalCodeRequired,
    });
  }
  if (issues.length > 0) throw new ProcessValidationError(issues);
  return draft;
}

export interface ProcessNumber {
  readonly number: number;
  readonly year: number;
  readonly code: string;
}

export interface InitialStagePosition {
  readonly processStageId: string;
  readonly workflowStageId: string;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly dueAt: Date | null;
}

export interface CreateProcessContext {
  readonly id: string;
  readonly tenantId: string;
  /** Órgão resolvido (o informado ou o principal do tenant — RN-PROC-01). */
  readonly organizationId: string;
  readonly now: Date;
  readonly createdById: string;
  /** Exercício quando não numerado (RN-PROC-05). */
  readonly currentYear: number;
  /** `null` = numeração na autuação (`assignOn = START` — FA-03 · RN-PROC-08). */
  readonly numbering: ProcessNumber | null;
  readonly workflowVersionId: string;
  readonly initialStage: InitialStagePosition;
  readonly creationChannel?: CreationChannel;
}

/** `Process.create` (RN-PROC-04..08/10): processo em `DRAFT` posicionado na etapa inicial. */
export function createProcess(draft: ProcessDraft, context: CreateProcessContext): Process {
  return {
    id: context.id,
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    number: context.numbering?.number ?? null,
    year: context.numbering?.year ?? context.currentYear,
    code: context.numbering?.code ?? null,
    internalCode: draft.internalCode,
    title: draft.title,
    object: draft.object,
    description: draft.description,
    contractingTypeId: draft.contractingTypeId,
    modalityId: draft.modalityId,
    isPriceRegistration: draft.isPriceRegistration,
    requestingSecretariatId: draft.requestingSecretariatId,
    requestingDepartmentId: draft.requestingDepartmentId,
    currentDepartmentId: context.initialStage.departmentId,
    currentResponsibleId: context.initialStage.assigneeId,
    priority: draft.priority,
    status: 'DRAFT',
    workflowVersionId: context.workflowVersionId,
    currentStageId: context.initialStage.processStageId,
    currentWorkflowStageId: context.initialStage.workflowStageId,
    currentStageDueAt: context.initialStage.dueAt,
    openedAt: context.numbering === null ? null : context.now,
    targetDate: draft.targetDate,
    estimatedValue: draft.estimatedValue,
    estimatedValueSource: draft.estimatedValue === null ? null : 'MANUAL',
    isBudgetConfidential: false,
    originId: draft.originId,
    creationChannel: context.creationChannel ?? 'WEB',
    pcaStatus: draft.pcaStatus,
    pcaYear: draft.pcaYear,
    pcaItemCode: draft.pcaItemCode,
    pcaJustification: draft.pcaJustification,
    notes: draft.notes,
    duplicatedFromId: null,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.createdById,
    updatedById: null,
    version: 1,
  };
}
