import type { TenantTx } from '#shared/database/prisma.js';

import type { ProcessRuntime } from '../domain/process-runtime.js';

/*
 * Portas da aplicação do módulo `process` (US-041). O agregado `Process` e as tabelas
 * `processes`/`process_stages`/`process_access` nascem com a US-001: até lá o leitor de produção é
 * `PendingProcessRuntimeReader` (nenhum processo existe → 404) e os testes usam o
 * `InMemoryProcessRuntimeStore`. A US-001 troca o adaptador sem mudar quem chama.
 */

export interface ProcessRuntimeReader {
  /**
   * O runtime do processo NUM ÚNICO snapshot (processo + passagens + aprovações + documentos +
   * acessos lidos de uma vez, sob `READ COMMITTED` — nunca a etapa de antes misturada com a de
   * depois de uma tramitação concorrente). `null` = inexistente no tenant da transação (RLS),
   * descartado (`deletedAt`) ou de outro tenant.
   */
  load(tx: TenantTx, processId: string): Promise<ProcessRuntime | null>;
}

export const PROCESS_RUNTIME_READER = Symbol('ProcessRuntimeReader');

/** Leituras do módulo: Prisma (`TenantTransaction.read`) ou simulada em memória. */
export interface ProcessTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const PROCESS_TRANSACTIONS = Symbol('ProcessTransactions');
