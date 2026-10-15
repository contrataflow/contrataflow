'use client';

import type { NumberingPreview } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { previewNumbering, settingsKeys } from './settings.api';

/** Espera depois da última tecla antes de chamar SET-04 (screens.md · SCR-041). */
export const MASK_PREVIEW_DEBOUNCE_MS = 500;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return debounced;
}

export interface MaskPreviewProps {
  /** Corpo de SET-04 para a máscara em edição; `null` enquanto o rascunho é inválido. */
  readonly request: NumberingPreview | null;
  readonly id?: string;
}

/**
 * Prévia ao vivo da máscara de numeração (US-105 · SCR-041 `MaskField`): debounce de 500 ms e
 * SET-04 com a máscara ainda não salva — o servidor calcula o próximo número sem incrementar a
 * sequência. "Calculando prévia…" e o exemplo são anunciados por `aria-live`.
 */
export function MaskPreview({ request, id }: MaskPreviewProps) {
  const t = useTranslations('settings');
  const tenantId = useTenantId();
  const serialized = request === null ? null : JSON.stringify(request);
  const debounced = useDebounced(serialized, MASK_PREVIEW_DEBOUNCE_MS);
  const settled = debounced === serialized;
  const body = debounced === null ? null : (JSON.parse(debounced) as NumberingPreview);

  const preview = useQuery({
    queryKey: settingsKeys.numberingPreview(tenantId, body ?? { mask: '' }),
    queryFn: async ({ signal }) => (await previewNumbering(body ?? { mask: '' }, signal)).data,
    enabled: body !== null,
    staleTime: 30_000,
    retry: false,
  });

  let message: string | null = null;
  if (request !== null) {
    if (!settled || preview.isFetching) message = t('preview.calculating');
    else if (preview.data) message = t('preview.example', { example: preview.data.example });
    else if (preview.error) {
      const fieldMessage = isApiError(preview.error) ? preview.error.errors[0]?.message : undefined;
      message = fieldMessage ?? t('preview.failed');
    }
  }

  return (
    <p id={id} className="text-sm text-muted-foreground" aria-live="polite">
      {message}
    </p>
  );
}
