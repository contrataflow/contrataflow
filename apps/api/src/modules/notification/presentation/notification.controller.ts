import {
  cursorEnvelope,
  dataEnvelope,
  notificationIdParamsSchema,
  notificationListQuerySchema,
  notificationSchema,
  readAllResultSchema,
  unreadCountSchema,
} from '@contrataflow/validation';
import type {
  NotificationDto,
  NotificationListQuery,
  ReadAllResultDto,
  UnreadCountDto,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import type { CursorResult } from '#shared/http/pagination.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  ArchiveNotificationCommand,
  MarkAllReadCommand,
  MarkNotificationReadCommand,
} from '../application/notification.commands.js';
import {
  GetUnreadCountQuery,
  ListNotificationsQuery,
} from '../application/notification.queries.js';

const TAGS = ['Notificações'];

/** DEC-161: leitura e arquivamento de notificação não são auditados (baixo valor, alto volume). */
const NOT_AUDITED =
  'Marca leitura/arquivamento da própria notificação: projeção de sistema sem AuditLog (DEC-161 · US-111).';

/**
 * NTF-01..05 (api/13-dashboard-notifications-audit.md · US-111): central de notificações in-app.
 * Capacidade implícita do vínculo ativo sobre o próprio recurso (sem permissão do catálogo, como
 * as `ME-*`): cada usuário só lê e altera as notificações de que é destinatário no tenant ativo.
 */
@Controller('notifications')
@TenantScope('TENANT')
export class NotificationController {
  constructor(
    private readonly list: ListNotificationsQuery,
    private readonly unread: GetUnreadCountQuery,
    private readonly markRead: MarkNotificationReadCommand,
    private readonly markAllRead: MarkAllReadCommand,
    private readonly archive: ArchiveNotificationCommand,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'NTF-01',
    summary: 'Listar notificações',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Notificações do usuário no tenant ativo, mais recentes primeiro, por cursor; arquivadas e vencidas ficam de fora. `unreadOnly=true` traz só as não lidas.',
        schema: cursorEnvelope(notificationSchema),
      },
    },
  })
  listNotifications(
    @ZodQuery(notificationListQuerySchema) query: NotificationListQuery,
  ): Promise<CursorResult<NotificationDto>> {
    return this.list.execute(query);
  }

  @Get('unread-count')
  @ApiOperation({
    operationId: 'NTF-02',
    summary: 'Obter contador de não lidas',
    tags: TAGS,
    responses: {
      200: {
        description: 'Não arquivadas, não vencidas e não lidas (contador do sininho).',
        schema: dataEnvelope(unreadCountSchema),
      },
    },
  })
  unreadCount(): Promise<UnreadCountDto> {
    return this.unread.execute();
  }

  // Antes de `:id/read`: `read-all` não é um id.
  @Post('read-all')
  @HttpCode(200)
  @ImplicitAccess(
    'Notificações do próprio destinatário (US-111 · permissions.md §7): capacidade implícita.',
  )
  @ApiOperation({
    operationId: 'NTF-04',
    summary: 'Marcar todas como lidas',
    tags: TAGS,
    auditExempt: NOT_AUDITED,
    responses: {
      200: {
        description: 'Quantas notificações foram marcadas como lidas.',
        schema: dataEnvelope(readAllResultSchema),
      },
    },
  })
  readAll(): Promise<ReadAllResultDto> {
    return this.markAllRead.execute();
  }

  @Post(':id/read')
  @HttpCode(200)
  @ImplicitAccess(
    'Notificações do próprio destinatário (US-111 · permissions.md §7): capacidade implícita.',
  )
  @ApiOperation({
    operationId: 'NTF-03',
    summary: 'Marcar notificação como lida',
    tags: TAGS,
    auditExempt: NOT_AUDITED,
    responses: {
      200: {
        description: 'Notificação com `readAt` preenchido (idempotente).',
        schema: dataEnvelope(notificationSchema),
      },
    },
  })
  read(@ZodParams(notificationIdParamsSchema) params: { id: string }): Promise<NotificationDto> {
    return this.markRead.execute(params.id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ImplicitAccess(
    'Notificações do próprio destinatário (US-111 · permissions.md §7): capacidade implícita.',
  )
  @ApiOperation({
    operationId: 'NTF-05',
    summary: 'Arquivar notificação',
    tags: TAGS,
    auditExempt: NOT_AUDITED,
    responses: {
      200: {
        description: 'Notificação com `archivedAt` preenchido (idempotente); sai da lista.',
        schema: dataEnvelope(notificationSchema),
      },
    },
  })
  archiveNotification(
    @ZodParams(notificationIdParamsSchema) params: { id: string },
  ): Promise<NotificationDto> {
    return this.archive.execute(params.id);
  }
}
