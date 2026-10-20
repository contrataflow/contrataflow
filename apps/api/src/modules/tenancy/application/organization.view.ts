import type { OrganizationDto } from '@contrataflow/validation';

import type { Organization } from '../domain/organization.js';

/** `Organization` da resposta de ORG-01..04; `primaryId` = `tenants.primaryOrganizationId`. */
export function toOrganizationDto(
  organization: Organization,
  primaryId: string | null,
): OrganizationDto {
  return {
    id: organization.id,
    name: organization.name,
    shortName: organization.shortName,
    cnpj: organization.cnpj,
    type: organization.type,
    isActive: organization.isActive,
    isPrimary: organization.id === primaryId,
    email: organization.email,
    phone: organization.phone,
    website: organization.website,
    addressStreet: organization.addressStreet,
    addressNumber: organization.addressNumber,
    addressComplement: organization.addressComplement,
    addressDistrict: organization.addressDistrict,
    addressCity: organization.addressCity,
    addressState: organization.addressState,
    addressZipCode: organization.addressZipCode,
    ibgeCityCode: organization.ibgeCityCode,
    logoAttachmentId: organization.logoAttachmentId,
    metadata: { ...organization.metadata },
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
    version: organization.version,
  };
}

/** CNPJ para logs: só os 4 últimos caracteres (DEC-138 · "Nunca logar o CNPJ completo"). */
export function maskCnpj(cnpj: string): string {
  return `**********${cnpj.slice(-4)}`;
}
