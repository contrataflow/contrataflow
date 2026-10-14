/** Cabeçalho de correlação, fixo por contrato (api.md §1.1 · observability.md §3). */
export const CORRELATION_HEADER = 'X-Correlation-Id';

/**
 * Valor aceito de quem chama (RN-FND-74 · V-01): 8 a 64 caracteres sem espaço nem caractere que
 * permita injeção em logs ou cabeçalhos.
 */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

/** Usa o valor recebido quando válido; ausente ou inválido, descarta-o e gera um UUIDv7 (FA-01). */
export function resolveCorrelationId(received: string | null | undefined): string {
  return isValidCorrelationId(received) ? received : uuidv7();
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/**
 * UUIDv7 (RFC 9562): 48 bits de milissegundos Unix, versão, variante e 74 bits aleatórios. Usa
 * a Web Crypto global para servir tanto ao Node (api, worker) quanto ao runtime do Next (BFF).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
