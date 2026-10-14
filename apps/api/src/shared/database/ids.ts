import { randomBytes } from 'node:crypto';

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
