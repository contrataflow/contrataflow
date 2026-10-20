import { z } from 'zod';

/*
 * CNPJ (entities.md `Organization.cnpj` · RN-TEN-04): 14 posições, as 12 primeiras numéricas ou
 * alfanuméricas (CNPJ alfanumérico da Receita Federal, a partir de 2026) e 2 dígitos verificadores
 * numéricos. Cada caractere vale o código ASCII − 48 (`0`–`9` → 0–9; `A`–`Z` → 17–42); o DV é o
 * módulo 11 com os pesos 2–9 da direita para a esquerda.
 */

const CNPJ_SHAPE = /^[0-9A-Z]{12}[0-9]{2}$/;
const FIRST_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SECOND_WEIGHTS = [6, ...FIRST_WEIGHTS];

/** Remove a máscara (`.`, `/`, `-`, espaços) e coloca as letras em maiúsculas. */
export function normalizeCnpj(value: string): string {
  return value.replace(/[.\-/\s]/g, '').toUpperCase();
}

function checkDigit(base: string, weights: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < weights.length; index += 1) {
    sum += (base.charCodeAt(index) - 48) * (weights[index] ?? 0);
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** O CNPJ (com ou sem máscara) tem formato e dígitos verificadores válidos? */
export function isValidCnpj(value: string): boolean {
  const cnpj = normalizeCnpj(value);
  if (!CNPJ_SHAPE.test(cnpj)) return false;
  // Sequências repetidas passam no módulo 11, mas não são CNPJs emitidos.
  if (/^(.)\1{13}$/.test(cnpj)) return false;
  const first = checkDigit(cnpj.slice(0, 12), FIRST_WEIGHTS);
  const second = checkDigit(`${cnpj.slice(0, 12)}${first}`, SECOND_WEIGHTS);
  return cnpj.endsWith(`${first}${second}`);
}

export const CNPJ_INVALID_MESSAGE = 'CNPJ inválido. Confira os dígitos verificadores.';

/** CNPJ normalizado (14 posições sem máscara); DV inválido → `INVALID_CNPJ` (V-06). */
export const cnpjSchema = z
  .string({ error: 'Informe o CNPJ.' })
  .trim()
  .min(1, { error: 'Informe o CNPJ.' })
  .transform(normalizeCnpj)
  .refine(isValidCnpj, { message: CNPJ_INVALID_MESSAGE, params: { code: 'INVALID_CNPJ' } });
