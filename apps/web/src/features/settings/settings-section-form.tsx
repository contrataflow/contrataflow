'use client';

import { Alert, Button, Card, toast } from '@contrataflow/ui';
import type { SettingsMapDto, SettingsMetaDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

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
  hasFutureEffect,
  maskNeedsOrganization,
  maskPreviewRequest,
  scopeChanged,
  toDraft,
} from './settings-model';
import type { Draft, SettingsSectionId } from './settings-model';
import { settingsKeys, updateSettings } from './settings.api';

const FIELD_PREFIX = 'values.';

/** SET-01 em cache: os valores e o `meta.aiTerms` (versão vigente dos termos — US-116). */
export interface SettingsSnapshot {
  readonly values: SettingsMapDto;
  readonly aiTerms: SettingsMetaDto['aiTerms'] | null;
}

/** Chaves salvas (SET-02 devolve só as alteradas) sobre o SET-01 em cache. */
export function useMergeSaved(): (saved: SettingsMapDto) => void {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return (saved) => {
    queryClient.setQueryData<SettingsSnapshot>(settingsKeys.full(tenantId), (previous) =>
      previous ? { ...previous, values: { ...previous.values, ...saved } } : previous,
    );
  };
}

/** Relê SET-01 depois de um conflito de versão (412). */
export function useReloadSettings(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: settingsKeys.all(tenantId) });
}

/** Aviso de 412 com "Recarregar valores" (o chamador relê e descarta os rascunhos). */
export function ConflictAlert({ onReload }: { readonly onReload: () => void }) {
  const t = useTranslations('settings');
  return (
    <Alert tone="warning" title={t('conflict.title')}>
      <p>{t('conflict.description')}</p>
      <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onReload}>
        {t('conflict.reload')}
      </Button>
    </Alert>
  );
}

type Banner = 'conflict' | 'unavailable' | 'generic' | null;

export interface SettingsSectionFormProps {
  readonly id: SettingsSectionId;
  readonly keys: readonly string[];
  /** SET-01 (todas as chaves). */
  readonly values: SettingsMapDto;
}

/**
 * Formulário de uma seção da SCR-041 (US-103 · prd-5): um `Card` com um campo por chave e a barra
 * "Salvar"/"Descartar" no rodapé (só com `SETTINGS_MANAGE`). Salva só o que mudou NESTA seção em
 * UM `PATCH` tudo ou nada (SET-02) com a versão (`If-Match`) de cada chave. 412 oferece recarregar;
 * 422 marca os campos; o aviso de efeito futuro da numeração não bloqueia o salvamento (RN-TEN-58).
 * Os rascunhos vivem aqui: trocar de seção recomeça o formulário.
 */
export function SettingsSectionForm({ id, keys, values }: SettingsSectionFormProps) {
  const t = useTranslations('settings');
  const mergeSaved = useMergeSaved();
  const reloadSettings = useReloadSettings();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [serverErrors, setServerErrors] = useState<Readonly<Record<string, string>>>({});
  const [banner, setBanner] = useState<Banner>(null);

  const evaluation = useMemo(() => evaluateDrafts(values, drafts), [values, drafts]);
  const needsOrg = maskNeedsOrganization(values, drafts);
  const hasErrors = Object.keys(evaluation.errors).length > 0 || needsOrg;
  const dirty = Object.keys(drafts).length > 0;

  const reload = async () => {
    setBanner(null);
    setServerErrors({});
    setDrafts({});
    await reloadSettings();
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

  const showNumberingWarning =
    id === 'numbering' && keys.some((key) => key in drafts && hasFutureEffect(key));
  // DEC-028 · RN-TEN-68: o novo escopo só vale a partir do próximo exercício (aviso não bloqueante).
  const showScopeWarning = id === 'numbering' && scopeChanged(values, drafts);

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
    <form
      noValidate
      className="flex min-w-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (evaluation.changes.length === 0 || hasErrors || save.isPending) return;
        save.mutate();
      }}
    >
      <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
        {banner === 'conflict' ? (
          <ConflictAlert
            onReload={() => {
              void reload();
            }}
          />
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
      </div>

      <Card title={t(`sections.${id}`)}>
        <div className="flex max-w-3xl flex-col gap-5">
          {keys.map((key) => {
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

        <Can permission="SETTINGS_MANAGE">
          <div
            role="region"
            aria-label={t('saveBar.region')}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
          >
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {evaluation.changes.length === 0
                ? t('saveBar.none')
                : t('saveBar.pending', { count: evaluation.changes.length })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setDrafts({});
                  setServerErrors({});
                  setBanner(null);
                }}
              >
                {t('saveBar.discard')}
              </Button>
              <Button
                type="submit"
                disabled={evaluation.changes.length === 0 || hasErrors || save.isPending}
                aria-busy={save.isPending}
              >
                {save.isPending ? t('saveBar.saving') : t('saveBar.save')}
              </Button>
            </div>
          </div>
        </Can>
      </Card>
    </form>
  );
}
