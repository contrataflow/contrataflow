import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { AttachmentRepository, FilesTransactions } from '../application/files-ports.js';
import type { Attachment } from '../domain/attachment.js';
import { canTransition } from '../domain/attachment.js';

/**
 * Anexos em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`), gravação
 * condicional por versão e a máquina de estados do gatilho `attachments_guard`.
 */
@Injectable()
export class InMemoryAttachmentRepository implements AttachmentRepository {
  readonly rows = new Map<string, Attachment>();
  /** Simula o banco fora do ar (Gherkin "[Falha de banco]"). */
  failing: Error | null = null;

  private check(): void {
    if (this.failing) throw this.failing;
  }

  private inTenant(): Attachment[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  insert(_tx: TenantTx, attachment: Attachment): Promise<void> {
    this.check();
    this.rows.set(attachment.id, attachment);
    return Promise.resolve();
  }

  findById(_tx: TenantTx, id: string): Promise<Attachment | null> {
    this.check();
    return Promise.resolve(this.inTenant().find((row) => row.id === id) ?? null);
  }

  findByIds(_tx: TenantTx, ids: readonly string[]): Promise<Attachment[]> {
    this.check();
    return Promise.resolve(this.inTenant().filter((row) => ids.includes(row.id)));
  }

  update(_tx: TenantTx, next: Attachment, expectedVersion: number): Promise<boolean> {
    this.check();
    const current = this.inTenant().find((row) => row.id === next.id);
    if (current?.version !== expectedVersion) return Promise.resolve(false);
    if (current.status !== next.status && !canTransition(current.status, next.status)) {
      return Promise.reject(new Error(`attachments_guard: ${current.status} → ${next.status}`));
    }
    this.rows.set(next.id, next);
    return Promise.resolve(true);
  }

  usedBytes(): Promise<number> {
    this.check();
    return Promise.resolve(
      this.inTenant()
        .filter((row) => ['UPLOADED', 'SCANNING', 'AVAILABLE', 'DELETED'].includes(row.status))
        .reduce((total, row) => total + row.sizeBytes, 0),
    );
  }
}

/** Transações simuladas: escritas em fila (uma de cada vez), como o bloqueio de linha. */
@Injectable()
export class InMemoryFilesTransactions implements FilesTransactions {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
