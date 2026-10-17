/*
 * CPF (US-025 · RN-PRICE-16): 11 dígitos, os dois últimos verificadores (módulo 11, pesos 10..2 e
 * 11..2; resto < 2 → dígito 0). Em repouso o número é criptografado e o que a API devolve é a
 * versão mascarada (`***.444.777-**`).
 */

const CPF_SHAPE = /^\d{11}$/;

/** Remove a máscara (`.`, `-`, espaços); o CPF só tem dígitos. */
export function normalizeCpf(value: string): string {
  return value.replace(/[.\-\s]/g, '');
}

function checkDigit(base: string): number {
  let sum = 0;
  for (let index = 0; index < base.length; index += 1) {
    sum += Number(base[index]) * (base.length + 1 - index);
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** O CPF (com ou sem máscara) tem formato e dígitos verificadores válidos? */
export function isValidCpf(value: string): boolean {
  const cpf = normalizeCpf(value);
  if (!CPF_SHAPE.test(cpf)) return false;
  // Sequências repetidas passam no módulo 11, mas não são CPFs emitidos.
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  const first = checkDigit(cpf.slice(0, 9));
  const second = checkDigit(`${cpf.slice(0, 9)}${first}`);
  return cpf.endsWith(`${first}${second}`);
}

/** `111.444.777-35` → `***.444.777-**` (RN-PRICE-16); entrada fora do formato volta sem alteração. */
export function maskCpf(value: string): string {
  const cpf = normalizeCpf(value);
  if (!CPF_SHAPE.test(cpf)) return value;
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
}

export const CPF_INVALID_MESSAGE = 'CPF inválido. Verifique o número digitado.';
