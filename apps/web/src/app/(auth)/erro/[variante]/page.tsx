import { buttonClassName } from '@contrataflow/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { isValidCorrelationId } from '@/bff/correlation';
import { safeReturnTo } from '@/bff/return-to';
import { ErrorView } from '@/components/errors/error-view';
import { HOME_PATH } from '@/lib/routes';

/*
 * SCR-111 — páginas de erro e estados globais (`/erro/*`): destino dos interceptadores e
 * boundaries (architecture.md §8.12). Só `correlationId` é exibido como código técnico.
 */

const ERROR_VARIANTS = [
  '403',
  '404',
  '500',
  'sessao-expirada',
  'manutencao',
  'sem-vinculo',
  'acesso-indisponivel',
] as const;

type Variant = (typeof ERROR_VARIANTS)[number];

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
  const query = await searchParams;
  const t = await getTranslations('errors');
  const codigo = single(query.codigo);
  const correlationId = isValidCorrelationId(codigo) ? codigo : null;
  const retorno = safeReturnTo(single(query.retorno)) ?? HOME_PATH;

  const primary = buttonClassName();
  const secondary = buttonClassName({ variant: 'secondary' });
  const actions = {
    '403': (
      <Link href={HOME_PATH} className={secondary}>
        {t('actions.home')}
      </Link>
    ),
    '404': (
      <Link href={HOME_PATH} className={secondary}>
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
    'sem-vinculo': (
      <Link href="/selecionar-orgao" className={primary}>
        {t('actions.switchTenant')}
      </Link>
    ),
    'acesso-indisponivel': (
      <Link href="/selecionar-orgao" className={primary}>
        {t('actions.switchTenant')}
      </Link>
    ),
  } satisfies Record<Variant, ReactNode>;

  return (
    <ErrorView
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
