import type { CommentTargetType } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

import type { Comment } from '../domain/comment.js';

/*
 * Portas da aplicação dos comentários (US-071): implementadas em `infrastructure/` (Prisma) e em
 * memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

/** Filtros de CMT-01 (FA-09). */
export interface CommentListFilter {
  readonly targetType?: CommentTargetType | undefined;
  readonly documentId?: string | undefined;
  readonly sectionKey?: string | undefined;
}

/** Posição do cursor: (`createdAt`, `id`) — decrescente nas raízes, crescente nas respostas. */
export interface CommentCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface CommentRepository {
  /**
   * Raízes do processo (`parentId` nulo, inclusive excluídas — a thread continua) por
   * (`createdAt`, `id`) decrescente, depois do cursor; `limit + 1` para saber se há mais.
   */
  listRoots(
    tx: TenantTx,
    processId: string,
    filter: CommentListFilter,
    page: { readonly after: CommentCursor | null; readonly limit: number },
  ): Promise<Comment[]>;
  /**
   * Respostas das raízes (uma consulta para a página inteira — sem N+1): as primeiras `perParent`
   * de cada pai em ordem crescente e o total por pai.
   */
  repliesOf(
    tx: TenantTx,
    parentIds: readonly string[],
    perParent: number,
  ): Promise<{ readonly replies: Comment[]; readonly counts: Map<string, number> }>;
  /** Respostas de UM pai, crescente, depois do cursor (FA-10 · `?parentId=`). */
  listReplies(
    tx: TenantTx,
    parentId: string,
    page: { readonly after: CommentCursor | null; readonly limit: number },
  ): Promise<Comment[]>;
  /** Inclusive excluído (a API decide 409/412); `null` = inexistente ou de outro tenant (RLS). */
  findById(tx: TenantTx, id: string): Promise<Comment | null>;
  insert(tx: TenantTx, comment: Comment): Promise<void>;
  /**
   * Grava o próximo estado (`version = expectedVersion + 1`) condicionado à versão e a não estar
   * excluído (DEC-055). @throws VersionConflictError
   */
  save(tx: TenantTx, comment: Comment, expectedVersion: number): Promise<void>;
  /** Respostas não excluídas do comentário (auditoria `hadReplies`). */
  countReplies(tx: TenantTx, parentId: string): Promise<number>;
  /** Texto puro, alvo e exclusão (timeline: trecho congelado e supressão — RN-CMT-15). */
  excerpts(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<
    Map<
      string,
      {
        readonly bodyText: string;
        readonly documentId: string | null;
        readonly isDeleted: boolean;
      }
    >
  >;
}

export const COMMENT_REPOSITORY = Symbol('CommentRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface CommentTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const COMMENT_TRANSACTIONS = Symbol('CommentTransactions');

export type CommentClock = () => Date;

export const COMMENT_CLOCK = Symbol('CommentClock');
