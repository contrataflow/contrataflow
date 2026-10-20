import {
  DEFAULT_DOCUMENT_NUMBERING_MASK,
  DEFAULT_PROCESS_NUMBERING_MASK,
} from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import type {
  NumberingOrganization,
  NumberingSettings,
  NumberingSettingsReader,
  NumberSequenceRepository,
} from '../application/numbering-ports.js';

function tenantOfContext(): string {
  return requireRequestContext().tenantId ?? '';
}

/**
 * Sequências em memória (testes e modo de identidade fake): por tenant do contexto. O incremento é
 * imediato (a transação simulada não desfaz nada) — rollback e concorrência reais são cobertos
 * contra o PostgreSQL em `test/tenant-leak/numbering.spec.ts`.
 */
@Injectable()
export class InMemoryNumberSequenceRepository implements NumberSequenceRepository {
  private readonly values = new Map<string, number>();
  private readonly opened: string[] = [];

  private keyOf(tenantId: string, sequenceKey: string): string {
    return `${tenantId}|${sequenceKey}`;
  }

  increment(_tx: TenantTx, sequenceKey: string): Promise<number> {
    const key = this.keyOf(tenantOfContext(), sequenceKey);
    if (!this.values.has(key)) this.opened.push(key);
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return Promise.resolve(next);
  }

  lastValue(_tx: TenantTx, sequenceKey: string): Promise<number> {
    return Promise.resolve(this.values.get(this.keyOf(tenantOfContext(), sequenceKey)) ?? 0);
  }

  openedProcessKeyOfYear(_tx: TenantTx, year: number): Promise<string | null> {
    const prefix = `${tenantOfContext()}|PROCESS:`;
    const key = this.opened.find(
      (item) => item.startsWith(prefix) && item.endsWith(`:${String(year)}`),
    );
    return Promise.resolve(key === undefined ? null : key.slice(key.indexOf('|') + 1));
  }

  /** Teste: último valor de uma sequência do tenant. */
  seed(tenantId: string, sequenceKey: string, lastValue: number): void {
    const key = this.keyOf(tenantId, sequenceKey);
    if (!this.values.has(key)) this.opened.push(key);
    this.values.set(key, lastValue);
  }

  /** Teste: último valor (0 se não existe). */
  valueOf(tenantId: string, sequenceKey: string): number {
    return this.values.get(this.keyOf(tenantId, sequenceKey)) ?? 0;
  }
}

/** Configuração de numeração em memória: padrões do registro, com ajustes por tenant nos testes. */
@Injectable()
export class InMemoryNumberingSettingsReader implements NumberingSettingsReader {
  private readonly overrides = new Map<string, Partial<NumberingSettings>>();
  private readonly organizations = new Map<string, NumberingOrganization[]>();
  private readonly primary = new Map<string, string>();

  read(_tx: TenantTx, tenantId: string): Promise<NumberingSettings> {
    const fake = Object.values(FAKE_TENANTS).find((tenant) => tenant.id === tenantId);
    const override = this.overrides.get(tenantId);
    return Promise.resolve({
      timezone: override?.timezone ?? fake?.timezone ?? 'America/Sao_Paulo',
      processMask: override?.processMask ?? DEFAULT_PROCESS_NUMBERING_MASK,
      processScope: override?.processScope ?? 'TENANT',
      documentDefaultMask: override?.documentDefaultMask ?? DEFAULT_DOCUMENT_NUMBERING_MASK,
      documentMasks: override?.documentMasks ?? new Map(),
    });
  }

  organization(_tx: TenantTx, organizationId: string): Promise<NumberingOrganization | null> {
    const found = (this.organizations.get(tenantOfContext()) ?? []).find(
      (organization) => organization.id === organizationId,
    );
    return Promise.resolve(found ?? null);
  }

  primaryOrganization(tx: TenantTx, tenantId: string): Promise<NumberingOrganization | null> {
    const id = this.primary.get(tenantId);
    return id === undefined ? Promise.resolve(null) : this.organization(tx, id);
  }

  /** Teste: ajusta a configuração do tenant. */
  set(tenantId: string, settings: Partial<NumberingSettings>): void {
    this.overrides.set(tenantId, { ...this.overrides.get(tenantId), ...settings });
  }

  /** Teste: órgão do tenant (o primeiro vira o principal). */
  addOrganization(tenantId: string, organization: NumberingOrganization): void {
    this.organizations.set(tenantId, [...(this.organizations.get(tenantId) ?? []), organization]);
    if (!this.primary.has(tenantId)) this.primary.set(tenantId, organization.id);
  }
}
