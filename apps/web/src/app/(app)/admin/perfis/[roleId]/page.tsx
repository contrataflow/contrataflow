import { RoleDetailView } from '@/features/roles/role-detail-view';

/**
 * SCR-031 (`/admin/perfis/[roleId]` · US-095): dados e matriz do perfil; o catálogo completo de
 * permissões (US-094) fica atrás de "Ver catálogo de permissões" dentro do detalhe.
 */
export default async function RoleDetailPage({
  params,
}: {
  readonly params: Promise<{ roleId: string }>;
}) {
  const { roleId } = await params;
  return <RoleDetailView roleId={roleId} />;
}
