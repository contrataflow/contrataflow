'use client';

import { Alert, Button, SettingsPage, Skeleton } from '@contrataflow/ui';
import { settingsMetaSchema } from '@contrataflow/validation';
import type { SettingsMetaDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useMemo, useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { AiSettingsSection } from '@/features/ai/ai-settings-section';
import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { sectionSettings } from './settings-model';
import {
  ConflictAlert,
  SettingsSectionForm,
  useMergeSaved,
  useReloadSettings,
} from './settings-section-form';
import type { SettingsSnapshot } from './settings-section-form';
import { SETTINGS_STALE_TIME_MS, fetchSettings, settingsKeys } from './settings.api';

/** Parâmetro da URL com a seção aberta (`/admin/configuracoes?secao=seguranca`). */
export const SECTION_PARAM = 'secao';

function aiTermsOf(meta: Readonly<Record<string, unknown>>): SettingsMetaDto['aiTerms'] | null {
  const parsed = settingsMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.aiTerms : null;
}

/**
 * SCR-041 — Administração › Configurações (`/admin/configuracoes` · US-103) no modelo
 * `SettingsPage` (prd-5): seções à esquerda, o formulário da seção à direita. Lê todas as chaves
 * (SET-01), reúne os grupos do registro em seções (só as que têm chave aparecem) e cada formulário
 * salva só o que mudou nele (SET-02, `If-Match` por chave). A seção atual vai em `?secao=`.
 */
export function SettingsView() {
  // `useSearchParams` exige fronteira de Suspense para a página poder ser pré-renderizada.
  return (
    <Suspense fallback={null}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const t = useTranslations('settings');
  const tenantId = useTenantId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mergeSaved = useMergeSaved();
  const reloadSettings = useReloadSettings();
  const [chosen, setChosen] = useState<string | null>(searchParams.get(SECTION_PARAM));
  const [aiConflict, setAiConflict] = useState(false);

  const settings = useQuery({
    queryKey: settingsKeys.full(tenantId),
    queryFn: async ({ signal }): Promise<SettingsSnapshot> => {
      const result = await fetchSettings(signal);
      return { values: result.data, aiTerms: aiTermsOf(result.meta) };
    },
    staleTime: SETTINGS_STALE_TIME_MS,
  });
  const values = settings.data?.values;

  const sections = useMemo(() => (values ? sectionSettings(values) : []), [values]);
  const current = sections.find((section) => section.id === chosen) ?? sections[0];

  const selectSection = (id: string) => {
    setChosen(id);
    setAiConflict(false);
    router.replace(`${pathname}?${SECTION_PARAM}=${id}`, { scroll: false });
  };

  if (settings.error && isApiError(settings.error) && settings.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  let body;
  if (settings.isPending) {
    body = (
      <div role="status" className="flex max-w-xl flex-col gap-3">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  } else if (settings.isError) {
    body = (
      <Alert tone="error" title={t('loadFailed')}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void settings.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (values && current?.id === 'ai') {
    // "Inteligência artificial" salva pela própria seção (termos e limites).
    body = (
      <>
        {aiConflict ? (
          <ConflictAlert
            onReload={() => {
              setAiConflict(false);
              void reloadSettings();
            }}
          />
        ) : null}
        <AiSettingsSection
          values={values}
          aiTerms={settings.data.aiTerms}
          onSaved={mergeSaved}
          onConflict={() => {
            setAiConflict(true);
          }}
        />
      </>
    );
  } else if (values && current) {
    // `key` por seção: o rascunho nunca atravessa a troca de seção.
    body = (
      <SettingsSectionForm key={current.id} id={current.id} keys={current.keys} values={values} />
    );
  }

  return (
    <SettingsPage
      header={<AppPageHeader section="admin" title={t('title')} description={t('description')} />}
      sections={sections.map((section) => ({ id: section.id, label: t(`sections.${section.id}`) }))}
      current={current?.id ?? ''}
      onSectionChange={selectSection}
      navLabel={t('nav.label')}
    >
      {body}
    </SettingsPage>
  );
}
