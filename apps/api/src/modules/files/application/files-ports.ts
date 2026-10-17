import type { Readable } from 'node:stream';

import type { TenantTx } from '#shared/database/prisma.js';

import type { Attachment } from '../domain/attachment.js';
import type { AntivirusResult } from '../domain/scan-verdict.js';

/*
 * Portas da aplicação do módulo `files` (US-068): implementadas em `infrastructure/` (Prisma,
 * ClamAV) e em memória (testes e modo de identidade fake — local/dev/test sem banco).
 */

export interface AttachmentRepository {
  insert(tx: TenantTx, attachment: Attachment): Promise<void>;
  /** `null` se não existe NO TENANT da transação. */
  findById(tx: TenantTx, id: string): Promise<Attachment | null>;
  findByIds(tx: TenantTx, ids: readonly string[]): Promise<Attachment[]>;
  /**
   * Grava a nova versão SE o registro ainda está na versão lida (`UPDATE … WHERE version = $lida`).
   * `false` = outro escreveu antes (perdeu a corrida).
   */
  update(tx: TenantTx, next: Attachment, expectedVersion: number): Promise<boolean>;
  /**
   * RN-DOC-80 (storage.md §8): bytes retidos do tenant — anexos `AVAILABLE` e `DELETED` (binário
   * retido) e os em trânsito (`UPLOADED`/`SCANNING`), que viram uso ao serem liberados.
   */
  usedBytes(tx: TenantTx): Promise<number>;
}

export const ATTACHMENT_REPOSITORY = Symbol('AttachmentRepository');

export interface FilesTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const FILES_TRANSACTIONS = Symbol('FilesTransactions');

export type FilesClock = () => Date;

export const FILES_CLOCK = Symbol('FilesClock');

/** Parâmetros de plataforma do módulo (storage.md §8 · queues.md §4.5). */
export interface FilesSettings {
  /** Limite técnico de armazenamento por tenant (PEND-17), em bytes. */
  readonly tenantQuotaBytes: number;
  /** Tentativas do `file-scan` (queues.md: 5) e base do backoff (5 s). */
  readonly scanAttempts: number;
  readonly scanBackoffMs: number;
  /** Trava da varredura: depois disso, outra entrega da mesma tentativa pode assumir (90 s). */
  readonly scanLeaseMs: number;
}

export const FILES_SETTINGS = Symbol('FilesSettings');

/** ClamAV fora do ar (conexão, timeout ou `PING` sem `PONG`): o job pausa, nunca libera (P3). */
export class AntivirusUnavailableError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super('Antivírus indisponível.', options);
    this.name = 'AntivirusUnavailableError';
  }
}

/** Cliente do antivírus (`clamd` INSTREAM — storage.md §5.3). */
export interface AntivirusPort {
  readonly engine: string;
  /**
   * Varre o stream até o fim. Erro do PRÓPRIO stream (ex.: inspeção de tipo abortou a leitura)
   * propaga como está; falha do antivírus → `AntivirusUnavailableError`.
   */
  scan(stream: Readable): Promise<AntivirusResult>;
  /** Versão do motor e da base de assinaturas (`VERSION`); `null` se não disponível. */
  version(): Promise<string | null>;
}

export const ANTIVIRUS = Symbol('Antivirus');
