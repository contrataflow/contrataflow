import { NOTIFICATION_PREFERENCE_LOCKED_MESSAGE } from '@contrataflow/validation';
import type {
  NotificationPreferenceDto,
  UpdateNotificationPreferences,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';

import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_TRANSACTIONS,
} from './notification-ports.js';
import type {
  NotificationPreferenceRepository,
  NotificationTransactions,
} from './notification-ports.js';
import { currentRecipientId } from './notification.queries.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import {
  MandatoryChannelError,
  effectivePreferences,
  planPreferenceChanges,
} from '../domain/notification-preference.js';

const EMAIL_ENABLED_KEY = 'notifications.emailEnabled';

/** Meta de ME-05/ME-06: o e-mail do tenant desligado deixa a coluna `EMAIL` inerte (RN-NTF-24). */
export interface NotificationPreferencesMeta {
  readonly emailEnabled: boolean;
}

export type NotificationPreferencesResult = DataResult<
  NotificationPreferenceDto[],
  NotificationPreferencesMeta
>;

/**
 * Estado atual das preferências do usuário no tenant do `tx`: toda combinação tipo × canal com o
 * valor efetivo (salvo, ou o padrão do registro) e `notifications.emailEnabled` do tenant.
 */
async function currentPreferences(
  tx: TenantTx,
  repository: NotificationPreferenceRepository,
  tenancy: TenancyFacade,
  userId: string,
): Promise<NotificationPreferencesResult> {
  const stored = await repository.list(tx, userId);
  const settings = await tenancy.settingValues(tx, [EMAIL_ENABLED_KEY]);
  return new DataResult([...effectivePreferences(stored)], {
    emailEnabled: settings.get(EMAIL_ENABLED_KEY) !== false,
  });
}

/**
 * `GetNotificationPreferencesQuery` — ME-05 (US-113): capacidade implícita sobre o próprio perfil;
 * o `userId` vem do token, nunca da requisição.
 */
@Injectable()
export class GetNotificationPreferencesQuery {
  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
    @Inject(NOTIFICATION_TRANSACTIONS) private readonly transactions: NotificationTransactions,
    private readonly tenancy: TenancyFacade,
  ) {}

  execute(): Promise<NotificationPreferencesResult> {
    const userId = currentRecipientId();
    return this.transactions.read((tx) =>
      currentPreferences(tx, this.preferences, this.tenancy, userId),
    );
  }
}

/**
 * `UpdateNotificationPreferencesCommand` — ME-06 (US-113): merge das combinações enviadas
 * (RN-NTF-25) numa única transação, com a trava dos tipos obrigatórios (RN-NTF-23) conferida ANTES
 * de qualquer escrita e o `AuditLog` `notification.preferences_update` (RN-NTF-26) na mesma
 * transação. Reenviar valores já salvos não grava nem audita.
 * @throws ApiError 422 `VALIDATION_ERROR` (`NOT_ALLOWED`) ao desligar canal obrigatório
 */
@Injectable()
export class UpdateNotificationPreferencesCommand {
  private readonly logger = new Logger('Notification');

  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
    @Inject(NOTIFICATION_TRANSACTIONS) private readonly transactions: NotificationTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly tenancy: TenancyFacade,
  ) {}

  async execute(input: UpdateNotificationPreferences): Promise<NotificationPreferencesResult> {
    const context = requireRequestContext();
    const userId = currentRecipientId();

    let changedCount = 0;
    let result: NotificationPreferencesResult;
    try {
      result = await this.transactions.run(async (tx) => {
        const stored = await this.preferences.list(tx, userId);
        const deltas = planPreferenceChanges(stored, input.preferences);
        changedCount = deltas.length;
        if (deltas.length > 0) {
          await this.preferences.apply(tx, userId, deltas);
          await this.audit.record(tx, {
            action: 'notification.preferences_update',
            entityType: 'User',
            entityId: userId,
            changes: deltas.map((delta) => ({
              path: `preferences.${delta.notificationType}.${delta.channel}`,
              // `null` = sem preferência salva (vale o padrão do registro).
              old: delta.from,
              new: delta.to,
            })),
            metadata: { changedCount: deltas.length, requestedCount: input.preferences.length },
          });
        }
        return currentPreferences(tx, this.preferences, this.tenancy, userId);
      });
    } catch (error) {
      if (error instanceof MandatoryChannelError) {
        this.logger.warn(
          {
            event: 'notification_preferences.mandatory_channel_blocked',
            notificationType: error.notificationType,
            channel: 'IN_APP',
            correlationId: context.correlationId,
          },
          'notification_preferences.mandatory_channel_blocked',
        );
        throw validationError([
          {
            field: `preferences[${String(error.index)}].enabled`,
            code: 'NOT_ALLOWED',
            message: NOTIFICATION_PREFERENCE_LOCKED_MESSAGE,
          },
        ]);
      }
      throw error;
    }

    if (changedCount > 0) {
      this.logger.log(
        {
          event: 'notification_preferences.updated',
          changedCount,
          correlationId: context.correlationId,
        },
        'notification_preferences.updated',
      );
    }
    return result;
  }
}
