import { getTranslations } from 'next-intl/server';

/** `/convite/[token]` (SCR-102): só a rota nesta story; o aceite vem com a US-091. */
export default async function InvitePage() {
  const t = await getTranslations('auth.invite');
  return (
    <section className="flex w-full max-w-md flex-col gap-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground">{t('description')}</p>
    </section>
  );
}
