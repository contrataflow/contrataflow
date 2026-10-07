import { z } from 'zod';

export interface TrimmedStringOptions {
  readonly min?: number;
  readonly max: number;
}

/** Texto com espaços das extremidades removidos e limites de tamanho. */
export function trimmedString({ min = 1, max }: TrimmedStringOptions) {
  return z
    .string()
    .trim()
    .min(min, { error: min === 1 ? 'Campo obrigatório.' : `Informe ao menos ${min} caracteres.` })
    .max(max, { error: `Informe no máximo ${max} caracteres.` });
}
