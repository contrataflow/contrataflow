import { withSpan } from '@contrataflow/observability';
import { Logger } from '@nestjs/common';

import { requireRequestContext } from '../context/request-context.js';
import type { TenantTx } from '../database/prisma.js';
import { ApiError } from '../errors/api-error.js';

/*
 * Padrão de comando transacional (US-001 · DEC-161 · RN-FND-49/52/53) — base dos casos de uso que
 * mudam estado de negócio. Uma execução é:
 *
 *   1. `prepare(input)` — FORA da transação: leituras de configuração e pré-condições baratas
 *      (nada de escrita; pode recusar cedo).
 *   2. `handle(tx, input, prepared)` — DENTRO de UMA transação do tenant (`TenantTransaction.run`,
 *      `app.tenant_id` definido, `READ COMMITTED`), nesta ordem:
 *        validação de referências → autorização por escopo → domínio (fábricas puras) →
 *        repositórios (INSERT/UPDATE versionado) → `audit.record(tx, …)` →
 *        `outbox.record(tx, Evento.of(…))` (dispara no mesmo `tx` as projeções síncronas
 *        `TimelineProjector`/`ProcessAccessProjector`) → commit.
 *      Qualquer erro desfaz TUDO — agregado, projeções, auditoria, outbox e incrementos de
 *      sequência (RN-PROC-15). Deadlock/serialização refazem a transação inteira (até 2 vezes):
 *      nada com efeito externo dentro de `handle`.
 *   3. `committed(result, durationMs)` — depois do commit: logs de negócio e métricas.
 *
 * A base mede a duração, abre o span `<command>.transaction` e registra `<command>_failed`
 * (`error`) nas falhas inesperadas (banco fora, erro de programação) — nunca nos erros de regra
 * (4xx), que já são a resposta. Nada de dado sensível nos logs: só código, correlação e duração.
 */

/** Transações de escrita do módulo (Prisma `TenantTransaction` ou simulada em memória). */
export interface CommandTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

/** Código registrado no log de falha: o do `ApiError` ou `INTERNAL_ERROR`. */
export function failureCodeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
}

/** Falha que merece `error` no log (indisponibilidade ou erro inesperado — nunca regra de negócio). */
export function isUnexpectedFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500;
}

export abstract class TransactionalCommandHandler<I, P, O> {
  protected readonly logger: Logger;

  /** @param commandName nome estável do comando (`process.create`): span e log `<nome>_failed`. */
  protected constructor(
    protected readonly commandName: string,
    private readonly commandTransactions: CommandTransactions,
  ) {
    this.logger = new Logger(commandName);
  }

  async execute(input: I): Promise<O> {
    const startedAt = performance.now();
    try {
      const prepared = await this.prepare(input);
      const result = await withSpan(`${this.commandName}.transaction`, {}, () =>
        this.commandTransactions.run((tx) => this.handle(tx, input, prepared)),
      );
      this.committed(result, Math.round(performance.now() - startedAt));
      return result;
    } catch (error) {
      this.failed(error, Math.round(performance.now() - startedAt));
      throw error;
    }
  }

  /** Passo 1 — fora da transação (padrão: nada a preparar). */
  protected abstract prepare(input: I): Promise<P>;

  /** Passo 2 — o trabalho atômico do comando, no `tx` do tenant. */
  protected abstract handle(tx: TenantTx, input: I, prepared: P): Promise<O>;

  /** Passo 3 — depois do commit (padrão: nada). */
  protected committed(_result: O, _durationMs: number): void {
    // Sem efeito por padrão.
  }

  private failed(error: unknown, durationMs: number): void {
    if (!isUnexpectedFailure(error)) return;
    const event = `${this.commandName}_failed`;
    this.logger.error(
      {
        event,
        errorCode: failureCodeOf(error),
        cause: error instanceof Error ? error.name : 'unknown',
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      event,
    );
  }
}
