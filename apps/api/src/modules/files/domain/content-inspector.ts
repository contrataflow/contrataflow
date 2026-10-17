import { UPLOAD_FILE_TYPES } from '@contrataflow/types';
import type { AttachmentReasonCode, UploadExtension, UploadFileFamily } from '@contrataflow/types';

/*
 * Checagem do conteúdo REAL do arquivo na varredura (US-068 · RN-DOC-74 · storage.md §5.3/§7):
 * detecção por *magic bytes* nos primeiros 8 KB e checagens estruturais incrementais, alimentadas
 * pelo MESMO stream que calcula o SHA-256 e vai ao ClamAV (*tee* — nenhuma leitura extra). Puro:
 * recebe pedaços de bytes e devolve o veredito.
 *
 * - Conteúdo que não corresponde à extensão declarada → `TYPE_MISMATCH` (ex.: `.pdf` com bytes de
 *   executável); extensão que o tenant deixou de permitir → `TYPE_NOT_ALLOWED`.
 * - PDF criptografado → `ENCRYPTED_CONTENT`; DOCX/XLSX com `vbaProject.bin` ou ODF com `Basic/` →
 *   `MACRO_CONTENT`; imagem acima de 12.000 px, texto com linha > 1 MB ou caractere de controle →
 *   `STRUCTURAL_CHECK_FAILED`; zero bytes → `EMPTY_FILE`.
 */

export type ContentVerdict =
  | { readonly ok: true; readonly detectedMimeType: string }
  | {
      readonly ok: false;
      readonly reasonCode: AttachmentReasonCode;
      readonly detectedMimeType: string | null;
    };

/** Tamanho da janela de detecção por *magic bytes* (RN-DOC-74). */
export const HEAD_BYTES = 8 * 1024;

const MAX_IMAGE_SIDE = 12_000;
const MAX_TEXT_LINE = 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const PDF_ENCRYPT = Buffer.from('/Encrypt', 'latin1');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Detected {
  readonly family: UploadFileFamily | 'zip';
  readonly mimeType: string | null;
}

function startsWith(buffer: Buffer, magic: Buffer, offset = 0): boolean {
  return (
    buffer.length >= offset + magic.length &&
    buffer.subarray(offset, offset + magic.length).equals(magic)
  );
}

/** Bytes que nunca aparecem em texto (NUL e controles fora de TAB/LF/FF/CR/ESC/SUB). */
function isBinaryByte(byte: number): boolean {
  return (
    (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b && byte !== 0x1a)) && byte !== 0x0c
  );
}

/** Detecção pelos primeiros bytes (storage.md §7, coluna "Assinatura"). */
export function detectHead(head: Buffer): Detected | null {
  if (head.subarray(0, 1024).includes(PDF_MAGIC)) {
    return { family: 'pdf', mimeType: 'application/pdf' };
  }
  if (startsWith(head, PNG_MAGIC)) return { family: 'png', mimeType: 'image/png' };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { family: 'jpeg', mimeType: 'image/jpeg' };
  }
  if (startsWith(head, ZIP_LOCAL_HEADER)) {
    const odf = odfMimeType(head);
    return odf === null ? { family: 'zip', mimeType: null } : { family: 'odf', mimeType: odf };
  }
  if (head.length > 0 && !head.some(isBinaryByte)) {
    return { family: 'text', mimeType: 'text/plain' };
  }
  return null;
}

/** ODF: primeira entrada `mimetype`, sem compressão, com o MIME do pacote. */
function odfMimeType(head: Buffer): string | null {
  if (head.length < 30) return null;
  const method = head.readUInt16LE(8);
  const size = head.readUInt32LE(18);
  const nameLength = head.readUInt16LE(26);
  const extraLength = head.readUInt16LE(28);
  const name = head.toString('latin1', 30, 30 + nameLength);
  if (name !== 'mimetype' || method !== 0 || size > 100) return null;
  const start = 30 + nameLength + extraLength;
  if (head.length < start + size) return null;
  return head.toString('latin1', start, start + size);
}

/** Lado (largura, altura) de PNG (IHDR) ou JPEG (marcador SOFn) quando está nos primeiros bytes. */
export function imageSize(head: Buffer, family: 'png' | 'jpeg'): readonly [number, number] | null {
  if (family === 'png') {
    return head.length >= 24 ? [head.readUInt32BE(16), head.readUInt32BE(20)] : null;
  }
  let offset = 2;
  while (offset + 9 < head.length) {
    if (head[offset] !== 0xff) return null;
    const marker = head[offset + 1] ?? 0;
    const length = head.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return [head.readUInt16BE(offset + 7), head.readUInt16BE(offset + 5)];
    offset += 2 + length;
  }
  return null;
}

/** Procura uma sequência ao longo do stream (com sobreposição entre pedaços). */
class SequenceScanner {
  private carry = Buffer.alloc(0);
  found = false;

  constructor(private readonly needle: Buffer) {}

  update(chunk: Buffer): void {
    if (this.found) return;
    const window = Buffer.concat([this.carry, chunk]);
    if (window.includes(this.needle)) {
      this.found = true;
      return;
    }
    this.carry = window.subarray(Math.max(0, window.length - this.needle.length + 1));
  }
}

/** Nomes das entradas do ZIP pelos cabeçalhos locais, ao longo do stream. */
class ZipEntryScanner {
  private carry = Buffer.alloc(0);
  private consumed = 0;
  private readonly seen = new Set<number>();
  readonly names: string[] = [];

  update(chunk: Buffer): void {
    if (this.names.length >= MAX_ZIP_ENTRIES) return;
    const window = Buffer.concat([this.carry, chunk]);
    const windowStart = this.consumed - this.carry.length;
    this.consumed += chunk.length;
    let from = 0;
    let incomplete: number | null = null;
    for (;;) {
      const position = window.indexOf(ZIP_LOCAL_HEADER, from);
      if (position < 0) break;
      if (position + 30 > window.length) {
        incomplete = position;
        break;
      }
      const nameLength = window.readUInt16LE(position + 26);
      if (position + 30 + nameLength > window.length) {
        incomplete = position;
        break;
      }
      const absolute = windowStart + position;
      if (!this.seen.has(absolute)) {
        this.seen.add(absolute);
        this.names.push(window.toString('utf8', position + 30, position + 30 + nameLength));
      }
      from = position + 4;
    }
    this.carry =
      incomplete === null
        ? window.subarray(Math.max(0, window.length - (ZIP_LOCAL_HEADER.length - 1)))
        : window.subarray(incomplete);
  }
}

/** Linhas de texto: comprimento máximo e caracteres de controle ao longo do stream. */
class TextScanner {
  private lineLength = 0;
  invalid = false;

  update(chunk: Buffer): void {
    if (this.invalid) return;
    for (const byte of chunk) {
      if (isBinaryByte(byte)) {
        this.invalid = true;
        return;
      }
      if (byte === 0x0a) {
        this.lineLength = 0;
      } else if (++this.lineLength > MAX_TEXT_LINE) {
        this.invalid = true;
        return;
      }
    }
  }
}

export interface InspectorOptions {
  /** Extensão declarada na intenção (já validada contra a allowlist). */
  readonly extension: UploadExtension;
  /** Allowlist efetiva do tenant NO MOMENTO da varredura. */
  readonly allowedExtensions: readonly string[];
}

export class ContentInspector {
  private head = Buffer.alloc(0);
  private detected: Detected | null = null;
  private headDone = false;
  private total = 0;
  private early: ContentVerdict | null = null;
  private readonly encrypt = new SequenceScanner(PDF_ENCRYPT);
  private readonly zip = new ZipEntryScanner();
  private readonly text = new TextScanner();

  constructor(private readonly options: InspectorOptions) {}

  private get expected() {
    return UPLOAD_FILE_TYPES[this.options.extension];
  }

  /**
   * Alimenta o próximo pedaço. Devolve um veredito de rejeição assim que ele é certo (tipo
   * divergente já nos primeiros 8 KB — o chamador pode abortar o stream), senão `null`.
   */
  update(chunk: Buffer): ContentVerdict | null {
    if (this.early) return this.early;
    this.total += chunk.length;
    if (!this.headDone) {
      this.head = Buffer.concat([this.head, chunk]).subarray(0, HEAD_BYTES);
      if (this.head.length >= HEAD_BYTES) this.closeHead();
    }
    const family = this.detected?.family ?? this.expected.family;
    if (family === 'pdf') this.encrypt.update(chunk);
    if (family === 'zip' || family === 'odf' || family === 'ooxml') this.zip.update(chunk);
    if (family === 'text') this.text.update(chunk);
    return this.early;
  }

  private closeHead(): void {
    this.headDone = true;
    this.detected = detectHead(this.head);
    this.early = this.typeVerdict();
  }

  /** Coerência entre o conteúdo e a extensão declarada (apenas o que os primeiros bytes decidem). */
  private typeVerdict(): ContentVerdict | null {
    if (!this.options.allowedExtensions.includes(this.options.extension)) {
      return { ok: false, reasonCode: 'TYPE_NOT_ALLOWED', detectedMimeType: this.detectedMime() };
    }
    const expected = this.expected;
    const detected = this.detected;
    const mismatch = (): ContentVerdict => ({
      ok: false,
      reasonCode: 'TYPE_MISMATCH',
      detectedMimeType: this.detectedMime(),
    });
    if (detected === null) return mismatch();
    if (expected.family === 'ooxml') return detected.family === 'zip' ? null : mismatch();
    if (expected.family === 'odf') {
      return detected.family === 'odf' && detected.mimeType === expected.mimeType
        ? null
        : mismatch();
    }
    return detected.family === expected.family ? null : mismatch();
  }

  private detectedMime(): string | null {
    return this.detected?.mimeType ?? null;
  }

  finish(): ContentVerdict {
    if (this.total === 0) return { ok: false, reasonCode: 'EMPTY_FILE', detectedMimeType: null };
    if (!this.headDone) this.closeHead();
    if (this.early) return this.early;
    const expected = this.expected;
    const reject = (reasonCode: AttachmentReasonCode): ContentVerdict => ({
      ok: false,
      reasonCode,
      detectedMimeType: expected.mimeType,
    });
    switch (expected.family) {
      case 'pdf':
        return this.encrypt.found ? reject('ENCRYPTED_CONTENT') : this.clean();
      case 'ooxml': {
        const names = this.zip.names;
        if (!names.includes('[Content_Types].xml')) {
          return { ok: false, reasonCode: 'TYPE_MISMATCH', detectedMimeType: null };
        }
        if (!names.some((name) => name.startsWith(expected.ooxmlPart))) {
          return { ok: false, reasonCode: 'TYPE_MISMATCH', detectedMimeType: null };
        }
        return names.some((name) => name.toLowerCase().endsWith('vbaproject.bin'))
          ? reject('MACRO_CONTENT')
          : this.clean();
      }
      case 'odf':
        return this.zip.names.some(
          (name) => name.startsWith('Basic/') || name.startsWith('Scripts/'),
        )
          ? reject('MACRO_CONTENT')
          : this.clean();
      case 'png':
      case 'jpeg': {
        const size = imageSize(this.head, expected.family);
        if (size !== null && (size[0] > MAX_IMAGE_SIDE || size[1] > MAX_IMAGE_SIDE)) {
          return reject('STRUCTURAL_CHECK_FAILED');
        }
        return this.clean();
      }
      case 'text':
        return this.text.invalid ? reject('STRUCTURAL_CHECK_FAILED') : this.clean();
    }
  }

  private clean(): ContentVerdict {
    return { ok: true, detectedMimeType: this.expected.mimeType };
  }
}
