import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * Códigos de tipo de documento do tenant para quem os referencia (US-040 · RN-WF-15). `workflow`
 * valida `documentTypeCodes`, `approvalDocumentTypeCodes` e `REQUIRED_DOCUMENT` contra o catálogo
 * de `document`, mas os dois estão no mesmo nível (DEC-040): a dependência vira esta porta do
 * shared kernel, que `document` implementa e registra no `onModuleInit` — o mesmo arranjo de
 * `DocumentTypeUsageRegistry`, no sentido contrário.
 */

/** Situação dos códigos do tenant da transação. */
export interface DocumentTypeCodes {
  readonly active: ReadonlySet<string>;
  readonly inactive: ReadonlySet<string>;
}

export interface DocumentTypeCodesProvider {
  /** Códigos ativos e inativos do tenant, lidos no `tx` do chamador (sob a RLS). */
  codesOf(tx: TenantTx): Promise<DocumentTypeCodes>;
}

export const NO_DOCUMENT_TYPE_CODES: DocumentTypeCodes = Object.freeze({
  active: new Set<string>(),
  inactive: new Set<string>(),
});

/** Lê o provedor registrado; sem provedor (módulo `document` fora), não há tipo algum. */
@Injectable()
export class DocumentTypeCatalog {
  private provider: DocumentTypeCodesProvider | null = null;

  register(provider: DocumentTypeCodesProvider): void {
    this.provider = provider;
  }

  codesOf(tx: TenantTx): Promise<DocumentTypeCodes> {
    return this.provider ? this.provider.codesOf(tx) : Promise.resolve(NO_DOCUMENT_TYPE_CODES);
  }
}

/** Importado por `workflow` (consumidor) e `document` (implementador); a instância é única. */
@Module({ providers: [DocumentTypeCatalog], exports: [DocumentTypeCatalog] })
export class DocumentTypeCatalogModule {}
