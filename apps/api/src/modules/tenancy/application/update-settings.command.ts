import { TenantSettingsChanged } from '@contrataflow/validation';
import type { SettingsMapDto, UpdateSettings } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { ORGANIZATION_LOGO_PORT } from './organization-ports.js';
import type { OrganizationLogoPort } from './organization-ports.js';
import {
  SETTINGS_CLOCK,
  SETTINGS_TRANSACTIONS,
  SettingAlreadyExistsError,
  TENANT_SETTINGS_REPOSITORY,
} from './settings-ports.js';
import type {
  SettingsClock,
  SettingsTransactions,
  SettingWrite,
  TenantSettingsRepository,
} from './settings-ports.js';
import {
  expectedVersionsMissing,
  invalidSettingValues,
  isNumberingMaskOnly,
  logMaskInvalid,
  logSaveFailure,
  settingKeyUnknown,
  settingVersionConflict,
} from './settings.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { SettingsRegistry } from '../domain/settings-registry.js';
import {
  InvalidSettingValuesError,
  MissingExpectedVersionsError,
  planSettingsUpdate,
  SettingVersionConflictError,
  UnknownSettingKeysError,
} from '../domain/settings-update.js';
import type { PlannedSettingChange, StoredSetting } from '../domain/settings-update.js';

/** Chave do logotipo: referencia um anexo do tenant (RN-TEN-42, mesma regra do órgão). */
const LOGO_KEY = 'branding.logoAttachmentId';

/**
 * `UpdateSettingsCommand` — SET-02 (US-103 · fluxo principal, passos 3–5): `PATCH` em lote, tudo ou
 * nada. Autoriza (`SETTINGS_MANAGE` + MFA), valida chaves, valores e versões (`expectedVersions`
 * por chave — RN-TEN-52..54) e, numa única transação, grava cada `TenantSetting`, uma auditoria
 * `settings.update` por chave (valor anterior e novo) e UM `TenantSettingsChanged` com `keys[]`
 * (RN-TEN-55). Nada alterado → 200 sem nova versão, auditoria nem evento.
 */
@Injectable()
export class UpdateSettingsCommand {
  private readonly logger = new Logger('Settings');

  constructor(
    private readonly registry: SettingsRegistry,
    @Inject(TENANT_SETTINGS_REPOSITORY) private readonly settings: TenantSettingsRepository,
    @Inject(SETTINGS_TRANSACTIONS) private readonly transactions: SettingsTransactions,
    @Inject(SETTINGS_CLOCK) private readonly clock: SettingsClock,
    @Inject(ORGANIZATION_LOGO_PORT) private readonly logos: OrganizationLogoPort,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: UpdateSettings): Promise<SettingsMapDto> {
    this.access.assertCan('SETTINGS_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const context = requireRequestContext();
    const now = this.clock();

    let updated: SettingsMapDto;
    try {
      updated = await this.transactions.run((tx) => this.apply(tx, input, now));
    } catch (error) {
      if (error instanceof UnknownSettingKeysError) {
        this.logger.warn(
          {
            event: 'settings.unknown_key_rejected',
            keys: error.keys,
            tenantId: context.tenantId,
            userId: context.actor.userId,
            correlationId: context.correlationId,
          },
          'settings.unknown_key_rejected',
        );
      } else {
        logSaveFailure(this.logger, error, context.correlationId);
      }
      throw error;
    }

    const keys = Object.keys(updated);
    if (keys.length > 0) {
      this.logger.log(
        {
          event: 'settings.updated',
          keys,
          tenantId: context.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        },
        'settings.updated',
      );
    }
    return updated;
  }

  private async apply(tx: TenantTx, input: UpdateSettings, now: Date): Promise<SettingsMapDto> {
    const context = requireRequestContext();
    const tenantId = context.tenantId;
    if (tenantId === null) throw new Error('UpdateSettingsCommand exige o tenant do contexto.');

    const current = await this.currentRows(tx);
    const plan = this.plan(current, input);
    if (plan.changes.length === 0) return {};

    for (const change of plan.changes) {
      if (change.key === LOGO_KEY && typeof change.next === 'string') {
        const check = await this.logos.check(tx, change.next);
        if (check !== 'OK') {
          throw validationError([
            {
              field: `values.${LOGO_KEY}`,
              code: check === 'INACTIVE' ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
              message: 'Não foi possível usar esta imagem como logotipo.',
            },
          ]);
        }
      }
    }

    const updated: SettingsMapDto = {};
    for (const change of plan.changes) {
      const write = {
        tenantId,
        key: change.key,
        value: change.next,
        userId: context.actor.userId,
        now,
      };
      await this.write(tx, change, write);
      updated[change.key] = { value: change.next, version: change.expectedVersion + 1 };
      await this.audit.record(tx, {
        action: 'settings.update',
        entityType: 'Tenant',
        entityId: tenantId,
        changes: [{ path: change.key, old: change.previous, new: change.next }],
        metadata: { key: change.key, group: change.group },
      });
    }

    await this.outbox.record(
      tx,
      TenantSettingsChanged.of({
        aggregateId: tenantId,
        payload: { keys: plan.changes.map((change) => change.key) },
      }),
    );
    return updated;
  }

  private async currentRows(tx: TenantTx): Promise<Map<string, StoredSetting>> {
    const rows = await this.settings.list(tx);
    return new Map(rows.map((row) => [row.key, row]));
  }

  private plan(current: ReadonlyMap<string, StoredSetting>, input: UpdateSettings) {
    try {
      return planSettingsUpdate(this.registry, current, input);
    } catch (error) {
      if (error instanceof UnknownSettingKeysError) throw settingKeyUnknown(error);
      if (error instanceof InvalidSettingValuesError) {
        if (isNumberingMaskOnly(error)) {
          logMaskInvalid(this.logger, error, input.values, requireRequestContext().correlationId);
        }
        throw invalidSettingValues(error);
      }
      if (error instanceof MissingExpectedVersionsError) throw expectedVersionsMissing(error);
      if (error instanceof SettingVersionConflictError) throw settingVersionConflict(error);
      throw error;
    }
  }

  /** Insert/update da chave; corrida com outra requisição vira 412 com a versão vencedora. */
  private async write(
    tx: TenantTx,
    change: PlannedSettingChange,
    write: SettingWrite,
  ): Promise<void> {
    try {
      if (change.insert) await this.settings.insert(tx, write);
      else await this.settings.update(tx, write, change.expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError || error instanceof SettingAlreadyExistsError) {
        const latest = (await this.currentRows(tx)).get(change.key);
        throw settingVersionConflict(
          new SettingVersionConflictError([
            { key: change.key, currentVersion: latest?.version ?? change.expectedVersion + 1 },
          ]),
        );
      }
      throw error;
    }
  }
}
