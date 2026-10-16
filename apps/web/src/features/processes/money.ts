/*
 * Valor estimado em reais (US-001 · RN-PROC-10): a pessoa digita no formato brasileiro ("15.000,50"
 * ou "15000,5") e a API recebe sempre a string decimal com ponto ("15000.50") — nunca um `number`.
 */

/** "R$" e espaços (o `\s` já cobre o NBSP) que a pessoa pode ter colado. */
const NOISE = /^(?:r\$)?\s*|\s+$/gi;
const THOUSANDS_ONLY = /^\d{1,3}(?:\.\d{3})+$/;
const DOT_DECIMAL = /^\d+\.\d{1,2}$/;

/**
 * Texto digitado → string decimal com ponto. Vazio → `undefined` (campo opcional não preenchido).
 * Texto que não é número devolve o próprio texto limpo: o schema da API o reprova com a mensagem
 * "Informe um valor válido, com até 2 casas decimais." (V-08).
 */
export function parseMoneyText(text: string): string | undefined {
  const clean = text.replace(NOISE, '');
  if (clean === '') return undefined;
  if (clean.includes(',')) return clean.replaceAll('.', '').replace(',', '.');
  if (THOUSANDS_ONLY.test(clean)) return clean.replaceAll('.', '');
  if (DOT_DECIMAL.test(clean)) return clean;
  return clean;
}

const DECIMAL = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

/** A string decimal já está no formato da API (sem sinal, até 2 casas)? */
export function isDecimalMoney(value: string): boolean {
  return DECIMAL.test(value);
}

/** Texto digitado → decimal com exatamente 2 casas ("15000,5" → "15000.50"); inválido → `null`. */
export function toDecimalMoney(text: string): string | null {
  const parsed = parseMoneyText(text);
  if (parsed === undefined || !isDecimalMoney(parsed)) return null;
  const [whole = '0', cents = ''] = parsed.split('.');
  return `${whole}.${cents.padEnd(2, '0')}`;
}

/** String decimal → exibição brasileira sem símbolo ("15000.50" → "15.000,50"). */
export function formatMoneyText(decimal: string): string {
  const [whole = '0', cents = '00'] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${cents.padEnd(2, '0')}`;
}

/**
 * Ao sair do campo: valor válido é normalizado para a exibição brasileira com 2 casas; inválido
 * fica como foi digitado (o erro é mostrado ao validar o passo).
 */
export function normalizeMoneyText(text: string): string {
  const decimal = toDecimalMoney(text);
  return decimal === null ? text.trim() : formatMoneyText(decimal);
}
