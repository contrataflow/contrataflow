import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { TemplateDraftExistsError, TemplateNameTakenError } from '../application/template.ports.js';
import type {
  TemplateListFilter,
  TemplateRepository,
  TemplateVersionListFilter,
} from '../application/template.ports.js';
import { templateNameKey } from '../domain/document-template.js';
import type { DocumentTemplate, DocumentTemplateVersion } from '../domain/document-template.js';

/**
 * Templates em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento por tenant (o do contexto, como o `app.tenant_id`), nome único por
 * tipo sem diferenciar maiúsculas, um rascunho por template e concorrência otimista por versão.
 */
@Injectable()
export class InMemoryTemplateRepository implements TemplateRepository {
  private readonly templates = new Map<string, DocumentTemplate>();
  private readonly versions = new Map<string, DocumentTemplateVersion>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private templatesInTenant(): DocumentTemplate[] {
    const tenantId = this.tenantId();
    return [...this.templates.values()].filter((template) => template.tenantId === tenantId);
  }

  private versionsInTenant(): DocumentTemplateVersion[] {
    const tenantId = this.tenantId();
    return [...this.versions.values()].filter((version) => version.tenantId === tenantId);
  }

  private nameTaken(template: DocumentTemplate): boolean {
    const key = templateNameKey(template.name);
    return this.templatesInTenant().some(
      (other) =>
        other.id !== template.id &&
        other.documentTypeId === template.documentTypeId &&
        templateNameKey(other.name) === key,
    );
  }

  list(_tx: TenantTx, filter: TemplateListFilter) {
    const needle = filter.q?.toLocaleLowerCase('pt-BR');
    const all = this.templatesInTenant()
      .filter(
        (template) => !filter.documentTypeId || template.documentTypeId === filter.documentTypeId,
      )
      .filter((template) => filter.isActive === undefined || template.isActive === filter.isActive)
      .filter((template) => !needle || template.name.toLocaleLowerCase('pt-BR').includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id));
    return Promise.resolve({
      items: all.slice(filter.skip, filter.skip + filter.take),
      totalItems: all.length,
    });
  }

  findById(_tx: TenantTx, id: string): Promise<DocumentTemplate | null> {
    return Promise.resolve(this.templatesInTenant().find((template) => template.id === id) ?? null);
  }

  findByName(
    _tx: TenantTx,
    documentTypeId: string,
    name: string,
  ): Promise<DocumentTemplate | null> {
    const key = templateNameKey(name);
    return Promise.resolve(
      this.templatesInTenant().find(
        (template) =>
          template.documentTypeId === documentTypeId && templateNameKey(template.name) === key,
      ) ?? null,
    );
  }

  insert(_tx: TenantTx, template: DocumentTemplate, draft: DocumentTemplateVersion): Promise<void> {
    if (this.nameTaken(template)) return Promise.reject(new TemplateNameTakenError(template.name));
    const hasDraft = this.versionsInTenant().some(
      (version) => version.templateId === draft.templateId && version.status === 'DRAFT',
    );
    if (hasDraft) return Promise.reject(new TemplateDraftExistsError(draft.templateId));
    this.templates.set(template.id, template);
    this.versions.set(draft.id, draft);
    return Promise.resolve();
  }

  update(_tx: TenantTx, template: DocumentTemplate, expectedVersion: number): Promise<void> {
    const current = this.templatesInTenant().find((existing) => existing.id === template.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'DocumentTemplate',
          aggregateId: template.id,
          expectedVersion,
        }),
      );
    }
    if (this.nameTaken(template)) return Promise.reject(new TemplateNameTakenError(template.name));
    this.templates.set(template.id, { ...template, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  findCurrentVersions(
    _tx: TenantTx,
    templateIds: readonly string[],
  ): Promise<DocumentTemplateVersion[]> {
    const ids = new Set(templateIds);
    return Promise.resolve(
      this.versionsInTenant()
        .filter((version) => ids.has(version.templateId) && version.status !== 'RETIRED')
        .sort((a, b) => a.versionNumber - b.versionNumber),
    );
  }

  findVersionById(_tx: TenantTx, id: string): Promise<DocumentTemplateVersion | null> {
    return Promise.resolve(this.versionsInTenant().find((version) => version.id === id) ?? null);
  }

  updateVersionContent(
    _tx: TenantTx,
    version: DocumentTemplateVersion,
    expectedVersion: number,
  ): Promise<void> {
    const current = this.versionsInTenant().find((existing) => existing.id === version.id);
    if (current?.version !== expectedVersion || current.status !== 'DRAFT') {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'DocumentTemplateVersion',
          aggregateId: version.id,
          expectedVersion,
        }),
      );
    }
    this.versions.set(version.id, { ...version, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  listVersions(_tx: TenantTx, templateId: string, filter: TemplateVersionListFilter) {
    const all = this.versionsInTenant()
      .filter((version) => version.templateId === templateId)
      .filter((version) => !filter.status || version.status === filter.status)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return Promise.resolve({
      items: all.slice(filter.skip, filter.skip + filter.take),
      totalItems: all.length,
    });
  }

  findAllVersions(_tx: TenantTx, templateId: string): Promise<DocumentTemplateVersion[]> {
    return Promise.resolve(
      this.versionsInTenant()
        .filter((version) => version.templateId === templateId)
        .sort((a, b) => a.versionNumber - b.versionNumber),
    );
  }

  insertVersion(_tx: TenantTx, version: DocumentTemplateVersion): Promise<void> {
    const taken = this.versionsInTenant().some(
      (other) =>
        other.templateId === version.templateId &&
        (other.status === 'DRAFT' || other.versionNumber === version.versionNumber),
    );
    if (taken) return Promise.reject(new TemplateDraftExistsError(version.templateId));
    this.versions.set(version.id, version);
    return Promise.resolve();
  }

  publishVersion(
    _tx: TenantTx,
    version: DocumentTemplateVersion,
    expectedVersion: number,
  ): Promise<void> {
    return this.transitionVersion(version, expectedVersion, 'DRAFT');
  }

  retireVersion(
    _tx: TenantTx,
    version: DocumentTemplateVersion,
    expectedVersion: number,
  ): Promise<void> {
    return this.transitionVersion(version, expectedVersion, 'PUBLISHED');
  }

  updateCurrentPublishedVersion(
    _tx: TenantTx,
    template: DocumentTemplate,
    expectedVersion: number,
  ): Promise<void> {
    const current = this.templatesInTenant().find((existing) => existing.id === template.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'DocumentTemplate',
          aggregateId: template.id,
          expectedVersion,
        }),
      );
    }
    this.templates.set(template.id, {
      ...current,
      currentPublishedVersionId: template.currentPublishedVersionId,
      updatedAt: template.updatedAt,
      updatedById: template.updatedById,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  private transitionVersion(
    version: DocumentTemplateVersion,
    expectedVersion: number,
    from: DocumentTemplateVersion['status'],
  ): Promise<void> {
    const current = this.versionsInTenant().find((existing) => existing.id === version.id);
    if (current?.version !== expectedVersion || current.status !== from) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'DocumentTemplateVersion',
          aggregateId: version.id,
          expectedVersion,
        }),
      );
    }
    this.versions.set(version.id, { ...version, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  /** Inspeção de testes: todos os templates e versões de todos os tenants. */
  snapshot(): {
    templates: readonly DocumentTemplate[];
    versions: readonly DocumentTemplateVersion[];
  } {
    return { templates: [...this.templates.values()], versions: [...this.versions.values()] };
  }

  /** Carga de testes (versão publicada, template de outro tenant…). */
  seed(templates: readonly DocumentTemplate[], versions: readonly DocumentTemplateVersion[]): void {
    for (const template of templates) this.templates.set(template.id, template);
    for (const version of versions) this.versions.set(version.id, version);
  }
}
