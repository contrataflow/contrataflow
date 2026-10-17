import { isUuid } from '../database/ids.js';
import { tenantIsolationViolation } from '../tenancy/isolation.js';
import { TenantContext } from '../tenancy/tenant-context.js';

/*
 * Chaves de objeto por tenant (US-100 · RN-TEN-30 · storage.md §4/§13): toda chave começa com
 * `tenants/{tenantId}/` e só é montada no servidor pelo `StorageKeyBuilder`, com o tenant do
 * contexto — nunca vem do cliente nem recebe o tenant por parâmetro.
 */

/** Segmento de chave: IDs, números de versão e nomes já sanitizados (sem `/`, `..` ou espaços). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Segmento inválido: erro de programação (nome não sanitizado, tentativa de `../`). */
export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

function segment(value: string | number): string {
  const text = String(value);
  if (!SEGMENT.test(text) || text.includes('..')) {
    throw new StorageKeyError('segmento de chave de storage inválido');
  }
  return text;
}

/** Prefixo do tenant: `tenants/{tenantId}/`. */
export function tenantStoragePrefix(tenantId: string): string {
  if (!isUuid(tenantId)) throw new StorageKeyError('tenantId inválido para chave de storage');
  return `tenants/${tenantId.toLowerCase()}/`;
}

/**
 * Monta as chaves do layout de storage.md §4 sempre com o tenant do contexto (sem contexto →
 * `TenantContextMissingError`, falha fechada).
 */
export const StorageKeyBuilder = {
  /** Chave genérica `tenants/{tenantId}/{segmentos…}`. */
  build(...segments: readonly (string | number)[]): string {
    if (segments.length === 0) throw new StorageKeyError('chave de storage sem segmentos');
    const { tenantId } = TenantContext.getOrThrow('storage', { operation: 'key_build' });
    return tenantStoragePrefix(tenantId) + segments.map(segment).join('/');
  },

  /** Upload em quarentena: `tenants/{tenantId}/uploads/{attachmentId}`. */
  quarantine(attachmentId: string): string {
    return StorageKeyBuilder.build('uploads', attachmentId);
  },

  /** Anexo de processo: `tenants/{tenantId}/processes/{processId}/attachments/{id}/{nome}`. */
  processAttachment(processId: string, attachmentId: string, fileName: string): string {
    return StorageKeyBuilder.build('processes', processId, 'attachments', attachmentId, fileName);
  },

  /** Ativo sem processo (`TENANT_ASSET`/`TEMPLATE_VERSION`): `tenants/{tenantId}/assets/{id}/{nome}`. */
  tenantAsset(attachmentId: string, fileName: string): string {
    return StorageKeyBuilder.build('assets', attachmentId, fileName);
  },

  /** PDF da versão: `…/processes/{processId}/documents/{documentId}/versions/{n}/renditions/content.pdf`. */
  versionContent(processId: string, documentId: string, versionNumber: number): string {
    return StorageKeyBuilder.build(
      'processes',
      processId,
      'documents',
      documentId,
      'versions',
      versionNumber,
      'renditions',
      'content.pdf',
    );
  },

  /**
   * PDF de uma versão com nome discriminado (US-067): `content.pdf`, `content-masked.pdf` (POL-09),
   * `approval-stamped-{approvalId}[-masked].pdf` — sob `…/versions/{n}/renditions/`.
   */
  versionRendition(
    processId: string,
    documentId: string,
    versionNumber: number,
    fileName: string,
  ): string {
    return StorageKeyBuilder.build(
      'processes',
      processId,
      'documents',
      documentId,
      'versions',
      versionNumber,
      'renditions',
      fileName,
    );
  },

  /** Prévia do rascunho (US-067): `tenants/{tenantId}/previews/{documentId}/{renditionId}.pdf`. */
  documentPreview(documentId: string, renditionId: string): string {
    return StorageKeyBuilder.build('previews', documentId, `${renditionId}.pdf`);
  },
} as const;

/**
 * Guarda do adaptador (storage.md §2 · V-08): a chave tem de estar no prefixo do tenant do
 * contexto. Fora dele → `TenantIsolationViolationError` (log `error
 * security.tenant_isolation_violation` com `barrier = storage`, métrica e alerta) ANTES de assinar
 * URL ou tocar no bucket. A chave não vai para o log (contém IDs de outro tenant).
 */
export function assertTenantStorageKey(key: string, operation: string): void {
  const { tenantId } = TenantContext.getOrThrow('storage', { operation });
  const prefix = tenantStoragePrefix(tenantId);
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : null;
  const valid =
    relative !== null &&
    relative.length > 0 &&
    relative.split('/').every((part) => SEGMENT.test(part) && !part.includes('..'));
  if (!valid) {
    throw tenantIsolationViolation('storage', 'key_outside_tenant_prefix', { operation });
  }
}
