import { TEMPLATE_PREVIEW_ERROR_CODES, TEMPLATE_PREVIEW_STATUSES } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TenantCache } from '#shared/cache/tenant-cache.js';

import { DOCUMENT_CLOCK } from './ports.js';
import type { DocumentClock } from './ports.js';
import type { TemplatePreview } from '../domain/template-preview.js';

/*
 * Estado efêmero da prévia do template no Redis (US-109 · RN-TPL-26 · api/04-templates.md TPL-12):
 * `cf:{env}:t:{tenantId}:template-preview:preview:{renditionId}`, com TTL até `expiresAt` (24 h) — o
 * tenant vem sempre do contexto (`TenantCache`), então a prévia de outro tenant simplesmente não
 * existe (404). A trava `active:{versionId}:{revisão}:{usuário}` (`SET NX`, curta) faz os cliques
 * repetidos devolverem a mesma prévia em andamento (Gherkin "[Duplicidade]"). Erro do Redis
 * propaga: quem chama responde 503.
 */

const MODULE = 'template-preview';
/** Trava da prévia em andamento: cobre o timeout do job (60 s) com folga. */
const ACTIVE_TTL_SECONDS = 300;

const storedSchema = z.object({
  renditionId: z.uuid(),
  tenantId: z.uuid(),
  templateVersionId: z.uuid(),
  templateVersionRevision: z.int(),
  requestedById: z.uuid().nullable(),
  status: z.enum(TEMPLATE_PREVIEW_STATUSES),
  storageKey: z.string().nullable(),
  sha256: z.string().nullable(),
  sizeBytes: z.int().nullable(),
  pageCount: z.int().nullable(),
  errorCode: z.enum(TEMPLATE_PREVIEW_ERROR_CODES).nullable(),
  errorMessage: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  readyAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
});
type StoredPreview = z.infer<typeof storedSchema>;

const date = (value: string | null) => (value === null ? null : new Date(value));

function fromStored(row: StoredPreview): TemplatePreview {
  return {
    ...row,
    requestedAt: new Date(row.requestedAt),
    startedAt: date(row.startedAt),
    readyAt: date(row.readyAt),
    expiresAt: new Date(row.expiresAt),
  };
}

function toStored(preview: TemplatePreview): StoredPreview {
  return {
    ...preview,
    requestedAt: preview.requestedAt.toISOString(),
    startedAt: preview.startedAt?.toISOString() ?? null,
    readyAt: preview.readyAt?.toISOString() ?? null,
    expiresAt: preview.expiresAt.toISOString(),
  };
}

/** Quem pede e o quê: a mesma revisão da versão, pelo mesmo usuário. */
export interface ActivePreviewKey {
  readonly templateVersionId: string;
  readonly revision: number;
  readonly userId: string | null;
}

const activeKey = (key: ActivePreviewKey) =>
  `active:${key.templateVersionId}:${String(key.revision)}:${key.userId ?? 'system'}`;

@Injectable()
export class TemplatePreviewStore {
  constructor(
    private readonly cache: TenantCache,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
  ) {}

  async find(renditionId: string): Promise<TemplatePreview | null> {
    const row = await this.cache.get(MODULE, `preview:${renditionId}`, storedSchema);
    return row === null ? null : fromStored(row);
  }

  /** Grava o estado com o TTL restante até `expiresAt`. */
  async save(preview: TemplatePreview): Promise<void> {
    const ttlSeconds = Math.max(
      1,
      Math.ceil((preview.expiresAt.getTime() - this.clock().getTime()) / 1000),
    );
    await this.cache.set(MODULE, `preview:${preview.renditionId}`, toStored(preview), {
      ttlSeconds,
    });
  }

  /** `true` = esta prévia passou a ser a em andamento da chave (nenhuma outra estava). */
  claimActive(key: ActivePreviewKey, renditionId: string): Promise<boolean> {
    return this.cache.setIfAbsent(MODULE, activeKey(key), renditionId, {
      ttlSeconds: ACTIVE_TTL_SECONDS,
    });
  }

  activeOf(key: ActivePreviewKey): Promise<string | null> {
    return this.cache.get(MODULE, activeKey(key), z.uuid());
  }

  replaceActive(key: ActivePreviewKey, renditionId: string): Promise<void> {
    return this.cache.set(MODULE, activeKey(key), renditionId, { ttlSeconds: ACTIVE_TTL_SECONDS });
  }

  /** Libera a trava ao concluir (só se ainda é desta prévia). */
  async releaseActive(key: ActivePreviewKey, renditionId: string): Promise<void> {
    if ((await this.activeOf(key)) === renditionId) {
      await this.cache.delete(MODULE, activeKey(key));
    }
  }
}

export function activeKeyOf(preview: TemplatePreview): ActivePreviewKey {
  return {
    templateVersionId: preview.templateVersionId,
    revision: preview.templateVersionRevision,
    userId: preview.requestedById,
  };
}
