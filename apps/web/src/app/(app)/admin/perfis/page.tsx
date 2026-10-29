import { RolesView } from '@/features/roles/roles-view';

/**
 * Administração › Perfis e permissões (SCR-030 · US-095): lista de perfis carregada no cliente; o
 * cabeçalho (título e "Novo perfil") fica na própria view (modelo `ListPage`). A API decide o
 * acesso (`ROLE_VIEW` — RN-FND-92) e a tela trata o 403.
 */
export default function RolesPage() {
  return <RolesView />;
}
