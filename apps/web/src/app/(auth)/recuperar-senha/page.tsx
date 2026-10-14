import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/** `/recuperar-senha` (SCR-002): só a rota nesta story; o fluxo no Authentik vem com a US-089. */
export default async function PasswordRecoveryPage() {
  const t = await getTranslations('auth.recovery');
  return (
    <section className="flex w-full max-w-md flex-col gap-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground">{t('description')}</p>
      <Link href="/entrar?motivo=saiu" className="text-sm text-primary underline">
        {t('back')}
      </Link>
    </section>
  );
}
