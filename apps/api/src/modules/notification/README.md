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
