'use client';

import { NOTIFICATION_CHANNELS } from '@contrataflow/types';
import type { NotificationChannel, NotificationType } from '@contrataflow/types';
import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  NOTIFICATION_AREAS,
  NOTIFICATION_TYPES_BY_AREA,
  buildChanges,
  cellOf,
  resetType,
  toPreferencesDraft,
  toggleCell,
} from './notification-preferences-model';
import type { PreferencesDraft } from './notification-preferences-model';
import {
  NOTIFICATION_PREFERENCES_STALE_TIME_MS,
  fetchNotificationPreferences,
  notificationPreferencesKeys,
  updateNotificationPreferences,
} from './notification-preferences.api';
import type { NotificationPreferencesState } from './notification-preferences.api';

type Banner = 'unavailable' | 'generic' | 'notAllowed' | 'invalidType' | null;

/**
 * SCR-039 — aba "Notificações" (`NotificationPreferencesGrid` · US-113): lê ME-05, mostra cada
 * tipo agrupado por área com um interruptor por canal e salva só as combinações alteradas em ME-06.
 * O in-app dos tipos obrigatórios fica ligado e desabilitado; com o e-mail desligado no órgão a
 * coluna inteira fica desabilitada e explicada.
 */
export function NotificationPreferencesGrid() {
  const t = useTranslations('notificationPreferences');
  const tenantId = useTenantId();
  const preferences = useQuery({
    queryKey: notificationPreferencesKeys.all(tenantId),
    queryFn: ({ signal }) => fetchNotificationPreferences(signal),
    staleTime: NOTIFICATION_PREFERENCES_STALE_TIME_MS,
    // O erro de carga é mostrado na própria aba, com "Tentar novamente" (SCR-039 · Estados).
    throwOnError: false,
  });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </header>

      {preferences.isPending ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : null}

      {preferences.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => {
              void preferences.refetch();
            }}
          >
            {t('actions.retry')}
          </Button>
        </Alert>
      ) : null}

      {preferences.data ? (
        // A chave muda quando o servidor devolve outro estado: o rascunho recomeça dele.
        <PreferencesForm key={preferences.dataUpdatedAt} state={preferences.data} />
      ) : null}
    </div>
  );
}

function PreferencesForm({ state }: { readonly state: NotificationPreferencesState }) {
  const t = useTranslations('notificationPreferences');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [draft, setDraft] = useState<PreferencesDraft>(() => toPreferencesDraft(state.items));
  const [banner, setBanner] = useState<Banner>(null);

  const changes = buildChanges(draft, state.items);
  const dirty = changes.length > 0;
  const changedKeys = new Set(changes.map((item) => `${item.notificationType}:${item.channel}`));

  const save = useMutation({
    mutationFn: () => updateNotificationPreferences(buildChanges(draft, state.items)),
    onSuccess: (next) => {
      setBanner(null);
      // Troca o cache pelo estado devolvido; a `key` do formulário reinicia o rascunho dele.
      queryClient.setQueryData<NotificationPreferencesState>(
        notificationPreferencesKeys.all(tenantId),
        next,
      );
      toast({ title: t('toast.saved'), tone: 'success' });
    },
    onError: (error) => {
      if (!isApiError(error)) {
        setBanner('generic');
        return;
      }
      if (error.status === 422) {
        const codes = error.errors.map((item) => item.code);
        // Reverte os interruptores: relê o estado real do servidor (descarta o rascunho).
        void queryClient.invalidateQueries({
          queryKey: notificationPreferencesKeys.all(tenantId),
        });
        setBanner(codes.includes('NOT_ALLOWED') ? 'notAllowed' : 'invalidType');
        return;
      }
      // 503: mantém as alterações locais e oferece "Tentar novamente" (Casos de erro da story).
      setBanner(error.status === 503 ? 'unavailable' : 'generic');
    },
  });

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!dirty || save.isPending) return;
    setBanner(null);
    save.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-8">
      <div aria-live="polite" className="flex flex-col gap-3">
        {!state.emailEnabled ? <Alert tone="warning" title={t('emailDisabledBanner')} /> : null}
        {banner ? (
          <Alert
            tone={banner === 'notAllowed' || banner === 'invalidType' ? 'warning' : 'error'}
            title={t(`errors.${banner}`)}
          >
            {banner === 'unavailable' || banner === 'generic' ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setBanner(null);
                  save.mutate();
                }}
              >
                {t('actions.retry')}
              </Button>
            ) : null}
          </Alert>
        ) : null}
      </div>

      {NOTIFICATION_AREAS.map((area) => (
        <section key={area} aria-labelledby={`${ids}-${area}`} className="flex flex-col gap-3">
          <h3 id={`${ids}-${area}`} className="text-base font-semibold">
            {t(`areas.${area}`)}
          </h3>
          <ul className="flex flex-col gap-3">
            {NOTIFICATION_TYPES_BY_AREA[area].map((type) => (
              <li key={type}>
                <TypeRow
                  idPrefix={ids}
                  type={type}
                  draft={draft}
                  emailEnabled={state.emailEnabled}
                  busyKeys={save.isPending ? changedKeys : null}
                  onToggle={(channel, enabled) => {
                    setDraft((current) => toggleCell(current, type, channel, enabled));
                    setBanner(null);
                  }}
                  onReset={() => {
                    setDraft((current) => resetType(current, type));
                    setBanner(null);
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending ? t('actions.saving') : t('actions.save')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setDraft(toPreferencesDraft(state.items));
            setBanner(null);
          }}
        >
          {t('actions.discard')}
        </Button>
      </div>
    </form>
  );
}

interface TypeRowProps {
  readonly idPrefix: string;
  readonly type: NotificationType;
  readonly draft: PreferencesDraft;
  readonly emailEnabled: boolean;
  /** Combinações em salvamento (carregamento individual do interruptor); `null` = parado. */
  readonly busyKeys: ReadonlySet<string> | null;
  readonly onToggle: (channel: NotificationChannel, enabled: boolean) => void;
  readonly onReset: () => void;
}

/** Um tipo de aviso: os dois interruptores de canal e o "Usar padrão" (FA-01). */
function TypeRow({
  idPrefix,
  type,
  draft,
  emailEnabled,
  busyKeys,
  onToggle,
  onReset,
}: TypeRowProps) {
  const t = useTranslations('notificationPreferences');
  const label = t(`types.${type}`);
  const groupId = `${idPrefix}-${type}`;
  const resettable = NOTIFICATION_CHANNELS.some(
    (channel) => cellOf(draft, type, channel)?.editable,
  );
  return (
    <div
      role="group"
      aria-labelledby={groupId}
      className="flex flex-col gap-3 rounded-control border border-border bg-surface p-4 md:flex-row md:items-center md:justify-between"
    >
      <p id={groupId} className="text-sm font-medium md:max-w-xs">
        {label}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
        {NOTIFICATION_CHANNELS.map((channel) => {
          const cell = cellOf(draft, type, channel);
          const emailOff = channel === 'EMAIL' && !emailEnabled;
          const note = !cell?.editable
            ? t('notes.mandatory')
            : emailOff
              ? t('notes.emailDisabled')
              : null;
          return (
            <PreferenceSwitch
              key={channel}
              id={`${groupId}-${channel}`}
              label={t(`channels.${channel}`)}
              checked={cell?.enabled ?? false}
              disabled={!cell?.editable || emailOff}
              busy={busyKeys?.has(`${type}:${channel}`) ?? false}
              note={note}
              onChange={(enabled) => {
                onToggle(channel, enabled);
              }}
            />
          );
        })}
        {resettable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('actions.useDefaultOf', { type: label })}
            disabled={busyKeys !== null}
            onClick={onReset}
          >
            {t('actions.useDefault')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface PreferenceSwitchProps {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly note: string | null;
  readonly onChange: (enabled: boolean) => void;
}

/** Interruptor acessível (`role="switch"`): rótulo associado, estado anunciado e nota vinculada. */
function PreferenceSwitch({
  id,
  label,
  checked,
  disabled,
  busy,
  note,
  onChange,
}: PreferenceSwitchProps) {
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          id={id}
          aria-checked={checked}
          aria-labelledby={`${id}-label`}
          aria-describedby={note ? `${id}-note` : undefined}
          aria-busy={busy || undefined}
          disabled={disabled || busy}
          onClick={() => {
            onChange(!checked);
          }}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 ${
            checked ? 'bg-primary' : 'bg-muted'
          } ${busy ? 'animate-pulse' : ''}`}
        >
          <span
            aria-hidden="true"
            className={`inline-block size-4 rounded-full bg-surface shadow transition-transform ${
              checked ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <label id={`${id}-label`} htmlFor={id} className="text-sm">
          {label}
        </label>
      </div>
      {note ? (
        <p id={`${id}-note`} className="text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}
