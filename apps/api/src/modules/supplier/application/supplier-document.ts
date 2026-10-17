import { normalizeCnpj, normalizeCpf, normalizeSupplierDocument } from '@contrataflow/validation';
import type { SupplierDocumentType } from '@contrataflow/validation';

import type { FieldProtection } from '#shared/crypto/field-protection.js';

import type { ProtectedDocument } from '../domain/supplier.js';

/*
 * Proteção do número do documento (RN-PRICE-16/17/18 · DEC-086): o blind index é o HMAC do número
 * normalizado e em maiúsculas — a unicidade e o SUP-06 comparam hashes, nunca o CPF. Só o CPF é
 * cifrado; CNPJ e estrangeiro ficam em claro (a unicidade do estrangeiro usa o próprio valor
 * normalizado, via o mesmo hash).
 */

function hashOf(protection: FieldProtection, normalized: string): string {
  return protection.blindIndex(normalized.toUpperCase());
}

/**
 * Normaliza, gera o blind index e (CPF) cifra o número. Falha do KMS aqui — antes de abrir a
 * transação — vira 503 e nada é gravado (Falha de integração da US-025).
 */
export async function protectDocument(
  protection: FieldProtection,
  documentType: SupplierDocumentType,
  raw: string,
): Promise<ProtectedDocument> {
  const normalized = normalizeSupplierDocument(documentType, raw);
  return {
    normalized,
    hash: hashOf(protection, normalized),
    encrypted: documentType === 'CPF' ? await protection.encrypt(normalized) : null,
  };
}

/** Blind index do documento informado para o tipo (conferência de imutabilidade na edição). */
export function documentHash(
  protection: FieldProtection,
  documentType: SupplierDocumentType,
  raw: string,
): string {
  return hashOf(protection, normalizeSupplierDocument(documentType, raw));
}

/** Prioridade quando o mesmo número existe em mais de um tipo (improvável): CNPJ, CPF, estrangeiro. */
export const LOOKUP_TYPE_ORDER: readonly SupplierDocumentType[] = ['CNPJ', 'CPF', 'FOREIGN'];

/**
 * SUP-06 (FA-06): o tipo não vem na consulta — gera o blind index de cada forma plausível do
 * número informado (como CNPJ, como CPF e como documento estrangeiro).
 */
export function lookupHashes(protection: FieldProtection, raw: string): string[] {
  const forms = [
    normalizeCnpj(raw),
    normalizeCpf(raw),
    normalizeSupplierDocument('FOREIGN', raw),
  ].filter((form) => form.length > 0);
  return [...new Set(forms.map((form) => hashOf(protection, form)))];
}
