import type { TemplateDto, TemplateListQuery, TemplateVersionDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentTransactions } from './ports.js';
import { TemplateContext } from './template-context.js';
import { templateNotFound, templateVersionNotFound } from './template.errors.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { toTemplateDto, toTemplateVersionDto } from './template.view.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';

/**
 * Leituras de templates (US-107 · TPL-01/03/07), todas com `TEMPLATE_VIEW` — permissão de
 * configuração do tenant, sem escopo de unidade. Outro tenant → 404 (a RLS nunca devolve a linha).
 */
@Injectable()
export class TemplateQueries {
  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly templateContext: TemplateContext,
  ) {}

  private async assertCanView(): Promise<void> {
    this.access.assertCan('TEMPLATE_VIEW', { mfaPolicy: await this.identity.mfaPolicy() });
  }

  /** TPL-01: página de templates por nome, com filtros de tipo, nome e situação. */
  async list(
    query: TemplateListQuery,
  ): Promise<{ readonly items: TemplateDto[]; readonly totalItems: number }> {
    await this.assertCanView();
    const catalog = await this.templateContext.catalog();
    const { items, totalItems, versions } = await this.transactions.read(async (tx) => {
      const page = await this.templates.list(tx, {
        documentTypeId: query.documentTypeId,
        q: query.q,
        isActive: query.isActive,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const current = await this.templates.findCurrentVersions(
        tx,
        page.items.map((template) => template.id),
      );
      return { ...page, versions: current };
    });
    return {
      items: items.flatMap((template) => {
        const type = catalog.byId.get(template.documentTypeId);
        return type ? [toTemplateDto(template, type, versions)] : [];
      }),
      totalItems,
    };
  }

  /** TPL-03. */
  async get(id: string): Promise<TemplateDto> {
    await this.assertCanView();
    const catalog = await this.templateContext.catalog();
    const found = await this.transactions.read(async (tx) => {
      const template = await this.templates.findById(tx, id);
      if (!template) return null;
      return { template, versions: await this.templates.findCurrentVersions(tx, [id]) };
    });
    if (!found) throw templateNotFound();
    const type = this.templateContext.typeOf(catalog, found.template);
    return toTemplateDto(found.template, type, found.versions);
  }

  /** TPL-07 (com a origem do mapeamento TR ← ETP, quando TR). */
  async getVersion(versionId: string): Promise<TemplateVersionDto> {
    await this.assertCanView();
    const catalog = await this.templateContext.catalog();
    const dto = await this.transactions.read(async (tx) => {
      const version = await this.templates.findVersionById(tx, versionId);
      if (!version) return null;
      const template = await this.templates.findById(tx, version.templateId);
      if (!template) return null;
      const type = this.templateContext.typeOf(catalog, template);
      const importSources = await this.templateContext.importSourcesFor(tx, catalog, type);
      return toTemplateVersionDto(version, template, type, importSources);
    });
    if (!dto) throw templateVersionNotFound();
    return dto;
  }
}
