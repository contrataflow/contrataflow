import { useTranslations } from 'next-intl';

import { ErrorView } from '@/components/errors/error-view';

import { SignOutButton } from './sign-out-button';

/**
 * Corpo de `/erro/sem-vinculo` (FA-02 · SCR-111): a sessão existe, mas nenhum vínculo é
 * utilizável. Sem instituição ativa o usuário só pode sair (ou abrir o convite recebido por
 * e-mail); por isso a única ação é "Sair".
 */
export function NoMembershipPage() {
  const t = useTranslations('errors.pages.sem-vinculo');
  return (
    <ErrorView
      illustration="membership"
      title={t('title')}
      description={t('description')}
      actions={<SignOutButton />}
    />
  );
}
