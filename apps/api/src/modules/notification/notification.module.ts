import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import {
  NOTIFICATION_CLOCK,
  NOTIFICATION_REPOSITORY,
  NOTIFICATION_TRANSACTIONS,
} from './application/notification-ports.js';
import {
  ArchiveNotificationCommand,
  MarkAllReadCommand,
  MarkNotificationReadCommand,
} from './application/notification.commands.js';
import { NotificationFacade } from './application/notification.facade.js';
import { GetUnreadCountQuery, ListNotificationsQuery } from './application/notification.queries.js';
import {
  InMemoryNotificationRepository,
  InMemoryNotificationTransactions,
} from './infrastructure/in-memory-notification.repository.js';
import {
  PrismaNotificationRepository,
  PrismaNotificationTransactions,
} from './infrastructure/prisma-notification.repository.js';
import { NotificationController } from './presentation/notification.controller.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): notificações em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `notification` (DEC-040): outros módulos usam somente a fachada exportada. Na API, a
 * central in-app (US-111: NTF-01..05); a gravação é do `NotificationDispatcher` do worker (fila
 * `notifications`), que aplica o registro `NotificationType` de `packages/types`.
 */
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationFacade,
    ListNotificationsQuery,
    GetUnreadCountQuery,
    MarkNotificationReadCommand,
    MarkAllReadCommand,
    ArchiveNotificationCommand,
    PrismaNotificationRepository,
    PrismaNotificationTransactions,
    InMemoryNotificationTransactions,
    {
      provide: InMemoryNotificationRepository,
      useFactory: () => new InMemoryNotificationRepository(),
    },
    {
      provide: NOTIFICATION_REPOSITORY,
      inject: [APP_CONFIG, PrismaNotificationRepository, InMemoryNotificationRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaNotificationRepository,
        memory: InMemoryNotificationRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: NOTIFICATION_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaNotificationTransactions, InMemoryNotificationTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaNotificationTransactions,
        memory: InMemoryNotificationTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: NOTIFICATION_CLOCK, useValue: () => new Date() },
  ],
  exports: [NotificationFacade],
})
export class NotificationModule {}
