import 'server-only';

import { timingSafeEqual } from 'node:crypto';

import { seal, unseal } from '../crypto';

/*
 * Cookie de transação do login (RN-IAM-02 · US-087 Lacuna 2): `state`, `nonce`, `code_verifier`,
 * `returnTo` e `createdAt` cifrados (AES-256-GCM) num cookie `__Host-` curto (`Max-Age=600`).
 * Guarda até 3 transações — login iniciado em várias abas —, cada uma de uso único e válida por
 * 10 min; a mais antiga é descartada quando entra a quarta.
 */

export const LOGIN_TRANSACTION_COOKIE = '__Host-cf_auth_tx';
export const LOGIN_TRANSACTION_MAX_AGE_SECONDS = 600;
export const LOGIN_TRANSACTION_TTL_MS = LOGIN_TRANSACTION_MAX_AGE_SECONDS * 1000;
export const MAX_LOGIN_TRANSACTIONS = 3;

export interface LoginTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Destino validado (RN-IAM-03). */
  readonly returnTo: string;
  /** Step-up (US-090): substitui os tokens da sessão existente. */
  readonly stepUp: boolean;
  /** Epoch em ms. */
  readonly createdAt: number;
}

function isTransaction(value: unknown): value is LoginTransaction {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.state === 'string' &&
    typeof item.nonce === 'string' &&
    typeof item.codeVerifier === 'string' &&
    typeof item.returnTo === 'string' &&
    typeof item.stepUp === 'boolean' &&
    typeof item.createdAt === 'number'
  );
}

function sameState(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sealTransactions(key: Buffer, transactions: readonly LoginTransaction[]): string {
  return seal(key, JSON.stringify(transactions), LOGIN_TRANSACTION_COOKIE);
}

/** Transações ainda válidas; cookie ausente, adulterado ou de outra chave → lista vazia. */
export function openTransactions(
  key: Buffer,
  value: string | null,
  now: number,
): LoginTransaction[] {
  if (!value) return [];
  const plain = unseal(key, value, LOGIN_TRANSACTION_COOKIE);
  if (plain === null) return [];
  try {
    const parsed: unknown = JSON.parse(plain);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isTransaction)
      .filter((item) => now - item.createdAt < LOGIN_TRANSACTION_TTL_MS && item.createdAt <= now);
  } catch {
    return [];
  }
}

/** Acrescenta uma transação, mantendo no máximo 3 (descarta a mais antiga). */
export function addTransaction(
  current: readonly LoginTransaction[],
  transaction: LoginTransaction,
): LoginTransaction[] {
  return [...current, transaction]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_LOGIN_TRANSACTIONS);
}

/** Retira (uso único) a transação do `state` recebido no callback. */
export function takeTransaction(
  current: readonly LoginTransaction[],
  state: string | null,
): { readonly transaction: LoginTransaction | null; readonly rest: LoginTransaction[] } {
  if (!state) return { transaction: null, rest: [...current] };
  const transaction = current.find((item) => sameState(item.state, state)) ?? null;
  return { transaction, rest: current.filter((item) => item !== transaction) };
}
