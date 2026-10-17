import type {
  Confidentiality,
  DocumentAction,
  DocumentKind,
  DocumentStatus,
  DraftContent,
  DraftSection,
  ProcessStatus,
} from '@contrataflow/validation';

/*
 * `Document` (entities.md §4.7 · DEC-017/018 · US-065 · RN-DOC-41..50): o artefato genérico do
 * processo — rascunho de trabalho, status e ponteiros de versão. Funções puras sobre um registro
 * imutável: nada aqui lê banco, relógio ou contexto. Toda mudança de `status` passa por uma das
 * transições abaixo (RN-DOC-41) — nunca por atribuição direta do campo.
 *
 * | De                          | Para       | Transição                                   |
 * |-----------------------------|------------|---------------------------------------------|
 * | DRAFT/RETURNED              | FINALIZED  | `finalizeDocument` (tipo sem aprovação)     |
 * | DRAFT/RETURNED              | IN_REVIEW  | `submitDocument` / `enterApprovalStage`     |
 * | FINALIZED/APPROVED          | (mesmo)    | `enterApprovalStage` (só `pendingApprovalId`)|
 * | IN_REVIEW/FINALIZED/APPROVED| APPROVED…  | `applyApprovalDecision`                     |
 * | IN_REVIEW                   | DRAFT      | `withdrawSubmission` (US-053)               |
 * | APPROVED/FINALIZED/REJECTED | DRAFT      | `reopenDocument`                            |
 * | DRAFT/RETURNED              | CANCELED   | `cancelDocument` (final)                    |
 * | DRAFT nunca submetido       | (excluído) | `deleteDocument` (lógica — DEC-034)         |
 */

export interface Document {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentTypeId: string;
  /** Nula para `UPLOADED`. */
  readonly templateVersionId: string | null;
  readonly number: number | null;
  readonly year: number | null;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly confidentiality: Confidentiality;
  readonly draftContent: DraftContent;
  readonly draftRevision: number;
  /** `= documentTypeId` quando o tipo não permite múltiplos por processo (RN-DOC-50). */
  readonly singletonKey: string | null;
  readonly currentVersionId: string | null;
  /** Número da versão corrente (lido junto; `null` sem versão). */
  readonly currentVersionNumber: number | null;
  readonly approvedVersionId: string | null;
  readonly pendingApprovalId: string | null;
  readonly responsibleId: string | null;
  readonly submittedAt: Date | null;
  readonly submittedById: string | null;
  readonly finalizedAt: Date | null;
  readonly finalizedById: string | null;
  readonly approvedAt: Date | null;
  readonly returnedAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly reopenedAt: Date | null;
  readonly reopenedById: string | null;
  readonly reopenReason: string | null;
  readonly canceledAt: Date | null;
  readonly canceledById: string | null;
  readonly cancellationReason: string | null;
  readonly sourceDocumentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string;
  readonly updatedById: string | null;
  readonly deletedAt: Date | null;
  readonly version: number;
}

/** O que as transições precisam do `DocumentType` (US-061). */
export interface LifecycleDocumentType {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: DocumentKind;
  readonly requiresApproval: boolean;
  readonly allowMultiplePerProcess: boolean;
}

/** Motivo da recusa de uma transição — escolhe a mensagem e o código HTTP (V-04/V-05/V-07). */
export type DocumentTransitionFailure =
  /** Status atual não admite a transição (V-05 → 409 `INVALID_STATE`). */
  | 'STATUS'
  /** Reabertura com aprovação pendente (V-04 → 409 `INVALID_STATE`). */
  | 'PENDING_APPROVAL'
  /** Exclusão de documento já submetido/finalizado (V-07 → 409 `INVALID_STATE`). */
  | 'ALREADY_SUBMITTED'
  /** Finalizar tipo que exige aprovação, ou submeter tipo que não exige (409 `INVALID_STATE`). */
  | 'APPROVAL_MODE'
  /** Edição de cabeçalho fora de `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`). */
  | 'NOT_EDITABLE';

export class DocumentTransitionError extends Error {
  constructor(
    readonly failure: DocumentTransitionFailure,
    readonly status: DocumentStatus,
  ) {
    super(`Transição de documento recusada (${failure}) a partir de ${status}.`);
    this.name = 'DocumentTransitionError';
  }
}

const EDITABLE: ReadonlySet<DocumentStatus> = new Set(['DRAFT', 'RETURNED']);
const REOPENABLE: ReadonlySet<DocumentStatus> = new Set(['APPROVED', 'FINALIZED', 'REJECTED']);
/** Processo em que documentos podem ser editados, finalizados, submetidos e cancelados (POL-02). */
export const DOCUMENT_EDITABLE_PROCESS_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  'DRAFT',
  'IN_PROGRESS',
  'RETURNED',
]);

/** Quem age e quando (carimbo das transições). */
export interface TransitionStamp {
  readonly actorId: string;
  readonly now: Date;
}

function touched(stamp: TransitionStamp): Pick<Document, 'updatedAt' | 'updatedById'> {
  return { updatedAt: stamp.now, updatedById: stamp.actorId };
}

function assertFrom(document: Document, allowed: ReadonlySet<DocumentStatus>): void {
  if (document.deletedAt !== null || !allowed.has(document.status)) {
    throw new DocumentTransitionError('STATUS', document.status);
  }
}

export interface NewDocumentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly type: Pick<LifecycleDocumentType, 'id' | 'allowMultiplePerProcess'> & {
    readonly defaultConfidentiality: Confidentiality;
  };
  /** Padrão: o sigilo padrão do tipo (a cópia da duplicação mantém o da origem — US-011). */
  readonly confidentiality?: Confidentiality;
  readonly templateVersionId: string | null;
  readonly title: string;
  readonly draftContent: DraftContent;
  readonly numbering: {
    readonly number: number;
    readonly year: number;
    readonly code: string;
  } | null;
  readonly responsibleId: string | null;
  readonly sourceDocumentId: string | null;
  readonly createdById: string;
  readonly now: Date;
}

/**
 * Fábrica única do documento (US-065 — reaproveitada por US-063/064 e pelos módulos tipados):
 * nasce em `DRAFT`, com o sigilo padrão do tipo, o responsável (padrão: o criador) e a chave de
 * singularidade do tipo que não admite múltiplos por processo (RN-DOC-50).
 */
export function newDocument(input: NewDocumentInput): Document {
  return {
    id: input.id,
    tenantId: input.tenantId,
    processId: input.processId,
    documentTypeId: input.type.id,
    templateVersionId: input.templateVersionId,
    number: input.numbering?.number ?? null,
    year: input.numbering?.year ?? null,
    code: input.numbering?.code ?? null,
    title: input.title,
    status: 'DRAFT',
    confidentiality: input.confidentiality ?? input.type.defaultConfidentiality,
    draftContent: input.draftContent,
    draftRevision: 1,
    singletonKey: input.type.allowMultiplePerProcess ? null : input.type.id,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: input.responsibleId ?? input.createdById,
    submittedAt: null,
    submittedById: null,
    finalizedAt: null,
    finalizedById: null,
    approvedAt: null,
    returnedAt: null,
    rejectedAt: null,
    reopenedAt: null,
    reopenedById: null,
    reopenReason: null,
    canceledAt: null,
    canceledById: null,
    cancellationReason: null,
    sourceDocumentId: input.sourceDocumentId,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.createdById,
    updatedById: input.createdById,
    deletedAt: null,
    version: 1,
  };
}

/** Rascunho editável (`DRAFT`/`RETURNED` — POL-02). */
export function isEditable(document: Document): boolean {
  return document.deletedAt === null && EDITABLE.has(document.status);
}

/**
 * O documento já saiu de `DRAFT` alguma vez (RN-DOC-49): tem versão de `SUBMISSION` ou
 * `FINALIZATION` — exatamente quando `submittedAt`/`finalizedAt` foram preenchidos (as datas nunca
 * são apagadas, nem pela reabertura).
 */
export function hasLeftDraft(document: Document): boolean {
  return document.submittedAt !== null || document.finalizedAt !== null;
}

/** Ação do usuário compatível com o modo de aprovação do tipo (RN-DOC-42/43). */
export function concludingActionOf(
  type: Pick<LifecycleDocumentType, 'requiresApproval'>,
): 'FINALIZE' | 'SUBMIT' {
  return type.requiresApproval ? 'SUBMIT' : 'FINALIZE';
}

/**
 * Pré-condição de finalizar/submeter, conferida ANTES da completude (409 antes de 422): rascunho e
 * ação compatível com o modo de aprovação do tipo.
 */
export function assertConcludable(
  document: Document,
  type: Pick<LifecycleDocumentType, 'requiresApproval'>,
  action: 'FINALIZE' | 'SUBMIT',
): void {
  assertFrom(document, EDITABLE);
  if (concludingActionOf(type) !== action) {
    throw new DocumentTransitionError('APPROVAL_MODE', document.status);
  }
}

/** RN-DOC-42 · DOC-10: `DRAFT`/`RETURNED` → `FINALIZED` com a versão `FINALIZATION`. */
export function finalizeDocument(
  document: Document,
  type: Pick<LifecycleDocumentType, 'requiresApproval'>,
  input: TransitionStamp & { readonly versionId: string; readonly versionNumber: number },
): Document {
  assertFrom(document, EDITABLE);
  if (type.requiresApproval) throw new DocumentTransitionError('APPROVAL_MODE', document.status);
  return {
    ...document,
    ...touched(input),
    status: 'FINALIZED',
    currentVersionId: input.versionId,
    currentVersionNumber: input.versionNumber,
    finalizedAt: input.now,
    finalizedById: input.actorId,
  };
}

/**
 * RN-DOC-43 · DOC-09: `DRAFT`/`RETURNED` → `IN_REVIEW` com a versão `SUBMISSION` e a `Approval`
 * avulsa (`subjectType = DOCUMENT`) em `pendingApprovalId`.
 */
export function submitDocument(
  document: Document,
  type: Pick<LifecycleDocumentType, 'requiresApproval'>,
  input: TransitionStamp & {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly approvalId: string;
  },
): Document {
  assertFrom(document, EDITABLE);
  if (!type.requiresApproval) throw new DocumentTransitionError('APPROVAL_MODE', document.status);
  return {
    ...document,
    ...touched(input),
    status: 'IN_REVIEW',
    currentVersionId: input.versionId,
    currentVersionNumber: input.versionNumber,
    pendingApprovalId: input.approvalId,
    submittedAt: input.now,
    submittedById: input.actorId,
  };
}

/** Resultado de `enterApprovalStage`: se a entrada criou versão (documento em rascunho). */
export interface StageEntryOutcome {
  readonly document: Document;
  readonly createdVersion: boolean;
}

/**
 * RN-DOC-44 (acionada pela tramitação — US-047/US-051): documento em `DRAFT`/`RETURNED` recebe a
 * versão `SUBMISSION` e vai a `IN_REVIEW`; `FINALIZED`/`APPROVED` mantém o status e só ganha
 * `pendingApprovalId` (o selo "Em aprovação" — DEC-018). Com aprovação já pendente ou em
 * `IN_REVIEW`/`REJECTED`/`CANCELED` → `STATUS`.
 */
export function enterApprovalStage(
  document: Document,
  input: TransitionStamp & {
    readonly approvalId: string;
    /** Versão a criar, quando o documento ainda é rascunho. */
    readonly draftVersion: { readonly id: string; readonly versionNumber: number } | null;
  },
): StageEntryOutcome {
  if (document.deletedAt !== null || document.pendingApprovalId !== null) {
    throw new DocumentTransitionError('STATUS', document.status);
  }
  if (EDITABLE.has(document.status)) {
    if (input.draftVersion === null) throw new DocumentTransitionError('STATUS', document.status);
    return {
      createdVersion: true,
      document: {
        ...document,
        ...touched(input),
        status: 'IN_REVIEW',
        currentVersionId: input.draftVersion.id,
        currentVersionNumber: input.draftVersion.versionNumber,
        pendingApprovalId: input.approvalId,
        submittedAt: input.now,
        submittedById: input.actorId,
      },
    };
  }
  if (document.status === 'FINALIZED' || document.status === 'APPROVED') {
    return {
      createdVersion: false,
      document: { ...document, ...touched(input), pendingApprovalId: input.approvalId },
    };
  }
  throw new DocumentTransitionError('STATUS', document.status);
}

export type ApprovalOutcome = 'APPROVED' | 'RETURNED' | 'REJECTED';

/**
 * RN-DOC-45 (decisão da aprovação — US-052): `APPROVED` grava `approvedVersionId` = versão
 * analisada (documento já `APPROVED` permanece `APPROVED`); `RETURNED`/`REJECTED` trocam o status;
 * sempre limpa `pendingApprovalId`. Só a aprovação pendente do documento decide.
 */
export function applyApprovalDecision(
  document: Document,
  input: TransitionStamp & {
    readonly approvalId: string;
    readonly outcome: ApprovalOutcome;
    readonly analyzedVersionId: string;
  },
): Document {
  const coveredStatus =
    document.status === 'IN_REVIEW' ||
    document.status === 'FINALIZED' ||
    document.status === 'APPROVED';
  if (
    document.deletedAt !== null ||
    !coveredStatus ||
    document.pendingApprovalId !== input.approvalId
  ) {
    throw new DocumentTransitionError('STATUS', document.status);
  }
  const base = { ...document, ...touched(input), pendingApprovalId: null };
  switch (input.outcome) {
    case 'APPROVED':
      return {
        ...base,
        status: 'APPROVED',
        approvedVersionId: input.analyzedVersionId,
        approvedAt: input.now,
      };
    case 'RETURNED':
      return { ...base, status: 'RETURNED', returnedAt: input.now };
    case 'REJECTED':
      return { ...base, status: 'REJECTED', rejectedAt: input.now };
  }
}

/** RN-DOC-46 (DOC-11 — US-053): `IN_REVIEW` → `DRAFT`, cancelando a aprovação pendente. */
export function withdrawSubmission(document: Document, input: TransitionStamp): Document {
  assertFrom(document, new Set(['IN_REVIEW']));
  return { ...document, ...touched(input), status: 'DRAFT', pendingApprovalId: null };
}

/**
 * RN-DOC-47 · DOC-12: `APPROVED`/`FINALIZED`/`REJECTED` → `DRAFT` com justificativa; o novo
 * rascunho de trabalho nasce das seções da versão corrente (`baseSections`); sem versão nova (a
 * próxima nasce na finalização/submissão seguinte — RN-DOC-53). Bloqueado com aprovação pendente.
 */
export function reopenDocument(
  document: Document,
  input: TransitionStamp & {
    readonly reason: string;
    /** Seções da versão corrente (`null` = versão sem conteúdo estruturado: mantém o rascunho). */
    readonly baseSections: DraftContent['sections'] | null;
  },
): Document {
  assertFrom(document, REOPENABLE);
  if (document.pendingApprovalId !== null) {
    throw new DocumentTransitionError('PENDING_APPROVAL', document.status);
  }
  return {
    ...document,
    ...touched(input),
    status: 'DRAFT',
    draftContent:
      input.baseSections === null ? document.draftContent : { sections: input.baseSections },
    draftRevision: document.draftRevision + 1,
    reopenedAt: input.now,
    reopenedById: input.actorId,
    reopenReason: input.reason,
  };
}

/** RN-DOC-48 · DOC-13: `DRAFT`/`RETURNED` → `CANCELED` (final), com justificativa. */
export function cancelDocument(
  document: Document,
  input: TransitionStamp & { readonly reason: string },
): Document {
  assertFrom(document, EDITABLE);
  return {
    ...document,
    ...touched(input),
    status: 'CANCELED',
    canceledAt: input.now,
    canceledById: input.actorId,
    cancellationReason: input.reason,
  };
}

/** RN-DOC-49 · DOC-14: exclusão lógica do rascunho que nunca saiu de `DRAFT`. */
export function deleteDocument(document: Document, input: TransitionStamp): Document {
  assertFrom(document, new Set(['DRAFT']));
  if (hasLeftDraft(document))
    throw new DocumentTransitionError('ALREADY_SUBMITTED', document.status);
  return { ...document, ...touched(input), deletedAt: input.now };
}

export interface DocumentHeaderPatch {
  readonly title?: string | undefined;
  readonly responsibleId?: string | undefined;
}

/** Campo alterado do cabeçalho (auditoria `document.draft_update`). */
export interface DocumentHeaderChange {
  readonly field: 'title' | 'responsibleId';
  readonly old: string | null;
  readonly new: string;
}

/** RN-DOC-55 · DOC-04: ajuste de título/responsável do rascunho; sem versão nova. */
export function updateDocumentHeader(
  document: Document,
  patch: DocumentHeaderPatch,
  stamp: TransitionStamp,
): { readonly document: Document; readonly changes: readonly DocumentHeaderChange[] } {
  if (!isEditable(document)) throw new DocumentTransitionError('NOT_EDITABLE', document.status);
  const changes: DocumentHeaderChange[] = [];
  if (patch.title !== undefined && patch.title !== document.title) {
    changes.push({ field: 'title', old: document.title, new: patch.title });
  }
  if (patch.responsibleId !== undefined && patch.responsibleId !== document.responsibleId) {
    changes.push({ field: 'responsibleId', old: document.responsibleId, new: patch.responsibleId });
  }
  if (changes.length === 0) return { document, changes };
  return {
    changes,
    document: {
      ...document,
      ...touched(stamp),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.responsibleId === undefined ? {} : { responsibleId: patch.responsibleId }),
    },
  };
}

/**
 * RN-DOC-56 · DOC-16 (US-066): "Salvar versão" do rascunho editável (`DRAFT`/`RETURNED`) sem mudar
 * o status — só aponta `currentVersionId`/`currentVersionNumber` para a versão `MANUAL`. Fora disso
 * → `NOT_EDITABLE` (409 `DOCUMENT_NOT_EDITABLE`).
 */
export function recordManualVersion(
  document: Document,
  input: TransitionStamp & { readonly versionId: string; readonly versionNumber: number },
): Document {
  if (!isEditable(document)) throw new DocumentTransitionError('NOT_EDITABLE', document.status);
  return {
    ...document,
    ...touched(input),
    currentVersionId: input.versionId,
    currentVersionNumber: input.versionNumber,
  };
}

// --- Ações permitidas (RN-DOC-18 · `meta.allowedActions`) --------------------------------------

/** O que a autorização decidiu para o usuário sobre ESTE documento (POL-01/02/11 já avaliadas). */
export interface DocumentActor {
  /** Permissão de edição do tipo cobrindo o processo (perfil ou participação). */
  readonly canEditType: boolean;
  /** Permissão de submissão do tipo cobrindo o processo. */
  readonly canSubmitType: boolean;
  readonly canReopen: boolean;
  readonly canCancel: boolean;
  /** Custódia atual do processo (POL-01). */
  readonly isCustodian: boolean;
  /** Participação `COLLABORATOR`/`CONSULTANT` ativa no processo (POL-02). */
  readonly isCollaborator: boolean;
}

/** O que POL-02/POL-11 leem do processo. */
export interface DocumentProcessState {
  readonly status: ProcessStatus;
  /** `WorkflowStage.documentTypeCodes` vazio ou contendo o tipo (POL-02). */
  readonly typeAllowedInStage: boolean;
}

/**
 * `DocumentLifecycleService.allowedActions` (RN-DOC-18 · US-062): função pura e única para o
 * painel e o visualizador. POL-02 (editar/finalizar/submeter/excluir): permissão do tipo + (custódia
 * ou participação) + rascunho + tipo permitido na etapa + processo editável. POL-11 (reabrir):
 * `DOCUMENT_REOPEN` + custódia + processo editável + tipo na etapa + sem aprovação pendente.
 * Cancelar: `DOCUMENT_CANCEL` + custódia + rascunho + processo editável.
 */
export function allowedDocumentActions(
  document: Document,
  type: Pick<LifecycleDocumentType, 'requiresApproval'>,
  actor: DocumentActor,
  process: DocumentProcessState,
): DocumentAction[] {
  if (document.deletedAt !== null) return [];
  const processEditable = DOCUMENT_EDITABLE_PROCESS_STATUSES.has(process.status);
  const pol02 =
    processEditable &&
    process.typeAllowedInStage &&
    isEditable(document) &&
    (actor.isCustodian || actor.isCollaborator);
  const actions: DocumentAction[] = [];
  if (pol02 && actor.canEditType) actions.push('UPDATE');
  if (pol02 && actor.canSubmitType) actions.push(concludingActionOf(type));
  if (
    actor.canReopen &&
    actor.isCustodian &&
    processEditable &&
    process.typeAllowedInStage &&
    REOPENABLE.has(document.status) &&
    document.pendingApprovalId === null
  ) {
    actions.push('REOPEN');
  }
  if (actor.canCancel && actor.isCustodian && processEditable && isEditable(document)) {
    actions.push('CANCEL');
  }
  if (pol02 && actor.canEditType && document.status === 'DRAFT' && !hasLeftDraft(document)) {
    actions.push('DELETE');
  }
  return actions;
}

/**
 * `Document.copyAsDraft` (US-011 · RN-PROC-120 · DEC-033): o rascunho de trabalho da origem — o
 * conteúdo mais recente, seja o da versão aprovada/finalizada, seja o rascunho em edição — como
 * conteúdo inicial do novo documento em `DRAFT`. Nada de versões, aprovações ou números: cada
 * seção recomeça (`revision = 1`, carimbo de quem duplicou) e a proveniência de IA é mantida, mas
 * volta a exigir revisão humana no novo processo (RN-AI-55).
 */
export function draftContentCopy(content: DraftContent, stamp: TransitionStamp): DraftContent {
  const at = stamp.now.toISOString();
  const sections: Record<string, DraftSection> = {};
  for (const [key, section] of Object.entries(content.sections)) {
    sections[key] = {
      ...section,
      revision: 1,
      updatedAt: at,
      updatedById: stamp.actorId,
      ...(section.ai ? { ai: { ...section.ai, reviewedAt: null, reviewedById: null } } : {}),
    };
  }
  return { sections };
}
