import { bffRuntime } from '@/bff/runtime';
import { profileTabFromParam } from '@/features/profile/profile-model';
import { ProfileView } from '@/features/profile/profile-view';
import type { AuthentikLinks } from '@/features/profile/profile-view';

/**
 * SCR-039 — Meu perfil (US-098): capacidade implícita de qualquer vínculo ativo — o layout de
 * `(app)` já redireciona sem sessão ou sem vínculo ativo (SCR-111). Os dados são lidos no cliente
 * (ME-01). `?aba=notificacoes` abre a aba de preferências de notificação (US-113). Os atalhos de senha e de autenticação em duas etapas apontam para a conta do usuário
 * no Authentik (origem do emissor OIDC), em nova aba.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string | string[] }>;
}) {
  const { aba } = await searchParams;
  return (
    <ProfileView
      links={authentikLinks()}
      initialTab={profileTabFromParam(typeof aba === 'string' ? aba : undefined)}
    />
  );
}

function authentikLinks(): AuthentikLinks {
  try {
    const origin = new URL(bffRuntime().config.oidc.issuerUrl).origin;
    return {
      password: `${origin}/if/user/#/settings;page-details`,
      mfa: `${origin}/if/user/#/settings;page-mfa`,
    };
  } catch {
    return { password: null, mfa: null };
  }
}
