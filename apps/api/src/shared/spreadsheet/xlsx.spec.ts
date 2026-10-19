import { crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  columnIndex,
  columnLetter,
  decodeXml,
  escapeXml,
  readXlsx,
  writeXlsx,
  XlsxFormatError,
  XlsxTooLargeError,
} from './xlsx.js';
import { writeZip, ZipFormatError, ZipReader } from './zip.js';

/*
 * Camada de planilha (US-028 · reaproveitada pela US-031): ZIP determinístico e defensivo, XLSX de
 * uma aba escrito e lido sem dependência externa — inclusive o que o Excel/LibreOffice gravam
 * (textos compartilhados, texto rico, fórmulas, células sem referência).
 */

const LIMITS = { maxRows: 1000, maxColumns: 16_384 };
const text = (value: string) => Buffer.from(value, 'utf8');

const values = (buffer: Buffer) =>
  readXlsx(buffer, LIMITS).map((row) => ({
    row: row.row,
    cells: Object.fromEntries(
      [...row.cells.entries()].map(([column, cell]) => [columnLetter(column), cell]),
    ),
  }));

/** XLSX "à mão", como o Excel grava: textos compartilhados e aba em `xl/worksheets/folha.xml`. */
function excelLike(sheetData: string, sharedStrings: string | null = null): Buffer {
  return writeZip([
    {
      name: 'xl/workbook.xml',
      data: text(
        '<workbook xmlns:r="r"><sheets><sheet name="Plan1" sheetId="1" r:id="rId7"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text(
        '<Relationships><Relationship Id="rId1" Target="styles.xml"/><Relationship Id="rId7" Target="/xl/worksheets/folha.xml"/></Relationships>',
      ),
    },
    ...(sharedStrings === null
      ? []
      : [{ name: 'xl/sharedStrings.xml', data: text(`<sst>${sharedStrings}</sst>`) }]),
    {
      name: 'xl/worksheets/folha.xml',
      data: text(
        `<worksheet><cols><col min="1"/></cols><sheetData>${sheetData}</sheetData></worksheet>`,
      ),
    },
  ]);
}

describe('colunas', () => {
  it('converte índice ↔ letras (A, Z, AA, AZ, ZZ, AAA)', () => {
    for (const [index, letters] of [
      [0, 'A'],
      [25, 'Z'],
      [26, 'AA'],
      [51, 'AZ'],
      [701, 'ZZ'],
      [702, 'AAA'],
    ] as const) {
      expect(columnLetter(index)).toBe(letters);
      expect(columnIndex(letters)).toBe(index);
    }
  });
});

describe('XML', () => {
  it('escapa e decodifica entidades; remove caracteres de controle', () => {
    expect(escapeXml('a & b < "c" > d\u0001')).toBe('a &amp; b &lt; &quot;c&quot; &gt; d');
    expect(decodeXml('&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&nbsp;&#x110000;')).toBe(
      '&<>"\'AB&nbsp;&#x110000;',
    );
  });
});

describe('writeXlsx → readXlsx', () => {
  it('ida e volta: texto inline, números, cabeçalho e células vazias', () => {
    const file = writeXlsx({
      name: 'Cotações & preços',
      freezeHeader: true,
      columnWidths: [8, 40],
      rows: [
        [
          { kind: 'text', value: 'Item', style: 'header' },
          { kind: 'text', value: 'Descrição <do> item', style: 'header' },
          { kind: 'text', value: 'Painel de Preços', style: 'header' },
        ],
        [
          { kind: 'number', value: '1' },
          { kind: 'text', value: ' Cimento  ' },
          { kind: 'number', value: '150.2500', style: 'decimal4' },
        ],
        [{ kind: 'number', value: '2' }, null, null],
        [null, null, null],
      ],
    });
    expect(values(file)).toEqual([
      {
        row: 1,
        cells: {
          A: { kind: 'text', text: 'Item' },
          B: { kind: 'text', text: 'Descrição <do> item' },
          C: { kind: 'text', text: 'Painel de Preços' },
        },
      },
      {
        row: 2,
        cells: {
          A: { kind: 'number', text: '1' },
          B: { kind: 'text', text: ' Cimento  ' },
          C: { kind: 'number', text: '150.2500' },
        },
      },
      { row: 3, cells: { A: { kind: 'number', text: '2' } } },
    ]);
  });

  it('é determinístico (mesma entrada, mesmos bytes) e recusa número malformado', () => {
    const sheet = { name: 'A', rows: [[{ kind: 'number', value: '10.5' } as const]] };
    expect(writeXlsx(sheet).equals(writeXlsx(sheet))).toBe(true);
    expect(() => writeXlsx({ name: 'A', rows: [[{ kind: 'number', value: '1e3' }]] })).toThrow(
      /número inválido/,
    );
  });
});

describe('readXlsx — formatos do Excel/LibreOffice', () => {
  it('textos compartilhados (rico, sem fonética), fórmulas, booleanos, erros e células sem r', () => {
    const file = excelLike(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="4" spans="1:3"><c r="A4"><v>1</v></c><c r="B4" t="str"><f>A4*2</f><v>2</v></c><c r="C4" s="2"><v>150.24999999999997</v></c></row>' +
        '<row><c t="b"><v>1</v></c><c t="e"><v>#DIV/0!</v></c><c t="inlineStr"><is><t>x</t></is></c><c/></row>' +
        '<row r="9"><c r="A9" t="s"><v>2</v></c><c r="B9"/></row>',
      '<si><t>Item</t></si><si><r><t>Painel </t></r><r><rPr><b/></rPr><t xml:space="preserve">de Preços</t></r><rPh><t>X</t></rPh></si><si/>',
    );
    expect(values(file)).toEqual([
      {
        row: 1,
        cells: { A: { kind: 'text', text: 'Item' }, C: { kind: 'text', text: 'Painel de Preços' } },
      },
      {
        row: 4,
        cells: {
          A: { kind: 'number', text: '1' },
          B: { kind: 'text', text: '2' },
          C: { kind: 'number', text: '150.24999999999997' },
        },
      },
      {
        row: 5,
        cells: {
          A: { kind: 'boolean', text: '1' },
          B: { kind: 'error', text: '#DIV/0!' },
          C: { kind: 'text', text: 'x' },
        },
      },
    ]);
  });

  it('limites: linhas além do teto → XlsxTooLargeError; colunas além do teto ignoradas', () => {
    const rows = Array.from(
      { length: 5 },
      (_, index) =>
        `<row r="${String(index + 1)}"><c r="A${String(index + 1)}"><v>1</v></c><c r="D${String(index + 1)}"><v>2</v></c></row>`,
    ).join('');
    expect(() => readXlsx(excelLike(rows), { maxRows: 4, maxColumns: 10 })).toThrow(
      XlsxTooLargeError,
    );
    const read = readXlsx(excelLike(rows), { maxRows: 5, maxColumns: 2 });
    expect(read).toHaveLength(5);
    expect([...(read[0]?.cells.keys() ?? [])]).toEqual([0]);
  });

  it('arquivo que não é planilha → XlsxFormatError', () => {
    expect(() => readXlsx(text('não é um zip'), LIMITS)).toThrow(XlsxFormatError);
    expect(() => readXlsx(Buffer.alloc(0), LIMITS)).toThrow(XlsxFormatError);
    expect(() => readXlsx(writeZip([{ name: 'a.txt', data: text('x') }]), LIMITS)).toThrow(
      XlsxFormatError,
    );
    const noSheet = writeZip([
      { name: 'xl/workbook.xml', data: text('<workbook><sheets/></workbook>') },
    ]);
    expect(() => readXlsx(noSheet, LIMITS)).toThrow(XlsxFormatError);
    const notWorksheet = writeZip([
      { name: 'xl/workbook.xml', data: text('<workbook/>') },
      { name: 'xl/worksheets/sheet1.xml', data: text('<html/>') },
    ]);
    expect(() => readXlsx(notWorksheet, LIMITS)).toThrow(XlsxFormatError);
    expect(() => readXlsx(excelLike('<row r="1"><c r="A1"><v>1</v>'), LIMITS)).toThrow(
      XlsxFormatError,
    );
    expect(() => readXlsx(excelLike('<row r="1"><c r="A1"'), LIMITS)).toThrow(XlsxFormatError);
    expect(() => readXlsx(excelLike('', '<si><rPh>x</si>'), LIMITS)).toThrow(XlsxFormatError);
  });
});

describe('ZipReader', () => {
  const zip = writeZip([
    { name: 'a.txt', data: text('olá') },
    { name: 'pasta/b.txt', data: text('b'.repeat(1000)) },
  ]);

  it('lista e lê as entradas; entrada ausente = null', () => {
    const reader = new ZipReader(zip);
    expect(reader.names()).toEqual(['a.txt', 'pasta/b.txt']);
    expect(reader.read('a.txt')?.toString('utf8')).toBe('olá');
    expect(reader.read('pasta/b.txt')).toHaveLength(1000);
    expect(reader.read('c.txt')).toBeNull();
  });

  it('lê entrada armazenada (método 0)', () => {
    const data = text('olá');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(5, 26);
    const name = text('x.txt');
    const raw = Buffer.concat([local, name, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(5, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + 5, 12);
    end.writeUInt32LE(raw.length, 16);
    const file = Buffer.concat([raw, central, name, end]);
    expect(new ZipReader(file).read('x.txt')?.toString('utf8')).toBe('olá');
  });

  it('recusa conteúdo corrompido, entradas demais e bomba de compressão', () => {
    const corrupted = Buffer.from(zip);
    // Byte no meio do dado compactado da primeira entrada.
    corrupted[36] = (corrupted[36] ?? 0) ^ 0xff;
    expect(() => new ZipReader(corrupted).read('a.txt')).toThrow(ZipFormatError);
    expect(() => new ZipReader(zip, { maxEntries: 1, maxEntryBytes: 10_000 })).toThrow(
      ZipFormatError,
    );
    expect(() =>
      new ZipReader(zip, { maxEntries: 10, maxEntryBytes: 100 }).read('pasta/b.txt'),
    ).toThrow(ZipFormatError);
    // Tamanho declarado mentindo: o inflate para no teto.
    const bomb = writeZip([{ name: 'big', data: Buffer.alloc(200_000) }]);
    const lying = Buffer.from(bomb);
    const centralStart = lying.length - 22 - 46 - 3;
    lying.writeUInt32LE(10, centralStart + 24);
    expect(() => new ZipReader(lying, { maxEntries: 10, maxEntryBytes: 1000 }).read('big')).toThrow(
      ZipFormatError,
    );
  });
});
