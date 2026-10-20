import { Inject, Injectable } from '@nestjs/common';

import { DocumentTypeUsageRegistry } from '#shared/document/document-type-usage.js';
import type { BlockingDocumentRule } from '#shared/document/document-type-usage.js';

import { documentTypeNotFound } from './document-type.errors.js';
import { DOCUMENT_COUNTER, DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentCounter, DocumentTransactions, DocumentTypeRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';

/** Prévia de impacto de desativar o tipo (FA-01) e de mudar a aprovação avulsa (FA-05). */
export interface DocumentTypeImpact {
  readonly documentTypeId: string;
  readonly code: string;
  /** Documentos existentes do tipo: continuam acessíveis (RN-DOC-10). */
  readonly documentsCount: number;
  /** Workflows publicados que referenciam o tipo (aviso). */
  readonly workflowsReferencing: number;
  /** Regras bloqueantes publicadas: a desativação seria recusada (RN-DOC-09). */
  readonly blockingRules: readonly BlockingDocumentRule[];
  readonly canDeactivate: boolean;
}

/**
 * `PreviewDocumentTypeImpactQuery` (US-061 · FA-01/FA-05): contagens e vínculos do tipo para o
 * diálogo de impacto do SCR-108. Só leitura; exige `DOCUMENT_TYPE_MANAGE`. A rota HTTP desta
 * consulta não está no catálogo de api.md (DTY-01..04): fica na fachada até o contrato existir.
 */
@Injectable()
export class PreviewDocumentTypeImpactQuery {
  constructor(
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_COUNTER) private readonly counter: DocumentCounter,
    private readonly usage: DocumentTypeUsageRegistry,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(documentTypeId: string): Promise<DocumentTypeImpact> {
    this.access.assertCan('DOCUMENT_TYPE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    return this.transactions.read(async (tx) => {
      const type = await this.types.findById(tx, documentTypeId);
      if (!type) throw documentTypeNotFound();
      const [documentsCount, usage] = await Promise.all([
        this.counter.countByType(tx, type.id),
        this.usage.usageOf(tx, type.code),
      ]);
      return {
        documentTypeId: type.id,
        code: type.code,
        documentsCount,
        workflowsReferencing: usage.referencingWorkflows,
        blockingRules: usage.blockingRules,
        canDeactivate: type.kind !== 'STRUCTURED' && usage.blockingRules.length === 0,
      };
    });
  }
}
