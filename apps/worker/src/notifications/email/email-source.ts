import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RenderedEmail } from './email-templates.js';

/*
 * Origem de um e-mail transacional (US-112 · padrão B — queues.md §1.1): o registro durável que
 * pediu o envio (`Notification.emailStatus = PENDING` ou o convite pendente da US-091). O
 * `EmailSender` só lê o estado, envia e grava o resultado com transições CONDICIONAIS a
 * `PENDING` — toda gravação devolve se a linha ainda estava pendente.
 */

/** Motivo de não enviar sem erro (FA-01/FA-04). */
export type EmailSkipReason = 'EMAIL_DISABLED' | 'TENANT_INACTIVE';

/** Falha permanente detectada antes do envio (FA-02/FA-03). */
export type EmailPreflightFailure = 'NO_RECIPIENT' | 'TEMPLATE_MISSING';

export type EmailPreparation =
  /** V-01: o registro não existe (excluído ou de outro tenant — a RLS o esconde). */
  | { readonly kind: 'missing' }
  /** V-02 · RN-NTF-13: já enviado, falho ou pulado — no-op idempotente. */
  | { readonly kind: 'not-pending'; readonly status: string }
  | { readonly kind: 'skip'; readonly reason: EmailSkipReason }
  | { readonly kind: 'fail'; readonly code: EmailPreflightFailure; readonly error: string }
  | {
      readonly kind: 'send';
      /** Endereço resolvido agora (RN-NTF-14 — nunca no payload do job). */
      readonly to: string;
      readonly content: RenderedEmail;
      /** Rótulo de baixa cardinalidade para logs (`NotificationType` ou `INVITATION`). */
      readonly type: string;
      /**
       * Marcador opaco da geração do conteúdo enviado (ex.: o convite da US-091 guarda o hash do
       * token e o `invite_expires_at` lidos): o `EmailSender` o devolve ao `markSent`, que só
       * grava se a geração ainda for a mesma. Nunca vai para log nem para o e-mail.
       */
      readonly receipt?: string;
    };

export interface EmailSource {
  /** Lê o registro, revalida tenant e `notifications.emailEnabled` e renderiza o conteúdo. */
  prepare(client: SqlClient, sourceId: string, tenantId: string): Promise<EmailPreparation>;
  markSent(client: SqlClient, sourceId: string, sentAt: Date, receipt?: string): Promise<boolean>;
  markFailed(client: SqlClient, sourceId: string, error: string): Promise<boolean>;
  markSkipped(client: SqlClient, sourceId: string): Promise<boolean>;
}

/** Limite de `emailError` (varchar(500)) — causa resumida, sem stack nem corpo do e-mail. */
export const EMAIL_ERROR_MAX = 500;

export function truncateEmailError(error: string): string {
  const oneLine = error.replace(/\s+/g, ' ').trim();
  return oneLine.length <= EMAIL_ERROR_MAX ? oneLine : `${oneLine.slice(0, EMAIL_ERROR_MAX - 1)}…`;
}

/** Validação mínima do endereço (FA-02): o e-mail é identificador de login, ausência é anomalia. */
export function isDeliverableAddress(address: string | null | undefined): address is string {
  return typeof address === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address.trim());
}
