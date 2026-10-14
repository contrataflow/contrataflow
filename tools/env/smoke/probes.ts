// Sondas do smoke da US-078: e-mail pelo Mailpit (SMTP real), PDF pelo Gotenberg e varredura pelo
// ClamAV (INSTREAM). Sem dependências: só `node:net` e `fetch`.
import { createHash } from 'node:crypto';
import { connect } from 'node:net';

import type { FetchLike } from './oidc.js';

/**
 * Arquivo de teste EICAR montado em tempo de execução — nunca versionado em claro, para o
 * antivírus da estação não colocar arquivos do repositório em quarentena (storage.md §11).
 */
export function eicarTestFile(): Buffer {
  const encoded = [
    'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0ND',
    'KTd9JEVJQ0FSLVNUQU5EQVJELUFOVElW',
    'SVJVUy1URVNULUZJTEUhJEgrSCo=',
  ];
  return Buffer.from(encoded.join(''), 'base64');
}

/** SHA-256 publicado do arquivo EICAR de 68 bytes. */
export const EICAR_SHA256 = '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f';

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Varre `data` no clamd (protocolo INSTREAM) e devolve a resposta (`stream: OK` / `… FOUND`). */
export function clamavScan(host: string, port: number, data: Buffer, timeoutMs = 30_000) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    let response = '';
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error('ClamAV não respondeu no tempo limite'));
    });
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
    });
    socket.once('close', () => {
      resolve(response.replace(/\0/g, '').trim());
    });
    socket.once('connect', () => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(data.length);
      socket.write(Buffer.concat([Buffer.from('zINSTREAM\0'), size, data, Buffer.alloc(4)]));
    });
  });
}

/** Envia um e-mail por SMTP (sem TLS — só para o Mailpit local). */
export function sendSmtp(
  host: string,
  port: number,
  message: { from: string; to: string; subject: string; text: string },
  timeoutMs = 15_000,
) {
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const date = new Date().toUTCString();
    const commands = [
      'EHLO smoke.contrataflow.test',
      `MAIL FROM:<${message.from}>`,
      `RCPT TO:<${message.to}>`,
      'DATA',
      [
        `From: ${message.from}`,
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        `Date: ${date}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        message.text,
        '.',
      ].join('\r\n'),
      'QUIT',
    ];
    let buffer = '';
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error('SMTP sem resposta no tempo limite'));
    });
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // Resposta completa: última linha "NNN texto" (sem hífen de continuação).
      const lines = buffer.split('\r\n').filter((line) => line !== '');
      const last = lines.at(-1) ?? '';
      if (!/^\d{3} /.test(last)) return;
      buffer = '';
      const code = Number(last.slice(0, 3));
      if (code >= 400) {
        socket.destroy(new Error(`SMTP respondeu ${last}`));
        return;
      }
      const next = commands.shift();
      if (next === undefined) {
        socket.end();
        resolve();
      } else {
        socket.write(`${next}\r\n`);
      }
    });
  });
}

/** Procura no Mailpit uma mensagem com o assunto exato (com espera curta pela entrega). */
export async function mailpitHasMessage(
  baseUrl: string,
  subject: string,
  fetchImpl: FetchLike = fetch,
  attempts = 10,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
    );
    if (response.ok) {
      const body = (await response.json()) as { messages_count?: number };
      if ((body.messages_count ?? 0) > 0) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** Converte HTML em PDF no Gotenberg (rota Chromium) e devolve os bytes. */
export async function gotenbergPdf(
  baseUrl: string,
  html: string,
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const response = await fetchImpl(`${baseUrl}/forms/chromium/convert/html`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) throw new Error(`Gotenberg respondeu HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
