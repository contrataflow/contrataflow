import { Socket } from 'node:net';
import type { Readable } from 'node:stream';

import { AntivirusUnavailableError } from '../application/files-ports.js';
import type { AntivirusPort } from '../application/files-ports.js';
import type { AntivirusResult } from '../domain/scan-verdict.js';

/*
 * Cliente do `clamd` pelo protocolo INSTREAM (US-068 · storage.md §5.3 — TCP 3310): `zINSTREAM\0`
 * e pedaços `<tamanho uint32 BE><bytes>` terminados por um pedaço de tamanho zero; a resposta é
 * `stream: OK`, `stream: <assinatura> FOUND` ou `… ERROR`. Sem dependência externa — o protocolo é
 * pequeno e estável. Conexão recusada, *timeout* ou `ERROR` do motor → `AntivirusUnavailableError`
 * (o job pausa, nunca libera — RN-DOC-75); erro do stream de ENTRADA propaga como está.
 */

export interface ClamavOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

/** Tamanho de cada pedaço enviado (bem abaixo do `StreamMaxLength`). */
const CHUNK = 64 * 1024;

/** `INSTREAM size limit exceeded`: arquivo além do `StreamMaxLength` nunca é "limpo por omissão". */
const LIMIT_SIGNATURE = 'Heuristics.Limits.Exceeded.StreamMaxLength';

export function parseClamavReply(reply: string): AntivirusResult | 'ERROR' {
  const text = reply.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(text)) return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found?.[1]) return { clean: false, signature: found[1] };
  if (/size limit exceeded/i.test(text)) return { clean: false, signature: LIMIT_SIGNATURE };
  return 'ERROR';
}

export class ClamavClient implements AntivirusPort {
  readonly engine = 'clamav';

  constructor(private readonly options: ClamavOptions) {}

  scan(stream: Readable): Promise<AntivirusResult> {
    return new Promise<AntivirusResult>((resolve, reject) => {
      const socket = new Socket();
      const replies: Buffer[] = [];
      let settled = false;
      const finish = (outcome: { result?: AntivirusResult; error?: unknown }) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (outcome.error !== undefined) {
          stream.unpipe();
          reject(
            outcome.error instanceof Error ? outcome.error : new Error('clamd: falha desconhecida'),
          );
          return;
        }
        resolve(outcome.result ?? { clean: true });
      };
      const unavailable = (cause: unknown) => {
        finish({ error: new AntivirusUnavailableError({ cause }) });
      };

      socket.setTimeout(this.options.timeoutMs, () => {
        unavailable(new Error('timeout'));
      });
      socket.on('error', unavailable);
      socket.on('data', (data: Buffer) => replies.push(data));
      socket.on('end', () => {
        const parsed = parseClamavReply(Buffer.concat(replies).toString('utf8'));
        if (parsed === 'ERROR') unavailable(new Error('clamd ERROR'));
        else finish({ result: parsed });
      });
      stream.on('error', (error) => {
        finish({ error });
      });

      socket.connect(this.options.port, this.options.host, () => {
        socket.write('zINSTREAM\0');
        void this.pump(stream, socket).then(
          () => socket.write(Buffer.alloc(4)),
          (error: unknown) => {
            finish({ error });
          },
        );
      });
    });
  }

  /** Envia o stream em pedaços com o prefixo de tamanho, respeitando o *backpressure*. */
  private async pump(stream: Readable, socket: Socket): Promise<void> {
    for await (const piece of stream) {
      const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
      for (let offset = 0; offset < buffer.length; offset += CHUNK) {
        const part = buffer.subarray(offset, offset + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        if (!socket.write(Buffer.concat([size, part]))) {
          await new Promise<void>((resolve) => socket.once('drain', resolve));
        }
        if (socket.destroyed) return;
      }
    }
  }

  /** Motor e base de assinaturas (`zVERSION`): `ClamAV 1.4.1/27400/Mon Oct 13 …`. */
  version(): Promise<string | null> {
    return new Promise((resolve) => {
      const socket = new Socket();
      const replies: Buffer[] = [];
      socket.setTimeout(this.options.timeoutMs, () => {
        socket.destroy();
        resolve(null);
      });
      socket.on('error', () => {
        resolve(null);
      });
      socket.on('data', (data: Buffer) => replies.push(data));
      socket.on('end', () => {
        const text = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
        resolve(text.slice(0, 200) || null);
      });
      socket.connect(this.options.port, this.options.host, () => socket.write('zVERSION\0'));
    });
  }
}

/** Sem `CLAMAV_HOST`: toda varredura fica adiada (P3 — nunca libera sem antivírus). */
export class UnconfiguredAntivirus implements AntivirusPort {
  readonly engine = 'none';

  scan(stream: Readable): Promise<AntivirusResult> {
    stream.resume();
    return Promise.reject(new AntivirusUnavailableError());
  }

  version(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
