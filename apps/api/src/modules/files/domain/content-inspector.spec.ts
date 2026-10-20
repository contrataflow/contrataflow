import type { UploadExtension } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { ContentInspector, HEAD_BYTES, detectHead, imageSize } from './content-inspector.js';
import type { ContentVerdict } from './content-inspector.js';

const ALL = ['pdf', 'docx', 'xlsx', 'odt', 'ods', 'csv', 'txt', 'png', 'jpg', 'jpeg'];

/** Cabeçalho local de ZIP com a entrada (sem compressão). */
function zipEntry(name: string, content = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(content.length, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, Buffer.from(name), content]);
}

function zip(...entries: readonly (readonly [string, string?])[]): Buffer {
  return Buffer.concat(entries.map(([name, text]) => zipEntry(name, Buffer.from(text ?? ''))));
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(32)]);
}

/** Alimenta o inspetor em pedaços pequenos (fronteiras no meio das assinaturas). */
function inspect(
  extension: UploadExtension,
  bytes: Buffer,
  options: { chunk?: number; allowed?: string[] } = {},
): ContentVerdict {
  const inspector = new ContentInspector({ extension, allowedExtensions: options.allowed ?? ALL });
  const size = options.chunk ?? 7;
  for (let offset = 0; offset < bytes.length; offset += size) {
    const early = inspector.update(bytes.subarray(offset, offset + size));
    if (early !== null) return early;
  }
  return inspector.finish();
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF');
const DOCX = zip(
  ['[Content_Types].xml', '<Types/>'],
  ['_rels/.rels'],
  ['word/document.xml', '<w/>'],
);

describe('ContentInspector (RN-DOC-74 · storage.md §7)', () => {
  it.each([
    ['pdf', PDF, 'application/pdf'],
    ['docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    [
      'xlsx',
      zip(['[Content_Types].xml'], ['xl/workbook.xml']),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    [
      'odt',
      zip(['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml']),
      'application/vnd.oasis.opendocument.text',
    ],
    ['png', png(800, 600), 'image/png'],
    ['jpg', jpeg(1024, 768), 'image/jpeg'],
    ['csv', Buffer.from('item;valor\r\ncadeira;10,00\r\n'), 'text/csv'],
    ['txt', Buffer.from('Consulta ao Painel de Preços em 17/10/2026\n', 'latin1'), 'text/plain'],
  ] as const)('%s válido → limpo com o MIME canônico', (extension, bytes, mime) => {
    expect(inspect(extension, bytes)).toEqual({ ok: true, detectedMimeType: mime });
  });

  it('vazio → EMPTY_FILE', () => {
    expect(inspect('pdf', Buffer.alloc(0))).toEqual({
      ok: false,
      reasonCode: 'EMPTY_FILE',
      detectedMimeType: null,
    });
  });

  it.each([
    ['pdf', Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(9000, 1)])],
    ['pdf', png(10, 10)],
    ['png', PDF],
    ['docx', PDF],
    ['docx', zip(['mimetype', 'application/vnd.oasis.opendocument.text'])],
    ['odt', DOCX],
    ['txt', Buffer.from([0x41, 0x00, 0x42])],
    ['jpg', Buffer.from('texto qualquer')],
  ] as const)('%s com outro conteúdo → TYPE_MISMATCH', (extension, bytes) => {
    expect(inspect(extension, bytes)).toMatchObject({ ok: false, reasonCode: 'TYPE_MISMATCH' });
  });

  it('ZIP genérico como docx (sem [Content_Types].xml ou sem word/) → TYPE_MISMATCH', () => {
    expect(inspect('docx', zip(['a.txt', 'x']))).toMatchObject({ reasonCode: 'TYPE_MISMATCH' });
    expect(inspect('docx', zip(['[Content_Types].xml'], ['xl/workbook.xml']))).toMatchObject({
      reasonCode: 'TYPE_MISMATCH',
    });
  });

  it('decide o tipo cedo: rejeição já nos primeiros 8 KB (aborta o stream)', () => {
    const inspector = new ContentInspector({ extension: 'pdf', allowedExtensions: ALL });
    const early = inspector.update(Buffer.alloc(HEAD_BYTES, 0x01));
    expect(early).toMatchObject({ ok: false, reasonCode: 'TYPE_MISMATCH' });
    expect(inspector.update(Buffer.from('mais'))).toBe(early);
  });

  it('extensão que o tenant deixou de permitir → TYPE_NOT_ALLOWED', () => {
    expect(inspect('pdf', PDF, { allowed: ['png'] })).toMatchObject({
      reasonCode: 'TYPE_NOT_ALLOWED',
    });
  });

  it('PDF criptografado (mesmo com /Encrypt partido entre pedaços) → ENCRYPTED_CONTENT', () => {
    const encrypted = Buffer.concat([PDF, Buffer.from('\ntrailer << /Encrypt 5 0 R >>')]);
    expect(inspect('pdf', encrypted, { chunk: 3 })).toMatchObject({
      reasonCode: 'ENCRYPTED_CONTENT',
    });
  });

  it('macros: vbaProject.bin no OOXML e Basic/ no ODF → MACRO_CONTENT', () => {
    const docm = Buffer.concat([DOCX, zipEntry('word/vbaProject.bin', Buffer.alloc(20))]);
    expect(inspect('docx', docm, { chunk: 5 })).toMatchObject({ reasonCode: 'MACRO_CONTENT' });
    const ods = zip(
      ['mimetype', 'application/vnd.oasis.opendocument.spreadsheet'],
      ['Basic/Standard/Module1.xml'],
    );
    expect(inspect('ods', ods)).toMatchObject({ reasonCode: 'MACRO_CONTENT' });
  });

  it('imagem acima de 12.000 px → STRUCTURAL_CHECK_FAILED', () => {
    expect(inspect('png', png(12_001, 10))).toMatchObject({
      reasonCode: 'STRUCTURAL_CHECK_FAILED',
    });
    expect(inspect('jpeg', jpeg(100, 20_000))).toMatchObject({
      reasonCode: 'STRUCTURAL_CHECK_FAILED',
    });
  });

  it('texto com controle no meio ou linha > 1 MB → STRUCTURAL_CHECK_FAILED', () => {
    const control = Buffer.concat([Buffer.alloc(HEAD_BYTES, 0x41), Buffer.from([0x00])]);
    expect(inspect('txt', control, { chunk: 4096 })).toMatchObject({
      reasonCode: 'STRUCTURAL_CHECK_FAILED',
    });
    const longLine = Buffer.alloc(1024 * 1024 + 1, 0x41);
    expect(inspect('csv', longLine, { chunk: 65_536 })).toMatchObject({
      reasonCode: 'STRUCTURAL_CHECK_FAILED',
    });
  });
});

describe('detectHead e imageSize', () => {
  it('desconhecido binário → null; JPEG sem SOF nos primeiros bytes → sem tamanho', () => {
    expect(detectHead(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), 'jpeg')).toBeNull();
    expect(
      imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x02, 0, 0, 0, 0, 0]), 'jpeg'),
    ).toBeNull();
    expect(imageSize(Buffer.alloc(10), 'png')).toBeNull();
  });
});
