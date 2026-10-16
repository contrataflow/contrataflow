'use client';

import type { MyProfileDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { PROFILE_STALE_TIME_MS, fetchMyProfile, profileKeys } from './profile.api';

/** Atributos do `<html>` que as preferências controlam (tema e densidade da interface). */
export function applyInterfacePreferences(preferences: {
  readonly density: string;
  readonly theme: string;
}): void {
  const root = document.documentElement;
  root.dataset.density = preferences.density;
  root.dataset.theme = preferences.theme;
  root.style.colorScheme = preferences.theme === 'system' ? '' : preferences.theme;
}

/**
 * Aplica as preferências do usuário (`GET /me`) ao documento assim que o shell carrega e a cada
 * mudança do perfil em cache — salvar em "Meu perfil" reflete na hora, sem recarregar (US-098).
 * Falha de rede nunca afeta o shell: as preferências ficam como estão.
 */
export function PreferencesApplier() {
  const tenantId = useTenantId();
  const profile = useQuery({
    queryKey: profileKeys.me(tenantId),
    queryFn: async ({ signal }) => (await fetchMyProfile(signal)).data,
    staleTime: PROFILE_STALE_TIME_MS,
    retry: false,
    throwOnError: false,
  });
  // Resposta fora do formato (proxy, versão antiga da API) nunca derruba o shell.
  const preferences = (profile.data as Partial<MyProfileDto> | undefined)?.preferences;
  const density = preferences?.density;
  const theme = preferences?.theme;
  useEffect(() => {
    if (density === undefined || theme === undefined) return;
    applyInterfacePreferences({ density, theme });
  }, [density, theme]);
  return null;
}
