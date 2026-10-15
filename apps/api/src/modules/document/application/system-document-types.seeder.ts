import { Inject, Injectable } from '@nestjs/common';

import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { DocumentTypeFacade } from './document-type.facade.js';
import { DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentTransactions, DocumentTypeRepository } from './ports.js';
import { SYSTEM_DOCUMENT_TYPES } from '../domain/system-document-types.js';

const SYSTEM_CODES = new Set(SYSTEM_DOCUMENT_TYPES.map((spec) => spec.code));

/**
 * Seeder `document.systemTypes` (US-061 · US-099 · entities.md §7): os 11 tipos de sistema numa
 * `TenantTransaction` do tenant novo, idempotente por `(tenant, code)` e sem alterar tipos já
 * existentes; aplicável a tenants existentes (tipo de sistema novo numa versão futura — RM-07).
 */
@Injectable()
export class SystemDocumentTypesSeeder implements TenantSeeder {
  readonly key = 'document.systemTypes';
  readonly module = 'document';
  readonly version = '2026.10.1';
  readonly dependsOn: readonly string[] = [];
  readonly applyToExistingTenants = true;

  constructor(
    private readonly facade: DocumentTypeFacade,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
  ) {}

  async seed(_ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const created = await this.transactions.run((tx) => this.facade.seedDefaults(tx));
    return { created, skipped: SYSTEM_CODES.size - created };
  }

  async verify(_ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const types = await this.transactions.read((tx) => this.types.list(tx));
    const found = types.filter((type) => type.isSystem && SYSTEM_CODES.has(type.code)).length;
    return {
      status: found === SYSTEM_CODES.size ? 'DONE' : 'PENDING',
      details: { documentTypes: found },
    };
  }
}
