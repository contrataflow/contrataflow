import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';
import type {
  DocumentTypeCodes,
  DocumentTypeCodesProvider,
} from '#shared/document/document-type-catalog.js';

import { DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentTypeRepository } from './ports.js';

/**
 * Implementa a porta `DocumentTypeCatalog` (US-040 · RN-WF-15): os códigos do tenant lidos no `tx`
 * de quem valida a definição de workflow — sem cache, para que a validação da publicação veja o
 * estado confirmado (FA-05 da US-040: tipo desativado depois da escrita).
 */
@Injectable()
export class DocumentTypeCodesAdapter implements DocumentTypeCodesProvider, OnModuleInit {
  constructor(
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    private readonly catalog: DocumentTypeCatalog,
  ) {}

  onModuleInit(): void {
    this.catalog.register(this);
  }

  async codesOf(tx: TenantTx): Promise<DocumentTypeCodes> {
    const types = await this.types.list(tx);
    return {
      active: new Set(types.filter((type) => type.isActive).map((type) => type.code)),
      inactive: new Set(types.filter((type) => !type.isActive).map((type) => type.code)),
    };
  }
}
