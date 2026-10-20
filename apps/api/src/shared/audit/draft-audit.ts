/*
 * Coalescência da auditoria de rascunho (US-015 · RN-DFD-35 · events.md §7 `document.draft_update`):
 * no máximo 1 registro por (documento, alvo, usuário) a cada 10 min. A janela é aberta no Redis
 * ANTES da transação (`SET NX PX`) — a transação nunca tem efeito externo e um refazer por deadlock
 * não reabre a janela. Cada registro informa a faixa de revisões desde o último auditado
 * (`fromRevision`..`toRevision`). Redis indisponível → audita toda gravação (fail-safe) e loga
 * `warn audit.coalesce_store_unavailable`. Porta do shared kernel: o módulo `audit` implementa o
 * coalescedor, a `platform` o armazenamento Redis (único lugar com cliente Redis — RM-03).
 */

/** Alvo da gravação coalescida. */
export interface DraftAuditTarget {
  readonly tenantId: string;
  readonly documentId: string;
  /** `SECTION:<CHAVE>`, `HEADER` ou `ITEMS`. */
  readonly target: string;
  readonly userId: string;
}

/** Decisão tomada antes da transação para uma gravação. */
export interface DraftAuditTicket {
  readonly key: string;
  /** `true`: esta gravação abre a janela e é auditada. */
  readonly record: boolean;
  /** `true`: esta gravação abriu a janela no armazenamento (desfeita se a gravação falhar). */
  readonly opened: boolean;
  /** Última revisão já auditada do usuário/alvo (`null` = nenhuma conhecida). */
  readonly lastAuditedRevision: number | null;
}

export interface DraftAuditCoalescerPort {
  /** Antes da transação: abre a janela (ou não) — nunca lança. */
  open(target: DraftAuditTarget): Promise<DraftAuditTicket>;
  /** Primeira revisão da faixa do registro (`lastAuditedRevision + 1`, ou a própria). */
  fromRevision(ticket: DraftAuditTicket, toRevision: number): number;
  /** Depois do commit da gravação auditada: guarda a revisão para a próxima faixa — nunca lança. */
  recorded(ticket: DraftAuditTicket, toRevision: number): Promise<void>;
  /** A gravação não aconteceu (erro, conflito, no-op): devolve a janela aberta — nunca lança. */
  abandon(ticket: DraftAuditTicket): Promise<void>;
}

export const DRAFT_AUDIT_COALESCER = Symbol('DraftAuditCoalescerPort');

/** Armazenamento da janela (Redis em `modules/platform`; em memória nos testes e na identidade fake). */
export interface DraftAuditWindowStorePort {
  /** `SET NX PX`: `true` se a janela foi aberta agora; devolve também a última revisão auditada. */
  open(
    key: string,
    windowMs: number,
  ): Promise<{ readonly opened: boolean; readonly lastAuditedRevision: number | null }>;
  /** Guarda a última revisão auditada (expira em `LAST_AUDITED_TTL_SECONDS`). */
  markAudited(key: string, revision: number): Promise<void>;
  /** Apaga a janela aberta por uma gravação que não aconteceu. */
  release(key: string): Promise<void>;
}

export const DRAFT_AUDIT_WINDOW_STORE = Symbol('DraftAuditWindowStorePort');

/** Por quanto tempo a última revisão auditada é lembrada (a faixa da próxima janela). */
export const LAST_AUDITED_TTL_SECONDS = 7 * 24 * 3_600;

/** Implementação em memória (testes e identidade fake), com a mesma semântica do Redis. */
export class InMemoryDraftAuditWindowStore implements DraftAuditWindowStorePort {
  private readonly windows = new Map<string, number>();
  private readonly audited = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  open(
    key: string,
    windowMs: number,
  ): Promise<{ readonly opened: boolean; readonly lastAuditedRevision: number | null }> {
    const expiresAt = this.windows.get(key);
    const opened = expiresAt === undefined || expiresAt <= this.now();
    if (opened) this.windows.set(key, this.now() + windowMs);
    return Promise.resolve({ opened, lastAuditedRevision: this.audited.get(key) ?? null });
  }

  markAudited(key: string, revision: number): Promise<void> {
    this.audited.set(key, revision);
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.windows.delete(key);
    return Promise.resolve();
  }
}
