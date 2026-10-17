import type { SupplierDto, SupplierListQuery, SupplierLookupQuery } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { FIELD_PROTECTION } from '#shared/crypto/field-protection.js';
import type { FieldProtection } from '#shared/crypto/field-protection.js';

import { LOOKUP_TYPE_ORDER, lookupHashes } from './supplier-document.js';
import { SUPPLIER_REPOSITORY, SUPPLIER_TRANSACTIONS } from './supplier-ports.js';
import type { SupplierRepository, SupplierTransactions } from './supplier-ports.js';
import { supplierNotFound } from './supplier.errors.js';
import { toSupplierDto } from './supplier.view.js';

export interface SupplierListResult {
  readonly items: readonly SupplierDto[];
  readonly totalItems: number;
}

/**
 * `ListSuppliersQuery` — SUP-01 (US-025): `SUPPLIER_VIEW` na rota. Busca textual (`q`, mín. 2
 * caracteres) em razão social, nome fantasia e documento, filtro Ativos/Inativos, por razão social.
 */
@Injectable()
export class ListSuppliersQuery {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(SUPPLIER_TRANSACTIONS) private readonly transactions: SupplierTransactions,
  ) {}

  execute(query: SupplierListQuery): Promise<SupplierListResult> {
    return this.transactions.read(async (tx) => {
      const page = await this.suppliers.list(
        tx,
        {
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
        },
        { skip: (query.page - 1) * query.pageSize, take: query.pageSize },
      );
      return { items: page.items.map(toSupplierDto), totalItems: page.total };
    });
  }
}

/** `GetSupplierQuery` — SUP-03: outro tenant e inexistente são indistinguíveis (404). */
@Injectable()
export class GetSupplierQuery {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(SUPPLIER_TRANSACTIONS) private readonly transactions: SupplierTransactions,
  ) {}

  execute(id: string): Promise<SupplierDto> {
    return this.transactions.read(async (tx) => {
      const supplier = await this.suppliers.findById(tx, id);
      if (!supplier) throw supplierNotFound();
      return toSupplierDto(supplier);
    });
  }
}

/**
 * `LookupSupplierQuery` — SUP-06 (FA-06 · RN-PRICE-17): normaliza o número recebido, gera o blind
 * index e consulta SÓ o tenant da transação (RLS) — fornecedor de outro tenant é `null`, como o
 * inexistente. Nunca decifra nem devolve CPF em claro.
 */
@Injectable()
export class LookupSupplierQuery {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(SUPPLIER_TRANSACTIONS) private readonly transactions: SupplierTransactions,
    @Inject(FIELD_PROTECTION) private readonly protection: FieldProtection,
  ) {}

  execute(query: SupplierLookupQuery): Promise<SupplierDto | null> {
    const hashes = lookupHashes(this.protection, query.documentNumber);
    return this.transactions.read(async (tx) => {
      const found = await this.suppliers.findByDocumentHashes(tx, hashes);
      const best = [...found].sort(
        (a, b) =>
          LOOKUP_TYPE_ORDER.indexOf(a.documentType) - LOOKUP_TYPE_ORDER.indexOf(b.documentType),
      )[0];
      return best === undefined ? null : toSupplierDto(best);
    });
  }
}
