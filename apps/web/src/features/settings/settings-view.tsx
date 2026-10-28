'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import { settingsMetaSchema } from '@contrataflow/validation';
import type { SettingGroup, SettingsMapDto, SettingsMetaDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { AiSettingsSection } from '@/features/ai/ai-settings-section';
import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { MaskPreview } from './mask-preview';
import { SettingField } from './setting-field';
import {
  MASK_TOKENS,
  buildPatchBody,
  evaluateDrafts,
  fieldKindOf,
  groupSettings,
  hasFutureEffect,
  maskNeedsOrganization,
  maskPreviewRequest,
  scopeChanged,
  toDraft,
} from './settings-model';
import type { Draft } from './settings-model';
import {
  SETTINGS_STALE_TIME_MS,
  fetchSettings,
  settingsKeys,
  updateSettings,
} from './settings.api';

const FIELD_PREFIX = 'values.';

/** SET-01 em cache: os valores e o `meta.aiTerms` (versão vigente dos termos — US-116). */
interface SettingsSnapshot {
  readonly values: SettingsMapDto;
  readonly aiTerms: SettingsMetaDto['aiTerms'] | null;
}

function aiTermsOf(meta: Readonly<Record<string, unknown>>): SettingsMetaDto['aiTerms'] | null {
  const parsed = settingsMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.aiTerms : null;
}

/**
 * SCR-041 — Administração › Configurações (`/admin/configuracoes` · US-103): lê todas as chaves
 * (SET-01), agrupa pelo prefixo, edita com o tipo certo por chave e salva só o que mudou em UM
 * `PATCH` tudo ou nada (SET-02) com a versão de cada chave. 412 oferece recarregar; 422 marca os
 * campos; o aviso de efeito futuro da numeração não bloqueia o salvamento (RN-TEN-58).
 */
export function SettingsView() {
  const t = useTranslations('settings');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [activeGroup, setActiveGroup] = useState<SettingGroup | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [serverErrors, setServerErrors] = useState<Readonly<Record<string, string>>>({});
  const [banner, setBanner] = useState<'conflict' | 'unavailable' | 'generic' | null>(null);

  const settings = useQuery({
    queryKey: settingsKeys.full(tenantId),
    queryFn: async ({ signal }): Promise<SettingsSnapshot> => {
      const result = await fetchSettings(signal);
      return { values: result.data, aiTerms: aiTermsOf(result.meta) };
    },
    staleTime: SETTINGS_STALE_TIME_MS,
  });
  const values = settings.data?.values;

  const groups = useMemo(() => (values ? groupSettings(values) : []), [values]);
  const current: SettingGroup | null = activeGroup ?? groups[0]?.group ?? null;
  const evaluation = useMemo(
    () => (values ? evaluateDrafts(values, drafts) : { changes: [], errors: {} }),
    [values, drafts],
  );
  const needsOrg = values ? maskNeedsOrganization(values, drafts) : false;
  const hasErrors = Object.keys(evaluation.errors).length > 0 || needsOrg;

  /** Chaves salvas (SET-02 devolve só as alteradas) sobre o SET-01 em cache. */
  const mergeSaved = (saved: SettingsMapDto) => {
    queryClient.setQueryData<SettingsSnapshot>(settingsKeys.full(tenantId), (previous) =>
      previous ? { ...previous, values: { ...previous.values, ...saved } } : previous,
    );
  };

  const reload = async () => {
    setBanner(null);
    setServerErrors({});
    setDrafts({});
    await queryClient.invalidateQueries({ queryKey: settingsKeys.all(tenantId) });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = buildPatchBody(evaluation.changes);
      return updateSettings(body.values, body.expectedVersions);
    },
    onSuccess: (result) => {
      mergeSaved(result.data);
      setDrafts({});
      setServerErrors({});
      setBanner(null);
      toast({ title: t('toast.saved'), tone: 'success' });
      // Rótulos e marca públicos (SET-03) refletem na hora nas demais telas.
      void queryClient.invalidateQueries({ queryKey: settingsKeys.public(tenantId) });
    },
    onError: (error) => {
      if (!isApiError(error)) {
        setBanner('generic');
        return;
      }
      if (error.code === 'VERSION_CONFLICT' || error.code === 'PRECONDITION_REQUIRED') {
        setBanner('conflict');
        return;
      }
      if (error.code === 'SETTING_KEY_UNKNOWN') {
        setBanner('generic');
        void queryClient.invalidateQueries({ queryKey: settingsKeys.all(tenantId) });
        return;
      }
      if (error.status === 422) {
        const fieldErrors: Record<string, string> = {};
        for (const item of error.errors) {
          if (!item.field.startsWith(FIELD_PREFIX)) continue;
          const key = item.field.slice(FIELD_PREFIX.length);
          fieldErrors[key] = item.message;
        }
        setServerErrors(fieldErrors);
        setBanner(Object.keys(fieldErrors).length === 0 ? 'generic' : null);
        return;
      }
      setBanner(error.status === 503 ? 'unavailable' : 'generic');
    },
  });

  if (settings.error && isApiError(settings.error) && settings.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
    const target = groups[next];
    if (!target) return;
    event.preventDefault();
    setActiveGroup(target.group);
    document.getElementById(`settings-tab-${target.group}`)?.focus();
  };

  const currentGroup = groups.find((model) => model.group === current);
  const showNumberingWarning =
    current === 'numbering' &&
    currentGroup?.keys.some((key) => key in drafts && hasFutureEffect(key));
  // DEC-028 · RN-TEN-68: o novo escopo só vale a partir do próximo exercício (aviso não bloqueante).
  const showScopeWarning = current === 'numbering' && values ? scopeChanged(values, drafts) : false;

  const errorOf = (key: string): string | undefined => {
    const server = serverErrors[key];
    if (server) return server;
    if (key === 'numbering.process.mask' && needsOrg) {
      return t('field.invalidMaskOrg', MASK_TOKENS);
    }
    const reason = evaluation.errors[key];
    if (!reason) return undefined;
    if (reason === 'number') return t('field.invalidNumber');
    if (reason === 'json') return t('field.invalidJson');
    if (reason === 'contrast') return t('field.contrast');
    if (fieldKindOf(key) === 'mask') return t('field.invalidMask', MASK_TOKENS);
    return t('field.invalid', { name: key });
  };

  return (
    <section className="flex flex-col gap-6">
      <AppPageHeader section="admin" title={t('title')} description={t('description')} />

      {settings.isPending ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {settings.isError ? (
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
      ) : null}

      {values && current ? (
        <>
          <div>
            <div
              role="tablist"
              aria-label={t('tabs.label')}
              className="hidden flex-wrap gap-2 border-b border-border md:flex"
            >
              {groups.map((model, index) => {
                const selected = model.group === current;
                return (
                  <button
                    key={model.group}
                    type="button"
                    role="tab"
                    id={`settings-tab-${model.group}`}
                    aria-selected={selected}
                    aria-controls="settings-panel"
                    tabIndex={selected ? 0 : -1}
                    className={`border-b-2 px-3 py-2 text-sm font-medium ${
                      selected ? 'border-primary' : 'border-transparent text-muted-foreground'
                    }`}
                    onClick={() => {
                      setActiveGroup(model.group);
                    }}
                    onKeyDown={(event) => {
                      onTabKeyDown(event, index);
                    }}
                  >
                    {t(`groups.${model.group}`)}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-1 md:hidden">
              <label htmlFor="settings-group-select" className="text-sm font-medium">
                {t('tabs.select')}
              </label>
              <select
                id="settings-group-select"
                className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
                value={current}
                onChange={(event) => {
                  setActiveGroup(event.target.value as SettingGroup);
                }}
              >
                {groups.map((model) => (
                  <option key={model.group} value={model.group}>
                    {t(`groups.${model.group}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {banner === 'conflict' ? (
            <Alert tone="warning" title={t('conflict.title')}>
              <p>{t('conflict.description')}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() => void reload()}
              >
                {t('conflict.reload')}
              </Button>
            </Alert>
          ) : null}
          {banner === 'unavailable' ? <Alert tone="error" title={t('errors.unavailable')} /> : null}
          {banner === 'generic' ? <Alert tone="error" title={t('errors.generic')} /> : null}
          {showNumberingWarning ? (
            <Alert tone="info" title={t('numberingWarning.title')}>
              {t('numberingWarning.description')}
            </Alert>
          ) : null}
          {showScopeWarning ? (
            <Alert tone="warning" title={t('numberingWarning.scopeTitle')}>
              {t('numberingWarning.scopeDescription')}
            </Alert>
          ) : null}

          <div
            role="tabpanel"
            id="settings-panel"
            aria-labelledby={`settings-tab-${current}`}
            className="flex max-w-3xl flex-col gap-5"
          >
            {current === 'ai' ? (
              <AiSettingsSection
                values={values}
                aiTerms={settings.data?.aiTerms ?? null}
                onSaved={mergeSaved}
                onConflict={() => {
                  setBanner('conflict');
                }}
              />
            ) : null}
            {current === 'ai'
              ? null
              : currentGroup?.keys.map((key) => {
                  const entry = values[key];
                  if (!entry) return null;
                  return (
                    <SettingField
                      key={key}
                      settingKey={key}
                      version={entry.version}
                      draft={drafts[key] ?? toDraft(key, entry.value)}
                      disabled={save.isPending}
                      error={errorOf(key)}
                      addon={
                        fieldKindOf(key) === 'mask' ? (
                          <MaskPreview request={maskPreviewRequest(key, values, drafts)} />
                        ) : undefined
                      }
                      onChange={(draft) => {
                        setDrafts((previous) => ({ ...previous, [key]: draft }));
                        setServerErrors(({ [key]: _removed, ...rest }) => rest);
                      }}
                    />
                  );
                })}
          </div>

          {/* O grupo "Inteligência artificial" salva pela própria seção (termos e limites). */}
          <Can permission="SETTINGS_MANAGE">
            <div
              hidden={current === 'ai'}
              role="region"
              aria-label={t('saveBar.region')}
              className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface py-3"
            >
              <p aria-live="polite" className="text-sm text-muted-foreground">
                {evaluation.changes.length === 0
                  ? t('saveBar.none')
                  : t('saveBar.pending', { count: evaluation.changes.length })}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={Object.keys(drafts).length === 0 || save.isPending}
                  onClick={() => {
                    setDrafts({});
                    setServerErrors({});
                    setBanner(null);
                  }}
                >
                  {t('saveBar.discard')}
                </Button>
                <Button
                  disabled={evaluation.changes.length === 0 || hasErrors || save.isPending}
                  aria-busy={save.isPending}
                  onClick={() => {
                    save.mutate();
                  }}
                >
                  {save.isPending ? t('saveBar.saving') : t('saveBar.save')}
                </Button>
              </div>
            </div>
          </Can>
        </>
      ) : null}
    </section>
  );
}
