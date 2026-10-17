/*
 * Serialização HTML no servidor (DEC-056 · RN-DOC-65): o JSON TipTap/ProseMirror já conferido pela
 * API (`@contrataflow/validation` — rich-text) vira HTML para o Gotenberg. Só os nós e marks do
 * schema permitido são emitidos; qualquer outro é descartado (com o texto dos filhos preservado),
 * todo texto e atributo é escapado e os links só saem com `http(s)`/`mailto`. Nunca há HTML vindo
 * do cliente: o resultado é sempre montado aqui. O nó em linha `toConfirm` (US-122 · RN-AI-53) sai
 * como `<mark class="cf-to-confirm">[a confirmar: …]</mark>`, em destaque na prévia.
 */

export interface HtmlRichTextNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly HtmlRichTextNode[];
  readonly text?: string;
  readonly marks?: readonly {
    readonly type: string;
    readonly attrs?: Readonly<Record<string, unknown>>;
  }[];
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapa texto e valores de atributo (`& < > " '`). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

/** Elemento HTML de cada nó de bloco simples. */
const BLOCK_TAGS: Readonly<Record<string, string>> = {
  paragraph: 'p',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  blockquote: 'blockquote',
  table: 'table',
  tableRow: 'tr',
  tableHeader: 'th',
  tableCell: 'td',
};

const MARK_TAGS: Readonly<Record<string, string>> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
};

export interface RichTextHtmlOptions {
  /** Substituição de cada trecho de texto (ex.: variáveis `{{...}}` resolvidas no servidor). */
  readonly transformText?: (text: string) => string;
}

function positiveInt(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : null;
}

function wrapMarks(text: string, marks: HtmlRichTextNode['marks']): string {
  let html = text;
  for (const mark of marks ?? []) {
    const tag = MARK_TAGS[mark.type];
    if (tag !== undefined) {
      html = `<${tag}>${html}</${tag}>`;
      continue;
    }
    if (mark.type === 'link') {
      const href = mark.attrs?.href;
      if (typeof href === 'string' && SAFE_LINK.test(href)) {
        html = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${html}</a>`;
      }
    }
  }
  return html;
}

function cellAttributes(node: HtmlRichTextNode): string {
  const colspan = positiveInt(node.attrs?.colspan, 50);
  const rowspan = positiveInt(node.attrs?.rowspan, 500);
  return (
    (colspan !== null && colspan > 1 ? ` colspan="${String(colspan)}"` : '') +
    (rowspan !== null && rowspan > 1 ? ` rowspan="${String(rowspan)}"` : '')
  );
}

const TO_CONFIRM_CATEGORIES = new Set([
  'QUANTITY',
  'VALUE',
  'DEADLINE',
  'DATE',
  'DATA',
  'DECISION',
  'OTHER',
]);

/** Rótulo da marcação `toConfirm` (vazio → "informação"). */
export function toConfirmLabelOf(node: HtmlRichTextNode): string {
  const label = node.attrs?.label;
  return typeof label === 'string' && label.trim() !== '' ? label.trim() : 'informação';
}

function toConfirmHtml(node: HtmlRichTextNode): string {
  const category = node.attrs?.category;
  const data =
    typeof category === 'string' && TO_CONFIRM_CATEGORIES.has(category)
      ? ` data-category="${category}"`
      : '';
  return `<mark class="cf-to-confirm"${data}>${escapeHtml(`[a confirmar: ${toConfirmLabelOf(node)}]`)}</mark>`;
}

function renderNode(node: HtmlRichTextNode, options: RichTextHtmlOptions): string {
  const children = () => (node.content ?? []).map((child) => renderNode(child, options)).join('');
  switch (node.type) {
    case 'doc':
      return children();
    case 'text': {
      const raw = typeof node.text === 'string' ? node.text : '';
      const text = options.transformText ? options.transformText(raw) : raw;
      return wrapMarks(escapeHtml(text), node.marks);
    }
    case 'hardBreak':
      return '<br>';
    case 'toConfirm':
      return toConfirmHtml(node);
    case 'horizontalRule':
      return '<hr>';
    case 'heading': {
      const level = positiveInt(node.attrs?.level, 6) ?? 2;
      return `<h${String(level)}>${children()}</h${String(level)}>`;
    }
    case 'orderedList': {
      const start = positiveInt(node.attrs?.start, 100_000);
      return `<ol${start !== null && start > 1 ? ` start="${String(start)}"` : ''}>${children()}</ol>`;
    }
    case 'table':
      return `<table><tbody>${children()}</tbody></table>`;
    case 'tableHeader':
    case 'tableCell': {
      const tag = BLOCK_TAGS[node.type] ?? 'td';
      return `<${tag}${cellAttributes(node)}>${children()}</${tag}>`;
    }
    default: {
      const tag = BLOCK_TAGS[node.type];
      // Nó fora do schema: descartado, mas o texto dos filhos continua no PDF.
      return tag === undefined ? children() : `<${tag}>${children()}</${tag}>`;
    }
  }
}

/** HTML do documento TipTap (`null`/vazio → string vazia). */
export function richTextToHtml(
  doc: HtmlRichTextNode | null | undefined,
  options: RichTextHtmlOptions = {},
): string {
  if (doc === null || doc === undefined || typeof doc !== 'object') return '';
  return renderNode(doc, options);
}

/** Texto puro do documento TipTap (parágrafos separados por quebra de linha). */
export function richTextToPlainText(doc: HtmlRichTextNode | null | undefined): string {
  if (doc === null || doc === undefined) return '';
  if (doc.type === 'text') return typeof doc.text === 'string' ? doc.text : '';
  if (doc.type === 'hardBreak') return '\n';
  if (doc.type === 'toConfirm') return `[a confirmar: ${toConfirmLabelOf(doc)}]`;
  const parts = (doc.content ?? []).map((child) => richTextToPlainText(child));
  return doc.type === 'doc' ? parts.join('\n') : parts.join('');
}

/**
 * Resolve variáveis `{{nome}}` (espaços internos ignorados — `templateVariablesIn`). Variável sem
 * valor conhecido fica como está: a publicação do template já recusa as desconhecidas (V-05).
 */
export function resolveTemplateVariables(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  return text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? '') : match,
  );
}
