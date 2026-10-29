'use client';

import {
  Alert,
  Button,
  ExternalLink,
  Field,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  SettingsPage,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import type { MyProfileDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { MfaStatusBadge } from './mfa-status-badge';
import { NotificationPreferencesGrid } from './notification-preferences-grid';
import {
  PROFILE_DENSITIES,
  PROFILE_TABS,
  PROFILE_THEMES,
  buildPatch,
  isDirty,
  toDraft,
  validateDraft,
} from './profile-model';
import type { ProfileDraft, ProfileField, ProfileTab } from './profile-model';
import { PROFILE_STALE_TIME_MS, fetchMyProfile, profileKeys, updateMyProfile } from './profile.api';

export interface AuthentikLinks {
  /** Configurações da conta no Authentik (senha); `null` quando o IdP não é conhecido. */
  readonly password: string | null;
  /** Dispositivos de autenticação em duas etapas no Authentik. */
  readonly mfa: string | null;
}

/** Cartão de uma seção (prd-5 · regra 4): branco, sem borda, título e conteúdo. */
function SectionCard({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-5 rounded-card bg-surface p-5 shadow-card sm:p-6"
    >
      <header className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-bold text-brand-ink">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * SCR-039 — Meu perfil (`/perfil` · US-098) no modelo `SettingsPage` (prd-5): seções Dados,
 * Preferências, Notificações e Segurança à esquerda, o formulário da seção à direita. Lê `GET /me`
 * (ME-01) e cada formulário salva só o que mudou em `PATCH /me` (ME-02) com `If-Match`. E-mail e
 * dados do vínculo são somente leitura; senha e MFA são atalhos para o Authentik. "Notificações"
 * traz as preferências de aviso por canal (US-113 · ME-05/ME-06).
 */
export function ProfileView({
  links,
  initialTab = 'data',
}: {
  readonly links: AuthentikLinks;
  readonly initialTab?: ProfileTab;
}) {
  const t = useTranslations('profile');
  const tenantId = useTenantId();
  const [section, setSection] = useState<ProfileTab>(initialTab);
  const profile = useQuery({
    queryKey: profileKeys.me(tenantId),
    queryFn: async ({ signal }) => (await fetchMyProfile(signal)).data,
    staleTime: PROFILE_STALE_TIME_MS,
    // O erro de carga é mostrado na própria tela, com "Tentar novamente" (SCR-039 · Estados).
    throwOnError: false,
  });

  let body: ReactNode;
  if (section === 'notifications') {
    // `key` por instituição: o rascunho nunca atravessa a troca de tenant.
    body = <NotificationPreferencesGrid key={tenantId} />;
  } else if (profile.isPending) {
    body = (
      <div role="status" className="flex max-w-xl flex-col gap-3">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  } else if (profile.isError) {
    body = (
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
    );
  } else if (section === 'security') {
    body = <SecuritySection links={links} mfaVerified={profile.data.mfaVerified} />;
  } else {
    // A chave é a seção e a versão: salvar ou recarregar depois de um conflito recomeça o rascunho.
    body = (
      <ProfileForm
        key={`${section}-${String(profile.data.version)}`}
        section={section}
        profile={profile.data}
      />
    );
  }

  return (
    <SettingsPage
      header={<AppPageHeader title={t('title')} description={t('description')} />}
      sections={PROFILE_TABS.map((id) => ({ id, label: t(`tabs.${id}`) }))}
      current={section}
      onSectionChange={(id) => {
        setSection(id as ProfileTab);
      }}
      navLabel={t('tabs.label')}
    >
      {body}
    </SettingsPage>
  );
}

type Banner = 'conflict' | 'precondition' | 'unavailable' | 'generic' | null;

/** Formulário de uma seção ("Dados" ou "Preferências"): o PATCH leva só o que mudou nela. */
function ProfileForm({
  section,
  profile,
}: {
  readonly section: 'data' | 'preferences';
  readonly profile: MyProfileDto;
}) {
  const t = useTranslations('profile');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
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
    <form onSubmit={onSubmit} noValidate className="flex min-w-0 flex-col gap-5">
      <div aria-live="polite" className="empty:hidden">
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

      {section === 'data' ? (
        <>
          <SectionCard title={t('sections.personal')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('fields.name')}
                description={t('fields.nameHint')}
                error={messageOf('name')}
                required
                className="sm:col-span-2"
              >
                <Input
                  value={draft.name}
                  autoComplete="name"
                  onChange={(event) => {
                    set({ name: event.target.value });
                  }}
                  onBlur={() => {
                    touch('name');
                  }}
                />
              </Field>
              <Field
                label={t('fields.socialName')}
                description={t('fields.socialNameHint')}
                error={messageOf('socialName')}
                className="sm:col-span-2"
              >
                <Input
                  value={draft.socialName}
                  onChange={(event) => {
                    set({ socialName: event.target.value });
                  }}
                  onBlur={() => {
                    touch('socialName');
                  }}
                />
              </Field>
              <Field label={t('fields.email')} description={t('fields.emailHint')}>
                <Input value={profile.email} readOnly className="bg-muted text-muted-foreground" />
              </Field>
              <Field
                label={t('fields.phone')}
                description={t('fields.phoneHint')}
                error={messageOf('phone')}
              >
                <Input
                  type="tel"
                  value={draft.phone}
                  autoComplete="tel"
                  inputMode="tel"
                  onChange={(event) => {
                    set({ phone: event.target.value });
                  }}
                  onBlur={() => {
                    touch('phone');
                  }}
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title={t('sections.membership')}>
            <dl className="grid gap-4 sm:grid-cols-2">
              <ReadOnlyItem label={t('fields.jobTitle')}>
                {profile.membership.jobTitle ?? t('fields.none')}
              </ReadOnlyItem>
              <ReadOnlyItem label={t('fields.departments')}>
                {profile.membership.departments.length > 0
                  ? profile.membership.departments.join(', ')
                  : t('fields.none')}
              </ReadOnlyItem>
            </dl>
          </SectionCard>
        </>
      ) : (
        <PreferencesCard density={draft.density} theme={draft.theme} onChange={set} />
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
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
        <Button type="submit" disabled={!canSave || save.isPending}>
          {save.isPending ? t('actions.saving') : t('actions.save')}
        </Button>
      </div>
    </form>
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
      <dt className="text-sm font-semibold">{label}</dt>
      <dd className="text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}

/** Opções de uma preferência como `RadioGroup` do kit, com rótulo clicável. */
function PreferenceOptions({
  legend,
  value,
  options,
  labelOf,
  onChange,
}: {
  readonly legend: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly labelOf: (option: string) => string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field label={legend} group>
      <RadioGroup value={value} onValueChange={onChange} className="flex flex-wrap gap-x-6 gap-y-3">
        {options.map((option) => (
          <div key={option} className="flex items-center gap-2.5">
            <RadioGroupItem id={`${id}-${option}`} value={option} />
            <Label htmlFor={`${id}-${option}`} className="font-normal">
              {labelOf(option)}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </Field>
  );
}

/** `PreferencesCard` (SCR-039): tema e densidade, com os valores do registro (RN-IAM-111). */
function PreferencesCard({
  density,
  theme,
  onChange,
}: {
  readonly density: string;
  readonly theme: string;
  readonly onChange: (changes: Partial<ProfileDraft>) => void;
}) {
  const t = useTranslations('profile.preferences');
  return (
    <SectionCard title={t('legend')} description={t('description')}>
      <PreferenceOptions
        legend={t('theme')}
        value={theme}
        options={PROFILE_THEMES}
        labelOf={(option) => t(`themeOptions.${option as (typeof PROFILE_THEMES)[number]}`)}
        onChange={(next) => {
          onChange({ theme: next });
        }}
      />
      <PreferenceOptions
        legend={t('density')}
        value={density}
        options={PROFILE_DENSITIES}
        labelOf={(option) => t(`densityOptions.${option as (typeof PROFILE_DENSITIES)[number]}`)}
        onChange={(next) => {
          onChange({ density: next });
        }}
      />
    </SectionCard>
  );
}

/**
 * Segurança (SCR-039): o status do segundo fator nesta sessão (`MfaStatusBadge` — US-090) e os
 * atalhos de senha e MFA, que são do Authentik e abrem em nova aba.
 */
function SecuritySection({
  links,
  mfaVerified,
}: {
  readonly links: AuthentikLinks;
  readonly mfaVerified: boolean;
}) {
  const t = useTranslations('profile.security');
  const tSections = useTranslations('profile.sections');
  const hasLinks = links.password !== null || links.mfa !== null;
  const link = (href: string, label: string) => (
    <a
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-soft-foreground underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label} <span className="font-normal text-muted-foreground">{t('newTab')}</span>
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
  return (
    <SectionCard
      title={tSections('security')}
      description={hasLinks ? t('description') : undefined}
    >
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{t('mfaStatus.label')}</span>
        <MfaStatusBadge verified={mfaVerified} />
      </p>
      {hasLinks ? (
        <ul className="flex flex-wrap gap-x-6 gap-y-3">
          {links.password ? <li>{link(links.password, t('password'))}</li> : null}
          {links.mfa ? <li>{link(links.mfa, t('mfa'))}</li> : null}
        </ul>
      ) : null}
    </SectionCard>
  );
}
