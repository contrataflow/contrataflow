import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  CommentCursor,
  CommentListFilter,
  CommentRepository,
  CommentTransactions,
} from '../application/ports.js';
import type { Comment } from '../domain/comment.js';

const byCreated = (a: Comment, b: Comment) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

function isAfter(comment: Comment, after: CommentCursor | null, direction: 'desc' | 'asc') {
  if (after === null) return true;
  const delta =
    comment.createdAt.getTime() - after.createdAt.getTime() || comment.id.localeCompare(after.id);
  return direction === 'desc' ? delta < 0 : delta > 0;
}

/**
 * Comentários em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto (como o `app.tenant_id`), exclusão lógica
 * e concorrência otimista.
 */
@Injectable()
export class InMemoryCommentRepository implements CommentRepository {
  private readonly rows = new Map<string, Comment>();

  private inTenant(): Comment[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return [...this.rows.values()].filter((comment) => comment.tenantId === tenantId);
  }

  listRoots(
    _tx: TenantTx,
    processId: string,
    filter: CommentListFilter,
    page: { readonly after: CommentCursor | null; readonly limit: number },
  ): Promise<Comment[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((comment) => comment.processId === processId && comment.parentId === null)
        .filter((comment) => !filter.targetType || comment.targetType === filter.targetType)
        .filter((comment) => !filter.documentId || comment.documentId === filter.documentId)
        .filter((comment) => !filter.sectionKey || comment.sectionKey === filter.sectionKey)
        .filter((comment) => isAfter(comment, page.after, 'desc'))
        .sort((a, b) => byCreated(b, a))
        .slice(0, page.limit),
    );
  }

  repliesOf(
    _tx: TenantTx,
    parentIds: readonly string[],
    perParent: number,
  ): Promise<{ readonly replies: Comment[]; readonly counts: Map<string, number> }> {
    const wanted = new Set(parentIds);
    const all = this.inTenant()
      .filter((comment) => comment.parentId !== null && wanted.has(comment.parentId))
      .sort(byCreated);
    const counts = new Map<string, number>();
    const replies: Comment[] = [];
    for (const reply of all) {
      const parentId = reply.parentId ?? '';
      const count = (counts.get(parentId) ?? 0) + 1;
      counts.set(parentId, count);
      if (count <= perParent) replies.push(reply);
    }
    return Promise.resolve({ replies, counts });
  }

  listReplies(
    _tx: TenantTx,
    parentId: string,
    page: { readonly after: CommentCursor | null; readonly limit: number },
  ): Promise<Comment[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((comment) => comment.parentId === parentId)
        .filter((comment) => isAfter(comment, page.after, 'asc'))
        .sort(byCreated)
        .slice(0, page.limit),
    );
  }

  findById(_tx: TenantTx, id: string): Promise<Comment | null> {
    return Promise.resolve(this.inTenant().find((comment) => comment.id === id) ?? null);
  }

  insert(_tx: TenantTx, comment: Comment): Promise<void> {
    this.rows.set(comment.id, comment);
    return Promise.resolve();
  }

  save(_tx: TenantTx, comment: Comment, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((row) => row.id === comment.id);
    if (current?.version !== expectedVersion || current.deletedAt !== null) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'Comment',
          aggregateId: comment.id,
          expectedVersion,
        }),
      );
    }
    this.rows.set(comment.id, { ...comment, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  countReplies(_tx: TenantTx, parentId: string): Promise<number> {
    return Promise.resolve(
      this.inTenant().filter((row) => row.parentId === parentId && row.deletedAt === null).length,
    );
  }

  excerpts(
    _tx: TenantTx,
    ids: readonly string[],
  ): Promise<
    Map<
      string,
      { readonly bodyText: string; readonly documentId: string | null; readonly isDeleted: boolean }
    >
  > {
    const wanted = new Set(ids);
    return Promise.resolve(
      new Map(
        this.inTenant()
          .filter((row) => wanted.has(row.id))
          .map((row) => [
            row.id,
            {
              bodyText: row.bodyText,
              documentId: row.documentId,
              isDeleted: row.deletedAt !== null,
            },
          ]),
      ),
    );
  }

  /** Inspeção de testes: todos os comentários (de todos os tenants). */
  snapshot(): readonly Comment[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (comentário pronto — ex.: de outro tenant ou criado há 16 minutos). */
  seed(...comments: readonly Comment[]): void {
    for (const comment of comments) this.rows.set(comment.id, comment);
  }
}

/** Transações simuladas: um `tx` sentinela ativo só durante o trabalho, uma de cada vez. */
@Injectable()
export class InMemoryCommentTransactions implements CommentTransactions {
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
