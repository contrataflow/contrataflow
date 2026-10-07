import type { LoggerService } from '@nestjs/common';

/** Sinais que iniciam o encerramento limpo (ECS envia SIGTERM; terminal envia SIGINT). */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface Closable {
  close(): Promise<void>;
}

/** Subconjunto de `process` usado no encerramento (substituível nos testes). */
export interface ShutdownProcess {
  once(event: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): void;
  exitCode?: number | string | null | undefined;
}

export interface GracefulShutdownOptions {
  /** Prefixo dos eventos de log (`api.stopping`, `api.stopped`…). */
  readonly name: string;
  readonly logger: Pick<LoggerService, 'log' | 'error'>;
  readonly proc?: ShutdownProcess;
  /** Prazo para concluir o encerramento antes de forçar a saída com código 1. */
  readonly timeoutMs?: number;
}

/**
 * Encerra a aplicação ao receber SIGTERM/SIGINT e deixa o processo terminar com código 0.
 * Não usa `enableShutdownHooks()` do Nest, que reenvia o sinal ao processo e o
 * encerra pelo sinal (código 143) em vez de código 0.
 * @returns promessa resolvida com o sinal recebido, após o encerramento.
 */
export function registerGracefulShutdown(
  target: Closable,
  { name, logger, proc = process, timeoutMs = 10_000 }: GracefulShutdownOptions,
): Promise<ShutdownSignal> {
  return new Promise((resolve) => {
    let closing = false;

    const shutdown = (signal: ShutdownSignal): void => {
      if (closing) return;
      closing = true;
      logger.log(`${name}.stopping signal=${signal}`);

      const timer = setTimeout(() => {
        logger.error(`${name}.shutdown_timeout timeoutMs=${timeoutMs}`);
        proc.exit(1);
      }, timeoutMs);
      timer.unref();

      target.close().then(
        () => {
          clearTimeout(timer);
          proc.exitCode = 0;
          logger.log(`${name}.stopped`);
          resolve(signal);
        },
        (error: unknown) => {
          clearTimeout(timer);
          proc.exitCode = 1;
          logger.error(
            `${name}.shutdown_failed`,
            error instanceof Error ? error.stack : String(error),
          );
          resolve(signal);
        },
      );
    };

    for (const signal of SHUTDOWN_SIGNALS) {
      proc.once(signal, () => {
        shutdown(signal);
      });
    }
  });
}
