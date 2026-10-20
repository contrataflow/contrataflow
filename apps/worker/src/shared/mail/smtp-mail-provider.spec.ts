import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { MailRejectedError, MailTransientError } from './mail-provider.js';
import type { MailMessage } from './mail-provider.js';
import { SmtpMailProvider, classifySmtpError, smtpPoolOptions } from './smtp-mail-provider.js';

/*
 * Contrato do `MailProvider` SMTP contra um servidor SMTP mínimo em memória (o teste contra o
 * Mailpit real fica na integração): aceite, rejeição 550 do destinatário e 4xx transitório.
 */

interface Received {
  readonly rcpt: string[];
  data: string;
}

function fakeSmtp(
  rcptReply: string,
): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((socket: Socket) => {
    const current: Received = { rcpt: [], data: '' };
    let inData = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ rcpt: [...current.rcpt], data: current.data });
            socket.write('250 2.0.0 queued\r\n');
          } else {
            current.data += `${line}\n`;
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250 fake\r\n');
        else if (command === 'MAIL') socket.write('250 2.1.0 ok\r\n');
        else if (command === 'RCPT') {
          current.rcpt.push(line);
          socket.write(`${rcptReply}\r\n`);
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'RSET' || command === 'NOOP') socket.write('250 ok\r\n');
        else if (command === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, received });
    });
  });
}

const message: MailMessage = {
  from: 'ContrataFlow <nao-responda@contrataflow.test>',
  to: 'diego@pmsj.gov.br',
  subject: '[ContrataFlow] Aprovação pendente',
  html: '<p>Olá</p>',
  text: 'Olá',
  messageId: '<notification.n10@contrataflow.test>',
  headers: { 'X-Correlation-Id': 'corr-1', 'Auto-Submitted': 'auto-generated' },
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function providerFor(rcptReply: string) {
  const smtp = await fakeSmtp(rcptReply);
  const provider = new SmtpMailProvider({
    url: `smtp://127.0.0.1:${String(smtp.port)}`,
    connectionTimeoutMs: 2_000,
    socketTimeoutMs: 2_000,
  });
  cleanup.push(async () => {
    await provider.close();
    await new Promise((resolve) => smtp.server.close(resolve));
  });
  return { provider, received: smtp.received };
}

describe('SmtpMailProvider (US-112 · DEC-050)', () => {
  it('envia com Message-ID e cabeçalhos técnicos', async () => {
    const { provider, received } = await providerFor('250 2.1.5 ok');
    await expect(provider.send(message)).resolves.toEqual({
      providerMessageId: '<notification.n10@contrataflow.test>',
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.rcpt[0]).toContain('diego@pmsj.gov.br');
    expect(received[0]?.data).toMatch(/Message-ID: <notification\.n10@contrataflow\.test>/i);
    expect(received[0]?.data).toMatch(/X-Correlation-Id: corr-1/i);
    expect(received[0]?.data).toMatch(/Auto-Submitted: auto-generated/);
    expect(received[0]?.data).toMatch(/text\/plain/);
    expect(received[0]?.data).toMatch(/text\/html/);
  });

  it('550 no destinatário é rejeição definitiva', async () => {
    const { provider } = await providerFor('550 5.1.1 user unknown');
    const error: unknown = await provider.send(message).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MailRejectedError);
    expect((error as MailRejectedError).reason).toBe(
      'Destinatário ou mensagem recusados pelo provedor (SMTP 550)',
    );
  });

  it('451 no destinatário é transitório', async () => {
    const { provider } = await providerFor('451 4.3.0 try later');
    await expect(provider.send(message)).rejects.toBeInstanceOf(MailTransientError);
  });

  it('servidor fora do ar é transitório', async () => {
    const provider = new SmtpMailProvider({
      url: 'smtp://127.0.0.1:1',
      connectionTimeoutMs: 1_000,
    });
    cleanup.push(() => provider.close());
    await expect(provider.send(message)).rejects.toBeInstanceOf(MailTransientError);
  });
});

describe('classificação e opções do SMTP', () => {
  it('5xx no envelope/mensagem é definitivo; 4xx, rede e autenticação são transitórios', () => {
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 553 })).toBeInstanceOf(
      MailRejectedError,
    );
    expect(classifySmtpError({ code: 'EMESSAGE', responseCode: 554 })).toBeInstanceOf(
      MailRejectedError,
    );
    expect(classifySmtpError({ code: 'EENVELOPE' })).toMatchObject({ code: 'INVALID_RECIPIENT' });
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 452 })).toMatchObject({
      name: 'MailTransientError',
      code: 'SMTP_452',
    });
    expect(classifySmtpError({ code: 'EAUTH', responseCode: 535 })).toBeInstanceOf(
      MailTransientError,
    );
    expect(classifySmtpError({ code: 'ECONNECTION' })).toMatchObject({ code: 'ECONNECTION' });
    expect(classifySmtpError(null)).toMatchObject({ code: 'UNKNOWN' });
  });

  it('URL smtp:// e smtps:// com credenciais (SES pela interface SMTP)', () => {
    expect(smtpPoolOptions({ url: 'smtp://localhost:1025' })).toMatchObject({
      pool: true,
      host: 'localhost',
      port: 1025,
      secure: false,
    });
    expect(smtpPoolOptions({ url: 'smtp://mail.test' }).port).toBe(25);
    expect(
      smtpPoolOptions({ url: 'smtps://AKIA%2Fx:s%40cret@email-smtp.sa-east-1.amazonaws.com' }),
    ).toMatchObject({
      host: 'email-smtp.sa-east-1.amazonaws.com',
      port: 465,
      secure: true,
      auth: { user: 'AKIA/x', pass: 's@cret' },
    });
  });
});
