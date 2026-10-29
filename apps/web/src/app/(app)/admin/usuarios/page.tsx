import { UsersView } from '@/features/users/users-view';

/**
 * Administração › Usuários (SCR-029 · US-091): lista e convites pendentes carregados no cliente; a
 * própria API decide o acesso (`USER_VIEW` — RN-FND-92) e a tela trata o 403. O cabeçalho (com
 * "Convidar usuário") vem da própria lista, no modelo `ListPage` (prd-5).
 */
export default function UsersPage() {
  return <UsersView />;
}
