import type { MailMessage } from '#shared/mail/mail-provider.js';

import type { RenderedEmail } from './email-templates.js';

/*
 * Montagem do `MailMessage` (US-112 · RN-NTF-18 · queues.md §4.3): cabeçalhos técnicos
 * obrigatórios — `Message-ID` derivado do id de origem (rastreio e deduplicação no provedor e no
 * cliente), `X-Correlation-Id`, `X-CF-Notification-Id` e `Auto-Submitted: auto-generated`
 * (RFC 3834 — evita respostas automáticas em laço).
 */

export type EmailSourceKind = 'NOTIFICATION' | 'INVITATION';

export interface MailMessageInput {
  readonly kind: EmailSourceKind;
  /** `notificationId` ou `membershipId`. */
  readonly sourceId: string;
  readonly from: string;
  readonly to: string;
  readonly correlationId: string;
  readonly content: RenderedEmail;
}

/** Domínio do remetente (`Nome <nao-responda@dominio>` ou `nao-responda@dominio`). */
export function senderDomain(from: string): string {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const at = address.lastIndexOf('@');
  const domain = at < 0 ? '' : address.slice(at + 1).trim();
  return domain.length > 0 && !/[\s<>]/.test(domain)
    ? domain.toLowerCase()
    : 'contrataflow.invalid';
}

/** `Message-ID` estável por origem: o mesmo aviso tem sempre o mesmo id (RFC 5322). */
export function messageIdFor(kind: EmailSourceKind, sourceId: string, from: string): string {
  const prefix = kind === 'NOTIFICATION' ? 'notification' : 'invitation';
  return `<${prefix}.${sourceId}@${senderDomain(from)}>`;
}

/** Valor de cabeçalho em uma linha (sem CR/LF — evita injeção de cabeçalho). */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function buildMailMessage(input: MailMessageInput): MailMessage {
  return {
    from: input.from,
    to: input.to,
    subject: input.content.subject,
    html: input.content.html,
    text: input.content.text,
    messageId: messageIdFor(input.kind, input.sourceId, input.from),
    headers: {
      'X-Correlation-Id': headerValue(input.correlationId),
      ...(input.kind === 'NOTIFICATION'
        ? { 'X-CF-Notification-Id': input.sourceId }
        : { 'X-CF-Membership-Id': input.sourceId }),
      'Auto-Submitted': 'auto-generated',
    },
  };
}
