/*
 * Custo por geração (RN-AI-09 · DEC-079): `costUsd = inputTokens × preço de entrada + outputTokens
 * × preço de saída`, pela tabela de preços versionada da plataforma (`pricingVersion`), em
 * numeric(12,6). Aritmética inteira em micro-dólares — nada de ponto flutuante em dinheiro
 * (DEC-003). Modelo sem preço → `costUsd = null` (o chamador registra `warn ai.pricing_missing`).
 */

/** Preço em USD por milhão de tokens, como decimal em string (até 6 casas). */
export interface ModelPrice {
  readonly inputPerMillionUsd: string;
  readonly outputPerMillionUsd: string;
}

export interface PricingTable {
  readonly version: string;
  readonly models: Readonly<Record<string, ModelPrice>>;
}

export interface PricedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const MICROS = 1_000_000n;
const DECIMAL = /^\d{1,9}(?:\.\d{1,6})?$/;

/** "3.5" → 3_500_000 micro-USD. */
export function toMicros(decimal: string): bigint {
  if (!DECIMAL.test(decimal)) throw new Error(`Preço inválido na tabela: ${decimal}`);
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * MICROS + BigInt(fraction.padEnd(6, '0'));
}

/** 1_234_567 micro-USD → "1.234567". */
export function fromMicros(micros: bigint): string {
  const whole = micros / MICROS;
  const fraction = (micros % MICROS).toString().padStart(6, '0');
  return `${whole.toString()}.${fraction}`;
}

export interface CostResult {
  /** `null` = modelo sem preço na tabela. */
  readonly costUsd: string | null;
  readonly pricingVersion: string;
}

export function costOf(table: PricingTable, model: string, usage: PricedUsage): CostResult {
  const price = Object.hasOwn(table.models, model) ? table.models[model] : undefined;
  if (price === undefined) return { costUsd: null, pricingVersion: table.version };
  // Soma exata (tokens × micro-USD por milhão) e um único arredondamento, meio para cima.
  const numerator =
    BigInt(usage.inputTokens) * toMicros(price.inputPerMillionUsd) +
    BigInt(usage.outputTokens) * toMicros(price.outputPerMillionUsd);
  return { costUsd: fromMicros((numerator + MICROS / 2n) / MICROS), pricingVersion: table.version };
}
