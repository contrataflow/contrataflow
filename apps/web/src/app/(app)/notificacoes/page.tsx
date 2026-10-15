import { NotificationList } from '@/features/notifications/notification-list';

/**
 * SCR-036 — Notificações (US-111): histórico completo das notificações in-app do usuário no tenant
 * ativo, lido no cliente (NTF-01, por cursor). Cada usuário só acessa as próprias: não há
 * permissão a conferir (estado "sem permissão" não se aplica).
 */
export default function NotificationsPage() {
  return <NotificationList />;
}
