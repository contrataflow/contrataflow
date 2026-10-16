import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { ProcessRuntimeReader, ProcessTransactions } from '../application/ports.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

/**
 * Leitor de produção ATÉ a US-001: as tabelas `processes`/`process_stages`/`process_access` ainda
 * não existem, então nenhum processo existe e PRC-08/PRC-09 respondem 404. A US-001 o substitui
 * pelo leitor Prisma (uma consulta: processo + passagens + concessões, sob a RLS do tenant).
 */
@Injectable()
export class PendingProcessRuntimeReader implements ProcessRuntimeReader {
  load(_tx: TenantTx, _processId: string): Promise<ProcessRuntime | null> {
    return Promise.resolve(null);
  }
}

/**
 * Runtime de processos em memória (testes e modo de identidade fake): isolado pelo tenant do
 * contexto (outro tenant = `null`, como a RLS) e devolvido como CÓPIA — cada leitura é um snapshot
 * que uma tramitação concorrente (`save`) não altera depois de lido.
 */
@Injectable()
export class InMemoryProcessRuntimeStore implements ProcessRuntimeReader {
  private readonly runtimes = new Map<string, ProcessRuntime>();
  private loads = 0;

  load(_tx: TenantTx, processId: string): Promise<ProcessRuntime | null> {
    this.loads += 1;
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const runtime = this.runtimes.get(processId);
    const owned = runtime?.tenantId === tenantId ? runtime : undefined;
    return Promise.resolve(owned === undefined ? null : structuredClone(owned));
  }

  // --- Carga e inspeção (testes) ---------------------------------------------------------------

  save(runtime: ProcessRuntime): void {
    this.runtimes.set(runtime.id, structuredClone(runtime));
  }

  clear(): void {
    this.runtimes.clear();
    this.loads = 0;
  }

  /** Quantas leituras do runtime houve (uma por consulta — snapshot único). */
  loadCount(): number {
    return this.loads;
  }
}

@Injectable()
export class PrismaProcessTransactions implements ProcessTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

@Injectable()
export class InMemoryProcessTransactions implements ProcessTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
