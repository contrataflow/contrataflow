'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import type { MyProfileDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  PROFILE_DENSITIES,
  PROFILE_THEMES,
  buildPatch,
  isDirty,
  toDraft,
  validateDraft,
} from './profile-model';
import type { ProfileDraft, ProfileField } from './profile-model';
import { PROFILE_STALE_TIME_MS, fetchMyProfile, profileKeys, updateMyProfile } from './profile.api';

const INPUT =
  'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm aria-invalid:border-destructive';

export interface AuthentikLinks {
  /** Configurações da conta no Authentik (senha); `null` quando o IdP não é conhecido. */
  readonly password: string | null;
  /** Dispositivos de autenticação em duas etapas no Authentik. */
  readonly mfa: string | null;
}

/**
 * SCR-039 — Meu perfil (`/perfil` · US-098): lê `GET /me` (ME-01), edita nome, nome social,
 * telefone e preferências de interface e salva só o que mudou em `PATCH /me` (ME-02) com `If-Match`.
 * E-mail e dados do vínculo são somente leitura; senha e MFA são atalhos para o Authentik.
 */
export function ProfileView({ links }: { readonly links: AuthentikLinks }) {
  const t = useTranslations('profile');
  const tenantId = useTenantId();
  const profile = useQuery({
    queryKey: profileKeys.me(tenantId),
    queryFn: async ({ signal }) => (await fetchMyProfile(signal)).data,
    staleTime: PROFILE_STALE_TIME_MS,
    // O erro de carga é mostrado na própria tela, com "Tentar novamente" (SCR-039 · Estados).
    throwOnError: false,
  });

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>

      {profile.isPending ? (
        <div role="status" className="flex max-w-xl flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      ) : null}

      {profile.isError ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void profile.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {profile.data ? (
        // A chave é a versão: salvar ou recarregar depois de um conflito recomeça o rascunho.
        <ProfileForm key={profile.data.version} profile={profile.data} links={links} />
      ) : null}
    </section>
  );
}

type Banner = 'conflict' | 'precondition' | 'unavailable' | 'generic' | null;

function ProfileForm({
  profile,
  links,
}: {
  readonly profile: MyProfileDto;
  readonly links: AuthentikLinks;
}) {
  const t = useTranslations('profile');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const ids = useId();
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile));
  const [touched, setTouched] = useState<Readonly<Partial<Record<ProfileField, boolean>>>>({});
  const [serverErrors, setServerErrors] = useState<Readonly<Partial<Record<ProfileField, string>>>>(
    {},
  );
  const [banner, setBanner] = useState<Banner>(null);

  const errors = validateDraft(draft);
  const patch = buildPatch(draft, profile);
  const canSave = isDirty(patch) && Object.keys(errors).length === 0;

  const save = useMutation({
    mutationFn: () => updateMyProfile(patch, profile),
    onSuccess: (result) => {
      queryClient.setQueryData<MyProfileDto>(profileKeys.me(tenantId), result.data);
      setBanner(null);
      setServerErrors({});
      toast({ title: t('toast.saved'), tone: 'success' });
      // O nome exibido do shell vem da sessão (atualizada pelo BFF): relê o layout.
      router.refresh();
    },
    onError: (error) => {
      if (!isApiError(error)) {
        setBanner('generic');
        return;
      }
      if (error.code === 'VERSION_CONFLICT') {
        setBanner('conflict');
        void queryClient.invalidateQueries({ queryKey: profileKeys.me(tenantId) });
        return;
      }
      if (error.code === 'PRECONDITION_REQUIRED') {
        setBanner('precondition');
        void queryClient.invalidateQueries({ queryKey: profileKeys.me(tenantId) });
        return;
      }
      if (error.status === 422) {
        const fieldErrors: Partial<Record<ProfileField, string>> = {};
        for (const item of error.errors) {
          if (item.field === 'name' || item.field === 'socialName' || item.field === 'phone') {
            fieldErrors[item.field] = item.message;
          }
        }
        setServerErrors(fieldErrors);
        setBanner(Object.keys(fieldErrors).length === 0 ? 'generic' : null);
        return;
      }
      setBanner(error.status === 503 ? 'unavailable' : 'generic');
    },
  });

  const set = (changes: Partial<ProfileDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setServerErrors({});
  };
  const touch = (field: ProfileField) => {
    setTouched((current) => ({ ...current, [field]: true }));
  };
  const messageOf = (field: ProfileField): string | undefined => {
    const server = serverErrors[field];
    if (server) return server;
    return touched[field] && errors[field] ? t(`validation.${field}`) : undefined;
  };

  const onSubmit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setTouched({ name: true, socialName: true, phone: true });
    if (!canSave || save.isPending) return;
    setBanner(null);
    save.mutate();
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-8">
      <div aria-live="polite">
        {banner === 'conflict' || banner === 'precondition' ? (
          <Alert
            tone="warning"
            title={banner === 'conflict' ? t('conflict.title') : t('errors.precondition')}
          >
            <p>{t('conflict.description')}</p>
          </Alert>
        ) : null}
        {banner === 'unavailable' || banner === 'generic' ? (
          <Alert
            tone="error"
            title={banner === 'unavailable' ? t('errors.unavailable') : t('errors.generic')}
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={!canSave || save.isPending}
              onClick={() => {
                setBanner(null);
                save.mutate();
              }}
            >
              {t('errors.retry')}
            </Button>
          </Alert>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-lg font-semibold">{t('sections.personal')}</legend>
        <TextField
          id={`${ids}-name`}
          label={t('fields.name')}
          hint={t('fields.nameHint')}
          value={draft.name}
          error={messageOf('name')}
          autoComplete="name"
          required
          onChange={(name) => {
            set({ name });
          }}
          onBlur={() => {
            touch('name');
          }}
        />
        <TextField
          id={`${ids}-social`}
          label={t('fields.socialName')}
          hint={t('fields.socialNameHint')}
          value={draft.socialName}
          error={messageOf('socialName')}
          onChange={(socialName) => {
            set({ socialName });
          }}
          onBlur={() => {
            touch('socialName');
          }}
        />
        <TextField
          id={`${ids}-email`}
          label={t('fields.email')}
          hint={t('fields.emailHint')}
          value={profile.email}
          readOnly
        />
        <TextField
          id={`${ids}-phone`}
          label={t('fields.phone')}
          hint={t('fields.phoneHint')}
          value={draft.phone}
          error={messageOf('phone')}
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          onChange={(phone) => {
            set({ phone });
          }}
          onBlur={() => {
            touch('phone');
          }}
        />
      </fieldset>

      <section aria-labelledby={`${ids}-membership`} className="flex flex-col gap-3">
        <h2 id={`${ids}-membership`} className="text-lg font-semibold">
          {t('sections.membership')}
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <ReadOnlyItem label={t('fields.jobTitle')}>
            {profile.membership.jobTitle ?? t('fields.none')}
          </ReadOnlyItem>
          <ReadOnlyItem label={t('fields.departments')}>
            {profile.membership.departments.length > 0
              ? profile.membership.departments.join(', ')
              : t('fields.none')}
          </ReadOnlyItem>
        </dl>
      </section>

      <PreferencesFieldset
        idPrefix={ids}
        density={draft.density}
        theme={draft.theme}
        onChange={set}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canSave || save.isPending}>
          {save.isPending ? t('actions.saving') : t('actions.save')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!isDirty(patch) || save.isPending}
          onClick={() => {
            setDraft(toDraft(profile));
            setTouched({});
            setServerErrors({});
            setBanner(null);
          }}
        >
          {t('actions.discard')}
        </Button>
      </div>

      <AuthentikShortcutLinks links={links} />
    </form>
  );
}

interface TextFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly error?: string | undefined;
  readonly readOnly?: boolean;
  readonly required?: boolean;
  readonly type?: 'text' | 'tel';
  readonly autoComplete?: string;
  readonly inputMode?: 'tel';
  readonly onChange?: (value: string) => void;
  readonly onBlur?: () => void;
}

/** Campo de texto com rótulo, dica e erro associados (`aria-describedby`, erro em `aria-live`). */
function TextField({
  id,
  label,
  hint,
  value,
  error,
  readOnly = false,
  required = false,
  type = 'text',
  autoComplete,
  inputMode,
  onChange,
  onBlur,
}: TextFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        type={type}
        className={`${INPUT} ${readOnly ? 'bg-muted text-muted-foreground' : ''}`}
        value={value}
        readOnly={readOnly}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        onChange={(event) => {
          onChange?.(event.target.value);
        }}
        onBlur={onBlur}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      <p id={`${id}-error`} role={error ? 'alert' : undefined} className="text-sm text-destructive">
        {error}
      </p>
    </div>
  );
}

function ReadOnlyItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}

/** `PreferencesFieldset` (SCR-039): densidade e tema, com os valores do registro (RN-IAM-111). */
function PreferencesFieldset({
  idPrefix,
  density,
  theme,
  onChange,
}: {
  readonly idPrefix: string;
  readonly density: string;
  readonly theme: string;
  readonly onChange: (changes: Partial<ProfileDraft>) => void;
}) {
  const t = useTranslations('profile.preferences');
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-1 text-lg font-semibold">{t('legend')}</legend>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-density`} className="text-sm font-medium">
          {t('density')}
        </label>
        <select
          id={`${idPrefix}-density`}
          className={INPUT}
          value={density}
          onChange={(event) => {
            onChange({ density: event.target.value });
          }}
        >
          {PROFILE_DENSITIES.map((value) => (
            <option key={value} value={value}>
              {t(`densityOptions.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idPrefix}-theme`} className="text-sm font-medium">
          {t('theme')}
        </label>
        <select
          id={`${idPrefix}-theme`}
          className={INPUT}
          value={theme}
          onChange={(event) => {
            onChange({ theme: event.target.value });
          }}
        >
          {PROFILE_THEMES.map((value) => (
            <option key={value} value={value}>
              {t(`themeOptions.${value}`)}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

/** `AuthentikShortcutLinks` (SCR-039): senha e MFA são do Authentik, abertos em nova aba. */
function AuthentikShortcutLinks({ links }: { readonly links: AuthentikLinks }) {
  const t = useTranslations('profile.security');
  const tSections = useTranslations('profile.sections');
  if (links.password === null && links.mfa === null) return null;
  return (
    <section aria-labelledby="profile-security" className="flex flex-col gap-3">
      <h2 id="profile-security" className="text-lg font-semibold">
        {tSections('security')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <ul className="flex flex-wrap gap-3">
        {links.password ? (
          <li>
            <a
              className="text-sm font-medium text-primary underline underline-offset-2"
              href={links.password}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('password')} <span className="text-muted-foreground">{t('newTab')}</span>
            </a>
          </li>
        ) : null}
        {links.mfa ? (
          <li>
            <a
              className="text-sm font-medium text-primary underline underline-offset-2"
              href={links.mfa}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('mfa')} <span className="text-muted-foreground">{t('newTab')}</span>
            </a>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
