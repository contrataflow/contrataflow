import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { SESSION_REGISTRY } from '#shared/sessions/session-registry.js';
import type { SessionRegistryPort } from '#shared/sessions/session-registry.js';

import { RecordSessionEndingsCommand } from '../application/record-session-endings.command.js';

/** Cadência da varredura de sessões (a cada 1 min — authentication.md §7 · RN-IAM-28). */
export const SESSION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Agenda o `RecordSessionEndingsCommand` no processo da API: a cada 60 s, sem sobrepor execuções.
 * Só liga com o Redis de sessões configurado. Várias réplicas podem agendá-lo: a trava do Redis
 * deixa uma por ciclo. Vai para os agendadores do worker quando a US-083 existir (DEC-071), como
 * o job de partições da auditoria.
 */
@Injectable()
export class SessionSweepScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SessionSweep');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly command: RecordSessionEndingsCommand,
    @Inject(SESSION_REGISTRY) private readonly registry: SessionRegistryPort,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.registry.enabled) return;
    // O primeiro ciclo é daqui a 60 s: a conexão com o Redis de sessões abre em segundo plano.
    this.timer = setInterval(() => void this.tick(), SESSION_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Um ciclo da varredura; ignorado se o anterior ainda não terminou. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.command.run();
    } catch (error) {
      // O comando não lança por falha do Redis ou da auditoria; isto é só a rede de segurança de
      // um erro inesperado, que nunca pode derrubar o processo da API (promessa rejeitada solta).
      this.logger.error(
        {
          event: 'auth.session_sweep_failed',
          reason: error instanceof Error ? error.name : 'unknown',
        },
        'auth.session_sweep_failed',
      );
    } finally {
      this.running = false;
    }
  }
}
