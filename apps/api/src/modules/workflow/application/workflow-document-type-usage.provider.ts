import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import {
  DocumentTypeUsageRegistry,
  NO_DOCUMENT_TYPE_USAGE,
} from '#shared/document/document-type-usage.js';
import type {
  DocumentTypeUsage,
  DocumentTypeUsageProvider,
} from '#shared/document/document-type-usage.js';

/**
 * Uso de tipos de documento pelos fluxos (US-061 · RN-DOC-09): regras `REQUIRED_DOCUMENT`
 * `BLOCKING` de versões `PUBLISHED` e etapas que listam o tipo. As tabelas de workflow e de regras
 * chegam com a US-040/US-044; até lá nenhum fluxo publicado referencia tipo algum e o uso é vazio.
 * A consulta real substitui `usageOf` sem mudar quem o consome (`document`).
 */
@Injectable()
export class WorkflowDocumentTypeUsageProvider implements DocumentTypeUsageProvider, OnModuleInit {
  constructor(private readonly registry: DocumentTypeUsageRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  usageOf(_tx: TenantTx, _documentTypeCode: string): Promise<DocumentTypeUsage> {
    return Promise.resolve(NO_DOCUMENT_TYPE_USAGE);
  }
}
