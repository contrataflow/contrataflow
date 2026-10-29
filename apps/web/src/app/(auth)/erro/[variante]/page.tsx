import { buttonClassName } from '@contrataflow/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { isValidCorrelationId } from '@/bff/correlation';
import { safeReturnTo } from '@/bff/return-to';
import type { ErrorIllustrationKind } from '@/components/errors/error-illustration';
import { ErrorView } from '@/components/errors/error-view';
import { NoMembershipPage } from '@/features/auth/no-membership-page';
import { SignOutButton } from '@/features/auth/sign-out-button';
import { HOME_PATH } from '@/lib/routes';

/*
 * SCR-111 — páginas de erro e estados globais (`/erro/*`): destino dos interceptadores e
 * boundaries (architecture.md §8.12), do callback do login (US-087: `sem-vinculo`,
 * `acesso-bloqueado`, `manutencao`) e do vínculo encerrado durante o uso (US-088:
 * `vinculo-inativo`) e do *step-up* que não se concluiu (US-090: `confirmacao-indisponivel`,
 * `confirmacao-nao-concluida` — a sessão segue válida, por isso não voltam a `/entrar`, que
 * devolveria a pessoa à ação bloqueada). Só `correlationId` é exibido como código técnico.
 */

const ERROR_VARIANTS = [
  '403',
  '404',
  '500',
  'sessao-expirada',
  'manutencao',
  'sem-vinculo',
  'vinculo-inativo',
  'acesso-bloqueado',
  'acesso-indisponivel',
  'confirmacao-indisponivel',
  'confirmacao-nao-concluida',
] as const;

type Variant = (typeof ERROR_VARIANTS)[number];

/** Ilustração de cada variante (prd-5 · card 10): o motivo em desenho, acima do título. */
const ILLUSTRATIONS = {
  '403': 'forbidden',
  '404': 'not-found',
  '500': 'failure',
  'sessao-expirada': 'session',
  manutencao: 'maintenance',
  'sem-vinculo': 'membership',
  'vinculo-inativo': 'membership',
  'acesso-bloqueado': 'forbidden',
  'acesso-indisponivel': 'membership',
  'confirmacao-indisponivel': 'confirmation',
  'confirmacao-nao-concluida': 'confirmation',
} as const satisfies Record<Variant, ErrorIllustrationKind>;

function isVariant(value: string): value is Variant {
  return (ERROR_VARIANTS as readonly string[]).includes(value);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface ErrorPageProps {
  readonly params: Promise<{ variante: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: ErrorPageProps): Promise<Metadata> {
  const { variante } = await params;
  if (!isVariant(variante)) return {};
  const t = await getTranslations('errors');
  return { title: `${t(`pages.${variante}.title`)} — ContrataFlow` };
}

export default async function ErrorPage({ params, searchParams }: ErrorPageProps) {
  const { variante } = await params;
  if (!isVariant(variante)) notFound();
  // Sem vínculo utilizável (FA-02): corpo próprio, com a explicação completa e só "Sair".
  if (variante === 'sem-vinculo') return <NoMembershipPage />;

  const query = await searchParams;
  const t = await getTranslations('errors');
  const codigo = single(query.codigo);
  const correlationId = isValidCorrelationId(codigo) ? codigo : null;
  const retorno = safeReturnTo(single(query.retorno)) ?? HOME_PATH;

  const primary = buttonClassName();
  const secondary = buttonClassName({ variant: 'secondary' });
  // Novo desafio de MFA para o mesmo destino; "início" não repete a ação bloqueada (US-090).
  const stepUpRetry = (
    <div className="flex flex-wrap justify-center gap-3">
      <a href={`/api/auth/step-up?returnTo=${encodeURIComponent(retorno)}`} className={primary}>
        {t('actions.retry')}
      </a>
      <Link href={HOME_PATH} className={secondary}>
        {t('actions.home')}
      </Link>
    </div>
  );
  const actions = {
    '403': (
      <Link href={HOME_PATH} className={primary}>
        {t('actions.home')}
      </Link>
    ),
    '404': (
      <Link href={HOME_PATH} className={primary}>
        {t('actions.home')}
      </Link>
    ),
    '500': (
      <Link href={retorno} className={primary}>
        {t('actions.retry')}
      </Link>
    ),
    manutencao: (
      <Link href={retorno} className={primary}>
        {t('actions.retry')}
      </Link>
    ),
    'sessao-expirada': (
      <a href={`/api/auth/login?returnTo=${encodeURIComponent(retorno)}`} className={primary}>
        {t('actions.login')}
      </a>
    ),
    // Vínculo suspenso/revogado durante o uso (FA-08 da US-088): outra instituição ou sair.
    'vinculo-inativo': (
      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/selecionar-orgao" className={primary}>
          {t('actions.switchTenant')}
        </Link>
        <SignOutButton variant="secondary" />
      </div>
    ),
    // Usuário bloqueado (FA-06): o BFF não cria a sessão; "Sair" só limpa o que houver.
    'acesso-bloqueado': <SignOutButton />,
    'acesso-indisponivel': (
      <Link href="/selecionar-orgao" className={primary}>
        {t('actions.switchTenant')}
      </Link>
    ),
    'confirmacao-indisponivel': stepUpRetry,
    'confirmacao-nao-concluida': stepUpRetry,
  } satisfies Record<Exclude<Variant, 'sem-vinculo'>, ReactNode>;

  return (
    <ErrorView
      illustration={ILLUSTRATIONS[variante]}
      title={t(`pages.${variante}.title`)}
      description={t(`pages.${variante}.description`)}
      correlationId={correlationId}
      correlationLabels={
        correlationId
          ? {
              code: t('correlation.label', { correlationId }),
              copy: t('correlation.copy'),
              copied: t('correlation.copied'),
            }
          : undefined
      }
      actions={actions[variante]}
    />
  );
}
