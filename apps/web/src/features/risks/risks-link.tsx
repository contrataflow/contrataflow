'use client';

import { buttonClassName } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/** Link "Riscos" do painel do processo para o SCR-011 (`/processos/[id]/riscos` — US-033). */
export function RisksLink({ processId }: { readonly processId: string }) {
  const t = useTranslations('risks');
  return (
    <Link
      href={`/processos/${processId}/riscos`}
      className={buttonClassName({ variant: 'secondary', size: 'sm' })}
    >
      {t('link')}
    </Link>
  );
}
