import { QUOTATION_IMPORT_LIMITS } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TenantCache } from '#shared/cache/tenant-cache.js';
import { ApiError } from '#shared/errors/api-error.js';

import { PRICE_RESEARCH_CLOCK } from './ports.js';
import type { PriceResearchClock } from './ports.js';
import type { ImportCell } from '../domain/quotation-import.js';

/*
 * Token da prévia de importação no Redis (US-028 · RN-PRICE-37/38 · "Impacto técnico"):
 * `cf:{env}:t:{tenantId}:price-import:preview:{token}` com as células válidas da prévia e TTL de 15
 * minutos (a aplicação não reprocessa o arquivo). O tenant vem do contexto (`TenantCache`): o token
 * de outro tenant simplesmente não existe (404). Um marcador curto (`issued:{token}`, 24 h, sem
 * células) distingue o token vencido (410 `IMPORT_PREVIEW_EXPIRED`) do desconhecido (404). Redis
 * fora → 503 `DEPENDENCY_UNAVAILABLE`.
 */

const MODULE = 'price-import';
const MARKER_TTL_SECONDS = 24 * 3600;

const storedSchema = z.object({
  researchId: z.uuid(),
  userId: z.uuid().nullable(),
  fileName: z.string(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Células preenchidas que a prévia já recusou (erro ou aviso) — entram no `skippedCount`. */
  skipped: z.int(),
  items: z.array(z.uuid()),
  sources: z.array(z.uuid()),
  /** `[índice do item, índice da fonte, preço]` — compacto para 500 × 50 células. */
  cells: z.array(z.tuple([z.int(), z.int(), z.string()])),
});

const markerSchema = z.object({
  researchId: z.uuid(),
  userId: z.uuid().nullable(),
  expiresAt: z.iso.datetime(),
});

export interface StoredImportPreview {
  readonly researchId: string;
  readonly userId: string | null;
  readonly fileName: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly skipped: number;
  readonly cells: readonly ImportCell[];
}

export type ImportPreviewLookup =
  | { readonly state: 'ACTIVE'; readonly preview: StoredImportPreview }
  | {
      readonly state: 'EXPIRED';
      readonly researchId: string;
      readonly userId: string | null;
    }
  | { readonly state: 'UNKNOWN' };

function unavailable(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('DEPENDENCY_UNAVAILABLE', { cause: error });
}

@Injectable()
export class QuotationImportStore {
  constructor(
    private readonly cache: TenantCache,
    @Inject(PRICE_RESEARCH_CLOCK) private readonly clock: PriceResearchClock,
  ) {}

  /** Grava a prévia (15 min) e o marcador; devolve a validade. */
  async save(
    token: string,
    preview: Omit<StoredImportPreview, 'issuedAt' | 'expiresAt'>,
  ): Promise<Date> {
    const issuedAt = this.clock();
    const expiresAt = new Date(
      issuedAt.getTime() + QUOTATION_IMPORT_LIMITS.previewTtlSeconds * 1000,
    );
    const items: string[] = [];
    const sources: string[] = [];
    const indexOf = (list: string[], index: Map<string, number>, id: string) => {
      let found = index.get(id);
      if (found === undefined) {
        found = list.length;
        list.push(id);
        index.set(id, found);
      }
      return found;
    };
    const itemIndex = new Map<string, number>();
    const sourceIndex = new Map<string, number>();
    const cells = preview.cells.map(
      (cell) =>
        [
          indexOf(items, itemIndex, cell.priceItemId),
          indexOf(sources, sourceIndex, cell.priceSourceId),
          cell.unitPrice,
        ] as const,
    );
    try {
      await this.cache.set(
        MODULE,
        `preview:${token}`,
        {
          researchId: preview.researchId,
          userId: preview.userId,
          fileName: preview.fileName,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          skipped: preview.skipped,
          items,
          sources,
          cells,
        },
        { ttlSeconds: QUOTATION_IMPORT_LIMITS.previewTtlSeconds },
      );
      await this.cache.set(
        MODULE,
        `issued:${token}`,
        {
          researchId: preview.researchId,
          userId: preview.userId,
          expiresAt: expiresAt.toISOString(),
        },
        { ttlSeconds: MARKER_TTL_SECONDS },
      );
    } catch (error) {
      throw unavailable(error);
    }
    return expiresAt;
  }

  /** A prévia vigente, vencida (pelo relógio ou pelo TTL) ou desconhecida. */
  async find(token: string): Promise<ImportPreviewLookup> {
    try {
      const stored = await this.cache.get(MODULE, `preview:${token}`, storedSchema);
      if (stored !== null) {
        const expiresAt = new Date(stored.expiresAt);
        if (expiresAt.getTime() <= this.clock().getTime()) {
          return { state: 'EXPIRED', researchId: stored.researchId, userId: stored.userId };
        }
        return {
          state: 'ACTIVE',
          preview: {
            researchId: stored.researchId,
            userId: stored.userId,
            fileName: stored.fileName,
            issuedAt: new Date(stored.issuedAt),
            expiresAt,
            skipped: stored.skipped,
            cells: stored.cells.flatMap(([item, source, unitPrice]) => {
              const priceItemId = stored.items[item];
              const priceSourceId = stored.sources[source];
              return priceItemId === undefined || priceSourceId === undefined
                ? []
                : [{ priceItemId, priceSourceId, unitPrice }];
            }),
          },
        };
      }
      const marker = await this.cache.get(MODULE, `issued:${token}`, markerSchema);
      return marker === null
        ? { state: 'UNKNOWN' }
        : { state: 'EXPIRED', researchId: marker.researchId, userId: marker.userId };
    } catch (error) {
      throw unavailable(error);
    }
  }

  /** Depois da aplicação: o token não serve de novo (o marcador responde 410). */
  async consume(token: string): Promise<void> {
    await this.cache.delete(MODULE, `preview:${token}`);
  }
}
