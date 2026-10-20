import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { ApiError } from '#shared/errors/api-error.js';

/*
 * Proteção de campos sensíveis (DEC-086 · US-025): criptografia de aplicação AES-256-GCM com
 * envelope encryption e *blind index* HMAC-SHA-256 para busca por igualdade e unicidade sem expor o
 * valor. Porta do shared kernel — `supplier` (CPF) e futuros campos sensíveis (segredos de
 * integração) a usam sem conhecer o provedor de chaves: local/dev/test usam `LocalKeyWrapper`
 * (chave de ambiente); produção troca o `KeyWrapper` pelo adaptador do KMS (ADR de infraestrutura).
 *
 * Formato do blob (`bytea`): `[versão 1B][tamanho da DEK cifrada 2B][DEK cifrada][iv 12B][tag 16B][texto cifrado]`.
 * Cada valor usa uma DEK nova; a DEK só sai do processo cifrada pela chave mestra.
 */

const BLOB_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD = Buffer.from('cf:field-protection:v1');

/** Cifra/decifra a chave de dados (DEK) com a chave mestra — o ponto de integração com o KMS. */
export interface KeyWrapper {
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

export const KEY_WRAPPER = Symbol('KeyWrapper');

export interface FieldProtection {
  /** Cifra o texto em claro; KMS/chave indisponível → `FieldProtectionUnavailableError` (503). */
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(blob: Buffer): Promise<string>;
  /** HMAC-SHA-256 (hex, 64) do valor já normalizado — determinístico, para igualdade. */
  blindIndex(normalized: string): string;
}

export const FIELD_PROTECTION = Symbol('FieldProtection');

/** KMS ou chave de criptografia indisponível: nada é gravado sem cifrar (503). */
export class FieldProtectionUnavailableError extends ApiError {
  constructor(cause: unknown) {
    super('DEPENDENCY_UNAVAILABLE', {
      detail: 'Não foi possível salvar agora. Tente novamente em instantes.',
      headers: { 'Retry-After': '5' },
      cause,
    });
    this.name = 'FieldProtectionUnavailableError';
  }
}

function seal(key: Buffer, iv: Buffer, input: Buffer): { out: Buffer; tag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const out = Buffer.concat([cipher.update(input), cipher.final()]);
  return { out, tag: cipher.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, input: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(input), decipher.final()]);
}

/** Chave mestra local (variável de ambiente): local/dev/test e testes. Produção usa o KMS. */
export class LocalKeyWrapper implements KeyWrapper {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== KEY_BYTES) throw new Error('A chave mestra deve ter 32 bytes.');
  }

  wrap(dataKey: Buffer): Promise<Buffer> {
    const iv = randomBytes(IV_BYTES);
    const { out, tag } = seal(this.masterKey, iv, dataKey);
    return Promise.resolve(Buffer.concat([iv, tag, out]));
  }

  unwrap(wrapped: Buffer): Promise<Buffer> {
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = wrapped.subarray(IV_BYTES + TAG_BYTES);
    return Promise.resolve(open(this.masterKey, iv, body, tag));
  }
}

/** Envelope encryption (DEK por valor, cifrada pelo `KeyWrapper`) + blind index HMAC. */
export class EnvelopeFieldProtection implements FieldProtection {
  constructor(
    private readonly wrapper: KeyWrapper,
    private readonly blindIndexKey: Buffer,
  ) {
    if (blindIndexKey.length < KEY_BYTES) {
      throw new Error('A chave do blind index deve ter ao menos 32 bytes.');
    }
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    const dataKey = randomBytes(KEY_BYTES);
    let wrapped: Buffer;
    try {
      wrapped = await this.wrapper.wrap(dataKey);
    } catch (error) {
      throw new FieldProtectionUnavailableError(error);
    }
    const iv = randomBytes(IV_BYTES);
    const { out, tag } = seal(dataKey, iv, Buffer.from(plaintext, 'utf8'));
    const header = Buffer.alloc(3);
    header.writeUInt8(BLOB_VERSION, 0);
    header.writeUInt16BE(wrapped.length, 1);
    return Buffer.concat([header, wrapped, iv, tag, out]);
  }

  async decrypt(blob: Buffer): Promise<string> {
    if (blob.length < 3 + IV_BYTES + TAG_BYTES || blob.readUInt8(0) !== BLOB_VERSION) {
      throw new Error('Valor criptografado inválido.');
    }
    const wrappedLength = blob.readUInt16BE(1);
    let offset = 3;
    const wrapped = blob.subarray(offset, offset + wrappedLength);
    offset += wrappedLength;
    const iv = blob.subarray(offset, offset + IV_BYTES);
    offset += IV_BYTES;
    const tag = blob.subarray(offset, offset + TAG_BYTES);
    offset += TAG_BYTES;
    let dataKey: Buffer;
    try {
      dataKey = await this.wrapper.unwrap(wrapped);
    } catch (error) {
      throw new FieldProtectionUnavailableError(error);
    }
    return open(dataKey, iv, blob.subarray(offset), tag).toString('utf8');
  }

  blindIndex(normalized: string): string {
    return createHmac('sha256', this.blindIndexKey).update(normalized, 'utf8').digest('hex');
  }
}
