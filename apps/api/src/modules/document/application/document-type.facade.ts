import { approvalPolicySchema } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';
import { z } from 'zod';

import { TenantCache } from '#shared/cache/tenant-cache.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';

import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentClock, DocumentTransactions, DocumentTypeRepository } from './ports.js';
import type { DocumentType } from '../domain/document-type.js';
import { buildSystemDocumentTypes } from '../domain/system-document-types.js';

/** Módulo e chave do cache de tipos do tenant: `cf:{env}:t:{tenantId}:document:types` (worker). */
export const DOCUMENT_TYPES_CACHE_MODULE = 'document';
export const DOCUMENT_TYPES_CACHE_KEY = 'types';
/** TTL do pior caso quando a invalidação por evento falha (RN-DOC-12). */
export const DOCUMENT_TYPES_CACHE_TTL_SECONDS = 600;

const iso = z.iso.datetime({ offset: true });

/** Forma gravada no Redis (datas em ISO); valor fora do schema vira ausência (recarrega). */
const cachedTypeSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['STRUCTURED', 'FREE_TEXT', 'UPLOADED']),
  systemModule: z
    .enum(['DFD', 'ETP', 'TERM_OF_REFERENCE', 'RISK_MAP', 'PRICE_RESEARCH'])
    .nullable(),
  isSystem: z.boolean(),
  isActive: z.boolean(),
  allowMultiplePerProcess: z.boolean(),
  numberingEnabled: z.boolean(),
  numberingMask: z.string().nullable(),
  requiresApproval: z.boolean(),
  approvalPolicy: approvalPolicySchema.nullable(),
  defaultTemplateId: z.uuid().nullable(),
  defaultConfidentiality: z.enum(['PUBLIC', 'INTERNAL', 'RESTRICTED']),
  sortOrder: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  createdById: z.uuid().nullable(),
  updatedById: z.uuid().nullable(),
  version: z.number().int(),
});
export const cachedTypesSchema = z.array(cachedTypeSchema);

function toCached(type: DocumentType): z.input<typeof cachedTypeSchema> {
  return {
    ...type,
    createdAt: type.createdAt.toISOString(),
    updatedAt: type.updatedAt.toISOString(),
  };
}

function fromCached(row: z.output<typeof cachedTypeSchema>): DocumentType {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

let cacheCounter: Counter | undefined;

/** `cf_document_type_cache_total{result}` — acertos e falhas do cache de tipos (US-061 · DoD). */
function cacheResult(result: 'hit' | 'miss' | 'unavailable'): void {
  cacheCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_document_type_cache_total', {
      description: 'Leituras do cache de tipos de documento por resultado (hit/miss).',
    });
  cacheCounter.add(1, { result });
}

/**
 * API pública do catálogo de tipos de documento para os demais módulos (DEC-041 · US-061 · núcleo
 * antecipado — US-040 valida códigos de tipo nos workflows e US-065 cria documentos): leitura com
 * cache por tenant (TTL 10 min) invalidado pelo evento `DocumentTypeChanged` (RN-DOC-12).
 */
@Injectable()
export class DocumentTypeFacade {
  private readonly logger = new Logger('DocumentTypes');

  constructor(
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly cache: TenantCache,
  ) {}

  /** Todos os tipos do tenant (ativos e inativos), por ordem de exibição — do cache quando há. */
  async listAll(): Promise<DocumentType[]> {
    try {
      const cached = await this.cache.get(
        DOCUMENT_TYPES_CACHE_MODULE,
        DOCUMENT_TYPES_CACHE_KEY,
        cachedTypesSchema,
      );
      if (cached !== null) {
        cacheResult('hit');
        return cached.map(fromCached);
      }
    } catch (error) {
      cacheResult('unavailable');
      this.logger.warn(
        {
          event: 'cache.unavailable',
          module: DOCUMENT_TYPES_CACHE_MODULE,
          cause: errorName(error),
        },
        'cache.unavailable',
      );
      return this.load();
    }
    cacheResult('miss');
    const loaded = await this.load();
    try {
      await this.cache.set(
        DOCUMENT_TYPES_CACHE_MODULE,
        DOCUMENT_TYPES_CACHE_KEY,
        loaded.map(toCached),
        { ttlSeconds: DOCUMENT_TYPES_CACHE_TTL_SECONDS },
      );
    } catch (error) {
      this.logger.warn(
        {
          event: 'cache.unavailable',
          module: DOCUMENT_TYPES_CACHE_MODULE,
          cause: errorName(error),
        },
        'cache.unavailable',
      );
    }
    return loaded;
  }

  async listActive(): Promise<DocumentType[]> {
    return (await this.listAll()).filter((type) => type.isActive);
  }

  async getByCode(code: string): Promise<DocumentType | null> {
    return (await this.listAll()).find((type) => type.code === code) ?? null;
  }

  async getById(id: string): Promise<DocumentType | null> {
    return (await this.listAll()).find((type) => type.id === id) ?? null;
  }

  /**
   * RN-DOC-10: tipo que pode originar documento novo — existente no tenant e ativo. Inexistente
   * (ou de outro tenant) → 422 `REFERENCE_NOT_FOUND`; inativo → 422 `REFERENCE_INACTIVE`, ambos
   * em `documentTypeId`.
   */
  async assertCreatable(documentTypeId: string): Promise<DocumentType> {
    const type = await this.getById(documentTypeId);
    if (!type) {
      throw validationError([
        {
          field: 'documentTypeId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Tipo de documento não encontrado.',
        },
      ]);
    }
    if (!type.isActive) {
      throw validationError([
        {
          field: 'documentTypeId',
          code: 'REFERENCE_INACTIVE',
          message: 'Este tipo de documento está desativado.',
        },
      ]);
    }
    return type;
  }

  /**
   * Semeadura dos tipos de sistema do tenant do `tx` (entities.md §7), idempotente: só grava os
   * códigos que ainda não existem — chamada pelo provisionamento (US-099) na transação dele.
   * Devolve quantos tipos foram criados.
   */
  seedDefaults(tx: TenantTx): Promise<number> {
    const { tenantId } = requireRequestContext();
    if (tenantId === null) throw new Error('seedDefaults exige o tenant do contexto.');
    return this.types.insertMissing(tx, buildSystemDocumentTypes(tenantId, this.clock(), newId));
  }

  /**
   * Apaga a chave de tipos do tenant, já no commit do caso de uso (a invalidação por evento
   * continua valendo para as demais instâncias). Falha do Redis não desfaz nada: o cache expira
   * pelo TTL (`warn document_type.cache_invalidation_failed`).
   */
  async invalidate(): Promise<void> {
    try {
      await this.cache.delete(DOCUMENT_TYPES_CACHE_MODULE, DOCUMENT_TYPES_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { event: 'document_type.cache_invalidation_failed', cause: errorName(error) },
        'document_type.cache_invalidation_failed',
      );
    }
  }

  private load(): Promise<DocumentType[]> {
    return this.transactions.read((tx) => this.types.list(tx));
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
