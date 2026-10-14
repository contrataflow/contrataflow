/*
 * Formatação pt-BR (architecture.md §8.10 · RN-FND-95): datas no fuso do tenant e dinheiro a
 * partir da string decimal da API — nunca convertida para `number` (sem perda de precisão).
 */

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** Valor monetário a partir da string decimal da API (ex.: "1234567.89"). */
export function formatMoney(value: string, currency = 'BRL'): string {
  if (!DECIMAL.test(value)) throw new Error('Valor monetário deve ser string decimal.');
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(
    value as Intl.StringNumericLiteral,
  );
}

/** Data e hora no fuso informado (IANA — `Tenant.timezone`). */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
}
