import { getTranslations } from 'next-intl/server';

import { AppPageHeader } from '@/components/shell/page-header';

/** Entrada da administração; cada área (`/admin/*`) chega com a sua story. */
export default async function AdminHomePage() {
  const t = await getTranslations('shell.admin');
  return (
    <section>
      <AppPageHeader title={t('title')} description={t('description')} />
    </section>
  );
}
