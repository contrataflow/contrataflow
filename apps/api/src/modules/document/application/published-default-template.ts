import type { TenantTx } from '#shared/database/prisma.js';

import type { TemplateRepository } from './template.ports.js';
import type { DocumentTemplateVersion } from '../domain/document-template.js';
import type { DocumentType } from '../domain/document-type.js';

/**
 * RN-DOC-22 (US-063): a versão `PUBLISHED` corrente do template padrão do tipo
 * (`DocumentType.defaultTemplateId` → `DocumentTemplate.currentPublishedVersionId`), ou `null`
 * quando o tipo não tem padrão, o padrão é de outro tipo, está inativo ou não tem versão publicada.
 * A mesma regra decide a criação do documento livre (DOC-02) e o menu "Criar documento" (DOC-01).
 */
export async function publishedDefaultTemplate(
  tx: TenantTx,
  templates: TemplateRepository,
  type: Pick<DocumentType, 'id' | 'defaultTemplateId'>,
): Promise<DocumentTemplateVersion | null> {
  if (type.defaultTemplateId === null) return null;
  const template = await templates.findById(tx, type.defaultTemplateId);
  if (template?.documentTypeId !== type.id) return null;
  if (!template.isActive || template.currentPublishedVersionId === null) return null;
  const version = await templates.findVersionById(tx, template.currentPublishedVersionId);
  return version?.status === 'PUBLISHED' ? version : null;
}
