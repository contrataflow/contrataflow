import { connect } from 'node:net';

import { createTransport } from 'nodemailer';
import type { NodemailerError, SMTPPoolOptions } from 'nodemailer';

import { MailRejectedError, MailTransientError } from './mail-provider.js';
import type { MailMessage, MailProvider, MailReceipt } from './mail-provider.js';

/*
 * `MailProvider` SMTP (US-112 · DEC-050): Mailpit em desenvolvimento e a interface SMTP do Amazon
 * SES em produção (`smtps://<usuário-smtp>:<senha>@email-smtp.<região>.amazonaws.com:465`). Pool de
 * conexões com timeouts menores que o da fila `email` (30 s): um provedor travado vira falha
 * transitória antes de o `runJob` abortar o job.
 *
 * Resolução de nomes: o nodemailer resolve o host por conta própria com `dns.resolve4/6`, que ignora
 * o arquivo hosts e consulta cada servidor DNS da máquina; para `localhost` isso devolve `ENOTFOUND`
 * (ou leva mais que o `connectionTimeout`) e o envio falha com `EDNS`. Por isso a conexão TCP é
 * aberta aqui, pelo `net.connect` (resolvedor do sistema, `dns.lookup`, que respeita o hosts) e
 * entregue ao nodemailer via `getSocket`. O nome original continua em `host`: o STARTTLS e o TLS
 * implícito do nodemailer usam esse nome no SNI e na validação do certificado, nunca o IP.
 */

export interface SmtpMailProviderOptions {
  /** `smtp://` (STARTTLS oportunista) ou `smtps://` (TLS implícito), com credenciais opcionais. */
  readonly url: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
}

/** Opções do pool a partir da URL (credenciais decodificadas; nada é logado). */
export function smtpPoolOptions(
  options: SmtpMailProviderOptions,
): SMTPPoolOptions & { pool: true } {
  const url = new URL(options.url);
  const secure = url.protocol === 'smtps:';
  const user = decodeURIComponent(url.username);
  return {
    pool: true,
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 25,
    secure,
    ...(user ? { auth: { user, pass: decodeURIComponent(url.password) } } : {}),
    maxConnections: options.maxConnections ?? 5,
    connectionTimeout: options.connectionTimeoutMs ?? 10_000,
    greetingTimeout: options.connectionTimeoutMs ?? 10_000,
    socketTimeout: options.socketTimeoutMs ?? 20_000,
  };
}

/** Callback do `getSocket` do nodemailer (o tipo não é exportado pela raiz do pacote). */
type GetSocketCallback = Parameters<NonNullable<SMTPPoolOptions['getSocket']>>[1];

/**
 * Abre o socket TCP pelo resolvedor do sistema. Falha de DNS vira `EDNS` e as demais, `ECONNECTION`
 * ou `ETIMEDOUT` (todas transitórias); o TLS é negociado depois pelo nodemailer sobre este socket,
 * com o nome original do host.
 */
export function openSystemResolvedSocket(
  options: Pick<SMTPPoolOptions, 'host' | 'port' | 'connectionTimeout'>,
  callback: GetSocketCallback,
): void {
  const socket = connect({ host: options.host ?? 'localhost', port: Number(options.port) });
  let settled = false;
  const finish = (error: Error | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.removeListener('error', onError);
    socket.removeListener('connect', onConnect);
    if (error) {
      socket.destroy();
      callback(error);
      return;
    }
    // O socket conectado passa a ser do nodemailer, que instala os próprios manipuladores de erro.
    callback(null, { connection: socket });
  };
  const onError = (error: NodeJS.ErrnoException): void => {
    finish(Object.assign(error, { code: error.code === 'ENOTFOUND' ? 'EDNS' : 'ECONNECTION' }));
  };
  const onConnect = (): void => {
    finish(null);
  };
  const timer = setTimeout(() => {
    finish(Object.assign(new Error('Tempo esgotado ao conectar'), { code: 'ETIMEDOUT' }));
  }, options.connectionTimeout ?? 10_000);
  socket.once('error', onError);
  socket.once('connect', onConnect);
}

/**
 * Classificação da falha SMTP (queues.md §4.3): 5xx no envelope ou na mensagem (550/553,
 * destinatário inexistente, `MessageRejected`) é rejeição definitiva; 4xx (421/450/451/452),
 * rede, TLS, timeout e autenticação são transitórios. A causa vai resumida — nunca a resposta
 * completa do servidor, que pode ecoar o endereço.
 */
export function classifySmtpError(error: unknown): MailRejectedError | MailTransientError {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as NodemailerError;
  const status = failure.responseCode;
  const code = typeof failure.code === 'string' ? failure.code : 'UNKNOWN';
  const permanent =
    status !== undefined &&
    status >= 500 &&
    status < 600 &&
    (code === 'EENVELOPE' || code === 'EMESSAGE');
  if (permanent) {
    return new MailRejectedError(
      `Destinatário ou mensagem recusados pelo provedor (SMTP ${String(status)})`,
      `SMTP_${String(status)}`,
    );
  }
  if (code === 'EENVELOPE' && status === undefined) {
    return new MailRejectedError('Endereço de destinatário inválido', 'INVALID_RECIPIENT');
  }
  return new MailTransientError(
    status === undefined
      ? `Falha transitória do provedor (${code})`
      : `Falha transitória do provedor (SMTP ${String(status)})`,
    status === undefined ? code : `SMTP_${String(status)}`,
  );
}

export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';
  private readonly transport;

  constructor(options: SmtpMailProviderOptions) {
    const poolOptions: SMTPPoolOptions & { pool: true } = {
      ...smtpPoolOptions(options),
      getSocket: openSystemResolvedSocket,
    };
    this.transport = createTransport(poolOptions);
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    try {
      const info = await this.transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: message.messageId,
        headers: { ...message.headers },
      });
      if (info.rejected.length > 0 && info.accepted.length === 0) {
        throw new MailRejectedError('Destinatário recusado pelo provedor', 'RECIPIENT_REJECTED');
      }
      return { providerMessageId: typeof info.messageId === 'string' ? info.messageId : null };
    } catch (error) {
      if (error instanceof MailRejectedError) throw error;
      throw classifySmtpError(error);
    }
  }

  close(): Promise<void> {
    this.transport.close();
    return Promise.resolve();
  }
}
