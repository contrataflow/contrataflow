import { PermissionCatalogPanel } from '@/features/permissions/permission-catalog-panel';
import { RoleDetailView } from '@/features/roles/role-detail-view';

/**
 * SCR-031 (`/admin/perfis/[roleId]` · US-095): dados e matriz do perfil, com o catálogo completo
 * de permissões (US-094) como referência.
 */
export default async function RoleDetailPage({
  params,
}: {
  readonly params: Promise<{ roleId: string }>;
}) {
  const { roleId } = await params;
  return (
    <div className="flex flex-col gap-10">
      <RoleDetailView roleId={roleId} />
      <PermissionCatalogPanel />
    </div>
  );
}
