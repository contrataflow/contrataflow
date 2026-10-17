import type { SupplierDto } from '@contrataflow/validation';

import type { Supplier } from '../domain/supplier.js';

/**
 * `Supplier` da resposta de SUP-01..06. Mapeamento explícito campo a campo: `documentNumber` já é
 * a forma exibível (CPF mascarado) e o número cifrado/hash nunca saem pela API (RN-PRICE-16).
 */
export function toSupplierDto(supplier: Supplier): SupplierDto {
  return {
    id: supplier.id,
    documentType: supplier.documentType,
    documentNumber: supplier.documentNumber,
    legalName: supplier.legalName,
    tradeName: supplier.tradeName,
    email: supplier.email,
    phone: supplier.phone,
    website: supplier.website,
    contactName: supplier.contactName,
    addressStreet: supplier.addressStreet,
    addressNumber: supplier.addressNumber,
    addressComplement: supplier.addressComplement,
    addressDistrict: supplier.addressDistrict,
    addressCity: supplier.addressCity,
    addressState: supplier.addressState,
    addressZipCode: supplier.addressZipCode,
    isActive: supplier.isActive,
    notes: supplier.notes,
    createdAt: supplier.createdAt.toISOString(),
    updatedAt: supplier.updatedAt.toISOString(),
    version: supplier.version,
  };
}
