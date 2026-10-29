import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { currentSessionOrUnavailable } from '@/bff/server-session';
import { LoginFrame } from '@/features/auth/login-frame';

import { InvitationAcceptCard } from './invitation-accept-card';

/**
 * `/convite/[token]` (SCR-102 · US-091): exige só sessão — a pessoa convidada ainda não tem vínculo
 * ativo na instituição. Sem sessão, segue para o login e volta aqui (o callback do BFF aceita
 * `returnTo` em `/convite/*` mesmo sem vínculo); Redis de sessões fora do ar é manutenção, nunca
 * "sem sessão" (DEC-131). O token é validado e aceito no cliente (USR-14/USR-06).
 */

interface InvitePageProps {
  readonly params: Promise<{ readonly token: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.invite');
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const returnTo = `/convite/${token}`;

  const lookup = await currentSessionOrUnavailable();
  if (lookup.status === 'unavailable') {
    redirect(`/erro/manutencao?retorno=${encodeURIComponent(returnTo)}`);
  }
  if (lookup.status !== 'active') {
    redirect(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return (
    <LoginFrame>
      <InvitationAcceptCard token={token} currentTenantId={lookup.record.activeTenantId} />
    </LoginFrame>
  );
}
