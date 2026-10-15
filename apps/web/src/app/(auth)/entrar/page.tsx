import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { safeReturnTo } from '@/bff/return-to';
import { currentSessionOrUnavailable, pendingRecoveryReturnTo } from '@/bff/server-session';
import { LoginFrame } from '@/features/auth/login-frame';
import { isLoginReason, LoginReasonMessage } from '@/features/auth/login-reason-message';
import { LoginSubmitLink } from '@/features/auth/login-submit-link';
import { LoginTitle } from '@/features/auth/login-title';
import { HOME_PATH } from '@/lib/routes';

/*
 * `/entrar` (SCR-001). Sem `motivo`, a página não tem tela própria: segue direto para
 * `GET /api/auth/login` (preserva `returnTo`) e a primeira tela do usuário é a do Authentik.
 * Com `motivo`, mostra a moldura de login com a mensagem, o botão "Entrar" e "Esqueci minha
 * senha" (direto para `GET /api/auth/forgot-password` — US-089). Já autenticado, volta para
 * `returnTo` (FA-07) sem novo login. Depois de uma redefinição de senha, sem `returnTo` na URL,
 * vale o destino guardado quando a recuperação começou (FA-05 da US-089).
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

  // FA-07. Redis de sessões fora do ar (`unavailable`): segue o fluxo normal — o login do BFF
  // responde com a indisponibilidade, e esta página precisa continuar acessível.
  const lookup = await currentSessionOrUnavailable();
  if (lookup.status === 'active') {
    // Nunca devolve para a própria página de entrada (RN-IAM-03).
    redirect(returnTo && !returnTo.startsWith('/entrar') ? returnTo : HOME_PATH);
  }

  const loginHref = withReturnTo('/api/auth/login', returnTo);
  if (!isLoginReason(motivo)) redirect(loginHref);

  const t = await getTranslations('auth.login');
  return (
    <LoginFrame>
      <LoginTitle />
      <LoginReasonMessage reason={motivo} />
      <div className="mt-8 space-y-4">
        <LoginSubmitLink href={loginHref} />
        <p className="text-center">
          <a
            href={withReturnTo('/api/auth/forgot-password', returnTo)}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('forgot')}
          </a>
        </p>
      </div>
    </LoginFrame>
  );
}
