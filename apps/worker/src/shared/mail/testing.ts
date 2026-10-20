import type { MailMessage, MailProvider, MailReceipt } from './mail-provider.js';

/* Dublê do `MailProvider` para testes (contrato do provedor sem rede). */

export class FakeMailProvider implements MailProvider {
  readonly name = 'fake';
  readonly sent: MailMessage[] = [];
  /** Falhas programadas: consumidas uma por envio, na ordem. */
  readonly failures: Error[] = [];
  /** Espera antes de aceitar (concorrência). */
  delayMs = 0;

  async send(message: MailMessage): Promise<MailReceipt> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(message);
    return { providerMessageId: message.messageId };
  }
}
