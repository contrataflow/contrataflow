import type { AiGenerationKind, AiGenerationStatus, AiTargetModule } from '@contrataflow/types';

import type { TenantTx } from '#shared/database/prisma.js';

import type { AiGeneration } from '../domain/ai-generation.js';
import type { AiUsageRow } from '../domain/ai-usage.js';

/*
 * Portas da aplicação do módulo `ai` (US-115): implementadas em `infrastructure/` (Prisma) e em
 * memória (testes e modo de identidade fake — local/dev/test sem banco).
 */

/** Alvo de uma geração: uma ativa por alvo (RN-AI-12). */
export interface AiGenerationTarget {
  readonly processId: string;
  readonly targetModule: AiTargetModule;
  readonly kind: AiGenerationKind;
  readonly documentId: string | null;
  readonly sectionKey: string | null;
}

/** Já existe geração `QUEUED`/`RUNNING` para o alvo (únicos parciais — V-08). */
export class AiGenerationActiveError extends Error {
  constructor(readonly activeId: string | null) {
    super('Já existe geração ativa para o alvo.');
    this.name = 'AiGenerationActiveError';
  }
}

export interface AiGenerationListFilter {
  readonly documentId?: string | undefined;
  readonly targetModule?: AiTargetModule | undefined;
  readonly kind?: AiGenerationKind | undefined;
  readonly statuses?: readonly AiGenerationStatus[] | undefined;
  readonly requestedById?: string | undefined;
}

/** Posição do cursor de AI-03 (`createdAt desc`, `id desc`). */
export interface AiGenerationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Condição da gravação condicional (RN-AI-03): status lido e, quando importa, tentativas (claim)
 * e `updatedAt` (aplicações acumuladas no mapa de riscos) lidos.
 */
export interface ExpectedState {
  readonly status: AiGenerationStatus;
  readonly attempts?: number;
  readonly updatedAt?: Date;
}

export interface AiGenerationRepository {
  /** @throws AiGenerationActiveError (único parcial do alvo) */
  insert(tx: TenantTx, generation: AiGeneration): Promise<void>;
  /** `null` se não existe NO TENANT da transação. */
  findById(tx: TenantTx, id: string): Promise<AiGeneration | null>;
  findActive(tx: TenantTx, target: AiGenerationTarget): Promise<AiGeneration | null>;
  /** AI-03: do processo, `createdAt desc, id desc`, depois do cursor. */
  list(
    tx: TenantTx,
    processId: string,
    filter: AiGenerationListFilter,
    page: { readonly after: AiGenerationCursor | null; readonly limit: number },
  ): Promise<AiGeneration[]>;
  /**
   * Grava a nova versão do registro SE o estado ainda é o lido (`UPDATE … WHERE status = $esperado
   * [AND attempts = $lidas]`). `false` = outro escreveu antes (perdeu a corrida).
   */
  update(tx: TenantTx, next: AiGeneration, expected: ExpectedState): Promise<boolean>;
  /** RN-AI-11: `SUCCEEDED` com `expiresAt` vencido → `EXPIRED` (conteúdo mantido). */
  expireDue(tx: TenantTx, now: Date): Promise<number>;
  /** RN-AI-08: `RUNNING` iniciadas antes de `before` (manutenção → `FAILED`/`TIMEOUT`). */
  findStaleRunning(tx: TenantTx, before: Date, limit: number): Promise<AiGeneration[]>;
  /**
   * US-116: recorte de consumo das gerações do tenant criadas em `[from, to)` (índice
   * `(tenant_id, created_at)`), sem conteúdo.
   */
  usageRows(tx: TenantTx, from: Date, to: Date): Promise<AiUsageRow[]>;
  /**
   * US-116 (RN-AI-19 · DEC-079): serializa por tenant a verificação de limites + inserção do AI-01
   * e o término da geração (`pg_advisory_xact_lock`, liberada no fim da transação).
   */
  lockTenantUsage(tx: TenantTx): Promise<void>;
}

export const AI_GENERATION_REPOSITORY = Symbol('AiGenerationRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface AiTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const AI_TRANSACTIONS = Symbol('AiTransactions');

export type AiClock = () => Date;

export const AI_CLOCK = Symbol('AiClock');

/** Configuração de plataforma da IA (RN-AI-14 · `AI_*`). */
export interface AiSettings {
  /** `none` = desligada para todos. */
  readonly provider: string;
  readonly models: { readonly draft: string; readonly section: string };
  /** Timeout de cada chamada ao provedor (RN-AI-08: 120 s). */
  readonly requestTimeoutMs: number;
  /** Tentativas do job `ai-generation` (RN-AI-08: 3) e base do backoff (10 s). */
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  /** Teto do contexto serializado (caracteres) — FA-07. */
  readonly maxContextChars: number;
}

export const AI_SETTINGS = Symbol('AiSettings');
