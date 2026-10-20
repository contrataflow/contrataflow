import { createHash, randomBytes } from 'node:crypto';

/** Maior valor do contador de 12 bits (`rand_a`) usado para ordenar ids do mesmo milissegundo. */
const COUNTER_MAX = 0xfff;

let lastMs = -1;
let counter = 0;

/**
 * Chave primária UUIDv7 (RFC 9562) gerada pela aplicação — DEC-002 · ADR-011 · RN-FND-39:
 * 48 bits de milissegundos Unix, versão 7, contador monotônico de 12 bits (ids do mesmo processo
 * saem em ordem crescente) e 62 bits aleatórios. Nunca sequencial nem previsível.
 */
export function newId(now: number = Date.now()): string {
  let ms = now;
  if (ms <= lastMs) {
    // Mesmo milissegundo (ou relógio que voltou): avança o contador; esgotado, avança o tempo.
    ms = lastMs;
    counter += 1;
    if (counter > COUNTER_MAX) {
      ms += 1;
      counter = 0;
    }
  } else {
    // Começa na metade inferior: sobra espaço para incrementos dentro do milissegundo.
    counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  lastMs = ms;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes.writeUInt16BE(0x7000 | counter, 6);
  bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UUID textual (qualquer versão RFC 9562): valida o `tenantId` antes do `set_config`. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * UUIDv7 DETERMINÍSTICO para chaves naturais (US-116 · DEC-079): os 48 bits de tempo são o instante
 * informado (ex.: início do mês) e os 74 bits restantes vêm do SHA-256 do nome — o mesmo
 * `(nome, instante)` dá sempre o mesmo id. Uso: `eventId` do aviso de consumo de IA por
 * `(tenant, mês, faixa)`, gravado com `recordOnce` (o envelope DEC-160 exige UUIDv7, por isso não
 * é um UUID v5).
 */
export function naturalKeyId(name: string, at: Date): string {
  const bytes = createHash('sha256').update(name, 'utf8').digest().subarray(0, 16);
  bytes.writeUIntBE(at.getTime(), 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
