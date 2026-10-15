import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeUsageRegistry } from '#shared/document/document-type-usage.js';
import type {
  DocumentTypeUsage,
  DocumentTypeUsageProvider,
} from '#shared/document/document-type-usage.js';

import { WORKFLOW_REPOSITORY } from './ports.js';
import type { WorkflowRepository } from './ports.js';

/**
 * Uso de tipos de documento pelos fluxos (US-061 · RN-DOC-09): regras `REQUIRED_DOCUMENT`
 * `BLOCKING` ativas de versões `PUBLISHED` e workflows publicados que referenciam o tipo em etapas
 * ou regras — consulta real desde a US-040 (tabelas de definição).
 */
@Injectable()
export class WorkflowDocumentTypeUsageProvider implements DocumentTypeUsageProvider, OnModuleInit {
  constructor(
    private readonly registry: DocumentTypeUsageRegistry,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  usageOf(tx: TenantTx, documentTypeCode: string): Promise<DocumentTypeUsage> {
    return this.workflows.documentTypeUsage(tx, documentTypeCode);
  }
}
