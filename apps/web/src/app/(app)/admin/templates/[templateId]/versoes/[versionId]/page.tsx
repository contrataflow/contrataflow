import { TemplateEditorView } from '@/features/templates/template-editor';

/**
 * SCR-114 (`/admin/templates/[id]/versoes/[versionId]` · US-107): editor da versão do template,
 * aba "Conteúdo" (seções, campos tipados e mapeamento TR ← ETP). A aba "Layout" chega com a US-109.
 */
export default async function TemplateEditorPage({
  params,
}: {
  readonly params: Promise<{ templateId: string; versionId: string }>;
}) {
  const { versionId } = await params;
  return <TemplateEditorView versionId={versionId} />;
}
