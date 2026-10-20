import {
  fieldConfigSchema,
  importMappingsSchema,
  layoutDefinitionSchema,
  sectionDefinitionSchema,
} from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { isUniqueViolation } from '#shared/database/errors.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { TemplateDraftExistsError, TemplateNameTakenError } from '../application/template.ports.js';
import type {
  TemplateListFilter,
  TemplateRepository,
  TemplateVersionListFilter,
} from '../application/template.ports.js';
import { templateNameKey } from '../domain/document-template.js';
import type { DocumentTemplate, DocumentTemplateVersion } from '../domain/document-template.js';

type TemplateRow = Prisma.DocumentTemplateGetPayload<object>;
type VersionRow = Prisma.DocumentTemplateVersionGetPayload<object>;

const sectionsSchema = z.array(sectionDefinitionSchema);

function toTemplate(row: TemplateRow): DocumentTemplate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentTypeId: row.documentTypeId,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    isSystem: row.isSystem,
    currentPublishedVersionId: row.currentPublishedVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

/** Linha → domínio. Os JSONB são conferidos pelos schemas; linha corrompida vira erro explícito. */
function toVersion(row: VersionRow): DocumentTemplateVersion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    templateId: row.templateId,
    versionNumber: row.versionNumber,
    status: row.status,
    sections: sectionsSchema.parse(row.sections),
    layout: layoutDefinitionSchema.parse(row.layout),
    fieldConfig: fieldConfigSchema.parse(row.fieldConfig),
    importMappings:
      row.importMappings === null ? null : importMappingsSchema.parse(row.importMappings),
    changeNotes: row.changeNotes,
    publishedAt: row.publishedAt,
    publishedById: row.publishedById,
    retiredAt: row.retiredAt,
    retiredById: row.retiredById,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * `document_templates` e `document_template_versions` no PostgreSQL (US-107): leituras e escritas
 * no `tx` do caso de uso, sob a RLS do tenant e a extensão de isolamento (que injeta o
 * `tenantId`). Nenhuma exclusão; fora de `DRAFT` o gatilho recusa alterar o conteúdo.
 */
@Injectable()
export class PrismaTemplateRepository implements TemplateRepository {
  async list(
    tx: TenantTx,
    filter: TemplateListFilter,
  ): Promise<{ items: DocumentTemplate[]; totalItems: number }> {
    const where: Prisma.DocumentTemplateWhereInput = {
      ...(filter.documentTypeId ? { documentTypeId: filter.documentTypeId } : {}),
      ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
      ...(filter.q ? { name: { contains: filter.q, mode: 'insensitive' } } : {}),
    };
    const [rows, totalItems] = await Promise.all([
      tx.documentTemplate.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      tx.documentTemplate.count({ where }),
    ]);
    return { items: rows.map(toTemplate), totalItems };
  }

  async findById(tx: TenantTx, id: string): Promise<DocumentTemplate | null> {
    const row = await tx.documentTemplate.findFirst({ where: { id } });
    return row === null ? null : toTemplate(row);
  }

  async findByName(
    tx: TenantTx,
    documentTypeId: string,
    name: string,
  ): Promise<DocumentTemplate | null> {
    // Poucos templates por tipo: a comparação sem maiúsculas é feita aqui (o índice único
    // `lower(name)` continua sendo a garantia na corrida).
    const rows = await tx.documentTemplate.findMany({ where: { documentTypeId } });
    const key = templateNameKey(name);
    const row = rows.find((candidate) => templateNameKey(candidate.name) === key);
    return row === undefined ? null : toTemplate(row);
  }

  async insert(
    tx: TenantTx,
    template: DocumentTemplate,
    draft: DocumentTemplateVersion,
  ): Promise<void> {
    try {
      await tx.documentTemplate.create({
        data: {
          id: template.id,
          tenantId: template.tenantId,
          documentTypeId: template.documentTypeId,
          name: template.name,
          description: template.description,
          isActive: template.isActive,
          isSystem: template.isSystem,
          currentPublishedVersionId: template.currentPublishedVersionId,
          createdAt: template.createdAt,
          updatedAt: template.updatedAt,
          createdById: template.createdById,
          updatedById: template.updatedById,
          version: template.version,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new TemplateNameTakenError(template.name);
      throw error;
    }
    try {
      await tx.documentTemplateVersion.create({
        data: {
          id: draft.id,
          tenantId: draft.tenantId,
          templateId: draft.templateId,
          versionNumber: draft.versionNumber,
          status: draft.status,
          sections: json(draft.sections),
          layout: json(draft.layout),
          fieldConfig: json(draft.fieldConfig),
          importMappings:
            draft.importMappings === null ? Prisma.DbNull : json(draft.importMappings),
          changeNotes: draft.changeNotes,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
          createdById: draft.createdById,
          updatedById: draft.updatedById,
          version: draft.version,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new TemplateDraftExistsError(draft.templateId);
      throw error;
    }
  }

  async update(tx: TenantTx, template: DocumentTemplate, expectedVersion: number): Promise<void> {
    try {
      await updateVersioned(
        { aggregateType: 'DocumentTemplate', aggregateId: template.id, expectedVersion },
        () =>
          tx.documentTemplate.updateMany({
            where: { id: template.id, version: expectedVersion },
            data: {
              name: template.name,
              description: template.description,
              isActive: template.isActive,
              updatedAt: template.updatedAt,
              updatedById: template.updatedById,
              version: { increment: 1 },
            },
          }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new TemplateNameTakenError(template.name);
      throw error;
    }
  }

  async findCurrentVersions(
    tx: TenantTx,
    templateIds: readonly string[],
  ): Promise<DocumentTemplateVersion[]> {
    if (templateIds.length === 0) return [];
    const rows = await tx.documentTemplateVersion.findMany({
      where: { templateId: { in: [...templateIds] }, status: { in: ['DRAFT', 'PUBLISHED'] } },
      orderBy: [{ templateId: 'asc' }, { versionNumber: 'asc' }],
    });
    return rows.map(toVersion);
  }

  async findVersionById(tx: TenantTx, id: string): Promise<DocumentTemplateVersion | null> {
    const row = await tx.documentTemplateVersion.findFirst({ where: { id } });
    return row === null ? null : toVersion(row);
  }

  async updateVersionContent(
    tx: TenantTx,
    version: DocumentTemplateVersion,
    expectedVersion: number,
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'DocumentTemplateVersion', aggregateId: version.id, expectedVersion },
      () =>
        tx.documentTemplateVersion.updateMany({
          where: { id: version.id, version: expectedVersion, status: 'DRAFT' },
          data: {
            sections: json(version.sections),
            layout: json(version.layout),
            fieldConfig: json(version.fieldConfig),
            importMappings:
              version.importMappings === null ? Prisma.DbNull : json(version.importMappings),
            changeNotes: version.changeNotes,
            updatedAt: version.updatedAt,
            updatedById: version.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async listVersions(
    tx: TenantTx,
    templateId: string,
    filter: TemplateVersionListFilter,
  ): Promise<{ items: DocumentTemplateVersion[]; totalItems: number }> {
    const where: Prisma.DocumentTemplateVersionWhereInput = {
      templateId,
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [rows, totalItems] = await Promise.all([
      tx.documentTemplateVersion.findMany({
        where,
        orderBy: { versionNumber: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.documentTemplateVersion.count({ where }),
    ]);
    return { items: rows.map(toVersion), totalItems };
  }

  async findAllVersions(tx: TenantTx, templateId: string): Promise<DocumentTemplateVersion[]> {
    const rows = await tx.documentTemplateVersion.findMany({
      where: { templateId },
      orderBy: { versionNumber: 'asc' },
    });
    return rows.map(toVersion);
  }

  async insertVersion(tx: TenantTx, version: DocumentTemplateVersion): Promise<void> {
    try {
      await tx.documentTemplateVersion.create({
        data: {
          id: version.id,
          tenantId: version.tenantId,
          templateId: version.templateId,
          versionNumber: version.versionNumber,
          status: version.status,
          sections: json(version.sections),
          layout: json(version.layout),
          fieldConfig: json(version.fieldConfig),
          importMappings:
            version.importMappings === null ? Prisma.DbNull : json(version.importMappings),
          changeNotes: version.changeNotes,
          createdAt: version.createdAt,
          updatedAt: version.updatedAt,
          createdById: version.createdById,
          updatedById: version.updatedById,
          version: version.version,
        },
      });
    } catch (error) {
      // Rascunho único ou número já usado: os dois são a corrida de duas "novas versões".
      if (isUniqueViolation(error)) throw new TemplateDraftExistsError(version.templateId);
      throw error;
    }
  }

  async publishVersion(
    tx: TenantTx,
    version: DocumentTemplateVersion,
    expectedVersion: number,
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'DocumentTemplateVersion', aggregateId: version.id, expectedVersion },
      () =>
        tx.documentTemplateVersion.updateMany({
          where: { id: version.id, version: expectedVersion, status: 'DRAFT' },
          data: {
            status: 'PUBLISHED',
            publishedAt: version.publishedAt,
            publishedById: version.publishedById,
            contentHash: version.contentHash,
            updatedAt: version.updatedAt,
            updatedById: version.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async retireVersion(
    tx: TenantTx,
    version: DocumentTemplateVersion,
    expectedVersion: number,
  ): Promise<void> {
    // Só as colunas que o gatilho de imutabilidade deixa mudar em `PUBLISHED → RETIRED`.
    await updateVersioned(
      { aggregateType: 'DocumentTemplateVersion', aggregateId: version.id, expectedVersion },
      () =>
        tx.documentTemplateVersion.updateMany({
          where: { id: version.id, version: expectedVersion, status: 'PUBLISHED' },
          data: {
            status: 'RETIRED',
            retiredAt: version.retiredAt,
            retiredById: version.retiredById,
            updatedAt: version.updatedAt,
            updatedById: version.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }

  async updateCurrentPublishedVersion(
    tx: TenantTx,
    template: DocumentTemplate,
    expectedVersion: number,
  ): Promise<void> {
    await updateVersioned(
      { aggregateType: 'DocumentTemplate', aggregateId: template.id, expectedVersion },
      () =>
        tx.documentTemplate.updateMany({
          where: { id: template.id, version: expectedVersion },
          data: {
            currentPublishedVersionId: template.currentPublishedVersionId,
            updatedAt: template.updatedAt,
            updatedById: template.updatedById,
            version: { increment: 1 },
          },
        }),
    );
  }
}
