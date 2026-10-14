import { Alert, buttonClassName } from '@contrataflow/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { safeReturnTo } from '@/bff/return-to';

/*
 * `/entrar` (SCR-001 — a tela definitiva vem com a US-087). Sem `motivo`, segue direto para o
 * login do BFF preservando `returnTo`; com `motivo`, mostra a mensagem e o botão "Entrar".
 */

const REASONS = ['saiu', 'sessao-expirada', 'senha-redefinida', 'erro', 'indisponivel'] as const;
type Reason = (typeof REASONS)[number];

function isReason(value: string | undefined): value is Reason {
  return (REASONS as readonly (string | undefined)[]).includes(value);
}

interface LoginPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const motivo = typeof query.motivo === 'string' ? query.motivo : undefined;
  const returnTo = safeReturnTo(typeof query.returnTo === 'string' ? query.returnTo : null);
  const loginHref = `/api/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;
  if (!isReason(motivo)) redirect(loginHref);

  const t = await getTranslations('auth');
  return (
    <section className="flex w-full max-w-md flex-col gap-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{t('login.title')}</h1>
      <p className="text-muted-foreground">{t('login.subtitle')}</p>
      <Alert
        tone={motivo === 'erro' || motivo === 'indisponivel' ? 'warning' : 'info'}
        title={t(`login.reasons.${motivo}`)}
      />
      <a href={loginHref} className={buttonClassName({ className: 'w-full' })}>
        {t('login.submit')}
      </a>
      <a href="/recuperar-senha" className="text-sm text-primary underline">
        {t('login.forgot')}
      </a>
    </section>
  );
}
