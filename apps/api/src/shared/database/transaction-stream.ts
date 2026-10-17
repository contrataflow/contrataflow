import { AsyncLocalStorage } from 'node:async_hooks';

import type { TenantTx } from './prisma.js';

/*
 * Leitura por cursor numa transação aberta enquanto o arquivo é enviado (US-003 · RN-PROC-45 —
 * padrão de exportação em *streaming*): a transação interativa só termina quando o trabalho
 * devolve, então o trabalho espera o PEDIDO do próximo lote (`pull`) do consumidor — o socket que
 * drena a resposta. Backpressure ponta a ponta: nada além de um lote fica em memória. O consumidor
 * que para no meio (cliente desconectou) manda `stop`: o trabalho devolve e a transação de leitura
 * é encerrada; erro do banco no meio chega ao consumidor como exceção do gerador.
 */

interface Mailbox<T> {
  put(value: T): void;
  take(): Promise<T>;
}

function mailbox<T>(): Mailbox<T> {
  const queued: T[] = [];
  let waiting: ((value: T) => void) | null = null;
  return {
    put(value) {
      if (waiting === null) {
        queued.push(value);
        return;
      }
      const resolve = waiting;
      waiting = null;
      resolve(value);
    },
    take() {
      if (queued.length > 0) return Promise.resolve(queued.shift() as T);
      return new Promise<T>((resolve) => {
        waiting = resolve;
      });
    },
  };
}

type Supply<T> =
  | { readonly kind: 'batch'; readonly rows: readonly T[] }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: unknown };

export interface CursorReader<T> {
  /** Prepara o cursor (ex.: `DECLARE … CURSOR`) na transação, antes do primeiro lote. */
  open(tx: TenantTx): Promise<void>;
  /** Próximo lote; vazio = fim. */
  next(tx: TenantTx): Promise<readonly T[]>;
}

/**
 * Lotes de `reader` lidos dentro de UMA transação aberta por `run` (ex.: `TenantTransaction.longRead`)
 * e entregues um a um, sob demanda. O gerador só termina depois de a transação terminar.
 */
export async function* pullInTransaction<T>(
  run: (work: (tx: TenantTx) => Promise<void>) => Promise<void>,
  reader: CursorReader<T>,
): AsyncGenerator<readonly T[]> {
  const demand = mailbox<'pull' | 'stop'>();
  const supply = mailbox<Supply<T>>();
  const finished = run(async (tx) => {
    let opened = false;
    for (;;) {
      if ((await demand.take()) === 'stop') return;
      if (!opened) {
        await reader.open(tx);
        opened = true;
      }
      const rows = await reader.next(tx);
      if (rows.length === 0) {
        supply.put({ kind: 'done' });
        return;
      }
      supply.put({ kind: 'batch', rows });
    }
  }).catch((error: unknown) => {
    supply.put({ kind: 'error', error });
  });
  try {
    for (;;) {
      demand.put('pull');
      const message = await supply.take();
      if (message.kind === 'error') throw message.error;
      if (message.kind === 'done') break;
      yield message.rows;
    }
  } finally {
    demand.put('stop');
    await finished;
  }
}

/**
 * O gerador é consumido DEPOIS de o handler devolver, conforme o socket drena: cada passo roda no
 * contexto da requisição capturado aqui (tenant da transação, ator, `correlationId`).
 */
export function inCurrentContext<T>(source: AsyncGenerator<T>): AsyncIterable<T> {
  const run = AsyncLocalStorage.snapshot();
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => run(() => source.next()),
      return: (value?: T) => run(() => source.return(value as T)),
      throw: (error?: unknown) => run(() => source.throw(error)),
    }),
  };
}
