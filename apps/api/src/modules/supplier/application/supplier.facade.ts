import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';

import { SUPPLIER_REPOSITORY } from './supplier-ports.js';
import type { SupplierRepository, SupplierUsageProvider } from './supplier-ports.js';
import { SupplierUsageRegistry } from './supplier-usage.registry.js';

export type { SupplierUsageProvider } from './supplier-ports.js';

/** Fornecedor visto por outros módulos: o necessário para referenciar e exibir (US-026). */
export interface SupplierRef {
  readonly id: string;
  readonly legalName: string;
  /** CNPJ/estrangeiro em claro; CPF mascarado (RN-PRICE-16). */
  readonly documentNumber: string;
  readonly isActive: boolean;
}

/**
 * API pública do módulo `supplier` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class SupplierFacade {
  constructor(
    private readonly usage: SupplierUsageRegistry,
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
  ) {}

  /**
   * `price-research` (US-026) registra, no `onModuleInit`, quem sabe se um fornecedor está
   * referenciado por `PriceSource` não excluída — a exclusão (SUP-05) é recusada enquanto estiver
   * (RN-PRICE-19). Módulos de nível superior chamam; `supplier` não conhece quem usa.
   */
  registerUsageProvider(provider: SupplierUsageProvider): void {
    this.usage.register(provider);
  }

  /**
   * RN-PRICE-22 · V-03 (US-026): o fornecedor existe NO TENANT da transação (a RLS esconde os de
   * outro tenant), não foi excluído e está ativo. Senão → 422 `VALIDATION_ERROR` em `field` com
   * `REFERENCE_NOT_FOUND` (inexistente, excluído ou de outro tenant — indistinguíveis) ou
   * `REFERENCE_INACTIVE`.
   */
  async assertActive(tx: TenantTx, id: string, field: string): Promise<SupplierRef> {
    const supplier = await this.suppliers.findById(tx, id);
    if (supplier === null) {
      throw validationError([
        { field, code: 'REFERENCE_NOT_FOUND', message: 'Selecione um fornecedor válido.' },
      ]);
    }
    if (!supplier.isActive) {
      throw validationError([
        { field, code: 'REFERENCE_INACTIVE', message: 'Este fornecedor está inativo.' },
      ]);
    }
    return this.refOf(supplier);
  }

  /** Exibição de referências existentes (mesmo inativos); excluídos ficam fora do mapa. */
  async summariesOf(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, SupplierRef>> {
    const summaries = new Map<string, SupplierRef>();
    for (const id of new Set(ids)) {
      const supplier = await this.suppliers.findById(tx, id);
      if (supplier !== null) summaries.set(id, this.refOf(supplier));
    }
    return summaries;
  }

  private refOf(supplier: {
    readonly id: string;
    readonly legalName: string;
    readonly documentNumber: string;
    readonly isActive: boolean;
  }): SupplierRef {
    return {
      id: supplier.id,
      legalName: supplier.legalName,
      documentNumber: supplier.documentNumber,
      isActive: supplier.isActive,
    };
  }
}
