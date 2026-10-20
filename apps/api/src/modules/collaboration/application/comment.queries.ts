import { COMMENT_LIMITS, COMMENT_MESSAGES } from '@contrataflow/validation';
import type {
  CommentDto,
  CommentListMetaDto,
  CommentListQuery,
  CommentThreadDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { validationError } from '#shared/errors/api-error.js';

import { CommentGate, CommentPresenter } from './comment.support.js';
import { COMMENT_CLOCK, COMMENT_REPOSITORY, COMMENT_TRANSACTIONS } from './ports.js';
import type {
  CommentClock,
  CommentCursor,
  CommentRepository,
  CommentTransactions,
} from './ports.js';
import { processAcceptsComments } from '../domain/comment.js';
import type { Comment } from '../domain/comment.js';

/*
 * `ListCommentsQuery` — CMT-01 (US-071 · RN-CMT-13/17 · FA-09/FA-10): `PROCESS_VIEW` pela
 * visibilidade do processo (DEC-024 — não visível = 404). Duas consultas por página (raízes
 * paginadas + respostas das raízes da página) evitam N+1; `?parentId=` pagina as respostas de uma
 * thread. Leitura: sem auditoria.
 */

/** Cursor opaco (base64url de `createdAt` + `id`). */
export function encodeCursor(comment: Pick<Comment, 'createdAt' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({ t: comment.createdAt.toISOString(), i: comment.id }),
    'utf8',
  ).toString('base64url');
}

const invalidCursor = () =>
  validationError([
    { field: 'cursor', code: 'INVALID_FORMAT', message: COMMENT_MESSAGES.invalidCursor },
  ]);

export function decodeCursor(cursor: string | undefined): CommentCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
    const { t, i } = parsed as { t?: unknown; i?: unknown };
    if (typeof t !== 'string' || typeof i !== 'string') throw invalidCursor();
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(i)) throw invalidCursor();
    return { createdAt, id: i };
  } catch {
    throw invalidCursor();
  }
}

export interface CommentList {
  readonly threads: CommentThreadDto[];
  readonly meta: CommentListMetaDto;
}

@Injectable()
export class ListCommentsQuery {
  constructor(
    @Inject(COMMENT_TRANSACTIONS) private readonly transactions: CommentTransactions,
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    @Inject(COMMENT_CLOCK) private readonly clock: CommentClock,
    private readonly gate: CommentGate,
    private readonly presenter: CommentPresenter,
  ) {}

  execute(processId: string, query: CommentListQuery): Promise<CommentList> {
    const after = decodeCursor(query.cursor);
    return this.transactions.read(async (tx) => {
      const process = await this.gate.visibleProcess(tx, processId);
      const viewer = await this.gate.viewer(process, this.clock());
      const meta = {
        canComment: viewer.canComment && processAcceptsComments(process.status),
        readOnly: !processAcceptsComments(process.status),
        isBudgetConfidential: process.isBudgetConfidential,
      };

      if (query.parentId !== undefined) {
        // FA-10: respostas de UMA thread (raiz do processo), em ordem crescente.
        const rows = await this.comments.listReplies(tx, query.parentId, {
          after,
          limit: query.limit + 1,
        });
        const page = rows.filter((row) => row.processId === processId).slice(0, query.limit);
        const dtos = await this.presenter.present(tx, page, viewer);
        return {
          threads: dtos.map((dto) => ({ ...dto, replies: [], replyCount: 0 })),
          meta: { ...meta, ...this.pageMeta(rows, page, query.limit) },
        };
      }

      const rows = await this.comments.listRoots(
        tx,
        processId,
        {
          targetType: query.targetType,
          documentId: query.documentId,
          sectionKey: query.sectionKey,
        },
        { after, limit: query.limit + 1 },
      );
      const roots = rows.slice(0, query.limit);
      const { replies, counts } = await this.comments.repliesOf(
        tx,
        roots.map((root) => root.id),
        COMMENT_LIMITS.repliesPerThread,
      );
      const dtos = await this.presenter.present(tx, [...roots, ...replies], viewer);
      const byId = new Map(dtos.map((dto) => [dto.id, dto]));
      const repliesByParent = new Map<string, CommentDto[]>();
      for (const reply of replies) {
        const dto = byId.get(reply.id);
        if (dto === undefined || reply.parentId === null) continue;
        repliesByParent.set(reply.parentId, [...(repliesByParent.get(reply.parentId) ?? []), dto]);
      }
      const threads = roots.flatMap((root) => {
        const dto = byId.get(root.id);
        return dto === undefined
          ? []
          : [
              {
                ...dto,
                replies: repliesByParent.get(root.id) ?? [],
                replyCount: counts.get(root.id) ?? 0,
              },
            ];
      });
      return { threads, meta: { ...meta, ...this.pageMeta(rows, roots, query.limit) } };
    });
  }

  private pageMeta(rows: readonly Comment[], page: readonly Comment[], limit: number) {
    const hasMore = rows.length > limit;
    const last = page.at(-1);
    return { hasMore, nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null };
  }
}
