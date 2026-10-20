'use client';

import { Skeleton, buttonClassName } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ErrorView } from '@/components/errors/error-view';
import { usePermission } from '@/lib/permissions/use-permission';
import { HOME_PATH } from '@/lib/routes';

import { ProcessWizard } from './process-wizard';

/**
 * SCR-005 (`/processos/novo` · US-001): o wizard só abre para quem tem `PROCESS_CREATE`; sem a
 * permissão (ou sem conseguir confirmá-la) a rota mostra a página 403 do SCR-111. A API continua
 * decidindo o escopo da unidade escolhida (RN-FND-92).
 */
export function NewProcessPage() {
  const t = useTranslations('errors');
  const tShell = useTranslations('shell');
  const { allowed, status } = usePermission('PROCESS_CREATE');
  if (status === 'pending') {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">{tShell('loading')}</span>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full max-w-3xl" />
      </div>
    );
  }
  if (!allowed) {
    return (
      <ErrorView
        title={t('pages.403.title')}
        description={t('pages.403.description')}
        actions={
          <Link href={HOME_PATH} className={buttonClassName({ variant: 'secondary' })}>
            {t('actions.home')}
          </Link>
        }
      />
    );
  }
  return <ProcessWizard />;
}
