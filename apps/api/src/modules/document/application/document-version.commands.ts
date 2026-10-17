import { DOCUMENT_VERSION_MESSAGES } from '@contrataflow/validation';
import type { DocumentVersionDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { toDocumentVersionDto } from './document-version.view.js';
import { recordDocumentVersion } from './document.commands.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { DocumentTransitionError, recordManualVersion } from '../domain/document.js';

/*
 * `SaveDocumentVersionCommand` — DOC-16 (US-066 · RN-DOC-56..58 · DEC-084): "Salvar versão" do
 * rascunho, sem mudar o status, numa ÚNICA transação do tenant: travar a linha do documento
 * (`FOR UPDATE` — dois pedidos simultâneos viram versões n e n+1, sem lacuna nem repetição) →
 * carregar (404) → POL-02 de edição (403/409/422) → tipo não `UPLOADED` (422 `NOT_ALLOWED`) →
 * documento em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`) → gravar o documento apontando a
 * versão nova → `DocumentVersion` `MANUAL` (snapshot + SHA-256 do JSON canônico, a mesma
 * `createVersion` das transições) → `document.version_create` → `DocumentVersionCreated` → commit.
 * Sem `If-Match` (api.md DOC-16): a proteção é a trava de linha e o índice único de
 * `version_number`.
 */

export interface SaveDocumentVersionInput {
  readonly documentId: string;
  readonly changeSummary: string | null;
}

@Injectable()
export class SaveDocumentVersionCommand extends TransactionalCommandHandler<
  SaveDocumentVersionInput,
  undefined,
  DocumentVersionDto
> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    private readonly lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly identity: IdentityFacade,
  ) {
    super('document.version_save', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected async handle(
    tx: TenantTx,
    input: SaveDocumentVersionInput,
  ): Promise<DocumentVersionDto> {
    await this.lifecycle.lockForVersioning(tx, input.documentId);
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    const { document, type } = context;
    if (type.kind === 'UPLOADED') {
      throw validationError([
        {
          field: 'kind',
          code: 'NOT_ALLOWED',
          message: DOCUMENT_VERSION_MESSAGES.uploadedNotAllowed,
        },
      ]);
    }

    const actorId = actor.userId;
    if (actorId === '') throw new ApiError('UNAUTHENTICATED');
    const now = this.clock();
    const versionNumber = await this.lifecycle.nextVersionNumber(tx, document.id);
    const versionId = newId();
    let next;
    try {
      next = recordManualVersion(document, { actorId, now, versionId, versionNumber });
    } catch (error) {
      if (error instanceof DocumentTransitionError) {
        throw new ApiError('DOCUMENT_NOT_EDITABLE', {
          detail: DOCUMENT_VERSION_MESSAGES.notEditable,
          extensions: { status: document.status },
        });
      }
      throw error;
    }
    // Com a linha travada a `version` lida é a atual: a gravação condicionada não perde corrida.
    const saved = await this.lifecycle.save(tx, next, document.version);
    const version = await this.lifecycle.createVersion(tx, context, {
      document: saved,
      versionId,
      versionNumber,
      reason: 'MANUAL',
      actorId,
      now,
      changeSummary: input.changeSummary,
    });
    await recordDocumentVersion(this.audit, this.outbox, tx, context, version);
    const names = await this.identity.userDisplayNames(tx, [actorId]);
    // Colaborador pode editar sem ver o orçamento sigiloso: a resposta segue POL-09 como o DOC-17.
    const masker = await this.lifecycle.confidentialMasker(context, [version]);
    return toDocumentVersionDto(version, type.kind, masker(version.content), names);
  }

  protected override committed(result: DocumentVersionDto, durationMs: number): void {
    this.logger.log(
      {
        event: 'document.version_saved',
        documentId: result.documentId,
        documentVersionId: result.id,
        versionNumber: result.versionNumber,
        reason: result.reason,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'document.version_saved',
    );
  }
}
