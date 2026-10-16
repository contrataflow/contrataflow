import type {
  TemplateCreate,
  TemplateDto,
  TemplateUpdate,
  TemplateVersionDto,
  TemplateVersionUpdate,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { ApiError } from '#shared/errors/api-error.js';

import { DocumentTypeFacade } from './document-type.facade.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import {
  recordTemplateContentUpdate,
  recordTemplateCreated,
  TemplateContext,
} from './template-context.js';
import {
  templateInvalid,
  templateNameTaken,
  templateNotFound,
  templateVersionConflict,
  templateVersionNotDraft,
  templateVersionNotFound,
} from './template.errors.js';
import { TEMPLATE_REPOSITORY, TemplateNameTakenError } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { templateDocumentTypeOf, toTemplateDto, toTemplateVersionDto } from './template.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  createDocumentTemplate,
  TemplateContentInvalidError,
  TemplateVersionNotDraftError,
  updateTemplateMetadata,
  updateTemplateVersionContent,
} from '../domain/document-template.js';

export interface CreateTemplateInput {
  readonly body: TemplateCreate;
  /** `Idempotency-Key` da requisição, registrada na auditoria. */
  readonly idempotencyKey: string | null;
}

/**
 * `CreateTemplateCommand` — TPL-02 (US-107 · fluxo principal, passo 3): autoriza
 * (`TEMPLATE_MANAGE`), exige tipo de documento ativo do tenant (V-03) e, numa transação, cria o
 * template e a versão 1 em `DRAFT` (RN-TPL-02) com a auditoria `template.create`. Nome repetido no
 * tipo → 409 `TEMPLATE_NAME_TAKEN` (V-02). Nenhum evento de domínio.
 */
@Injectable()
export class CreateTemplateCommand {
  private readonly logger = new Logger('Templates');

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly documentTypes: DocumentTypeFacade,
  ) {}

  async execute(input: CreateTemplateInput): Promise<TemplateDto> {
    const started = performance.now();
    this.access.assertCan('TEMPLATE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const type = templateDocumentTypeOf(
      await this.documentTypes.assertCreatable(input.body.documentTypeId),
    );
    const { template, draft } = createDocumentTemplate(input.body, type, {
      templateId: newId(),
      versionId: newId(),
      tenantId: context.tenantId ?? '',
      now,
      userId: context.actor.userId,
    });

    await this.transactions.run(async (tx) => {
      if (await this.templates.findByName(tx, template.documentTypeId, template.name)) {
        throw templateNameTaken(template.name);
      }
      try {
        await this.templates.insert(tx, template, draft);
      } catch (error) {
        // Corrida de duas criações com o mesmo nome: o índice único decide (V-02).
        if (error instanceof TemplateNameTakenError) throw templateNameTaken(template.name);
        throw error;
      }
      await this.audit.record(tx, {
        action: 'template.create',
        entityType: 'DocumentTemplate',
        entityId: template.id,
        changes: [
          { path: 'name', old: null, new: template.name },
          { path: 'documentTypeId', old: null, new: template.documentTypeId },
        ],
        metadata: {
          templateId: template.id,
          templateVersionId: draft.id,
          documentTypeCode: type.code,
          idempotencyKey: input.idempotencyKey,
        },
      });
    });

    recordTemplateCreated();
    this.logger.log(
      {
        event: 'template.created',
        templateId: template.id,
        documentTypeId: template.documentTypeId,
        durationMs: Math.round(performance.now() - started),
        tenantId: template.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'template.created',
    );
    return toTemplateDto(template, type, [draft], false);
  }
}

export interface UpdateTemplateInput {
  readonly id: string;
  readonly patch: TemplateUpdate;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `UpdateTemplateCommand` — TPL-04 (US-107 · FA-03): nome, descrição e `isActive` (RN-TPL-11),
 * independentes do estado da versão. Outro tenant → 404; versão divergente → 412 com
 * `currentVersion`; nome repetido no tipo → 409. Nada alterado → 200 sem nova versão nem auditoria.
 */
@Injectable()
export class UpdateTemplateCommand {
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

  async execute(input: UpdateTemplateInput): Promise<TemplateDto> {
    this.access.assertCan('TEMPLATE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();
    const catalog = await this.templateContext.catalog();

    const outcome = await this.transactions.run(async (tx) => {
      const current = await this.templates.findById(tx, input.id);
      if (!current) throw templateNotFound();
      if (current.version !== input.expectedVersion) {
        throw templateVersionConflict(current.version);
      }
      const result = updateTemplateMetadata(current, input.patch, {
        now,
        userId: context.actor.userId,
      });
      if (result.changedFields.length > 0) {
        if (result.changedFields.includes('name')) {
          const homonym = await this.templates.findByName(
            tx,
            current.documentTypeId,
            result.next.name,
          );
          if (homonym && homonym.id !== current.id) throw templateNameTaken(result.next.name);
        }
        try {
          await this.templates.update(tx, result.next, current.version);
        } catch (error) {
          if (error instanceof TemplateNameTakenError) throw templateNameTaken(result.next.name);
          if (error instanceof VersionConflictError) {
            const fresh = await this.templates.findById(tx, current.id);
            throw templateVersionConflict(fresh?.version ?? current.version + 1);
          }
          throw error;
        }
        await this.audit.record(tx, {
          action: 'template.update',
          entityType: 'DocumentTemplate',
          entityId: current.id,
          changes: result.changes,
          metadata: { templateId: current.id, scope: 'metadata' },
        });
      }
      const template =
        result.changedFields.length > 0
          ? { ...result.next, version: current.version + 1 }
          : current;
      const versions = await this.templates.findCurrentVersions(tx, [template.id]);
      return { template, versions, changedFields: result.changedFields };
    });

    if (outcome.changedFields.length > 0) {
      this.logger.log(
        {
          event: 'template.updated',
          templateId: outcome.template.id,
          fieldsChanged: outcome.changedFields,
          tenantId: outcome.template.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'template.updated',
      );
    }
    const type = this.templateContext.typeOf(catalog, outcome.template);
    return toTemplateDto(
      outcome.template,
      type,
      outcome.versions,
      this.templateContext.isDefault(catalog, outcome.template),
    );
  }
}

export interface UpdateTemplateVersionContentInput {
  readonly versionId: string;
  readonly patch: TemplateVersionUpdate;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/** Código do erro para o log `template_version.update_failed`. */
function errorCodeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
}

/**
 * `UpdateTemplateVersionContentCommand` — TPL-08 (US-107 · passos 5–7): só em `DRAFT` (409
 * `TEMPLATE_VERSION_NOT_DRAFT`), versão do `If-Match` (412 com `currentVersion`), conteúdo
 * conferido pelo `TemplateContentValidator` (422 `TEMPLATE_INVALID` com `violations[]`) e um
 * `UPDATE` único com checagem de versão, mais a auditoria `template.update` com o resumo. O
 * conteúdo das seções nunca vai para log nem auditoria.
 */
@Injectable()
export class UpdateTemplateVersionContentCommand {
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

  async execute(input: UpdateTemplateVersionContentInput): Promise<TemplateVersionDto> {
    this.access.assertCan('TEMPLATE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
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

        let result;
        try {
          result = updateTemplateVersionContent(
            current,
            input.patch,
            { documentType: type, importSources },
            { now, userId: context.actor.userId },
          );
        } catch (error) {
          if (error instanceof TemplateContentInvalidError) {
            recordTemplateContentUpdate('invalid');
            throw templateInvalid(error.violations);
          }
          if (error instanceof TemplateVersionNotDraftError) {
            throw templateVersionNotDraft(current.id, error.status);
          }
          throw error;
        }
        if (result.fieldsChanged.length === 0) {
          return { version: current, template, type, importSources, result } as const;
        }

        try {
          await this.templates.updateVersionContent(tx, result.next, current.version);
        } catch (error) {
          if (error instanceof VersionConflictError) {
            const fresh = await this.templates.findVersionById(tx, current.id);
            throw templateVersionConflict(fresh?.version ?? current.version + 1);
          }
          throw error;
        }
        await this.audit.record(tx, {
          action: 'template.update',
          entityType: 'DocumentTemplate',
          entityId: template.id,
          changes: [
            ...(result.sectionsChanged.length > 0 || result.fieldsChanged.includes('sections')
              ? [{ path: 'sectionsChanged', old: null, new: [...result.sectionsChanged] }]
              : []),
            ...(result.fieldConfigChanged
              ? [{ path: 'fieldConfigChanged', old: null, new: true }]
              : []),
            ...(result.importMappingsChanged
              ? [{ path: 'importMappingsChanged', old: null, new: true }]
              : []),
            ...(result.changeNotesChanged
              ? [{ path: 'changeNotesChanged', old: null, new: true }]
              : []),
          ],
          metadata: {
            templateId: template.id,
            templateVersionId: current.id,
            versionNumber: current.versionNumber,
            scope: 'content',
          },
        });
        return {
          version: { ...result.next, version: current.version + 1 },
          template,
          type,
          importSources,
          result,
        } as const;
      });

      if (outcome.result.fieldsChanged.length > 0) {
        recordTemplateContentUpdate('updated');
        this.logger.log(
          {
            event: 'template_version.content_updated',
            templateVersionId: outcome.version.id,
            sectionCount: outcome.version.sections.length,
            fieldsChanged: outcome.result.fieldsChanged,
            tenantId: outcome.version.tenantId,
            userId: context.actor.userId,
            correlationId: context.correlationId,
          },
          'template_version.content_updated',
        );
      }
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
            event: 'template_version.update_failed',
            templateVersionId: input.versionId,
            errorCode: errorCodeOf(error),
            cause: error instanceof Error ? error.name : 'unknown',
            correlationId: context.correlationId,
          },
          'template_version.update_failed',
        );
      }
      throw error;
    }
  }
}
