import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { ProcessRuntimeReader, ProcessTransactions } from '../application/ports.js';
import { ProcessRuntimeLoader } from '../application/process-runtime.loader.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

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

/**
 * Leitor do modo em memória: o runtime carregado nos testes (`InMemoryProcessRuntimeStore.save`)
 * ou, se não houver, o dos processos criados pelo PRC-02 (repositório em memória — US-001).
 */
@Injectable()
export class InMemoryProcessRuntimeReader implements ProcessRuntimeReader {
  constructor(
    private readonly store: InMemoryProcessRuntimeStore,
    private readonly loader: ProcessRuntimeLoader,
  ) {}

  async load(tx: TenantTx, processId: string): Promise<ProcessRuntime | null> {
    return (await this.store.load(tx, processId)) ?? this.loader.load(tx, processId);
  }
}

@Injectable()
export class InMemoryProcessTransactions implements ProcessTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  longRead<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
