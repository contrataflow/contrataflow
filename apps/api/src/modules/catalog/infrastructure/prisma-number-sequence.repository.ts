import {
  DEFAULT_DOCUMENT_NUMBERING_MASK,
  DEFAULT_PROCESS_NUMBERING_MASK,
  NUMBERING_SCOPES,
  SETTING_DOCUMENT_MASK_KEY,
} from '@contrataflow/validation';
import type { NumberingScope } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  NumberingOrganization,
  NumberingSettings,
  NumberingSettingsReader,
  NumberSequenceRepository,
} from '../application/numbering-ports.js';

/**
 * `number_sequences` no PostgreSQL (US-105 · RN-TEN-69): SQL parametrizado no `tx` do recurso
 * numerado, sob a RLS do tenant (`app.tenant_id` da `TenantTransaction`). O `UPDATE … RETURNING`
 * bloqueia a linha até o commit: numerações concorrentes da mesma chave saem consecutivas e o
 * rollback devolve o valor. A leitura da prévia não trava nada.
 */
@Injectable()
export class PrismaNumberSequenceRepository implements NumberSequenceRepository {
  async increment(tx: TenantTx, sequenceKey: string): Promise<number> {
    // Linha sob demanda (FA-01: o primeiro número do ano cria a sequência do ano). Uma criação
    // concorrente ainda não confirmada faz este INSERT esperar por ela, sem erro.
    await tx.$executeRaw`
      INSERT INTO number_sequences (id, tenant_id, sequence_key, last_value)
      VALUES (${newId()}::uuid, current_setting('app.tenant_id')::uuid, ${sequenceKey}, 0)
      ON CONFLICT (tenant_id, sequence_key) DO NOTHING`;
    const rows = await tx.$queryRaw<{ last_value: number }[]>`
      UPDATE number_sequences
         SET last_value = last_value + 1, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = current_setting('app.tenant_id')::uuid AND sequence_key = ${sequenceKey}
      RETURNING last_value`;
    const [row] = rows;
    if (!row) throw new Error(`Sequência de numeração não encontrada: ${sequenceKey}.`);
    return row.last_value;
  }

  async lastValue(tx: TenantTx, sequenceKey: string): Promise<number> {
    const row = await tx.numberSequence.findFirst({
      where: { sequenceKey },
      select: { lastValue: true },
    });
    return row?.lastValue ?? 0;
  }

  async openedProcessKeyOfYear(tx: TenantTx, year: number): Promise<string | null> {
    const row = await tx.numberSequence.findFirst({
      where: { sequenceKey: { startsWith: 'PROCESS:', endsWith: `:${String(year)}` } },
      orderBy: { createdAt: 'asc' },
      select: { sequenceKey: true },
    });
    return row?.sequenceKey ?? null;
  }
}

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function scopeOr(value: unknown): NumberingScope {
  return (NUMBERING_SCOPES as readonly unknown[]).includes(value)
    ? (value as NumberingScope)
    : 'TENANT';
}

/**
 * Configuração de numeração do tenant: chaves `numbering.*` de `tenant_settings` (sob RLS — chave
 * sem linha vale o padrão, RN-TEN-57), o fuso de `tenants.timezone` e a sigla dos órgãos.
 */
@Injectable()
export class PrismaNumberingSettingsReader implements NumberingSettingsReader {
  async read(tx: TenantTx, tenantId: string): Promise<NumberingSettings> {
    const [tenant, rows] = await Promise.all([
      tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }),
      tx.tenantSetting.findMany({
        where: { key: { startsWith: 'numbering.' } },
        select: { key: true, value: true },
      }),
    ]);
    const values = new Map(rows.map((row) => [row.key, row.value as unknown]));
    const documentMasks = new Map<string, string>();
    for (const [key, value] of values) {
      const code = SETTING_DOCUMENT_MASK_KEY.exec(key)?.[1];
      if (code !== undefined && typeof value === 'string') documentMasks.set(code, value);
    }
    return {
      timezone: tenant?.timezone ?? DEFAULT_TIMEZONE,
      processMask: stringOr(values.get('numbering.process.mask'), DEFAULT_PROCESS_NUMBERING_MASK),
      processScope: scopeOr(values.get('numbering.process.scope')),
      documentDefaultMask: stringOr(
        values.get('numbering.document.defaultMask'),
        DEFAULT_DOCUMENT_NUMBERING_MASK,
      ),
      documentMasks,
    };
  }

  async organization(tx: TenantTx, organizationId: string): Promise<NumberingOrganization | null> {
    return tx.organization.findFirst({
      where: { id: organizationId },
      select: { id: true, shortName: true },
    });
  }

  async primaryOrganization(tx: TenantTx, tenantId: string): Promise<NumberingOrganization | null> {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { primaryOrganizationId: true },
    });
    if (!tenant?.primaryOrganizationId) return null;
    return this.organization(tx, tenant.primaryOrganizationId);
  }
}
