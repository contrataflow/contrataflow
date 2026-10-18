// Apoio dos testes de fontes e cotações (US-026): o semeado do catálogo `PRICE_SOURCE_TYPE` e os
// fornecedores em memória. Os testes do módulo `price-research` usam estes atalhos em vez de importar
// internos de outro módulo (DEC-041 · dependency-cruiser).
import { CATALOG_SEED } from '#modules/catalog/domain/catalog-seed.js';
import type { Supplier } from '#modules/supplier/domain/supplier.js';
import { InMemorySupplierRepository } from '#modules/supplier/infrastructure/in-memory-supplier.repository.js';
import { newId } from '#shared/database/ids.js';

import type { TestApi } from './api-test-app.js';

/** Os tipos de fonte semeados no provisionamento do tenant (código + `metadata`). */
export const PRICE_SOURCE_TYPE_SEED = CATALOG_SEED.PRICE_SOURCE_TYPE;

export type { Supplier };

/** Fornecedor CNPJ ativo do tenant (sobrescreva o que o cenário precisar). */
export function buildSupplier(tenantId: string, overrides: Partial<Supplier> = {}): Supplier {
  const now = new Date('2026-10-06T15:00:00.000Z');
  return {
    id: newId(),
    tenantId,
    documentType: 'CNPJ',
    documentNumber: '11.222.333/0001-81',
    documentNumberEncrypted: null,
    documentNumberHash: newId(),
    legalName: 'Construtora XYZ Ltda.',
    tradeName: null,
    email: null,
    phone: null,
    website: null,
    contactName: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
    addressCity: null,
    addressState: null,
    addressZipCode: null,
    isActive: true,
    notes: null,
    createdAt: now,
    updatedAt: now,
    createdById: null,
    updatedById: null,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

/** Grava fornecedores no repositório em memória da API de teste. */
export function seedSuppliers(api: TestApi, ...suppliers: readonly Supplier[]): void {
  api.app.get(InMemorySupplierRepository, { strict: false }).seed(...suppliers);
}
