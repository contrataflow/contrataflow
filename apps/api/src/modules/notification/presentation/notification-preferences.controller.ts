import {
  notificationPreferenceSchema,
  updateNotificationPreferencesSchema,
} from '@contrataflow/validation';
import type { UpdateNotificationPreferences } from '@contrataflow/validation';
import { Controller, Get, HttpCode, Put } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import {
  GetNotificationPreferencesQuery,
  UpdateNotificationPreferencesCommand,
} from '../application/notification-preferences.js';
import type { NotificationPreferencesResult } from '../application/notification-preferences.js';

const TAGS = ['Sessão e perfil'];

/** `{ data: Preference[], meta: { emailEnabled } }` de ME-05/ME-06. */
const preferencesEnvelope = z.object({
  data: z.array(notificationPreferenceSchema),
  meta: z.object({ emailEnabled: z.boolean() }),
});

const IMPLICIT =
  'Capacidade implícita (permissions.md §1.1): o usuário lê e altera só as próprias preferências; não há userId na rota nem no corpo.';

/**
 * ME-05/ME-06 (api/01-session-me.md · US-113): preferências de notificação do próprio usuário no
 * tenant ativo. Pertence ao módulo `notification` (dono de `NotificationPreference`), embora a rota
 * viva sob `/me`.
 */
@Controller('me/notification-preferences')
@TenantScope('TENANT')
export class NotificationPreferencesController {
  constructor(
    private readonly get: GetNotificationPreferencesQuery,
    private readonly update: UpdateNotificationPreferencesCommand,
  ) {}

  @Get()
  @ImplicitAccess(IMPLICIT)
  @ApiOperation({
    operationId: 'ME-05',
    summary: 'Obter preferências de notificação',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Toda combinação tipo × canal com o valor efetivo (salvo ou padrão do registro) e `editable` (false = canal obrigatório). `meta.emailEnabled` é `notifications.emailEnabled` do tenant.',
        schema: preferencesEnvelope,
      },
    },
  })
  list(): Promise<NotificationPreferencesResult> {
    return this.get.execute();
  }

  @Put()
  @HttpCode(200)
  @ImplicitAccess(IMPLICIT)
  @ApiOperation({
    operationId: 'ME-06',
    summary: 'Atualizar preferências de notificação',
    tags: TAGS,
    auditActions: ['notification.preferences_update'],
    responses: {
      200: {
        description:
          'Merge das combinações enviadas (`enabled: null` = usar o padrão do registro); devolve o estado completo, como ME-05.',
        schema: preferencesEnvelope,
      },
    },
  })
  replace(
    @ZodBody(updateNotificationPreferencesSchema) body: UpdateNotificationPreferences,
  ): Promise<NotificationPreferencesResult> {
    return this.update.execute(body);
  }
}
