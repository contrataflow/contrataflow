import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { ClamavClient, UnconfiguredAntivirus, parseClamavReply } from './clamav.client.js';
import { FakeAntivirus } from './fake-antivirus.js';
import { AntivirusUnavailableError } from '../application/files-ports.js';

/*
 * Protocolo INSTREAM do `clamd` (storage.md §5.3) contra um servidor TCP que o imita: lê
 * `zINSTREAM\0` e os pedaços `<uint32 BE><bytes>` até o pedaço vazio, e responde conforme o
 * conteúdo recebido. O ClamAV real fica na integração (Testcontainers).
 */

type Reply = (received: Buffer) => string | null;

let server: Server | null = null;

async function fakeClamd(reply: Reply): Promise<{ port: number; commands: string[] }> {
  const commands: string[] = [];
  server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const body: Buffer[] = [];
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        command = buffer.toString('latin1', 0, end);
        commands.push(command);
        buffer = buffer.subarray(end + 1);
        if (command === 'zVERSION') {
          socket.end('ClamAV 1.4.1/27400/Fri Oct 17 2026\0');
          return;
        }
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const answer = reply(Buffer.concat(body));
          if (answer === null) socket.destroy();
          else socket.end(`${answer}\0`);
          return;
        }
        if (buffer.length < 4 + size) return;
        body.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, commands };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === null) resolve();
    else
      server.close(() => {
        resolve();
      });
  });
  server = null;
});

const client = (port: number, timeoutMs = 2_000) =>
  new ClamavClient({ host: '127.0.0.1', port, timeoutMs });

describe('ClamavClient (INSTREAM)', () => {
  it('envia o stream em pedaços e entende OK; o conteúdo chega inteiro', async () => {
    let received: Buffer = Buffer.alloc(0);
    const { port, commands } = await fakeClamd((bytes) => {
      received = bytes;
      return 'stream: OK';
    });
    const payload = Buffer.alloc(200 * 1024, 7);
    await expect(client(port).scan(Readable.from([payload]))).resolves.toEqual({ clean: true });
    expect(commands).toEqual(['zINSTREAM']);
    expect(received.equals(payload)).toBe(true);
  });

  it('FOUND → assinatura; limite de tamanho → heurística de limite', async () => {
    const { port } = await fakeClamd((bytes) =>
      bytes.toString('latin1').includes('EICAR')
        ? 'stream: Eicar-Test-Signature FOUND'
        : 'INSTREAM size limit exceeded. ERROR',
    );
    await expect(client(port).scan(Readable.from([Buffer.from('xEICARx')]))).resolves.toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
    await expect(client(port).scan(Readable.from([Buffer.from('grande')]))).resolves.toEqual({
      clean: false,
      signature: 'Heuristics.Limits.Exceeded.StreamMaxLength',
    });
  });

  it('conexão recusada, conexão derrubada ou ERROR do motor → AntivirusUnavailableError', async () => {
    const { port } = await fakeClamd(() => null);
    await expect(client(port).scan(Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(
      AntivirusUnavailableError,
    );
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    server = null;
    await expect(client(port).scan(Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(
      AntivirusUnavailableError,
    );
    const { port: other } = await fakeClamd(() => 'lstat() failed. ERROR');
    await expect(client(other).scan(Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(
      AntivirusUnavailableError,
    );
  });

  it('erro do stream de entrada propaga como está (inspeção de tipo abortou)', async () => {
    const { port } = await fakeClamd(() => 'stream: OK');
    const failure = new Error('abortado pela inspeção');
    const stream = new Readable({
      read() {
        this.destroy(failure);
      },
    });
    await expect(client(port).scan(stream)).rejects.toBe(failure);
  });

  it('VERSION devolve motor e base; indisponível → null', async () => {
    const { port } = await fakeClamd(() => 'stream: OK');
    await expect(client(port).version()).resolves.toBe('ClamAV 1.4.1/27400/Fri Oct 17 2026');
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    server = null;
    await expect(client(port).version()).resolves.toBeNull();
  });

  it('parseClamavReply', () => {
    expect(parseClamavReply('stream: OK\0')).toEqual({ clean: true });
    expect(parseClamavReply('stream: Win.Test FOUND\0')).toEqual({
      clean: false,
      signature: 'Win.Test',
    });
    expect(parseClamavReply('algo estranho')).toBe('ERROR');
  });
});

describe('antivírus sem configuração e de teste', () => {
  it('sem CLAMAV_HOST toda varredura fica adiada (P3)', async () => {
    const none = new UnconfiguredAntivirus();
    await expect(none.scan(Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(
      AntivirusUnavailableError,
    );
    await expect(none.version()).resolves.toBeNull();
  });

  it('FakeAntivirus acusa EICAR e simula indisponibilidade', async () => {
    const fake = new FakeAntivirus();
    const marker = ['EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE'].join('-');
    await expect(fake.scan(Readable.from([Buffer.from(marker)]))).resolves.toMatchObject({
      clean: false,
    });
    fake.failing = true;
    await expect(fake.scan(Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(
      AntivirusUnavailableError,
    );
  });
});
