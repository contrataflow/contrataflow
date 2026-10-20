/**
 * Versão do schema de conteúdo do editor (nós e marks permitidos — DEC-056).
 * Incrementar a cada mudança no conjunto de extensões; documentos guardam a versão usada.
 */
export const editorSchemaVersion = 1;

/**
 * Extensões TipTap compartilhadas por web (editor), api (validação) e worker (HTML para PDF).
 * Vazias até a story do editor rico.
 */
export const editorExtensions: readonly unknown[] = Object.freeze([]);

export {
  escapeHtml,
  resolveTemplateVariables,
  richTextToHtml,
  richTextToPlainText,
  toConfirmLabelOf,
} from './html.js';
export type { HtmlRichTextNode, RichTextHtmlOptions } from './html.js';
