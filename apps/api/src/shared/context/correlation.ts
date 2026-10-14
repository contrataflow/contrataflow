import { randomUUID } from 'node:crypto';

/** Cabeçalho de correlação, fixo por contrato (api.md §1.1 · `CORRELATION_HEADER_NAME`). */
export const CORRELATION_HEADER = 'X-Correlation-Id';

/** Valor aceito do cliente: curto e sem caracteres que permitam injeção em logs/cabeçalhos. */
const ACCEPTED = /^[A-Za-z0-9._:-]{1,128}$/;

/** Usa o `X-Correlation-Id` recebido quando válido; senão gera um novo (FA-05). */
export function resolveCorrelationId(received: string | undefined): string {
  return received !== undefined && ACCEPTED.test(received) ? received : randomUUID();
}
