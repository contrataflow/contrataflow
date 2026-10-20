import { ETP_IMPORTABLE_DFD_STATUSES, richTextPlainText } from '@contrataflow/validation';
import type {
  Confidentiality,
  DocumentAction,
  DocumentSnapshot,
  DocumentStatus,
  SectionRequirement,
  SystemDocumentModule,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { DocumentAiTargets } from './document-ai-target.js';
import type {
  AiChainSource,
  AiDocumentTarget,
  AiDocumentTargetInput,
  AiDraftSource,
  AiSectionSource,
} from './document-ai-target.js';
import { DocumentApprovalOutcomes } from './document-approval.outcomes.js';
import type {
  ApprovalOutcomeInput,
  ApprovalOutcomeResult,
  CoverageFacts,
  DocumentApprovedListener,
  TypedApprovalEffectsInput,
} from './document-approval.outcomes.js';
import type {
  ApprovalDecisionInput,
  CanceledApprovalInput,
  StageEntryInput,
  StageEntryResult,
} from './document-approval.transitions.js';
import { DocumentApprovalTransitions } from './document-approval.transitions.js';
import { DocumentCommentTargets } from './document-comment-target.js';
import type { CommentDocumentLabel, CommentDocumentTarget } from './document-comment-target.js';
import { DocumentCreationService } from './document-creation.service.js';
import type { CreateDocumentInput } from './document-creation.service.js';
import { DocumentItemsPresenter } from './document-items.commands.js';
import type { DocumentItemCopy, DocumentItemSnapshotLine } from './document-items.commands.js';
import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { FinalizeDocumentCommand } from './document.commands.js';
import type { ConcludeDocumentInput, DocumentTransitionResult } from './document.commands.js';
import { documentNotEditable, notProcessCustodian } from './document.errors.js';
import { DOCUMENT_REPOSITORY, DocumentValidatorRegistry } from './document.ports.js';
import type { DocumentRepository, DocumentValidator } from './document.ports.js';
import { DOCUMENT_CLOCK, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentClock, DocumentTypeRepository } from './ports.js';
import { StructuredDocumentCreator } from './structured-document.creator.js';
import type {
  CreateStructuredDocumentInput,
  CreatedStructuredDocument,
  PublishedTemplateOption,
} from './structured-document.creator.js';
import { TypedCollectionGuard } from './typed-collection-guard.js';
import type {
  TypedCollectionInput,
  TypedCollectionState,
  TypedCollectionWrite,
} from './typed-collection-guard.js';
import type { DocumentItem } from '../domain/document-items.js';
import type { DocumentTemplateVersion } from '../domain/document-template.js';
import type { DocumentType } from '../domain/document-type.js';
import { draftContentCopy, isEditable, updateDocumentHeader } from '../domain/document.js';
import type { Document } from '../domain/document.js';

export type {
  DocumentApprovalDecidedFacts,
  DocumentFinalizedFacts,
  DocumentReopenedFacts,
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
} from './document.ports.js';
export type { ConcludeDocumentInput, DocumentTransitionResult } from './document.commands.js';
export type { CreateDocumentInput } from './document-creation.service.js';
export type {
  ApprovalOutcomeInput,
  ApprovalOutcomeResult,
  CoverageFacts,
  DocumentApprovedHookEvent,
  TypedApprovalEffectsInput,
} from './document-approval.outcomes.js';
export type { PublishedTemplateOption } from './structured-document.creator.js';
export type {
  CreateStructuredDocumentInput,
  CreatedStructuredDocument,
} from './structured-document.creator.js';
export type { DocumentItemCopy } from './document-items.commands.js';
/** O `Document` de DOC-03 para os módulos tipados que respondem o documento (US-035 · RSK-10). */
export { toDocumentDto } from './document.view.js';
export type { DocumentItem } from '../domain/document-items.js';
export type { Document } from '../domain/document.js';
export type { AiDocumentTarget, AiDocumentTargetInput } from './document-ai-target.js';
export type { CommentDocumentLabel, CommentDocumentTarget } from './document-comment-target.js';
export type {
  TypedCollectionInput,
  TypedCollectionLockReason,
  TypedCollectionOwner,
  TypedCollectionState,
  TypedCollectionWrite,
} from './typed-collection-guard.js';
export type {
  ApprovalDecisionInput,
  CanceledApprovalInput,
  StageEntryInput,
  StageEntryResult,
} from './document-approval.transitions.js';

/** Documento como o painel situacional o lista (sem conteúdo). */
export interface SummaryDocumentFact {
  readonly id: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly versionNumber: number | null;
  readonly confidentiality: Confidentiality;
  readonly inApproval: boolean;
}

/**
 * O documento tipado como o módulo dono o lê (US-014 · DFD-03): documento, tipo, versão de
 * template, processo, `meta.allowedActions` (RN-DOC-18) e se o usuário vê o orçamento (POL-09).
 */
export interface TypedDocumentView {
  readonly document: Document;
  readonly type: DocumentType;
  readonly template: DocumentTemplateVersion | null;
  readonly processId: string;
  readonly isBudgetConfidential: boolean;
  readonly canViewConfidentialBudget: boolean;
  readonly allowedActions: DocumentAction[];
}

/**
 * O documento tipado aberto para GRAVAR o cabeçalho do módulo dono (US-015 · DFD-04): a leitura de
 * `TypedDocumentView` mais o que as regras de referência do cabeçalho precisam do processo.
 */
export interface EditableTypedDocument extends TypedDocumentView {
  readonly process: {
    readonly organizationId: string;
    readonly requestingSecretariatId: string;
  };
}

/** Completude de uma seção do template (DOC-08) como os módulos tipados a exibem (US-036). */
export interface SectionCompletenessFact {
  readonly key: string;
  readonly requirement: SectionRequirement;
  readonly complete: boolean;
}

/** Estado de um documento para listagens dos módulos tipados (DFD-01). */
export interface DocumentState {
  readonly id: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly version: number;
  readonly currentVersionNumber: number | null;
  readonly approvedAt: Date | null;
}

/**
 * DFD do processo elegível para a importação do ETP (US-019 · RN-ETP-04): não cancelado nem
 * excluído, em `FINALIZED`/`APPROVED`, com o snapshot da versão de origem (`approvedVersionId`,
 * senão `currentVersionId`).
 */
export interface ImportableDfdSource {
  readonly documentId: string;
  readonly code: string | null;
  readonly status: (typeof ETP_IMPORTABLE_DFD_STATUSES)[number];
  readonly versionId: string;
  readonly versionNumber: number;
  readonly snapshot: DocumentSnapshot;
}

/** Documento como a tramitação o registra (US-047 · entities.md §5.6). */
export interface MovementDocumentFact {
  readonly id: string;
  readonly typeCode: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly currentVersionId: string | null;
  readonly currentVersionNumber: number | null;
  /** Última alteração (rascunho salvo, transição ou versão criada). */
  readonly updatedAt: Date;
}

/** Resultado da cópia dos documentos estruturados na duplicação (US-011). */
export interface DocumentDraftCopies {
  /** Documento de origem → novo rascunho. */
  readonly copied: ReadonlyMap<string, string>;
  /** Elegíveis que não puderam ser copiados (tipo inativado depois da criação). */
  readonly skipped: number;
}

/**
 * API pública do módulo `document` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-065: a extensão dos módulos tipados (`registerValidator`), a
 * criação com singularidade e numeração (`createIn` — DOC-02 e criações tipadas), as transições
 * acionadas pela tramitação/aprovação (`enterApprovalStageIn`/`applyApprovalDecisionIn`) e os
 * nomes congelados da timeline (`documentLabels`/`versionNumbers`), sempre no `tx` do chamador.
 */
@Injectable()
export class DocumentFacade {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    private readonly validators: DocumentValidatorRegistry,
    private readonly creation: DocumentCreationService,
    private readonly approvals: DocumentApprovalTransitions,
    private readonly aiTargets: DocumentAiTargets,
    private readonly collections: TypedCollectionGuard,
    private readonly commentTargets: DocumentCommentTargets,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly structured: StructuredDocumentCreator,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly itemRows: DocumentItemsPresenter,
    private readonly outcomes: DocumentApprovalOutcomes,
    private readonly finalizer: FinalizeDocumentCommand,
  ) {}

  /**
   * Finalização (DOC-10) no `tx` do módulo tipado (US-032 · PRS-23 — concluir a pesquisa de preços é
   * finalizar o documento, DEC-018): a MESMA transição, com POL-02, `If-Match` do documento,
   * completude, versão `FINALIZATION`, `document.finalize`, `DocumentFinalized` e o gancho
   * `finalized` do validador. Depois do commit, `finalizationCommitted` registra log e métrica.
   */
  finalizeIn(tx: TenantTx, input: ConcludeDocumentInput): Promise<DocumentTransitionResult> {
    return this.finalizer.finalizeIn(tx, input);
  }

  finalizationCommitted(result: DocumentTransitionResult, durationMs: number): void {
    this.finalizer.transitionCommitted(result, durationMs);
  }

  /**
   * Registra o `DocumentValidator` do módulo tipado (no `onModuleInit` dele): validação de
   * completude, `typedSummary` e partes do snapshot. Um por `SystemDocumentModule`.
   */
  registerValidator(validator: DocumentValidator): void {
    this.validators.register(validator);
  }

  /** Cria o documento em `DRAFT` (RN-DOC-50: tipo singular → 409 `DOCUMENT_ALREADY_EXISTS`). */
  createIn(tx: TenantTx, input: CreateDocumentInput): Promise<Document> {
    return this.creation.create(tx, input);
  }

  /**
   * Padrão de documento tipado (US-014 · `createStructured`): cria o `Document` do tipo do módulo
   * a partir da versão publicada do template (padrão do tipo ou escolhido), com o rascunho de todas
   * as seções, numeração, `document.create`, `DocumentCreated` e timeline — no `tx` do chamador,
   * que grava o cabeçalho tipado em seguida. Lança 404/403/409/422 (ver `StructuredDocumentCreator`).
   */
  createStructuredIn(
    tx: TenantTx,
    input: CreateStructuredDocumentInput,
  ): Promise<CreatedStructuredDocument> {
    return this.structured.create(tx, input);
  }

  /** Modelos publicados do tipo do módulo para o diálogo de criação (US-036 · FA-01). */
  publishedTemplatesIn(
    tx: TenantTx,
    systemModule: SystemDocumentModule,
  ): Promise<PublishedTemplateOption[]> {
    return this.structured.publishedTemplates(tx, systemModule);
  }

  /**
   * Completude por seção do documento (US-036 · RN-TR-13): a MESMA avaliação do DOC-08 (genérica +
   * `DocumentValidator`), sem checar visibilidade — o chamador já leu o documento visível.
   * `null` se o documento não existe no tenant.
   */
  async sectionCompletenessIn(
    tx: TenantTx,
    documentId: string,
  ): Promise<readonly SectionCompletenessFact[] | null> {
    const context = await this.lifecycle.loadInternal(tx, documentId);
    if (context === null) return null;
    const { sections } = await this.lifecycle.evaluate(tx, context);
    return sections.map((section) => ({
      key: section.key,
      requirement: section.requirement,
      complete: section.complete,
    }));
  }

  /**
   * O documento visível ao usuário da requisição (DEC-024), com as ações e a POL-09 do processo;
   * `null` se inexistente, excluído, de outro tenant ou de processo não visível (o módulo dono
   * responde o seu 404 — ex.: `DFD_NOT_FOUND`).
   */
  async typedDocumentIn(tx: TenantTx, documentId: string): Promise<TypedDocumentView | null> {
    let context;
    try {
      context = await this.lifecycle.load(tx, documentId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
    const actor = await this.lifecycle.actorOf(context);
    const { process } = context;
    return {
      document: context.document,
      type: context.type,
      template: context.template,
      processId: process.id,
      isBudgetConfidential: process.isBudgetConfidential,
      canViewConfidentialBudget:
        !process.isBudgetConfidential || (await this.lifecycle.canViewConfidentialBudget(context)),
      allowedActions: this.lifecycle.allowedActions(context, actor),
    };
  }

  /**
   * Gravação do cabeçalho tipado pelo módulo dono (US-015 · DFD-04 · RN-DFD-30): linha do documento
   * travada (`FOR UPDATE` — corrida com a submissão/finalização) → visível (`null` = o 404 do
   * módulo) → permissão de EDIÇÃO do tipo + POL-02 (403 com `access.denied` — `NOT_PROCESS_CUSTODIAN`
   * sem custódia/participação —, 409 `INVALID_PROCESS_STATUS`, 422 de etapa) → documento em
   * `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE` com `meta.status`/`statusSince`).
   */
  async editableTypedDocumentIn(
    tx: TenantTx,
    documentId: string,
    options: { readonly notCustodianDetail: string },
  ): Promise<EditableTypedDocument | null> {
    await this.lifecycle.lockForVersioning(tx, documentId);
    let context;
    try {
      context = await this.lifecycle.load(tx, documentId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit', undefined, () =>
      notProcessCustodian('POL-02', options.notCustodianDetail),
    );
    if (!isEditable(context.document)) throw documentNotEditable(context.document);
    const { process } = context;
    return {
      document: context.document,
      type: context.type,
      template: context.template,
      processId: process.id,
      isBudgetConfidential: process.isBudgetConfidential,
      canViewConfidentialBudget:
        !process.isBudgetConfidential || (await this.lifecycle.canViewConfidentialBudget(context)),
      allowedActions: this.lifecycle.allowedActions(context, actor),
      process: {
        organizationId: process.organizationId,
        requestingSecretariatId: process.requestingSecretariatId,
      },
    };
  }

  /**
   * Completude do documento (RN-DFD-19): a MESMA avaliação do DOC-08 (genérica + `DocumentValidator`
   * do módulo tipado), sem checar visibilidade — o `RuleContext` da tramitação (US-041) lê por aqui.
   * `null` se o documento não existe no tenant.
   */
  async isCompleteIn(tx: TenantTx, documentId: string): Promise<boolean | null> {
    const context = await this.lifecycle.loadInternal(tx, documentId);
    if (context === null) return null;
    const { violations } = await this.lifecycle.evaluate(tx, context);
    return !violations.some((item) => item.severity === 'BLOCKING');
  }

  /** Linhas de item do documento (DOC-06), no `tx` do chamador — validador e snapshot tipados. */
  documentItemsIn(tx: TenantTx, documentId: string): Promise<DocumentItem[]> {
    return this.itemRows.rowsOf(tx, documentId);
  }

  /** Itens do documento como o snapshot da versão os congela (US-016 · RN-DFD-40). */
  snapshotItemsIn(tx: TenantTx, document: Document): Promise<DocumentItemSnapshotLine[]> {
    return this.itemRows.snapshotLinesOf(tx, document);
  }

  /**
   * Itens do documento recém-criado na duplicação de um módulo tipado (US-018 · RN-DFD-75), no `tx`
   * do chamador: as linhas já apontam para os itens do processo de destino. Devolve quantas gravou.
   */
  copyItemsIn(
    tx: TenantTx,
    document: Pick<Document, 'id' | 'tenantId'>,
    lines: readonly DocumentItemCopy[],
  ): Promise<number> {
    return this.itemRows.insertCopies(tx, document, lines);
  }

  /**
   * Quantidade de cada item do processo nos documentos tipados ativos (US-024 · RN-PRICE-04): para
   * cada `systemModule` (na ordem de preferência — ex.: `ETP`, depois `DFD`), as linhas de item do
   * documento não cancelado nem excluído do processo; a primeira fonte que tiver o item vence.
   * Decimal(18,4) como string. Sem checar visibilidade: quem chama já autorizou o processo.
   */
  async itemQuantitiesIn(
    tx: TenantTx,
    processId: string,
    systemModules: readonly SystemDocumentModule[],
  ): Promise<ReadonlyMap<string, string>> {
    const quantities = new Map<string, string>();
    const types = await this.types.list(tx);
    for (const systemModule of systemModules) {
      const type = types.find((candidate) => candidate.systemModule === systemModule);
      if (type === undefined) continue;
      const document = await this.documents.findActiveOfType(tx, processId, type.id);
      if (document === null || document.status === 'CANCELED') continue;
      for (const row of await this.itemRows.rowsOf(tx, document.id)) {
        if (!quantities.has(row.processItemId)) quantities.set(row.processItemId, row.quantity);
      }
    }
    return quantities;
  }

  /**
   * Título do rascunho alterado pelo módulo tipado dono (US-024 · PRS-04): o chamador já autorizou
   * (POL-02 estendida) e travou o documento no `tx`. `DRAFT`/`RETURNED` (senão 409
   * `DOCUMENT_NOT_EDITABLE`); grava com `version + 1`. Devolve o título anterior, ou `null` se não
   * mudou. A auditoria é de quem chama.
   */
  async renameDraftIn(
    tx: TenantTx,
    documentId: string,
    title: string,
  ): Promise<{ readonly previous: string } | null> {
    const document = await this.documents.findById(tx, documentId);
    if (document === null) throw new ApiError('NOT_FOUND', { detail: 'Documento não encontrado.' });
    const actorId = requireRequestContext().actor.userId;
    if (actorId === null) throw new ApiError('UNAUTHENTICATED');
    const { document: next, changes } = this.lifecycle.transition(() =>
      updateDocumentHeader(document, { title }, { actorId, now: this.clock() }),
    );
    if (changes.length === 0) return null;
    await this.lifecycle.save(tx, next, document.version);
    return { previous: document.title };
  }

  /**
   * O DFD elegível para a importação do ETP (US-019 · RN-ETP-04), no `tx` do chamador — a MESMA
   * regra para o cartão "Importar dados do DFD" (ETP-01) e para a criação (ETP-02). `null` sem DFD,
   * com o DFD em `DRAFT`/`RETURNED`/`IN_REVIEW`/`CANCELED` ou sem versão. Sem checar visibilidade:
   * quem chama já autorizou o processo.
   */
  async importableDfdIn(tx: TenantTx, processId: string): Promise<ImportableDfdSource | null> {
    const type = (await this.types.list(tx)).find((candidate) => candidate.systemModule === 'DFD');
    if (type === undefined) return null;
    const document = await this.documents.findActiveOfType(tx, processId, type.id);
    if (document === null) return null;
    const status = ETP_IMPORTABLE_DFD_STATUSES.find((candidate) => candidate === document.status);
    if (status === undefined) return null;
    const versionId = document.approvedVersionId ?? document.currentVersionId;
    if (versionId === null) return null;
    const version = await this.documents.findVersion(tx, versionId);
    if (version?.documentId !== document.id || version.content === null) return null;
    return {
      documentId: document.id,
      code: document.code,
      status,
      versionId: version.id,
      versionNumber: version.versionNumber,
      snapshot: version.content,
    };
  }

  /** Código, status e versão dos documentos não excluídos (inclusive cancelados) por id. */
  async documentStatesIn(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, DocumentState>> {
    const states = new Map<string, DocumentState>();
    for (const id of new Set(ids)) {
      const document = await this.documents.findById(tx, id);
      if (document === null) continue;
      states.set(id, {
        id: document.id,
        code: document.code,
        title: document.title,
        status: document.status,
        version: document.version,
        currentVersionNumber: document.currentVersionNumber,
        approvedAt: document.approvedAt,
      });
    }
    return states;
  }

  /**
   * Duplicação do processo com `copyDocuments` (US-011 · RN-PROC-120 · DEC-033): cada documento
   * estruturado (`STRUCTURED`) não cancelado nem excluído da origem vira um novo documento em
   * `DRAFT` no processo de destino, com o conteúdo mais recente (`draftContentCopy`), o mesmo
   * modelo e sigilo e `sourceDocumentId` — numeração, `document.create` e `DocumentCreated` pela
   * criação de sempre. Nunca versões nem aprovações. Tipo inativado depois é pulado (contado em
   * `skipped`). A autorização é da duplicação (o processo novo nasce sob custódia de quem duplica).
   */
  async copyStructuredAsDraftsIn(
    tx: TenantTx,
    input: {
      readonly sourceProcessId: string;
      readonly targetProcessId: string;
      readonly idempotencyKey: string | null;
    },
  ): Promise<DocumentDraftCopies> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const documents = await this.documents.listActiveByProcess(tx, input.sourceProcessId);
    const types = new Map((await this.types.list(tx)).map((type) => [type.id, type]));
    const copied = new Map<string, string>();
    let skipped = 0;
    for (const document of documents) {
      const type = types.get(document.documentTypeId);
      if (type?.kind !== 'STRUCTURED') continue;
      if (!type.isActive) {
        skipped += 1;
        continue;
      }
      const copy = await this.creation.create(tx, {
        processId: input.targetProcessId,
        documentTypeId: type.id,
        title: document.title,
        templateVersionId: document.templateVersionId,
        draftContent: draftContentCopy(document.draftContent, {
          actorId: userId,
          now: this.clock(),
        }),
        confidentiality: document.confidentiality,
        sourceDocumentId: document.id,
        idempotencyKey: input.idempotencyKey,
      });
      copied.set(document.id, copy.id);
    }
    return { copied, skipped };
  }

  /**
   * Documentos não excluídos do processo (inclusive cancelados) como a tramitação os registra
   * (US-047 · RN-TRAM-12 · `MovementDocumentRef`): tipo, código, título, status, versão atual e a
   * última alteração (rascunho salvo ou versão criada). Leitura no `tx` do encaminhamento.
   */
  async movementDocumentsIn(tx: TenantTx, processId: string): Promise<MovementDocumentFact[]> {
    const documents = await this.documents.listByProcess(tx, processId);
    if (documents.length === 0) return [];
    const types = new Map((await this.types.list(tx)).map((type) => [type.id, type]));
    return documents.map((document) => ({
      id: document.id,
      typeCode: types.get(document.documentTypeId)?.code ?? '',
      code: document.code,
      title: document.title,
      status: document.status,
      currentVersionId: document.currentVersionId,
      currentVersionNumber: document.currentVersionNumber,
      updatedAt: document.updatedAt,
    }));
  }

  /** RN-DOC-44: o documento entra na aprovação de etapa que o cobre (US-047/US-051). */
  enterApprovalStageIn(tx: TenantTx, input: StageEntryInput): Promise<StageEntryResult> {
    return this.approvals.enterApprovalStage(tx, input);
  }

  /** RN-DOC-45: a decisão da aprovação pendente do documento (US-052). */
  applyApprovalDecisionIn(tx: TenantTx, input: ApprovalDecisionInput): Promise<Document> {
    return this.approvals.applyApprovalDecision(tx, input);
  }

  /**
   * RN-TRAM-57/58 (US-052): a decisão no documento coberto e, quando ele passa a `APPROVED`, o selo
   * `APPROVAL_STAMPED` `PENDING` (o job sai em `afterCommit`, depois do commit) e o gancho
   * `onDocumentApproved` — no `tx` da decisão.
   */
  applyApprovalOutcomeIn(
    tx: TenantTx,
    input: ApprovalOutcomeInput,
  ): Promise<ApprovalOutcomeResult> {
    return this.outcomes.apply(tx, input);
  }

  /**
   * US-017: os efeitos do módulo tipado (ex.: o DFD propaga ao processo) na decisão da aprovação de
   * etapa, no `tx` da decisão e depois da mudança de etapa. Falha desfaz a decisão inteira.
   */
  applyApprovalEffectsIn(tx: TenantTx, input: TypedApprovalEffectsInput): Promise<void> {
    return this.outcomes.applyTypedEffects(tx, input);
  }

  /**
   * US-052: os documentos cobertos de uma aprovação (código, tipo, versão analisada, status) e os
   * autores — criador do documento e da versão analisada (segregação — RN-TRAM-62). Leitura.
   */
  approvalCoverageIn(
    tx: TenantTx,
    coverage: readonly { readonly documentId: string; readonly documentVersionId: string }[],
  ): Promise<CoverageFacts> {
    return this.outcomes.coverage(tx, coverage);
  }

  /** Gancho interno `onDocumentApproved` (US-052): integrações futuras, no `tx` da decisão. */
  onDocumentApproved(listener: DocumentApprovedListener): void {
    this.outcomes.onDocumentApproved(listener);
  }

  /**
   * RN-PROC-106 · DEC-018 (US-009): a aprovação que cobria o documento foi cancelada com o processo —
   * `IN_REVIEW` volta a `DRAFT` (retirada automática); `null` = nada mudou.
   */
  releaseCanceledApprovalIn(tx: TenantTx, input: CanceledApprovalInput): Promise<Document | null> {
    return this.approvals.releaseCanceledApproval(tx, input);
  }

  /**
   * Alvo de uma geração com IA (US-115 · POL-02 de edição para o usuário da requisição): lança
   * 403/409/422 como a edição do documento e devolve o que o pedido e o gerador precisam. Leitura.
   */
  aiTargetIn(tx: TenantTx, input: AiDocumentTargetInput): Promise<AiDocumentTarget> {
    return this.aiTargets.resolve(tx, input);
  }

  /**
   * Fonte do rascunho com IA (US-117 · RN-AI-25/26), no `tx` do job (RLS) e DEPOIS do `aiTargetIn`
   * do solicitante: versão de template fixada com o guia de redação, estado das seções e itens do
   * documento. `null` = inexistente no tenant ou excluído. Leitura; nunca o texto das seções.
   */
  async aiDraftSourceIn(tx: TenantTx, documentId: string): Promise<AiDraftSource | null> {
    const context = await this.lifecycle.loadInternal(tx, documentId);
    if (context?.document.deletedAt !== null) return null;
    const { document, template, type } = context;
    const items = await this.itemRows.rowsOf(tx, document.id);
    return {
      documentId: document.id,
      processId: document.processId,
      documentTypeCode: type.code,
      draftRevision: document.draftRevision,
      template:
        template === null
          ? null
          : {
              versionId: template.id,
              versionNumber: template.versionNumber,
              sections: [...template.sections]
                .sort((a, b) => a.order - b.order)
                .map((section) => ({
                  key: section.key,
                  title: section.title,
                  order: section.order,
                  requirement: section.requirement,
                  helpText: section.helpText ?? null,
                  legalBasis: section.legalBasis ?? null,
                  defaultText:
                    section.defaultContent === undefined
                      ? null
                      : richTextPlainText(section.defaultContent).trim() || null,
                  maxChars: section.maxChars,
                  render: section.render,
                  allowNarrative: section.allowNarrative,
                })),
            },
      sectionStates: Object.fromEntries(
        Object.entries(document.draftContent.sections).map(([key, section]) => [
          key,
          section.state,
        ]),
      ),
      items: [...items]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => ({
          processItemId: item.processItemId,
          quantity: item.quantity,
          calculationMemo: item.calculationMemo
            ? richTextPlainText(item.calculationMemo).trim() || null
            : null,
        })),
    };
  }

  /**
   * A seção a ajustar com IA (US-121 · RN-AI-48), no `tx` do chamador (RLS): definição no template
   * fixado, estado, revisão, texto atual e as demais seções preenchidas como texto. `null` sem
   * documento. Leitura; a POL-02 e o status são do `aiTargetIn`.
   */
  async aiSectionSourceIn(
    tx: TenantTx,
    documentId: string,
    sectionKey: string,
  ): Promise<AiSectionSource | null> {
    const context = await this.lifecycle.loadInternal(tx, documentId);
    if (context?.document.deletedAt !== null) return null;
    const { document, template, type } = context;
    const definitions = [...(template?.sections ?? [])].sort((a, b) => a.order - b.order);
    const definition = definitions.find((section) => section.key === sectionKey);
    const textOf = (key: string) => {
      const section = document.draftContent.sections[key];
      return section?.content ? richTextPlainText(section.content).trim() : '';
    };
    const current = document.draftContent.sections[sectionKey];
    return {
      documentId: document.id,
      processId: document.processId,
      documentTypeCode: type.code,
      draftRevision: document.draftRevision,
      template:
        template === null
          ? null
          : { versionId: template.id, versionNumber: template.versionNumber },
      definition:
        definition === undefined
          ? null
          : {
              key: definition.key,
              title: definition.title,
              requirement: definition.requirement,
              helpText: definition.helpText ?? null,
              legalBasis: definition.legalBasis ?? null,
              defaultText:
                definition.defaultContent === undefined
                  ? null
                  : richTextPlainText(definition.defaultContent).trim() || null,
              maxChars: definition.maxChars,
              render: definition.render,
              allowNarrative: definition.allowNarrative,
            },
      state: current?.state ?? 'EMPTY',
      revision: current?.revision ?? 0,
      text: current?.state === 'FILLED' ? textOf(sectionKey) : '',
      otherSections: definitions.flatMap((section) => {
        if (section.key === sectionKey) return [];
        if (document.draftContent.sections[section.key]?.state !== 'FILLED') return [];
        const text = textOf(section.key);
        return text === '' ? [] : [{ key: section.key, title: section.title, text }];
      }),
    };
  }

  /**
   * Documento da cadeia como entrada de geração com IA (US-119 · RN-AI-33/38), no `tx` do chamador
   * (RLS): o documento ativo (não cancelado nem excluído) do tipo de sistema no processo, pela
   * precedência aprovada → versão (finalizado/em revisão) → rascunho. `null` sem documento. Só
   * seções `FILLED` como texto puro (quem chama decide quais seções omitir). Leitura.
   */
  async aiChainSourceIn(
    tx: TenantTx,
    processId: string,
    systemModule: SystemDocumentModule,
  ): Promise<AiChainSource | null> {
    const type = (await this.types.list(tx)).find(
      (candidate) => candidate.systemModule === systemModule,
    );
    if (type === undefined) return null;
    const document = await this.documents.findActiveOfType(tx, processId, type.id);
    if (document === null) return null;
    const textsOf = (
      sections: Readonly<Record<string, { readonly state: string; readonly content: unknown }>>,
    ) =>
      Object.entries(sections).flatMap(([key, section]) => {
        if (section.state !== 'FILLED' || section.content === null) return [];
        const text = richTextPlainText(
          section.content as Parameters<typeof richTextPlainText>[0],
        ).trim();
        return text === '' ? [] : [{ key, text }];
      });
    const versioned = document.status !== 'DRAFT' && document.status !== 'RETURNED';
    const versionId = document.approvedVersionId ?? (versioned ? document.currentVersionId : null);
    if (versionId !== null) {
      const version = await this.documents.findVersion(tx, versionId);
      if (version?.documentId === document.id && version.content !== null) {
        return {
          documentId: document.id,
          documentTypeCode: type.code,
          status: document.status,
          source: versionId === document.approvedVersionId ? 'APPROVED_VERSION' : 'VERSION',
          versionNumber: version.versionNumber,
          draftRevision: null,
          sections: textsOf(version.content.sections),
        };
      }
    }
    return {
      documentId: document.id,
      documentTypeCode: type.code,
      status: document.status,
      source: 'DRAFT',
      versionNumber: null,
      draftRevision: document.draftRevision,
      sections: textsOf(document.draftContent.sections),
    };
  }

  /**
   * Coleção de documento tipado para LEITURA (US-033 · DEC-024): 404 `NOT_FOUND` se o processo não
   * é visível; o documento dono (ex.: `RISK_MAP`) e, sem lançar, se o usuário pode alterá-la agora.
   */
  typedCollectionStateIn(tx: TenantTx, input: TypedCollectionInput): Promise<TypedCollectionState> {
    return this.collections.inspect(tx, input);
  }

  /**
   * POL-02 estendida às coleções dos documentos tipados (RN-RISK-09): lança 403/404/409/422 e
   * trava o documento dono no `tx` do chamador (corrida com a finalização).
   */
  assertTypedCollectionWritableIn(
    tx: TenantTx,
    input: TypedCollectionInput,
  ): Promise<TypedCollectionWrite> {
    return this.collections.assertWritable(tx, input);
  }

  /**
   * US-071 (RN-CMT-01): o documento-alvo de um comentário no processo — status, sigilo e chaves de
   * seção do template (`null` = externo). `null` se inexistente, excluído ou de outro processo.
   */
  commentTargetIn(
    tx: TenantTx,
    processId: string,
    documentId: string,
  ): Promise<CommentDocumentTarget | null> {
    return this.commentTargets.resolve(tx, processId, documentId);
  }

  /** US-071 (RN-CMT-13): código, título e sigilo atual dos documentos comentados. */
  commentDocumentLabels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, CommentDocumentLabel>> {
    return this.commentTargets.labels(tx, ids);
  }

  /** Fonte `DOCUMENT` da timeline: código, título e nome do tipo (RN-TML-04). */
  async documentLabels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<
    Map<string, { readonly code: string | null; readonly title: string; readonly typeName: string }>
  > {
    const labels = await this.documents.labels(tx, ids);
    const typeNames = new Map((await this.types.list(tx)).map((type) => [type.id, type.name]));
    return new Map(
      [...labels].map(([id, label]) => [
        id,
        {
          code: label.code,
          title: label.title,
          typeName: typeNames.get(label.documentTypeId) ?? '',
        },
      ]),
    );
  }

  /**
   * Documentos do painel situacional (US-004 · RN-PROC-48(6)): não cancelados nem excluídos, com
   * tipo, código, título, status, versão atual, sigilo e o selo "Em aprovação"
   * (`pendingApprovalId` — DEC-018). Quem chama decide o que mascarar (POL-09).
   */
  async listForSummary(tx: TenantTx, processId: string): Promise<SummaryDocumentFact[]> {
    const documents = await this.documents.listActiveByProcess(tx, processId);
    if (documents.length === 0) return [];
    const types = new Map((await this.types.list(tx)).map((type) => [type.id, type]));
    return documents.map((document) => {
      const type = types.get(document.documentTypeId);
      return {
        id: document.id,
        typeCode: type?.code ?? '',
        typeName: type?.name ?? '',
        code: document.code,
        title: document.title,
        status: document.status,
        versionNumber: document.currentVersionNumber,
        confidentiality: document.confidentiality,
        inApproval: document.pendingApprovalId !== null,
      };
    });
  }

  /**
   * Cascata do sigilo do orçamento (US-013 · RN-PROC-139), no `tx` do PRC-33: ao ativar, todo
   * documento de pesquisa de preços (`systemModule = PRICE_RESEARCH`) não excluído do processo —
   * inclusive `FINALIZED`/`APPROVED`/cancelado — passa a `RESTRICTED`; ao desativar, volta à
   * confidencialidade padrão do tipo. Cada documento alterado é travado (`FOR UPDATE`), relido e
   * gravado com `version + 1` (DEC-055: uma edição concorrente com a versão antiga recebe 412 em vez
   * de sobrescrever o sigilo). Devolve quantos documentos mudaram.
   */
  async applyBudgetConfidentialityIn(
    tx: TenantTx,
    processId: string,
    isBudgetConfidential: boolean,
  ): Promise<number> {
    const types = new Map(
      (await this.types.list(tx))
        .filter((type) => type.systemModule === 'PRICE_RESEARCH')
        .map((type) => [type.id, type]),
    );
    if (types.size === 0) return 0;
    const targetOf = (document: Document): Confidentiality | null => {
      const type = types.get(document.documentTypeId);
      if (type === undefined) return null;
      return isBudgetConfidential ? 'RESTRICTED' : type.defaultConfidentiality;
    };
    const candidates = (await this.documents.listByProcess(tx, processId)).filter((document) => {
      const target = targetOf(document);
      return target !== null && document.confidentiality !== target;
    });
    const updatedById = requireRequestContext().actor.userId;
    const now = this.clock();
    let changed = 0;
    for (const candidate of candidates) {
      await this.documents.lockForUpdate(tx, candidate.id);
      const current = await this.documents.findById(tx, candidate.id);
      const target = current === null ? null : targetOf(current);
      if (current === null || target === null || current.confidentiality === target) continue;
      await this.documents.update(
        tx,
        { ...current, confidentiality: target, updatedAt: now, updatedById },
        current.version,
      );
      changed += 1;
    }
    return changed;
  }

  /** Fonte `DOCUMENT_VERSION` da timeline: número da versão. */
  versionNumbers(tx: TenantTx, versionIds: readonly string[]): Promise<Map<string, number>> {
    return this.documents.versionNumbers(tx, versionIds);
  }
}
