import { TemplateVersionsView } from '@/features/templates/template-versions-view';

/**
 * SCR-033, aba "Versões" (`/admin/templates/[id]` · US-108): histórico de versões do template com
 * publicar, aposentar e iniciar nova versão. A API decide quem pode cada ação (RN-FND-92).
 */
export default async function TemplateVersionsPage({
  params,
}: {
  readonly params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;
  return <TemplateVersionsView templateId={templateId} />;
}
