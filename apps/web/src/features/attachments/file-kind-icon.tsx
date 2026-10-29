import { ClipboardList, FileSearch, FileText, Paperclip } from '@contrataflow/ui';

const SHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xls', 'xlsx', 'csv', 'ods']);
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['pdf', 'doc', 'docx', 'odt', 'txt']);

/**
 * Ícone por tipo de arquivo. O kit não exporta `FileImage`/`FileSpreadsheet`: usa os mais
 * próximos (`FileSearch` para imagem, `ClipboardList` para planilha) e `Paperclip` no genérico.
 */
function iconFor(extension: string) {
  const ext = extension.toLowerCase();
  const props = { 'aria-hidden': true, className: 'size-5' } as const;
  if (DOCUMENT_EXTENSIONS.has(ext)) return <FileText {...props} />;
  if (IMAGE_EXTENSIONS.has(ext)) return <FileSearch {...props} />;
  if (SHEET_EXTENSIONS.has(ext)) return <ClipboardList {...props} />;
  return <Paperclip {...props} />;
}

/** Ícone decorativo do arquivo, num bloco suave; o nome acessível fica no nome do arquivo. */
export function FileKindIcon({ extension }: { readonly extension: string }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-control bg-muted text-brand-ink">
      {iconFor(extension)}
    </span>
  );
}
