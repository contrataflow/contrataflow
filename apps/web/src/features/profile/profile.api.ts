import type { MyProfileDto, UpdateMyProfile } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Meu perfil (US-098 · SCR-039): ME-01/ME-02 de api/01-session-me.md. A chave segue a convenção
 * `['t', tenantId, …]` (RN-FND-90): o cargo e as lotações do perfil são do vínculo da instituição
 * ativa, então nenhum dado sobrevive à troca de instituição.
 */

export const profileKeys = {
  me: (tenantId: string) => tenantKey(tenantId, 'me', 'profile'),
};

/** Staleness do perfil: muda pouco e é recarregado ao salvar ou em conflito. */
export const PROFILE_STALE_TIME_MS = 5 * 60_000;

/** ME-01. */
export function fetchMyProfile(signal?: AbortSignal): Promise<ApiResult<MyProfileDto>> {
  return apiRequest<MyProfileDto>('/me', { signal });
}

/** `ETag` de um perfil (`"<version>"`), reenviado como `If-Match` (RN-IAM-112). */
export function profileEtag(profile: Pick<MyProfileDto, 'version'>): string {
  return `"${String(profile.version)}"`;
}

/** ME-02: envia só o que mudou, com a versão lida no `GET` anterior. */
export function updateMyProfile(
  patch: UpdateMyProfile,
  profile: Pick<MyProfileDto, 'version'>,
): Promise<ApiResult<MyProfileDto>> {
  return apiRequest<MyProfileDto>('/me', {
    method: 'PATCH',
    body: patch,
    ifMatch: profileEtag(profile),
  });
}
