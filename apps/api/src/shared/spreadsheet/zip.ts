import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/*
 * ZIP mínimo para a planilha XLSX (US-028 · reaproveitado pelo mapa comparativo — US-031): escrita
 * determinística (deflate, data fixa 1980-01-01, nomes UTF-8) e leitura pelo diretório central, sem
 * ZIP64, criptografia nem multi-volume. A leitura é defensiva — o arquivo vem do usuário: limita o
 * número de entradas e o tamanho descompactado de cada uma (bomba de compressão) e recusa qualquer
 * estrutura inconsistente com `ZipFormatError`.
 */

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntryInput {
  readonly name: string;
  readonly data: Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
const STORED = 0;
/** 1980-01-01 00:00 no formato DOS (bytes iguais para o mesmo conteúdo). */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

/** Arquivo ZIP com as entradas na ordem dada (deflate). */
export function writeZip(entries: readonly ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface ZipReadLimits {
  /** Entradas no diretório central. */
  readonly maxEntries: number;
  /** Bytes descompactados por entrada lida. */
  readonly maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipReadLimits = Object.freeze({
  maxEntries: 2_000,
  maxEntryBytes: 64 * 1024 * 1024,
});

interface CentralEntry {
  readonly method: number;
  readonly flags: number;
  readonly checksum: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/** Leitor de ZIP: lista os nomes e descompacta sob demanda, uma entrada por vez. */
export class ZipReader {
  private readonly entries = new Map<string, CentralEntry>();

  constructor(
    private readonly buffer: Buffer,
    private readonly limits: ZipReadLimits = DEFAULT_ZIP_LIMITS,
  ) {
    const end = findEndOfCentral(buffer);
    const count = buffer.readUInt16LE(end + 10);
    const directorySize = buffer.readUInt32LE(end + 12);
    const directoryOffset = buffer.readUInt32LE(end + 16);
    if (count > limits.maxEntries) throw new ZipFormatError('entradas demais');
    if (directoryOffset + directorySize > end)
      throw new ZipFormatError('diretório central inválido');
    let cursor = directoryOffset;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) {
        throw new ZipFormatError('entrada do diretório central inválida');
      }
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      this.entries.set(name, {
        flags: buffer.readUInt16LE(cursor + 8),
        method: buffer.readUInt16LE(cursor + 10),
        checksum: buffer.readUInt32LE(cursor + 16),
        compressedSize: buffer.readUInt32LE(cursor + 20),
        size: buffer.readUInt32LE(cursor + 24),
        localOffset: buffer.readUInt32LE(cursor + 42),
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Conteúdo descompactado da entrada; `null` se não existe. */
  read(name: string): Buffer | null {
    const entry = this.entries.get(name);
    if (entry === undefined) return null;
    if ((entry.flags & 0x1) !== 0) throw new ZipFormatError('entrada criptografada');
    if (entry.size > this.limits.maxEntryBytes) throw new ZipFormatError('entrada grande demais');
    const local = entry.localOffset;
    if (local + 30 > this.buffer.length || this.buffer.readUInt32LE(local) !== LOCAL_HEADER) {
      throw new ZipFormatError('cabeçalho local inválido');
    }
    const start =
      local + 30 + this.buffer.readUInt16LE(local + 26) + this.buffer.readUInt16LE(local + 28);
    const end = start + entry.compressedSize;
    if (end > this.buffer.length) throw new ZipFormatError('entrada truncada');
    const raw = this.buffer.subarray(start, end);
    let data: Buffer;
    if (entry.method === STORED) {
      data = Buffer.from(raw);
    } else if (entry.method === DEFLATE) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: this.limits.maxEntryBytes });
      } catch {
        throw new ZipFormatError('entrada corrompida');
      }
    } else {
      throw new ZipFormatError('método de compressão não suportado');
    }
    if (data.length !== entry.size || crc32(data) !== entry.checksum) {
      throw new ZipFormatError('entrada corrompida');
    }
    return data;
  }
}

/** Fim do diretório central: procura de trás para frente (comentário de até 64 KB). */
function findEndOfCentral(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let position = buffer.length - 22; position >= lowest; position -= 1) {
    if (buffer.readUInt32LE(position) === END_OF_CENTRAL) return position;
  }
  throw new ZipFormatError('não é um arquivo ZIP');
}
