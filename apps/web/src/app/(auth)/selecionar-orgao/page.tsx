import { Alert } from '@contrataflow/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { safeReturnTo } from '@/bff/return-to';
import { currentSessionOrUnavailable } from '@/bff/server-session';
import { toShellSession } from '@/bff/session/view';
import { LoginFrame } from '@/features/auth/login-frame';

import { TenantSelection } from './tenant-selection';

/**
 * `/selecionar-orgao` (SCR-101 · FA-01/FA-08 da US-087 · US-093): destino do callback e do layout
 * de `(app)` quando a sessão não tem instituição ativa e há mais de um vínculo utilizável, e do
 * "Ver todas as instituições" do cabeçalho (troca com "Usar como padrão"). Exige só sessão.
 * `?motivo=troca-nao-concluida`: a troca que esperava o *step-up* foi recusada.
 */

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Primeiro nome do nome de exibição, para a saudação. */
function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

interface SelectTenantPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.selectTenant');
  return { title: t('metaTitle') };
}

export default async function SelectTenantPage({ searchParams }: SelectTenantPageProps) {
  const query = await searchParams;
  // `returnTo` inválido (open redirect) vira o início da área autenticada no cliente.
  const returnTo = safeReturnTo(single(query.returnTo));

  const lookup = await currentSessionOrUnavailable();
  // Redis de sessões fora do ar: indisponibilidade, nunca "sem sessão" (DEC-131).
  if (lookup.status === 'unavailable') {
    redirect(`/erro/manutencao?retorno=${encodeURIComponent('/selecionar-orgao')}`);
  }
  if (lookup.status !== 'active') redirect('/api/auth/login?returnTo=%2Fselecionar-orgao');
  const session = toShellSession(lookup.record);
  if (!session.memberships.some((membership) => membership.usable)) {
    redirect('/erro/sem-vinculo');
  }

  const t = await getTranslations('auth.selectTenant');
  const name = firstName(session.user.displayName);
  const switchNotCompleted = single(query.motivo) === 'troca-nao-concluida';
  return (
    <LoginFrame wide>
      <section className="flex flex-col">
        <h1 className="text-page-title text-brand-ink">
          {name ? t('title', { name }) : t('titleAnonymous')}
        </h1>
        <p className="mt-2 text-[0.9375rem] text-muted-foreground">
          {session.memberships.length > 1 ? t('description') : t('descriptionSingle')}
        </p>
        {switchNotCompleted ? (
          <Alert tone="warning" title={t('switchNotCompleted')} className="mt-6" />
        ) : null}
        <TenantSelection
          memberships={session.memberships}
          activeTenantId={session.activeTenant?.id ?? null}
          returnTo={returnTo}
        />
      </section>
    </LoginFrame>
  );
}
