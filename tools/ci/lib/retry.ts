// Retry com backoff exponencial e tempo limite por tentativa (US-079 — FA-04 · Gherkin "[Falha de
// integração]"): registry, scanner ou download instáveis ganham novas tentativas antes da falha
// definitiva, e nenhuma tentativa trava o pipeline indefinidamente. Só envolve comandos cujo código
// diferente de zero significa falha de infraestrutura (o gate de CVE, por exemplo, roda à parte).
import { spawn } from 'node:child_process';
import path from 'node:path';

import type { CiReporter } from './annotations.js';
import { quoteWindowsArg } from '../../lib/process.js';

export interface RetryOptions {
  /** Serviço contatado, para a mensagem ("Falha ao contatar {serviço}…"). */
  readonly service: string;
  readonly attempts: number;
  readonly initialDelayMs: number;
  readonly factor?: number;
  readonly maxDelayMs?: number;
  /** Tempo limite de cada tentativa; excedido, o processo é encerrado e conta como falha. */
  readonly attemptTimeoutMs?: number;
}

export interface AttemptResult {
  readonly status: number | null;
  readonly timedOut: boolean;
}

export type Attempt = (timeoutMs: number | undefined) => Promise<AttemptResult>;

export interface RetryOutcome {
  readonly ok: boolean;
  readonly attempts: number;
  readonly timedOut: boolean;
  readonly status: number | null;
}

/** Esperas entre as tentativas: `initial × factor^n`, limitadas a `maxDelayMs`. */
export function backoffSchedule(options: RetryOptions): number[] {
  const factor = options.factor ?? 2;
  const max = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  return Array.from({ length: Math.max(0, options.attempts - 1) }, (_, index) =>
    Math.min(max, Math.round(options.initialDelayMs * factor ** index)),
  );
}

export function retryMessage(service: string): string {
  return `Falha ao contatar ${service}. Tentando novamente.`;
}

export function finalFailureMessage(service: string, outcome: RetryOutcome, timeoutMs?: number) {
  if (outcome.timedOut && timeoutMs !== undefined) {
    return `Tempo limite de ${Math.round(timeoutMs / 1000)}s excedido ao contatar ${service} (${outcome.attempts} tentativas). Falha definitiva.`;
  }
  return `Falha ao contatar ${service} após ${outcome.attempts} tentativas. Falha definitiva.`;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry(
  attempt: Attempt,
  options: RetryOptions,
  reporter: CiReporter,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<RetryOutcome> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new RangeError('attempts deve ser um inteiro ≥ 1');
  }
  const delays = backoffSchedule(options);
  let last: AttemptResult = { status: null, timedOut: false };
  for (let index = 0; index < options.attempts; index += 1) {
    last = await attempt(options.attemptTimeoutMs);
    if (last.status === 0) {
      return { ok: true, attempts: index + 1, timedOut: false, status: 0 };
    }
    const delay = delays[index];
    if (delay !== undefined) {
      reporter.annotate('warning', retryMessage(options.service), {
        title: `Tentativa ${index + 1}/${options.attempts}`,
      });
      reporter.log('warn', 'ci.retry', retryMessage(options.service), {
        service: options.service,
        attempt: index + 1,
        attempts: options.attempts,
        nextDelaySeconds: Math.round(delay / 1000),
        timedOut: last.timedOut,
      });
      await sleep(delay);
    }
  }
  const outcome = {
    ok: false,
    attempts: options.attempts,
    timedOut: last.timedOut,
    status: last.status,
  };
  const message = finalFailureMessage(options.service, outcome, options.attemptTimeoutMs);
  reporter.annotate('error', message, { title: options.service });
  reporter.log('error', 'ci.stage_failed', message, { service: options.service });
  return outcome;
}

/**
 * Tentativa real: executa o comando herdando o terminal e o encerra no tempo limite. No Windows,
 * comandos do PATH (`pnpm`, `docker`) podem ser shims `.cmd` e passam pelo shell, como em
 * `lib/process.ts`; caminhos absolutos rodam direto.
 */
export function spawnAttempt(command: string, args: readonly string[]): Attempt {
  const viaShell = process.platform === 'win32' && !path.isAbsolute(command);
  return (timeoutMs) =>
    new Promise((resolve) => {
      const options = { stdio: 'inherit', windowsHide: true } as const;
      const child = viaShell
        ? spawn([command, ...args].map(quoteWindowsArg).join(' '), { ...options, shell: true })
        : spawn(command, args, options);
      let timedOut = false;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, timeoutMs);
      child.once('error', () => {
        if (timer) clearTimeout(timer);
        resolve({ status: null, timedOut });
      });
      child.once('close', (status) => {
        if (timer) clearTimeout(timer);
        resolve({ status: timedOut ? null : status, timedOut });
      });
    });
}
