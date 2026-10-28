import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { safeReturnTo } from '@/bff/return-to';
import { currentSessionOrUnavailable, pendingRecoveryReturnTo } from '@/bff/server-session';
import { LoginForm } from '@/features/auth/login-form';
import { LoginFrame } from '@/features/auth/login-frame';
import { isLoginReason } from '@/features/auth/login-reason-message';
import { HOME_PATH } from '@/lib/routes';

/*
 * `/entrar` (SCR-001 · DEC-187): a tela de entrada é do ContrataFlow — usuário e senha e, quando
 * houver segundo fator, o código — e o BFF conduz o *flow* do IdP (`POST /api/auth/login`); o
 * navegador nunca vê o Authentik no login. `motivo` (saiu, sessão expirada, senha redefinida,
 * erro, indisponível) vira o aviso acima do formulário; "Esqueci minha senha" segue para
 * `GET /api/auth/forgot-password` (US-089). Já autenticado, volta para `returnTo` (FA-07) sem
 * novo login. Depois de uma redefinição de senha, sem `returnTo` na URL, vale o destino guardado
 * quando a recuperação começou (FA-05 da US-089).
 */

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function withReturnTo(path: string, returnTo: string | null): string {
  return returnTo ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path;
}

interface LoginPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.login');
  return { title: t('metaTitle') };
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const motivo = single(query.motivo);
  const returnTo =
    safeReturnTo(single(query.returnTo)) ??
    (motivo === 'senha-redefinida' ? await pendingRecoveryReturnTo() : null);

  // FA-07. Redis de sessões fora do ar (`unavailable`): a página continua acessível — o login do
  // BFF responde com a indisponibilidade.
  const lookup = await currentSessionOrUnavailable();
  if (lookup.status === 'active') {
    // Nunca devolve para a própria página de entrada (RN-IAM-03).
    redirect(returnTo && !returnTo.startsWith('/entrar') ? returnTo : HOME_PATH);
  }

  return (
    <LoginFrame>
      <LoginForm
        returnTo={returnTo}
        reason={isLoginReason(motivo) ? motivo : null}
        forgotHref={withReturnTo('/api/auth/forgot-password', returnTo)}
      />
    </LoginFrame>
  );
}
