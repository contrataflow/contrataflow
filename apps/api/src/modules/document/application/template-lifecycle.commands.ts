import { TemplateVersionPublished, TemplateVersionRetired } from '@contrataflow/validation';
import type { TemplateVersionDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentClock, DocumentTransactions, DocumentTypeRepository } from './ports.js';
import { recordTemplateVersionLifecycle, TemplateContext } from './template-context.js';
import {
  templateDraftExists,
  templateInactive,
  templateInUse,
  templateInvalid,
  templateNotFound,
  templateVersionConflict,
  templateVersionNotDraft,
  templateVersionNotFound,
  templateVersionNotPublished,
} from './template.errors.js';
import { TEMPLATE_REPOSITORY, TemplateDraftExistsError } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { toTemplateVersionDto } from './template.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  newTemplateVersionFrom,
  publishTemplateVersion,
  retireTemplateVersion,
  TemplateContentInvalidError,
  TemplateInactiveError,
  TemplateInUseError,
  TemplateVersionNotDraftError,
  TemplateVersionNotPublishedError,
} from '../domain/document-template.js';
import type { DocumentTemplateVersion } from '../domain/document-template.js';

/*
 * Ciclo de vida das versões de template (US-108 · `DRAFT → PUBLISHED → RETIRED`, simétrico ao dos
 * workflows — DEC-015): nova versão (TPL-06), publicar (TPL-10) e aposentar (TPL-11). Nenhuma ação
 * altera documentos já criados (RN-TPL-16): cada documento referencia a versão da sua criação.
 */

/** Código do erro para os logs `*_failed`. */
function errorCodeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
}

/** 412 com a versão atual da linha (relida) quando o `UPDATE` condicionado não casou. */
async function conflictOf(
  templates: TemplateRepository,
  tx: Parameters<TemplateRepository['findVersionById']>[0],
  version: DocumentTemplateVersion,
): Promise<ApiError> {
  const fresh = await templates.findVersionById(tx, version.id);
  return templateVersionConflict(fresh?.version ?? version.version + 1);
}

export interface CreateTemplateVersionInput {
  readonly templateId: string;
  /** `Idempotency-Key` da requisição, registrada na auditoria. */
  readonly idempotencyKey: string | null;
}

/**
 * `CreateTemplateVersionCommand` — TPL-06 (US-108 · passo 5, FA-02 · RN-TPL-13): `TEMPLATE_MANAGE`;
 * clona a versão de maior número (publicada ou aposentada) num rascunho com o número seguinte e
 * grava `template.version_create`. Rascunho existente → 409 `TEMPLATE_DRAFT_EXISTS` com o id dele;
 * na corrida de duas solicitações, o índice parcial de rascunho único decide (a segunda recebe 409).
 */
@Injectable()
export class CreateTemplateVersionCommand {
  private readonly logger = new Logger('Templates');

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly templateContext: TemplateContext,
  ) {}

  async execute(input: CreateTemplateVersionInput): Promise<TemplateVersionDto> {
    this.access.assertCan('TEMPLATE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const catalog = await this.templateContext.catalog();

    const outcome = await this.transactions.run(async (tx) => {
      const template = await this.templates.findById(tx, input.templateId);
      if (!template) throw templateNotFound();
      const versions = await this.templates.findAllVersions(tx, template.id);
      const draft = versions.find((version) => version.status === 'DRAFT');
      if (draft) throw templateDraftExists(draft.id);
      const latest = versions.at(-1);
      if (!latest) throw new Error(`Template ${template.id} sem versões.`);

      const next = newTemplateVersionFrom(latest, {
        versionId: newId(),
        now,
        userId: context.actor.userId,
      });
      try {
        await this.templates.insertVersion(tx, next);
      } catch (error) {
        // Corrida: a outra solicitação criou o rascunho primeiro (a transação abortou — o id dele
        // não é relido; a UI recarrega o template).
        if (error instanceof TemplateDraftExistsError) throw templateDraftExists(null);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'template.version_create',
        entityType: 'DocumentTemplate',
        entityId: template.id,
        changes: [{ path: 'versionNumber', old: null, new: next.versionNumber }],
        metadata: {
          templateId: template.id,
          templateVersionId: next.id,
          versionNumber: next.versionNumber,
          clonedFromVersionId: latest.id,
          idempotencyKey: input.idempotencyKey,
        },
      });
      const type = this.templateContext.typeOf(catalog, template);
      const importSources = await this.templateContext.importSourcesFor(tx, catalog, type);
      return { template, version: next, type, importSources };
    });

    // US-110: `system` separa a adoção de atualização da biblioteca padrão (template semeado).
    recordTemplateVersionLifecycle('created', { system: outcome.template.isSystem });
    this.logger.log(
      {
        event: 'template_version.created',
        templateId: outcome.template.id,
        templateVersionId: outcome.version.id,
        versionNumber: outcome.version.versionNumber,
        sectionCount: outcome.version.sections.length,
        tenantId: outcome.template.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'template_version.created',
    );
    return toTemplateVersionDto(
      outcome.version,
      outcome.template,
      outcome.type,
      outcome.importSources,
    );
  }
}

export interface PublishTemplateVersionInput {
  readonly versionId: string;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição, registrada na auditoria. */
  readonly idempotencyKey: string | null;
}

/**
 * `PublishTemplateVersionCommand` — TPL-10 (US-108 · passos 2–4 · RN-TPL-14/15): `TEMPLATE_PUBLISH`
 * (+ MFA); versão `DRAFT` (409), `If-Match` (412), template ativo e o `TemplateContentValidator`
 * completo (422 `TEMPLATE_INVALID`, nada muda). Numa transação: a versão passa a `PUBLISHED` com
 * `contentHash`, vira a corrente do template, e são gravados `template.version_publish` e
 * `TemplateVersionPublished` no outbox (o relay publica depois — falha dele não desfaz nada).
 */
@Injectable()
export class PublishTemplateVersionCommand {
  private readonly logger = new Logger('Templates');

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly templateContext: TemplateContext,
  ) {}

  async execute(input: PublishTemplateVersionInput): Promise<TemplateVersionDto> {
    const started = performance.now();
    this.access.assertCan('TEMPLATE_PUBLISH', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    try {
      const catalog = await this.templateContext.catalog();
      const outcome = await this.transactions.run(async (tx) => {
        const current = await this.templates.findVersionById(tx, input.versionId);
        if (!current) throw templateVersionNotFound();
        if (current.status !== 'DRAFT') throw templateVersionNotDraft(current.id, current.status);
        if (current.version !== input.expectedVersion) {
          throw templateVersionConflict(current.version);
        }
        const template = await this.templates.findById(tx, current.templateId);
        if (!template) throw templateVersionNotFound();
        const type = this.templateContext.typeOf(catalog, template);
        const importSources = await this.templateContext.importSourcesFor(tx, catalog, type);

        let publication;
        try {
          publication = publishTemplateVersion(
            template,
            current,
            { documentType: type, importSources },
            { now, userId: context.actor.userId },
          );
        } catch (error) {
          if (error instanceof TemplateContentInvalidError) {
            recordTemplateVersionLifecycle('publish_invalid');
            throw templateInvalid(error.violations);
          }
          if (error instanceof TemplateVersionNotDraftError) {
            throw templateVersionNotDraft(current.id, error.status);
          }
          if (error instanceof TemplateInactiveError) throw templateInactive(template.id);
          throw error;
        }

        try {
          await this.templates.publishVersion(tx, publication.version, current.version);
          await this.templates.updateCurrentPublishedVersion(
            tx,
            publication.template,
            template.version,
          );
        } catch (error) {
          if (error instanceof VersionConflictError) {
            throw await conflictOf(this.templates, tx, current);
          }
          throw error;
        }
        const contentHash = publication.version.contentHash ?? '';
        await this.audit.record(tx, {
          action: 'template.version_publish',
          entityType: 'DocumentTemplate',
          entityId: template.id,
          changes: [
            {
              path: 'currentPublishedVersionId',
              old: template.currentPublishedVersionId,
              new: current.id,
            },
          ],
          metadata: {
            templateId: template.id,
            templateVersionId: current.id,
            versionNumber: current.versionNumber,
            contentHash,
            idempotencyKey: input.idempotencyKey,
          },
        });
        await this.outbox.record(
          tx,
          TemplateVersionPublished.of({
            aggregateId: template.id,
            payload: {
              templateId: template.id,
              templateVersionId: current.id,
              versionNumber: current.versionNumber,
              documentTypeCode: type.code,
              contentHash,
            },
          }),
        );
        return {
          version: { ...publication.version, version: current.version + 1 },
          template: { ...publication.template, version: template.version + 1 },
          type,
          importSources,
        } as const;
      });

      recordTemplateVersionLifecycle('published');
      this.logger.log(
        {
          event: 'template_version.published',
          templateId: outcome.template.id,
          templateVersionId: outcome.version.id,
          versionNumber: outcome.version.versionNumber,
          contentHash: outcome.version.contentHash,
          sectionCount: outcome.version.sections.length,
          durationMs: Math.round(performance.now() - started),
          tenantId: outcome.template.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'template_version.published',
      );
      return toTemplateVersionDto(
        outcome.version,
        outcome.template,
        outcome.type,
        outcome.importSources,
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) {
        this.logger.error(
          {
            event: 'template_version.publish_failed',
            templateVersionId: input.versionId,
            errorCode: errorCodeOf(error),
            cause: error instanceof Error ? error.name : 'unknown',
            correlationId: context.correlationId,
          },
          'template_version.publish_failed',
        );
      }
      throw error;
    }
  }
}

export interface RetireTemplateVersionInput {
  readonly versionId: string;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `RetireTemplateVersionCommand` — TPL-11 (US-108 · passo 6 · RN-TPL-17/18): `TEMPLATE_PUBLISH`
 * (+ MFA); só versão `PUBLISHED` (409 `INVALID_STATE`) e `If-Match` (412). Sendo a corrente, a
 * publicada de maior número entre as demais assume; sem nenhuma, é bloqueada se o template for
 * padrão de um tipo ativo (409 `TEMPLATE_IN_USE`). Grava `template.version_retire` e
 * `TemplateVersionRetired`. Documentos existentes seguem referenciando a versão aposentada.
 */
@Injectable()
export class RetireTemplateVersionCommand {
  private readonly logger = new Logger('Templates');

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly templateContext: TemplateContext,
  ) {}

  async execute(input: RetireTemplateVersionInput): Promise<TemplateVersionDto> {
    this.access.assertCan('TEMPLATE_PUBLISH', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const catalog = await this.templateContext.catalog();

    const outcome = await this.transactions.run(async (tx) => {
      const current = await this.templates.findVersionById(tx, input.versionId);
      if (!current) throw templateVersionNotFound();
      if (current.status !== 'PUBLISHED') {
        throw templateVersionNotPublished(current.id, current.status);
      }
      if (current.version !== input.expectedVersion) {
        throw templateVersionConflict(current.version);
      }
      const template = await this.templates.findById(tx, current.templateId);
      if (!template) throw templateVersionNotFound();
      const versions = await this.templates.findAllVersions(tx, template.id);
      // Lido no `tx` (não do cache): o padrão pode ter acabado de mudar (RN-TPL-18).
      const defaultOf = (await this.types.list(tx)).find(
        (type) => type.isActive && type.defaultTemplateId === template.id,
      );

      let retirement;
      try {
        retirement = retireTemplateVersion(
          template,
          current,
          versions,
          defaultOf ? { name: defaultOf.name } : null,
          { now, userId: context.actor.userId },
        );
      } catch (error) {
        if (error instanceof TemplateVersionNotPublishedError) {
          throw templateVersionNotPublished(current.id, error.status);
        }
        if (error instanceof TemplateInUseError) throw templateInUse(error.documentTypeName);
        throw error;
      }

      try {
        await this.templates.retireVersion(tx, retirement.version, current.version);
        if (retirement.template) {
          await this.templates.updateCurrentPublishedVersion(
            tx,
            retirement.template,
            template.version,
          );
        }
      } catch (error) {
        if (error instanceof VersionConflictError) {
          throw await conflictOf(this.templates, tx, current);
        }
        throw error;
      }
      await this.audit.record(tx, {
        action: 'template.version_retire',
        entityType: 'DocumentTemplate',
        entityId: template.id,
        changes: retirement.template
          ? [
              {
                path: 'currentPublishedVersionId',
                old: template.currentPublishedVersionId,
                new: retirement.template.currentPublishedVersionId,
              },
            ]
          : [],
        metadata: {
          templateId: template.id,
          templateVersionId: current.id,
          versionNumber: current.versionNumber,
        },
      });
      await this.outbox.record(
        tx,
        TemplateVersionRetired.of({
          aggregateId: template.id,
          payload: { templateId: template.id, templateVersionId: current.id },
        }),
      );
      const updated = retirement.template
        ? { ...retirement.template, version: template.version + 1 }
        : template;
      const type = this.templateContext.typeOf(catalog, updated);
      const importSources = await this.templateContext.importSourcesFor(tx, catalog, type);
      return {
        version: { ...retirement.version, version: current.version + 1 },
        template: updated,
        type,
        importSources,
      } as const;
    });

    recordTemplateVersionLifecycle('retired');
    this.logger.log(
      {
        event: 'template_version.retired',
        templateId: outcome.template.id,
        templateVersionId: outcome.version.id,
        versionNumber: outcome.version.versionNumber,
        currentPublishedVersionId: outcome.template.currentPublishedVersionId,
        tenantId: outcome.template.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'template_version.retired',
    );
    return toTemplateVersionDto(
      outcome.version,
      outcome.template,
      outcome.type,
      outcome.importSources,
    );
  }
}
