import { randomUUID } from 'node:crypto';

import type { TenantCache } from '../cache/tenant-cache.js';

/*
 * Chaves do cache de permissões efetivas (US-097 · RN-IAM-102 · permissions.md §1.2), todas no
 * tenant do contexto (`cf:{env}:t:{tenantId}:access:…`):
 * - `eff:{membershipId}` — o retrato calculado (TTL 5 min), com os tokens de geração lidos ANTES
 *   do cálculo;
 * - `eff-gen:{membershipId}` e `eff-gen` — tokens de geração do vínculo e do tenant, trocados a
 *   cada invalidação.
 * O retrato só vale se os tokens gravados nele forem os atuais: um cálculo que leu o banco antes de
 * uma revogação e gravou depois do `DEL` nunca é servido (Concorrência da US-097). O
 * `PermissionCacheInvalidator` do worker troca os mesmos tokens a partir dos eventos.
 */

export const PERMISSION_CACHE_MODULE = 'access';
export const PERMISSION_CACHE_TTL_SECONDS = 5 * 60;
/** Os tokens vivem mais que qualquer retrato (um token expirado só força um novo cálculo). */
export const PERMISSION_GENERATION_TTL_SECONDS = 24 * 3_600;

export const permissionSnapshotKey = (membershipId: string): string => `eff:${membershipId}`;
export const membershipGenerationKey = (membershipId: string): string => `eff-gen:${membershipId}`;
export const TENANT_GENERATION_KEY = 'eff-gen';

/**
 * Invalida as permissões efetivas do vínculo logo após o commit (RN-IAM-61/99/102): troca o token
 * de geração e apaga o retrato. Idempotente; erro do Redis propaga (quem chama registra `warn` e
 * não desfaz nada — o TTL de 5 min e o evento cobrem).
 */
export async function invalidateEffectivePermissions(
  cache: TenantCache,
  membershipId: string,
): Promise<void> {
  await cache.setRaw(PERMISSION_CACHE_MODULE, membershipGenerationKey(membershipId), randomUUID(), {
    ttlSeconds: PERMISSION_GENERATION_TTL_SECONDS,
  });
  await cache.delete(PERMISSION_CACHE_MODULE, permissionSnapshotKey(membershipId));
}

/** Invalida os retratos de todos os vínculos do tenant (perfil alterado, unidade movida). */
export async function invalidateTenantPermissions(cache: TenantCache): Promise<void> {
  await cache.setRaw(PERMISSION_CACHE_MODULE, TENANT_GENERATION_KEY, randomUUID(), {
    ttlSeconds: PERMISSION_GENERATION_TTL_SECONDS,
  });
}
