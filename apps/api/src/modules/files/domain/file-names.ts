/*
 * Nomes de arquivo (US-068 · storage.md §4): o nome original fica em `Attachment.fileName` só para
 * exibição e `Content-Disposition`; a chave definitiva usa um nome reduzido e sanitizado, com a
 * extensão CANÔNICA (nunca a digitada). Nomes podem conter dados pessoais: nunca vão para log,
 * métrica ou metadados do objeto.
 */

const DISPLAY_MAX = 255;
const STORAGE_BASE_MAX = 80;

/** Nome para exibição: sem caminho, sem caracteres de controle, espaços colapsados. */
export function displayFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- remover controles é o objetivo
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'arquivo').slice(0, DISPLAY_MAX);
}

/**
 * Segmento da chave (storage.md §4): NFKD sem diacríticos, minúsculas, fora de `[a-z0-9._-]` vira
 * `-`, hífens colapsados, sem `-`/`.` nas pontas, base até 80 caracteres e extensão canônica.
 * `Orçamento Empresa X (v2).PDF` → `orcamento-empresa-x-v2.pdf`; vazio → `arquivo.<ext>`.
 */
export function storageFileName(raw: string, extension: string): string {
  const display = displayFileName(raw);
  const dot = display.lastIndexOf('.');
  const base = dot > 0 ? display.slice(0, dot) : display;
  const slug = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, STORAGE_BASE_MAX)
    .replace(/[-.]+$/g, '');
  return `${slug || 'arquivo'}.${extension}`;
}
