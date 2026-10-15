import { DocumentTypeChanged } from '@contrataflow/validation';
import type { DocumentTypeDto, DocumentTypeUpdate } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { DocumentTypeUsageRegistry } from '#shared/document/document-type-usage.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { ApprovalPolicyValidator } from './approval-policy.validator.js';
import { documentTypeNotFound, ruleErrorToApiError } from './document-type.errors.js';
import { DocumentTypeFacade } from './document-type.facade.js';
import { toDocumentTypeDto } from './document-type.view.js';
import {
  DOCUMENT_CLOCK,
  DOCUMENT_COUNTER,
  DOCUMENT_TRANSACTIONS,
  DOCUMENT_TYPE_REPOSITORY,
} from './ports.js';
import type {
  DocumentClock,
  DocumentCounter,
  DocumentTransactions,
  DocumentTypeRepository,
} from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { DocumentTypeRuleError, updateDocumentType } from '../domain/document-type.js';

export interface UpdateDocumentTypeInput {
  readonly id: string;
  readonly patch: DocumentTypeUpdate;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

export interface UpdateDocumentTypeResult {
  readonly type: DocumentTypeDto;
}

/**
 * `UpdateDocumentTypeCommand` — DTY-03 (US-061 · fluxo principal, passo 8), inclusive ativar e
 * desativar. Autoriza (`DOCUMENT_TYPE_MANAGE` + MFA), lê o tipo sob a RLS (outro tenant → 404),
 * confere a versão (412), aplica as regras RN-DOC-03..09 e, na mesma transação, grava
 * `document_type.update` (com o impacto) e `DocumentTypeChanged`. Nada alterado → 200 sem nova
 * versão, auditoria nem evento.
 */
@Injectable()
export class UpdateDocumentTypeCommand {
  private readonly logger = new Logger('DocumentTypes');

  constructor(
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(DOCUMENT_COUNTER) private readonly counter: DocumentCounter,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly policies: ApprovalPolicyValidator,
    private readonly usage: DocumentTypeUsageRegistry,
    private readonly facade: DocumentTypeFacade,
  ) {}

  async execute(input: UpdateDocumentTypeInput): Promise<UpdateDocumentTypeResult> {
    this.access.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    const outcome = await this.transactions.run(async (tx) => {
      const current = await this.types.findById(tx, input.id);
      if (!current) throw documentTypeNotFound();
      if (current.version !== input.expectedVersion) {
        throw new VersionConflictError({
          aggregateType: 'DocumentType',
          aggregateId: current.id,
          expectedVersion: input.expectedVersion,
        });
      }

      const documentsCount = await this.counter.countByType(tx, current.id);
      let result;
      try {
        result = updateDocumentType(current, input.patch, {
          now,
          userId: context.actor.userId,
          documentsCount,
        });
      } catch (error) {
        if (error instanceof DocumentTypeRuleError) throw ruleErrorToApiError(error);
        throw error;
      }
      if (result.changedFields.length === 0) return { type: current, written: false } as const;

      if (result.policyNeedsValidation && result.next.approvalPolicy) {
        await this.policies.assertResolvable(tx, result.next.approvalPolicy, now);
      }
      const usage = await this.usage.usageOf(tx, current.code);
      if (result.deactivates && usage.blockingRules.length > 0) {
        const [rule] = usage.blockingRules;
        throw new ApiError('CONFLICT', {
          detail: `Este tipo é exigido pelo fluxo ${rule?.workflowName ?? ''} (etapa ${rule?.stageName ?? ''}). Ajuste o fluxo antes de desativar.`,
          extensions: {
            blockingRules: usage.blockingRules.map((blocking) => ({
              workflow: blocking.workflowName,
              stage: blocking.stageName,
            })),
          },
        });
      }

      await this.types.update(tx, result.next, current.version);
      await this.audit.record(tx, {
        action: 'document_type.update',
        entityType: 'DocumentType',
        entityId: current.id,
        changes: result.changes,
        metadata: {
          code: current.code,
          isSystem: current.isSystem,
          impact: {
            documentsCount,
            workflowsReferencing: usage.referencingWorkflows,
          },
        },
      });
      await this.outbox.record(
        tx,
        DocumentTypeChanged.of({
          aggregateId: current.id,
          payload: {
            documentTypeId: current.id,
            code: current.code,
            changedFields: [...result.changedFields],
          },
        }),
      );
      return {
        type: { ...result.next, version: current.version + 1 },
        written: true,
        deactivated: result.deactivates,
        documentsCount,
        changedFields: result.changedFields,
      } as const;
    });

    if (outcome.written) {
      this.logger.log(
        {
          event: outcome.deactivated ? 'document_type.deactivated' : 'document_type.updated',
          documentTypeId: outcome.type.id,
          code: outcome.type.code,
          changedFields: outcome.changedFields,
          ...(outcome.deactivated ? { existingDocumentsCount: outcome.documentsCount } : {}),
          tenantId: outcome.type.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        outcome.deactivated ? 'document_type.deactivated' : 'document_type.updated',
      );
      await this.facade.invalidate();
    }
    return { type: toDocumentTypeDto(outcome.type, now) };
  }
}
