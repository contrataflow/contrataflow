import { DOCUMENT_SECTION_MESSAGES, sectionContentBytes } from '@contrataflow/validation';
import type {
  DocumentSectionSavedDto,
  DraftSection,
  RichTextDoc,
  SectionConflictCurrent,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { DRAFT_AUDIT_COALESCER } from '#shared/audit/draft-audit.js';
import type { DraftAuditCoalescerPort, DraftAuditTicket } from '#shared/audit/draft-audit.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext } from './document-lifecycle.service.js';
import {
  documentNotEditable,
  documentNotFound,
  notProcessCustodian,
  sectionNotInTemplate,
  sectionProblemError,
  sectionRevisionConflict,
} from './document.errors.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { isEditable } from '../domain/document.js';
import type { Document } from '../domain/document.js';
import {
  applySectionDraft,
  isIdenticalSave,
  sectionDraftProblem,
  sectionDraftValue,
  sectionValueHash,
} from '../domain/section-draft.js';

/*
 * `SaveDocumentSectionCommand` — DOC-05 (US-015 · RN-DFD-23..36 · DEC-055/056/017): o autosave
 * genérico de seção, usado por todos os tipos (DFD, ETP, TR, documentos livres). Antes da
 * transação, a janela da auditoria coalescida (Redis — RN-DFD-35). Numa transação curta, sem
 * `FOR UPDATE`: documento visível (404) → permissão de EDIÇÃO do tipo + POL-02 (403
 * `NOT_PROCESS_CUSTODIAN` com `access.denied`, 409 processo, 422 etapa) → chave na versão do
 * template (422) → conteúdo (413/422) → documento editável (409) → reenvio idêntico (200 no-op,
 * RN-DFD-36) → revisão esperada (412 com `meta.current`) → atualização condicional atômica (estado
 * derivado, `revision + 1`, `draftRevision + 1`, `Document.version` intacta — RN-DFD-26) →
 * auditoria (coalescida, ou imediata em "Manter a minha versão"). Sem evento de domínio nem versão.
 * Nunca registra o texto: só hash e tamanho.
 */

let savesCounter: Counter | undefined;
let conflictsCounter: Counter | undefined;

/** `document_section_saves_total{result}` e `document_section_conflicts_total` (DoD da US-015). */
function countSave(result: 'saved' | 'noop'): void {
  savesCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('document_section_saves_total', {
      description: 'Gravações de seção do rascunho (DOC-05), por resultado.',
    });
  savesCounter.add(1, { result });
}

function countConflict(): void {
  conflictsCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('document_section_conflicts_total', {
      description: 'Gravações de seção recusadas por revisão divergente (412).',
    });
  conflictsCounter.add(1);
}

export interface SaveDocumentSectionInput {
  readonly documentId: string;
  readonly sectionKey: string;
  readonly expectedRevision: number;
  readonly content: RichTextDoc | null;
  readonly notApplicable: boolean;
  readonly justification: string | null;
  readonly overwrittenRevision: number | null;
}

export interface SaveDocumentSectionResult {
  readonly saved: DocumentSectionSavedDto;
  /** `false` = reenvio idêntico aceito sem gravar (RN-DFD-36). */
  readonly applied: boolean;
  /** A gravação foi auditada agora (janela aberta ou sobrescrita após conflito). */
  readonly audited: boolean;
  readonly documentId: string;
  readonly sizeBytes: number;
}

interface CommandInput extends SaveDocumentSectionInput {
  readonly ticket: DraftAuditTicket;
}

@Injectable()
export class SaveDocumentSectionCommand extends TransactionalCommandHandler<
  CommandInput,
  undefined,
  SaveDocumentSectionResult
> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    private readonly lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(DRAFT_AUDIT_COALESCER) private readonly coalescer: DraftAuditCoalescerPort,
    private readonly identity: IdentityFacade,
    private readonly numbering: NumberingFacade,
  ) {
    super('document.section_save', transactions);
  }

  /**
   * Abre a janela da auditoria (fora da transação), executa e fecha: gravação auditada guarda a
   * revisão para a próxima faixa; gravação que não aconteceu devolve a janela que abriu.
   */
  async save(input: SaveDocumentSectionInput): Promise<SaveDocumentSectionResult> {
    const context = requireRequestContext();
    const ticket = await this.coalescer.open({
      tenantId: context.tenantId ?? '',
      documentId: input.documentId,
      target: `SECTION:${input.sectionKey}`,
      userId: context.actor.userId ?? '',
    });
    let result: SaveDocumentSectionResult;
    try {
      result = await this.execute({ ...input, ticket });
    } catch (error) {
      await this.coalescer.abandon(ticket);
      throw error;
    }
    if (result.audited && ticket.record)
      await this.coalescer.recorded(ticket, result.saved.revision);
    else if (!result.audited) await this.coalescer.abandon(ticket);
    return result;
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(tx: TenantTx, input: CommandInput): Promise<SaveDocumentSectionResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit', undefined, () =>
      notProcessCustodian('POL-02', DOCUMENT_SECTION_MESSAGES.notCustodian),
    );
    const actorId = actor.userId;
    if (actorId === '') throw new ApiError('UNAUTHENTICATED');
    const definition = context.template?.sections.find(
      (section) => section.key === input.sectionKey,
    );
    if (definition === undefined) throw sectionNotInTemplate();
    const draft = {
      content: input.content,
      notApplicable: input.notApplicable,
      justification: input.justification,
    };
    const problem = sectionDraftProblem(draft, definition);
    if (problem !== null) throw sectionProblemError(problem);

    const { document } = context;
    if (!isEditable(document)) throw documentNotEditable(document);
    const previous = document.draftContent.sections[input.sectionKey];
    const value = sectionDraftValue(draft);
    const sizeBytes = sectionContentBytes(value.content);
    if (isIdenticalSave(previous, value) && previous !== undefined) {
      return {
        saved: await this.savedOf(tx, input.sectionKey, previous, document.draftRevision),
        applied: false,
        audited: false,
        documentId: document.id,
        sizeBytes,
      };
    }
    const currentRevision = previous?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw await this.conflict(tx, context, input, previous);
    }

    const now = this.clock();
    const section = applySectionDraft(previous, value, { actorId, now });
    const draftRevision = await this.documents.saveSectionDraft(tx, {
      documentId: document.id,
      sectionKey: input.sectionKey,
      section,
      expectedRevision: input.expectedRevision,
      actorId,
      now,
    });
    if (draftRevision === null) throw await this.diagnose(tx, input);

    const overwritten = input.overwrittenRevision !== null;
    const audited = overwritten || input.ticket.record;
    if (audited) {
      await this.audit.record(tx, {
        action: 'document.draft_update',
        entityType: 'Document',
        entityId: document.id,
        processId: document.processId,
        metadata: {
          documentCode: document.code,
          target: `SECTION:${input.sectionKey}`,
          sectionKey: input.sectionKey,
          state: section.state,
          fromRevision: overwritten
            ? section.revision
            : this.coalescer.fromRevision(input.ticket, section.revision),
          toRevision: section.revision,
          sizeBytesBefore: sectionContentBytes(previous?.content ?? null),
          sizeBytesAfter: sizeBytes,
          contentHash: sectionValueHash(value),
          ...(overwritten
            ? {
                conflictResolution: 'KEEP_MINE',
                overwrittenRevision: input.overwrittenRevision,
                overwrittenAuthorId: previous?.updatedById ?? null,
              }
            : { windowMinutes: 10 }),
        },
      });
    }
    return {
      saved: await this.savedOf(tx, input.sectionKey, section, draftRevision),
      applied: true,
      audited,
      documentId: document.id,
      sizeBytes,
    };
  }

  protected override committed(result: SaveDocumentSectionResult, durationMs: number): void {
    countSave(result.applied ? 'saved' : 'noop');
    this.logger.debug(
      {
        event: 'document.section_saved',
        documentId: result.documentId,
        sectionKey: result.saved.sectionKey,
        revision: result.saved.revision,
        applied: result.applied,
        sizeBytes: result.sizeBytes,
        durationMs,
      },
      'document.section_saved',
    );
  }

  /** A resposta 200 (`updatedBy` com o nome de quem gravou por último). */
  private async savedOf(
    tx: TenantTx,
    sectionKey: string,
    section: DraftSection,
    draftRevision: number,
  ): Promise<DocumentSectionSavedDto> {
    return {
      sectionKey,
      state: section.state,
      revision: section.revision,
      updatedAt: section.updatedAt,
      updatedBy: await this.authorOf(tx, section.updatedById),
      draftRevision,
    };
  }

  private async authorOf(tx: TenantTx, userId: string | undefined) {
    if (userId === undefined) return null;
    const names = await this.identity.userDisplayNames(tx, [userId]);
    return { id: userId, name: names.get(userId) ?? null };
  }

  /** V-02 → 412 com a seção atual (FA-01 · "Alterado por Bruno Carvalho às 14:31"). */
  private async conflict(
    tx: TenantTx,
    context: Pick<DocumentContext, 'document'>,
    input: CommandInput,
    current: DraftSection | undefined,
  ): Promise<ApiError> {
    countConflict();
    const revision = current?.revision ?? 0;
    this.logger.log(
      {
        event: 'document.section_conflict',
        documentId: context.document.id,
        sectionKey: input.sectionKey,
        expectedRevision: input.expectedRevision,
        currentRevision: revision,
      },
      'document.section_conflict',
    );
    const updatedBy = await this.authorOf(tx, current?.updatedById);
    const updatedAt = current?.updatedAt ?? context.document.updatedAt.toISOString();
    const body: SectionConflictCurrent = {
      sectionKey: input.sectionKey,
      state: current?.state ?? 'EMPTY',
      revision,
      content: current?.content ?? null,
      justification: current?.justification ?? null,
      updatedAt,
      updatedBy,
    };
    const { timezone } = await this.numbering.settingsOf(tx);
    const time = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(updatedAt));
    return sectionRevisionConflict(
      body,
      DOCUMENT_SECTION_MESSAGES.conflict(updatedBy?.name ?? 'outra pessoa', time),
    );
  }

  /** Zero linhas na atualização condicional: relê para distinguir 404, 409 e 412. */
  private async diagnose(tx: TenantTx, input: CommandInput): Promise<ApiError> {
    const fresh: Document | null = await this.documents.findById(tx, input.documentId);
    if (fresh === null) return documentNotFound();
    if (!isEditable(fresh)) return documentNotEditable(fresh);
    return this.conflict(
      tx,
      { document: fresh },
      input,
      fresh.draftContent.sections[input.sectionKey],
    );
  }
}
