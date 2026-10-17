import { escapeHtml, resolveTemplateVariables, richTextToHtml } from '@contrataflow/editor';
import type { HtmlRichTextNode } from '@contrataflow/editor';
import { DEFAULT_TEMPLATE_LAYOUT, layoutDefinitionSchema } from '@contrataflow/validation';
import type {
  DocumentSnapshot,
  LayoutDefinition,
  RenditionKind,
  SectionDefinition,
} from '@contrataflow/validation';

/*
 * HTML do PDF (US-067 · RN-DOC-65 · ADR-007 · DEC-056): o snapshot (já mascarado por POL-09 quando
 * for o caso) + o `LayoutDefinition` do template viram três páginas HTML para a rota Chromium do
 * Gotenberg — `index.html` (corpo), `header.html` e `footer.html` (repetidos em cada página). Tudo
 * é montado aqui a partir de JSON conferido: texto escapado, só os nós do editor, variáveis
 * `{{...}}` resolvidas no servidor. A prévia leva a marca d'água "RASCUNHO" em cada página; a
 * versão, o hash do conteúdo no rodapé (`showDocumentHashInFooter`). Na prévia, a seção com
 * conteúdo de IA não revisado ganha a nota "Conteúdo gerado por IA — revisão pendente" e as
 * marcações `toConfirm` saem destacadas (US-122 · RN-AI-58); a proveniência nunca é impressa nas
 * versões. Função pura: nunca loga nada.
 */

/** Layout inválido no template (V-04): falha permanente, sem nova tentativa. */
export class InvalidLayoutError extends Error {
  constructor() {
    super('Layout do template inválido para renderização.');
    this.name = 'InvalidLayoutError';
  }
}

export interface RenditionHtmlInput {
  readonly kind: RenditionKind;
  readonly snapshot: DocumentSnapshot;
  /** Seções e layout do template do documento; `null` = layout padrão, seções na ordem da chave. */
  readonly template: {
    readonly sections: readonly SectionDefinition[];
    readonly layout: unknown;
  } | null;
  /** `contentHash` da versão (`null` na prévia — o rascunho não tem hash). */
  readonly contentHash: string | null;
  readonly tenantName: string | null;
  /** Nome de quem pediu (`{{user.name}}`). */
  readonly requesterName: string | null;
  /** Data de referência do documento (`{{document.date}}`/`{{today}}`), no fuso do tenant. */
  readonly now: Date;
  readonly timeZone: string;
}

export interface RenditionHtml {
  readonly indexHtml: string;
  readonly headerHtml: string | null;
  readonly footerHtml: string;
  readonly layout: LayoutDefinition;
}

export const DRAFT_WATERMARK = 'RASCUNHO';
export const AI_REVIEW_PENDING_NOTE = 'Conteúdo gerado por IA — revisão pendente';
export const MASKED_VALUE_LABEL = 'Valor sigiloso';

/* Marcadores de página (área de uso privado do Unicode): sobrevivem ao escape do texto e viram os
 * `<span class="pageNumber|totalPages">` que o Chromium preenche no cabeçalho/rodapé. */
const PAGE_TOKEN = 'page';
const PAGES_TOKEN = 'pages';

function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/** RN-DOC-65: variáveis do `LayoutDefinition`/seções (entities.md §5.2), resolvidas no servidor. */
export function renditionVariables(input: RenditionHtmlInput): Record<string, string> {
  const { snapshot } = input;
  const today = formatDate(input.now, input.timeZone);
  return {
    'tenant.name': input.tenantName ?? '',
    'organization.name': snapshot.process.organizationName ?? '',
    'organization.cnpj': snapshot.process.organizationCnpj ?? '',
    'organization.address': '',
    'process.code': snapshot.process.code ?? '',
    'process.title': snapshot.process.title,
    'process.object': snapshot.process.object,
    'process.requestingSecretariat': snapshot.process.requestingSecretariatName ?? '',
    'process.requestingDepartment': snapshot.process.requestingDepartmentName ?? '',
    'document.code': snapshot.document.code ?? '',
    'document.title': snapshot.document.title,
    'document.version':
      input.kind === 'PREVIEW' ? DRAFT_WATERMARK : String(snapshot.document.versionNumber),
    'document.date': today,
    'document.hash': input.contentHash ?? '',
    today,
    'user.name': input.requesterName ?? '',
    page: PAGE_TOKEN,
    pages: PAGES_TOKEN,
  };
}

function withPageNumbers(html: string): string {
  return html
    .replaceAll(PAGE_TOKEN, '<span class="pageNumber"></span>')
    .replaceAll(PAGES_TOKEN, '<span class="totalPages"></span>');
}

function richText(doc: unknown, variables: Readonly<Record<string, string>>): string {
  if (typeof doc !== 'object' || doc === null) return '';
  return withPageNumbers(
    richTextToHtml(doc as HtmlRichTextNode, {
      transformText: (text) => resolveTemplateVariables(text, variables),
    }),
  );
}

/** Layout do template validado (V-04); sem template → padrão (RN-TPL-02). */
export function renditionLayout(layout: unknown): LayoutDefinition {
  if (layout === undefined || layout === null) return DEFAULT_TEMPLATE_LAYOUT;
  const parsed = layoutDefinitionSchema.safeParse(layout);
  if (!parsed.success) throw new InvalidLayoutError();
  const { marginsMm, fontSizePt, lineHeight } = parsed.data;
  const margins = [marginsMm.top, marginsMm.right, marginsMm.bottom, marginsMm.left];
  if (
    margins.some((value) => !Number.isFinite(value) || value < 0 || value > 100) ||
    !(fontSizePt >= 6 && fontSizePt <= 32) ||
    !(lineHeight >= 0.8 && lineHeight <= 3)
  ) {
    throw new InvalidLayoutError();
  }
  return parsed.data;
}

// --- Campos tipados (cabeçalho e coleções) -------------------------------------------------------

function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** Campos de um registro com POL-09 aplicado: `<campo>Masked: true` vira "Valor sigiloso". */
function recordFields(record: Readonly<Record<string, unknown>>): [string, string][] {
  const fields: [string, string][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith('Masked')) continue;
    if (record[`${key}Masked`] === true) {
      fields.push([key, MASKED_VALUE_LABEL]);
      continue;
    }
    if (typeof value === 'object' && value !== null) continue;
    fields.push([key, scalar(value)]);
  }
  return fields;
}

function headerTable(header: Readonly<Record<string, unknown>>): string {
  const rows = recordFields(header);
  if (rows.length === 0) return '';
  return (
    '<table class="cf-fields"><tbody>' +
    rows
      .map(
        ([key, value]) =>
          `<tr><th>${escapeHtml(humanize(key))}</th><td>${escapeHtml(value)}</td></tr>`,
      )
      .join('') +
    '</tbody></table>'
  );
}

function collectionTable(name: string, items: readonly unknown[]): string {
  const records = items.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
  if (records.length === 0) return '';
  const rows = records.map((record) => new Map(recordFields(record)));
  const columns = [...new Set(rows.flatMap((row) => [...row.keys()]))].filter(
    (key) => key !== 'id' && !key.endsWith('Id'),
  );
  if (columns.length === 0) return '';
  return (
    `<h3 class="cf-collection">${escapeHtml(humanize(name))}</h3>` +
    '<table class="cf-grid"><thead><tr>' +
    columns.map((column) => `<th>${escapeHtml(humanize(column))}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows
      .map(
        (row) =>
          '<tr>' +
          columns.map((column) => `<td>${escapeHtml(row.get(column) ?? '—')}</td>`).join('') +
          '</tr>',
      )
      .join('') +
    '</tbody></table>'
  );
}

// --- Seções ---------------------------------------------------------------------------------------

function orderedSections(input: RenditionHtmlInput): { key: string; title: string }[] {
  const keys = Object.keys(input.snapshot.sections);
  if (input.template === null || input.template.sections.length === 0) {
    return keys.sort().map((key) => ({ key, title: humanize(key) }));
  }
  const defined = [...input.template.sections].sort((a, b) => a.order - b.order);
  const known = new Set(defined.map((section) => section.key));
  return [
    ...defined.map((section) => ({ key: section.key, title: section.title })),
    ...keys
      .filter((key) => !known.has(key))
      .sort()
      .map((key) => ({ key, title: humanize(key) })),
  ];
}

function sectionsHtml(
  input: RenditionHtmlInput,
  variables: Readonly<Record<string, string>>,
): string {
  return orderedSections(input)
    .map(({ key, title }, index) => {
      const section = input.snapshot.sections[key];
      let body: string;
      if (section === undefined || section.state === 'EMPTY') {
        body = '<p class="cf-empty">Seção não preenchida.</p>';
      } else if (section.state === 'NOT_APPLICABLE') {
        body =
          '<p class="cf-empty">Não se aplica.</p>' +
          (section.justification
            ? `<p class="cf-justification">${escapeHtml(section.justification)}</p>`
            : '');
      } else {
        const aiPending =
          input.kind === 'PREVIEW' && section.ai !== undefined && section.ai !== null
            ? section.ai.reviewedAt === null
            : false;
        body =
          (aiPending ? `<p class="cf-ai-note">${escapeHtml(AI_REVIEW_PENDING_NOTE)}</p>` : '') +
          richText(section.content, variables);
      }
      return (
        `<section class="cf-section"><h2>${String(index + 1)}. ${escapeHtml(title)}</h2>` +
        `${body}</section>`
      );
    })
    .join('');
}

// --- Montagem --------------------------------------------------------------------------------------

function baseStyle(layout: LayoutDefinition): string {
  const font = `'${layout.fontFamily}', 'Liberation Sans', Arial, sans-serif`;
  return (
    `html,body{margin:0;padding:0;font-family:${font};font-size:${String(layout.fontSizePt)}pt;` +
    `line-height:${String(layout.lineHeight)};color:#111;}` +
    'h1{font-size:1.5em;margin:0 0 .4em;}h2{font-size:1.15em;margin:1.2em 0 .4em;}' +
    'h3{font-size:1.05em;}table{border-collapse:collapse;width:100%;margin:.6em 0;}' +
    'th,td{border:1px solid #999;padding:3pt 5pt;text-align:left;vertical-align:top;}' +
    '.cf-fields th{width:35%;background:#f2f2f2;}.cf-grid th{background:#f2f2f2;}' +
    '.cf-meta{color:#444;margin:0 0 1em;}.cf-empty{color:#666;font-style:italic;}' +
    '.cf-section{break-inside:auto;}blockquote{border-left:3px solid #999;margin:0;padding-left:8pt;}' +
    // US-122: pendência "[a confirmar]" e nota de IA visíveis também em impressão monocromática.
    '.cf-to-confirm{background:#fff3b0;color:#111;font-weight:700;border:1px dashed #8a6d00;' +
    'padding:0 2pt;}.cf-ai-note{border-left:4px solid #8a6d00;background:#fff8d6;' +
    'padding:3pt 6pt;font-weight:700;margin:0 0 .4em;}'
  );
}

const WATERMARK_STYLE =
  '.cf-watermark{position:fixed;top:45%;left:0;right:0;text-align:center;' +
  'transform:rotate(-35deg);font-size:96pt;font-weight:700;letter-spacing:8pt;' +
  'color:rgba(180,0,0,.13);z-index:1000;pointer-events:none;}';

function page(title: string, style: string, body: string): string {
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`
  );
}

/** Rodapé repetido (Chromium: estilos inline, fonte pequena, sem herança da página). */
function footer(
  input: RenditionHtmlInput,
  layout: LayoutDefinition,
  variables: Record<string, string>,
): string {
  const parts: string[] = [];
  const custom = richText(layout.footer, variables);
  if (custom !== '') parts.push(`<div>${custom}</div>`);
  if (input.kind === 'PREVIEW') {
    parts.push(
      `<div>${DRAFT_WATERMARK} — prévia sem valor oficial, gerada em ${escapeHtml(variables.today ?? '')}</div>`,
    );
  } else if (layout.showDocumentHashInFooter && input.contentHash !== null) {
    parts.push(
      `<div class="cf-hash">Hash SHA-256 da versão: ${escapeHtml(input.contentHash)}</div>`,
    );
  }
  if (layout.showPageNumbers) {
    parts.push(
      '<div>Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
    );
  }
  const style =
    'html,body{margin:0;}body{font-family:Arial,sans-serif;font-size:7pt;color:#444;width:100%;' +
    `padding:0 ${String(layout.marginsMm.left)}mm;box-sizing:border-box;text-align:center;}` +
    '.cf-hash{font-family:monospace;word-break:break-all;}';
  return page('Rodapé', style, parts.join(''));
}

function header(layout: LayoutDefinition, variables: Record<string, string>): string | null {
  const custom = richText(layout.header, variables);
  if (custom === '') return null;
  const style =
    'html,body{margin:0;}body{font-family:Arial,sans-serif;font-size:8pt;color:#333;width:100%;' +
    `padding:0 ${String(layout.marginsMm.left)}mm;box-sizing:border-box;text-align:center;}`;
  return page('Cabeçalho', style, custom);
}

/** As três páginas HTML do PDF (RN-DOC-65). */
export function buildRenditionHtml(input: RenditionHtmlInput): RenditionHtml {
  const layout = renditionLayout(input.template?.layout);
  const variables = renditionVariables(input);
  const { snapshot } = input;
  const isPreview = input.kind === 'PREVIEW';
  const meta = [
    snapshot.process.code === null ? null : `Processo ${snapshot.process.code}`,
    isPreview ? 'Rascunho' : `Versão ${String(snapshot.document.versionNumber)}`,
    snapshot.process.organizationName,
  ].filter((part): part is string => part !== null && part !== '');
  const title = [snapshot.document.code, snapshot.document.title]
    .filter((part): part is string => part !== null && part !== '')
    .join(' — ');
  const collections = Object.entries(snapshot.collections)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => collectionTable(name, items))
    .join('');
  const body =
    (isPreview ? `<div class="cf-watermark" aria-hidden="true">${DRAFT_WATERMARK}</div>` : '') +
    `<h1>${escapeHtml(title)}</h1>` +
    `<p class="cf-meta">${meta.map(escapeHtml).join(' · ')}</p>` +
    headerTable(snapshot.header) +
    sectionsHtml(input, variables) +
    collections;
  return {
    indexHtml: page(title, baseStyle(layout) + (isPreview ? WATERMARK_STYLE : ''), body),
    headerHtml: header(layout, variables),
    footerHtml: footer(input, layout, variables),
    layout,
  };
}
