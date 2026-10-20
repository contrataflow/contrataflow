import { UserDetailView } from '@/features/users/user-detail-view';

/**
 * Detalhe do usuário (SCR-029 `/admin/usuarios/[userId]` · US-092): dados, lotações e ações de
 * acesso carregados no cliente; a própria API decide o acesso (`USER_VIEW`/`USER_MANAGE`) e a tela
 * trata 403 e 404.
 */
export default async function UserDetailPage({
  params,
}: {
  readonly params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <UserDetailView userId={userId} />;
}
