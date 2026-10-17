import type { PermissionCode } from '@contrataflow/types';
import type { SystemDocumentModule } from '@contrataflow/validation';

/*
 * Permissão de edição e de submissão "do tipo" (permissions.md §2.2/§2.3 · POL-02): documentos
 * livres/externos usam `DOCUMENT_UPDATE`/`DOCUMENT_SUBMIT`; os tipados, a permissão do módulo dono.
 * Reabrir (`DOCUMENT_REOPEN`) e cancelar (`DOCUMENT_CANCEL`) valem para qualquer tipo.
 */

export interface TypePermissions {
  readonly edit: PermissionCode;
  readonly submit: PermissionCode;
}

const GENERIC: TypePermissions = { edit: 'DOCUMENT_UPDATE', submit: 'DOCUMENT_SUBMIT' };

const BY_MODULE: Readonly<Record<SystemDocumentModule, TypePermissions>> = {
  DFD: { edit: 'DFD_UPDATE', submit: 'DFD_SUBMIT' },
  ETP: { edit: 'ETP_UPDATE', submit: 'ETP_SUBMIT' },
  TERM_OF_REFERENCE: { edit: 'TERM_UPDATE', submit: 'TERM_SUBMIT' },
  RISK_MAP: { edit: 'RISK_MANAGE', submit: 'RISK_MAP_SUBMIT' },
  PRICE_RESEARCH: { edit: 'PRICE_RESEARCH_UPDATE', submit: 'PRICE_RESEARCH_COMPLETE' },
};

export function typePermissionsOf(systemModule: SystemDocumentModule | null): TypePermissions {
  return systemModule === null ? GENERIC : BY_MODULE[systemModule];
}

/**
 * Permissão de criação do tipo (RN-DOC-16 · permissions.md §2.2/§2.3): `DOCUMENT_CREATE` nos
 * livres/externos; nos tipados, a do módulo dono (o mapa de riscos nasce com `RISK_MANAGE`).
 */
const CREATE_BY_MODULE: Readonly<Record<SystemDocumentModule, PermissionCode>> = {
  DFD: 'DFD_CREATE',
  ETP: 'ETP_CREATE',
  TERM_OF_REFERENCE: 'TERM_CREATE',
  RISK_MAP: 'RISK_MANAGE',
  PRICE_RESEARCH: 'PRICE_RESEARCH_CREATE',
};

export function createPermissionOf(systemModule: SystemDocumentModule | null): PermissionCode {
  return systemModule === null ? 'DOCUMENT_CREATE' : CREATE_BY_MODULE[systemModule];
}
