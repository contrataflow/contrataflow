import { buttonClassName } from '@contrataflow/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { ErrorView } from '@/components/errors/error-view';
import { HOME_PATH } from '@/lib/routes';

/** 404 global: mesma mensagem para inexistente e sem acesso (DEC-024 · RN-FND-93). */
export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <main className="px-4">
      <ErrorView
        title={t('pages.404.title')}
        description={t('pages.404.description')}
        actions={
          <Link href={HOME_PATH} className={buttonClassName({ variant: 'secondary' })}>
            {t('actions.home')}
          </Link>
        }
      />
    </main>
  );
}
