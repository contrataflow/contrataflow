import type {
  TemplateDto,
  TemplateVersionDto,
  TemplateVersionSummary,
} from '@contrataflow/validation';

import type {
  DocumentTemplate,
  DocumentTemplateVersion,
  TemplateDocumentType,
} from '../domain/document-template.js';
import type { DocumentType } from '../domain/document-type.js';
import type { TemplateValidationContext } from '../domain/template-content.validator.js';

/** Tipo de documento como o template o vê. */
export function templateDocumentTypeOf(type: DocumentType): TemplateDocumentType {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    kind: type.kind,
    systemModule: type.systemModule,
    defaultConfidentiality: type.defaultConfidentiality,
  };
}

function summaryOf(version: DocumentTemplateVersion): TemplateVersionSummary {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    sectionCount: version.sections.length,
    updatedAt: version.updatedAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}

/** `Template` de TPL-01..04: metadados, tipo e os resumos do rascunho e da versão publicada. */
export function toTemplateDto(
  template: DocumentTemplate,
  type: TemplateDocumentType,
  versions: readonly DocumentTemplateVersion[],
): TemplateDto {
  const own = versions.filter((version) => version.templateId === template.id);
  const draft = own.find((version) => version.status === 'DRAFT');
  const published = own.find((version) => version.id === template.currentPublishedVersionId);
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    documentTypeId: template.documentTypeId,
    documentType: type,
    isActive: template.isActive,
    isSystem: template.isSystem,
    draftVersion: draft ? summaryOf(draft) : null,
    currentPublishedVersion: published ? summaryOf(published) : null,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    version: template.version,
  };
}

/** `TemplateVersion` de TPL-07/08. */
export function toTemplateVersionDto(
  version: DocumentTemplateVersion,
  template: DocumentTemplate,
  type: TemplateDocumentType,
  importSources: TemplateValidationContext['importSources'],
): TemplateVersionDto {
  return {
    id: version.id,
    templateId: version.templateId,
    templateName: template.name,
    versionNumber: version.versionNumber,
    status: version.status,
    documentType: type,
    sections: [...version.sections],
    fieldConfig: version.fieldConfig,
    importMappings: version.importMappings,
    layout: version.layout,
    changeNotes: version.changeNotes,
    importSources: importSources
      ? { sectionKeys: [...importSources.sectionKeys], fieldKeys: [...importSources.fieldKeys] }
      : null,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    retiredAt: version.retiredAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    version: version.version,
  };
}
