import { buttonClassName } from '@contrataflow/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { safeReturnTo } from '@/bff/return-to';
import { FocusedHeading } from '@/features/auth/focused-heading';
import { LoginReasonMessage } from '@/features/auth/login-reason-message';

/*
 * `/recuperar-senha` (SCR-002 · US-089): não há formulário no ContrataFlow — a página só aciona
 * `GET /api/auth/forgot-password`, que redireciona ao *flow* de recuperação do Authentik. Quando
 * o BFF não alcança o IdP, volta aqui com `motivo=indisponivel`: a mensagem de SCR-001, "Tentar
 * novamente" e "Voltar para a entrada", preservando o `returnTo`.
 */

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function withReturnTo(path: string, returnTo: string | null): string {
  return returnTo ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path;
}

interface PasswordRecoveryPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.recovery');
  return { title: t('metaTitle') };
}

export default async function PasswordRecoveryPage({ searchParams }: PasswordRecoveryPageProps) {
  const query = await searchParams;
  const returnTo = safeReturnTo(single(query.returnTo));
  const recoveryHref = withReturnTo('/api/auth/forgot-password', returnTo);
  if (single(query.motivo) !== 'indisponivel') redirect(recoveryHref);

  const t = await getTranslations('auth.recovery');
  return (
    <section className="flex w-full max-w-md flex-col gap-6 py-12">
      <FocusedHeading className="text-2xl font-semibold tracking-tight outline-none">
        {t('title')}
      </FocusedHeading>
      <LoginReasonMessage reason="indisponivel" />
      <a href={recoveryHref} className={buttonClassName({ size: 'md', className: 'w-full' })}>
        {t('retry')}
      </a>
      <a
        href={withReturnTo('/entrar', returnTo)}
        className="self-center text-sm font-medium text-primary hover:underline"
      >
        {t('back')}
      </a>
    </section>
  );
}
