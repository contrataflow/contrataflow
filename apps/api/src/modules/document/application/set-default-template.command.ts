import { DocumentTypeChanged } from '@contrataflow/validation';
import type { DocumentTypeDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { documentTypeNotFound } from './document-type.errors.js';
import { DocumentTypeFacade } from './document-type.facade.js';
import { toDocumentTypeDto } from './document-type.view.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentClock, DocumentTransactions, DocumentTypeRepository } from './ports.js';
import { templateNotFound, templateNotPublished, templateOfOtherType } from './template.errors.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { toDefaultTemplateView } from './template.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { DefaultTemplateRuleError, setDefaultTemplate } from '../domain/document-type.js';

export interface SetDefaultTemplateInput {
  readonly documentTypeId: string;
  readonly templateId: string;
  /** Versão do `If-Match` do tipo (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `SetDefaultTemplateCommand` — DTY-04 (US-108 · passo 7 · RN-TPL-19/20): `TEMPLATE_PUBLISH`
 * (+ MFA); tipo e template do tenant (404), `If-Match` do tipo (412), template do mesmo tipo (422
 * `VALIDATION_ERROR`), ativo e com versão publicada (422 `TEMPLATE_NOT_PUBLISHED`). Atualiza só o
 * `DocumentType` (não toca a versão) com `document_type.update` e `DocumentTypeChanged`
 * (`changedFields: ["defaultTemplateId"]`); o padrão anterior segue disponível. O mesmo template já
 * padrão → 200 sem nova versão, auditoria nem evento.
 */
@Injectable()
export class SetDefaultTemplateCommand {
  private readonly logger = new Logger('DocumentTypes');

  constructor(
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly facade: DocumentTypeFacade,
  ) {}

  async execute(input: SetDefaultTemplateInput): Promise<DocumentTypeDto> {
    this.access.assertCan('TEMPLATE_PUBLISH', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    const outcome = await this.transactions.run(async (tx) => {
      const current = await this.types.findById(tx, input.documentTypeId);
      if (!current) throw documentTypeNotFound();
      if (current.version !== input.expectedVersion) {
        throw new VersionConflictError({
          aggregateType: 'DocumentType',
          aggregateId: current.id,
          expectedVersion: input.expectedVersion,
        });
      }
      const template = await this.templates.findById(tx, input.templateId);
      if (!template) throw templateNotFound();

      let result;
      try {
        result = setDefaultTemplate(current, template, { now, userId: context.actor.userId });
      } catch (error) {
        if (error instanceof DefaultTemplateRuleError) {
          throw error.reason === 'OTHER_TYPE' ? templateOfOtherType() : templateNotPublished();
        }
        throw error;
      }
      const published = template.currentPublishedVersionId
        ? await this.templates.findVersionById(tx, template.currentPublishedVersionId)
        : null;
      const view = toDefaultTemplateView(template, published);
      if (!result.changed) return { type: current, view, previous: null, written: false } as const;

      await this.types.update(tx, result.next, current.version);
      await this.audit.record(tx, {
        action: 'document_type.update',
        entityType: 'DocumentType',
        entityId: current.id,
        changes: result.changes,
        metadata: { code: current.code, isSystem: current.isSystem, templateId: template.id },
      });
      await this.outbox.record(
        tx,
        DocumentTypeChanged.of({
          aggregateId: current.id,
          payload: {
            documentTypeId: current.id,
            code: current.code,
            changedFields: ['defaultTemplateId'],
          },
        }),
      );
      return {
        type: result.next,
        view,
        previous: current.defaultTemplateId,
        written: true,
      } as const;
    });

    if (outcome.written) {
      this.logger.log(
        {
          event: 'document_type.default_template_changed',
          documentTypeId: outcome.type.id,
          previousTemplateId: outcome.previous,
          templateId: outcome.type.defaultTemplateId,
          tenantId: outcome.type.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'document_type.default_template_changed',
      );
      await this.facade.invalidate();
    }
    return toDocumentTypeDto(outcome.type, now, outcome.view);
  }
}
