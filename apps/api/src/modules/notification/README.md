# `notification`

Notificações in-app e e-mail e preferências (DEC-040).

- **API (US-111):** central in-app — NTF-01..05 (`presentation/notification.controller.ts`). Só o
  destinatário lê e marca leitura/arquivamento; o `cf_app` tem `SELECT` e
  `UPDATE (read_at, archived_at)` em `notifications`.
- **Worker (US-111):** o `NotificationDispatcher` (`apps/worker/src/notifications/`) consome a fila
  `notifications`, aplica o registro `NotificationType` (`packages/types/src/notifications.ts` ·
  events.md §6) e grava/agrupa as notificações. Fontes de destinatários que dependem de outros
  módulos (visibilidade do processo, permissão por escopo, participantes, aprovações, anexos,
  renderizações) entram com as stories donas.
- **API (US-113):** preferências por tipo e canal — ME-05/ME-06 (`presentation/notification-preferences.controller.ts`,
  rota sob `/me`). Ausência de linha em `notification_preferences` = padrão do registro; o in-app dos
  tipos obrigatórios é travado (RN-NTF-23) e `enabled: null` restaura o padrão (apaga a linha).
- **Worker (US-113):** o `NotificationDispatcher` lê as preferências a cada despacho
  (`SqlNotificationPreferences`): e-mail desligado → `NOT_APPLICABLE`; in-app desligado → a
  notificação nasce arquivada só para portar o e-mail (sem e-mail a enviar, nada é gravado).
