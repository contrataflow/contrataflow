import 'server-only';

/** Cabeçalho de correlação, fixo por contrato (api.md §1.1). */
export const CORRELATION_HEADER = 'X-Correlation-Id';

/**
 * Valor aceito do browser: curto e sem caracteres que permitam injeção em logs/cabeçalhos — a
 * mesma regra da API (US-080/US-084). Inválido ou ausente → um novo UUID (gerado no BFF).
 */
const ACCEPTED = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidCorrelationId(value: string | null | undefined): value is string {
  return typeof value === 'string' && ACCEPTED.test(value);
}

export function resolveCorrelationId(received: string | null | undefined): string {
  return isValidCorrelationId(received) ? received : crypto.randomUUID();
}
