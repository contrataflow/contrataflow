import { DocumentTypeChanged } from '@contrataflow/validation';
import type { DocumentTypeCreate, DocumentTypeDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { ApprovalPolicyValidator } from './approval-policy.validator.js';
import { documentTypeCodeTaken, ruleErrorToApiError } from './document-type.errors.js';
import { DocumentTypeFacade } from './document-type.facade.js';
import { toDocumentTypeDto } from './document-type.view.js';
import {
  DOCUMENT_CLOCK,
  DOCUMENT_TRANSACTIONS,
  DOCUMENT_TYPE_REPOSITORY,
  DocumentTypeCodeTakenError,
} from './ports.js';
import type { DocumentClock, DocumentTransactions, DocumentTypeRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { createCustomDocumentType, DocumentTypeRuleError } from '../domain/document-type.js';

export interface CreateDocumentTypeInput {
  readonly body: DocumentTypeCreate;
  /** `Idempotency-Key` da requisição, registrada na auditoria. */
  readonly idempotencyKey: string | null;
}

/** Campos informados pelo cliente (evento e auditoria): só os que vieram no corpo. */
function informedFields(body: DocumentTypeCreate): string[] {
  return Object.entries(body)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([field]) => field);
}

/**
 * `CreateDocumentTypeCommand` — DTY-02 (US-061 · fluxo principal, passo 6): autoriza
 * (`DOCUMENT_TYPE_MANAGE` + MFA), valida máscara e política (RN-DOC-05/06/07) e, numa transação,
 * insere o tipo personalizado (`isSystem = false`), grava `document_type.create` e o evento
 * `DocumentTypeChanged`. Código repetido no tenant → 409 `CONFLICT` (V-05).
 */
@Injectable()
export class CreateDocumentTypeCommand {
  private readonly logger = new Logger('DocumentTypes');

  constructor(
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly policies: ApprovalPolicyValidator,
    private readonly facade: DocumentTypeFacade,
  ) {}

  async execute(input: CreateDocumentTypeInput): Promise<DocumentTypeDto> {
    this.access.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const { body } = input;

    let draft;
    try {
      draft = createCustomDocumentType(body, {
        id: newId(),
        tenantId: context.tenantId ?? '',
        now,
        userId: context.actor.userId,
      });
    } catch (error) {
      if (error instanceof DocumentTypeRuleError) throw ruleErrorToApiError(error);
      throw error;
    }

    const created = await this.transactions.run(async (tx) => {
      if (await this.types.findByCode(tx, draft.code)) throw documentTypeCodeTaken(draft.code);
      if (draft.requiresApproval && draft.approvalPolicy) {
        await this.policies.assertResolvable(tx, draft.approvalPolicy, now);
      }
      try {
        await this.types.insert(tx, draft);
      } catch (error) {
        if (error instanceof DocumentTypeCodeTakenError) throw documentTypeCodeTaken(draft.code);
        throw error;
      }
      const changedFields = informedFields(body);
      const changes: AuditChange[] = changedFields.map((path) => ({
        path,
        old: null,
        new: draft[path as keyof typeof draft],
      }));
      await this.audit.record(tx, {
        action: 'document_type.create',
        entityType: 'DocumentType',
        entityId: draft.id,
        changes,
        metadata: {
          code: draft.code,
          kind: draft.kind,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await this.outbox.record(
        tx,
        DocumentTypeChanged.of({
          aggregateId: draft.id,
          payload: { documentTypeId: draft.id, code: draft.code, changedFields },
        }),
      );
      return draft;
    });

    this.logger.log(
      {
        event: 'document_type.created',
        documentTypeId: created.id,
        code: created.code,
        tenantId: created.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'document_type.created',
    );
    await this.facade.invalidate();
    return toDocumentTypeDto(created, now);
  }
}
