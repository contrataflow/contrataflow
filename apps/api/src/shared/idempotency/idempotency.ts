import { SetMetadata } from '@nestjs/common';

/** Resposta guardada para reprodução (architecture.md §6.10). */
export interface StoredResponse {
  readonly status: number;
  /** Só os cabeçalhos relevantes à reprodução (`Location`, `ETag`). */
  readonly headers: Readonly<Record<string, string>>;
  /** Corpo já com envelope; omitido quando passa de 64 KB. */
  readonly body?: unknown;
}

export type IdempotencyRecord =
  | { readonly state: 'IN_PROGRESS'; readonly bodyHash: string }
  | { readonly state: 'DONE'; readonly bodyHash: string; readonly response: StoredResponse };

/** Armazenamento das chaves de idempotência (Redis em `modules/platform` — RN-FND-35). */
export interface IdempotencyStorePort {
  /**
   * Reserva a chave como `IN_PROGRESS` (atômico — `SET NX`). Devolve `null` quando reservou, ou o
   * registro existente.
   */
  begin(key: string, bodyHash: string, ttlMs: number): Promise<IdempotencyRecord | null>;
  complete(
    key: string,
    record: IdempotencyRecord & { state: 'DONE' },
    ttlMs: number,
  ): Promise<void>;
  release(key: string): Promise<void>;
}

export const IDEMPOTENCY_STORE = Symbol('IdempotencyStorePort');

export const IDEMPOTENT_METADATA = 'cf:idempotent';

/** `POST` de criação e comandos que aceitam `Idempotency-Key` (DEC-105 · rotas "Idem." de api.md §3). */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_METADATA, true);
