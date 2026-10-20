/*
 * `MailProvider` (US-112 · DEC-050 · queues.md §4.3): a abstração única de envio de e-mail do
 * produto — SMTP/Mailpit em desenvolvimento e Amazon SES em produção (pela interface SMTP do SES).
 * Trocar de provedor não muda o `EmailSender`; é também o ponto único de teste de contrato.
 *
 * O provedor classifica a falha: rejeição definitiva do destinatário/mensagem (SMTP 5xx,
 * `MessageRejected`, endereço inválido) vira `MailRejectedError` — resultado de negócio, gravado
 * como `FAILED` sem retentar —; qualquer outra (rede, timeout, 4xx, *throttling*) é transitória e
 * segue a política da fila `email`.
 */

/** Mensagem pronta para envio (value object `MailMessage`): assunto, HTML, texto e cabeçalhos. */
export interface MailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** `Message-ID` com os sinais de menor/maior (`<id@domínio>`). */
  readonly messageId: string;
  /** Cabeçalhos técnicos além do `Message-ID` (`X-Correlation-Id`, `Auto-Submitted`…). */
  readonly headers: Readonly<Record<string, string>>;
}

/** Aceite do provedor (o `Message-ID` devolvido, quando houver). */
export interface MailReceipt {
  readonly providerMessageId: string | null;
}

export interface MailProvider {
  /** Rótulo de baixa cardinalidade para logs e métricas (`smtp`, `fake`…). */
  readonly name: string;
  send(message: MailMessage, signal?: AbortSignal): Promise<MailReceipt>;
  close?(): Promise<void>;
}

/** Rejeição definitiva do provedor: não adianta retentar (resultado de negócio — sem DLQ). */
export class MailRejectedError extends Error {
  constructor(
    /** Causa resumida e sanitizada (vai para `emailError` — sem corpo nem resposta completa). */
    readonly reason: string,
    readonly code = 'MAIL_REJECTED',
  ) {
    super(reason);
    this.name = 'MailRejectedError';
  }
}

/** Falha transitória do provedor (rede, timeout, 4xx): a fila reaplica a política de retentativa. */
export class MailTransientError extends Error {
  constructor(
    readonly reason: string,
    readonly code = 'MAIL_TRANSIENT',
  ) {
    super(reason);
    this.name = 'MailTransientError';
  }
}
