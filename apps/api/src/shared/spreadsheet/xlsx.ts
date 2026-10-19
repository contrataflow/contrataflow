import { writeZip, ZipFormatError, ZipReader } from './zip.js';

/*
 * Planilha XLSX (SpreadsheetML) de uma aba, escrita e lida sem dependência externa (US-028 · a mesma
 * camada serve à exportação do mapa comparativo — US-031). Escrita: texto como `inlineStr`, números
 * com formato de exibição, cabeçalho em negrito e congelado. Leitura: a primeira aba do
 * `workbook.xml`, textos compartilhados (`sharedStrings.xml`), texto inline, fórmulas com resultado
 * em cache, booleanos e erros; células por referência (`C7`). Planilha inválida → `XlsxFormatError`.
 */

export class XlsxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxFormatError';
  }
}

// --- Escrita ------------------------------------------------------------------------------------

/** Estilos fixos do arquivo gerado (índices de `cellXfs` em `styles.xml`). */
export type XlsxCellStyle = 'default' | 'header' | 'decimal2' | 'decimal4';

const STYLE_INDEX: Readonly<Record<XlsxCellStyle, number>> = {
  default: 0,
  header: 1,
  decimal2: 2,
  decimal4: 3,
};

export type XlsxCellValue =
  | { readonly kind: 'text'; readonly value: string; readonly style?: XlsxCellStyle }
  /** Literal decimal com ponto (`"150.0000"`) — gravado como número, sem passar por `float`. */
  | { readonly kind: 'number'; readonly value: string; readonly style?: XlsxCellStyle }
  | null;

export interface XlsxSheetInput {
  readonly name: string;
  readonly rows: readonly (readonly XlsxCellValue[])[];
  /** Larguras por coluna (em caracteres). */
  readonly columnWidths?: readonly number[];
  /** Congela a primeira linha (cabeçalho). */
  readonly freezeHeader?: boolean;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/;

/** Letra da coluna a partir do índice 0 (`0` → `A`, `26` → `AA`). */
export function columnLetter(index: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const rest = (value - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/** Índice 0 da coluna a partir das letras (`AA` → `26`). */
export function columnIndex(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

/** Texto seguro para XML: escapa `&<>"` e remove caracteres de controle inválidos no XML 1.0. */
export function escapeXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- remover controles é o objetivo
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  );
}

function cellXml(cell: XlsxCellValue, ref: string): string {
  if (cell === null) return '';
  const style = STYLE_INDEX[cell.style ?? 'default'];
  const styleAttr = style === 0 ? '' : ` s="${String(style)}"`;
  if (cell.kind === 'number') {
    if (!NUMBER_LITERAL.test(cell.value)) throw new Error(`número inválido na célula ${ref}`);
    return `<c r="${ref}"${styleAttr}><v>${cell.value}</v></c>`;
  }
  const preserve = cell.value.trim() === cell.value ? '' : ' xml:space="preserve"';
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t${preserve}>${escapeXml(cell.value)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheetInput): string {
  const views = sheet.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';
  const cols =
    sheet.columnWidths && sheet.columnWidths.length > 0
      ? `<cols>${sheet.columnWidths
          .map(
            (width, index) =>
              `<col min="${String(index + 1)}" max="${String(index + 1)}" width="${String(width)}" customWidth="1"/>`,
          )
          .join('')}</cols>`
      : '';
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const number = String(rowIndex + 1);
      const cells = row
        .map((cell, columnIndexValue) =>
          cellXml(cell, `${columnLetter(columnIndexValue)}${number}`),
        )
        .join('');
      return `<row r="${number}">${cells}</row>`;
    })
    .join('');
  return `${XML_HEADER}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${views}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES_XML = `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.0000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Arquivo `.xlsx` de uma aba. Mesma entrada, mesmos bytes. */
export function writeXlsx(sheet: XlsxSheetInput): Buffer {
  const text = (value: string) => Buffer.from(value, 'utf8');
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: text(
        `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: text(
        `${XML_HEADER}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: text(
        `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${escapeXml(sheet.name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text(
        `${XML_HEADER}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    { name: 'xl/styles.xml', data: text(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheetXml(sheet)) },
  ]);
}

// --- Leitura ------------------------------------------------------------------------------------

export type XlsxReadCell =
  | { readonly kind: 'text'; readonly text: string }
  /** Valor numérico como gravado no XML (`"150.25"`, `"1.5E-2"`). */
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'boolean'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

export interface XlsxReadRow {
  /** Número da linha na planilha (1 = primeira). */
  readonly row: number;
  /** Células não vazias por índice 0 de coluna. */
  readonly cells: ReadonlyMap<number, XlsxReadCell>;
}

export interface XlsxReadLimits {
  /** Linhas não vazias lidas antes de recusar a planilha (`XlsxTooLargeError`). */
  readonly maxRows: number;
  /** Maior índice de coluna aceito (as células além são ignoradas). */
  readonly maxColumns: number;
}

/** A planilha passa dos limites de leitura (quem chama traduz para a mensagem da regra). */
export class XlsxTooLargeError extends Error {
  constructor() {
    super('planilha grande demais');
    this.name = 'XlsxTooLargeError';
  }
}

/** Partes XML lidas da planilha: teto bem acima de 500 × 50 células, abaixo de memória perigosa. */
const MAX_PART_BYTES = 32 * 1024 * 1024;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (match, entity: string) => {
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith('#')
        ? Number.parseInt(entity.slice(1), 10)
        : null;
    if (code === null) return ENTITIES[entity] ?? match;
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function attributes(raw: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of raw.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    found.set(match[1] ?? '', decodeXml(match[2] ?? match[3] ?? ''));
  }
  return found;
}

interface XmlElement {
  readonly attrs: string;
  /** Conteúdo entre as tags; `null` no elemento vazio (`<c r="A1"/>`). */
  readonly inner: string | null;
}

/**
 * Elementos `<tag …>…</tag>` de primeiro nível em `xml`, por varredura linear (`indexOf` sempre para
 * frente — sem retrocesso de regex sobre o conteúdo enviado pelo usuário). Os elementos lidos não se
 * aninham com o mesmo nome no SpreadsheetML; tag sem fechamento → `XlsxFormatError`.
 */
function* elements(xml: string, tag: string): Generator<XmlElement> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let cursor = 0;
  for (;;) {
    let start = xml.indexOf(open, cursor);
    // `<c` não casa com `<cols`: o caractere seguinte precisa encerrar o nome.
    while (start !== -1 && !/[\s/>]/.test(xml.charAt(start + open.length))) {
      start = xml.indexOf(open, start + open.length);
    }
    if (start === -1) return;
    const tagEnd = xml.indexOf('>', start + open.length);
    if (tagEnd === -1) throw new XlsxFormatError(`tag <${tag}> sem fim`);
    if (xml.charAt(tagEnd - 1) === '/') {
      yield { attrs: xml.slice(start + open.length, tagEnd - 1), inner: null };
      cursor = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd + 1);
    if (end === -1) throw new XlsxFormatError(`tag <${tag}> sem fechamento`);
    yield { attrs: xml.slice(start + open.length, tagEnd), inner: xml.slice(tagEnd + 1, end) };
    cursor = end + close.length;
  }
}

function firstElement(xml: string, tag: string): XmlElement | null {
  for (const element of elements(xml, tag)) return element;
  return null;
}

/** Remove os elementos `<tag>…</tag>` (a fonética `<rPh>` dos textos). */
function withoutElements(xml: string, tag: string): string {
  let result = '';
  let cursor = 0;
  for (const open = `<${tag}`, close = `</${tag}>`; ;) {
    const start = xml.indexOf(open, cursor);
    if (start === -1) return result + xml.slice(cursor);
    const end = xml.indexOf(close, start);
    if (end === -1) throw new XlsxFormatError(`tag <${tag}> sem fechamento`);
    result += xml.slice(cursor, start);
    cursor = end + close.length;
  }
}

/** Texto de um `<si>`/`<is>`: todos os `<t>`, sem a fonética (`<rPh>`). */
function richText(xml: string): string {
  let text = '';
  for (const element of elements(withoutElements(xml, 'rPh'), 't')) {
    text += decodeXml(element.inner ?? '');
  }
  return text;
}

function utf8(reader: ZipReader, name: string): string | null {
  const data = reader.read(name);
  if (data === null) return null;
  if (data.length > MAX_PART_BYTES) throw new XlsxFormatError(`${name} grande demais`);
  return data.toString('utf8');
}

/** Caminho da primeira aba: `workbook.xml` → relação da primeira `<sheet>` → alvo. */
function firstSheetPath(reader: ZipReader): string {
  const workbook = utf8(reader, 'xl/workbook.xml');
  if (workbook === null) throw new XlsxFormatError('sem xl/workbook.xml');
  const sheet = firstElement(workbook, 'sheet');
  const relationId = sheet === null ? undefined : attributes(sheet.attrs).get('r:id');
  const rels = utf8(reader, 'xl/_rels/workbook.xml.rels');
  if (relationId !== undefined && rels !== null) {
    for (const relation of elements(rels, 'Relationship')) {
      const attrs = attributes(relation.attrs);
      if (attrs.get('Id') !== relationId) continue;
      const target = attrs.get('Target') ?? '';
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      if (reader.has(path)) return path;
    }
  }
  if (reader.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  throw new XlsxFormatError('aba não encontrada');
}

function sharedStrings(reader: ZipReader): string[] {
  const xml = utf8(reader, 'xl/sharedStrings.xml');
  if (xml === null) return [];
  return [...elements(xml, 'si')].map((element) => richText(element.inner ?? ''));
}

const CELL_REF = /^([A-Z]{1,3})(\d{1,7})$/i;

/** Linhas não vazias da primeira aba, em ordem. */
export function readXlsx(buffer: Buffer, limits: XlsxReadLimits): XlsxReadRow[] {
  try {
    const reader = new ZipReader(buffer);
    const strings = sharedStrings(reader);
    const sheet = utf8(reader, firstSheetPath(reader));
    if (!sheet?.includes('<worksheet')) throw new XlsxFormatError('aba inválida');
    const data = firstElement(sheet, 'sheetData')?.inner ?? '';
    const rows: XlsxReadRow[] = [];
    let nextRow = 1;
    for (const rowElement of elements(data, 'row')) {
      const declared = Number(attributes(rowElement.attrs).get('r'));
      const rowNumber = Number.isInteger(declared) && declared > 0 ? declared : nextRow;
      nextRow = rowNumber + 1;
      const cells = new Map<number, XlsxReadCell>();
      let nextColumn = 0;
      for (const cellElement of elements(rowElement.inner ?? '', 'c')) {
        const attrs = attributes(cellElement.attrs);
        const ref = CELL_REF.exec(attrs.get('r') ?? '');
        const column = ref ? columnIndex(ref[1] ?? 'A') : nextColumn;
        nextColumn = column + 1;
        if (column >= limits.maxColumns) continue;
        const cell = readCell(attrs.get('t') ?? 'n', cellElement.inner ?? '', strings);
        if (cell !== null) cells.set(column, cell);
      }
      if (cells.size === 0) continue;
      if (rows.length >= limits.maxRows) throw new XlsxTooLargeError();
      rows.push({ row: rowNumber, cells });
    }
    return rows;
  } catch (error) {
    if (error instanceof ZipFormatError) throw new XlsxFormatError(error.message);
    throw error;
  }
}

function readCell(type: string, inner: string, strings: readonly string[]): XlsxReadCell | null {
  const value = firstElement(inner, 'v')?.inner ?? undefined;
  switch (type) {
    case 'inlineStr': {
      const text = richText(firstElement(inner, 'is')?.inner ?? '');
      return text.trim() === '' ? null : { kind: 'text', text };
    }
    case 's': {
      const text = value === undefined ? undefined : strings[Number(value)];
      return text === undefined || text.trim() === '' ? null : { kind: 'text', text };
    }
    case 'str': {
      const text = value === undefined ? '' : decodeXml(value);
      return text.trim() === '' ? null : { kind: 'text', text };
    }
    case 'b':
      return value === undefined ? null : { kind: 'boolean', text: value.trim() };
    case 'e':
      return { kind: 'error', text: value === undefined ? '#ERRO' : decodeXml(value).trim() };
    default: {
      const text = value === undefined ? '' : decodeXml(value).trim();
      return text === '' ? null : { kind: 'number', text };
    }
  }
}
