import { getTranslations } from 'next-intl/server';

/** Entrada da administração; cada área (`/admin/*`) chega com a sua story. */
export default async function AdminHomePage() {
  const t = await getTranslations('shell.admin');
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground">{t('description')}</p>
    </section>
  );
}
