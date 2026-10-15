import type { TenantTx } from '#shared/database/prisma.js';

import type { Notification } from '../domain/notification.js';

/*
 * Portas da central de notificações (US-111): implementadas em `infrastructure/` (Prisma) e em
 * memória nos testes e no modo de identidade fake (local/dev/test sem banco). Toda operação recebe
 * o destinatário: notificação de outra pessoa (ou de outro tenant, barrado pela RLS) não existe.
 */

/** Posição do cursor de NTF-01: `createdAt DESC, id DESC`. */
export interface NotificationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface NotificationListFilter {
  readonly recipientId: string;
  readonly unreadOnly: boolean;
  readonly after: NotificationCursor | null;
  /** Quantidade a buscar (o caso de uso pede `limit + 1` para saber se há mais). */
  readonly take: number;
  readonly now: Date;
}

export interface NotificationRepository {
  /** Não arquivadas e não vencidas (RN-NTF-09), mais recentes primeiro. */
  list(tx: TenantTx, filter: NotificationListFilter): Promise<Notification[]>;
  /** RN-NTF-10: não arquivadas, não vencidas e `readAt IS NULL`. */
  countUnread(tx: TenantTx, recipientId: string, now: Date): Promise<number>;
  /** `null` se não existe, é de outro destinatário ou de outro tenant (V-02). */
  findOwn(tx: TenantTx, id: string, recipientId: string): Promise<Notification | null>;
  /** Preenche `readAt` só se ainda nulo (idempotente — RN-NTF-11). */
  markRead(tx: TenantTx, id: string, recipientId: string, now: Date): Promise<void>;
  /** Marca as não lidas do destinatário no tenant da transação (RN-NTF-12); devolve quantas. */
  markAllRead(tx: TenantTx, recipientId: string, now: Date): Promise<number>;
  /** Preenche `archivedAt` só se ainda nulo (idempotente — RN-NTF-11). */
  archive(tx: TenantTx, id: string, recipientId: string, now: Date): Promise<void>;
}

export const NOTIFICATION_REPOSITORY = Symbol('NotificationRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface NotificationTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const NOTIFICATION_TRANSACTIONS = Symbol('NotificationTransactions');

export type NotificationClock = () => Date;

export const NOTIFICATION_CLOCK = Symbol('NotificationClock');
