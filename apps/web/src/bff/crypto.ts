import 'server-only';

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/*
 * Cifra autenticada do BFF (DEC-137 · RN-IAM-02/10): AES-256-GCM com IV aleatório de 96 bits e
 * dado associado (AAD) que amarra o texto cifrado ao seu lugar (nome do cookie, chave da sessão).
 * Uma chave mestra (`SESSION_ENCRYPTION_KEY`) gera uma subchave por finalidade (HKDF-SHA256).
 */

export type KeyPurpose = 'session-tokens' | 'login-transaction' | 'login-challenge';

/** Formato: versão (1 byte) · IV (12) · texto cifrado · tag (16), em base64url. */
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveKey(master: Buffer, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `contrataflow:${purpose}:v1`, 32));
}

export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    iv,
    ciphertext,
    cipher.getAuthTag(),
  ]).toString('base64url');
}

/** Texto em claro, ou `null` se o valor foi adulterado, é de outra chave/AAD ou está malformado. */
export function unseal(key: Buffer, sealed: string, aad: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 1 + IV_BYTES + TAG_BYTES || raw[0] !== FORMAT_VERSION) return null;
    const iv = raw.subarray(1, 1 + IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ciphertext = raw.subarray(1 + IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Chave mestra da configuração ou, só em local/dev/test, uma aleatória por processo. */
export function masterKey(configured: Buffer | null): Buffer {
  return configured ?? randomBytes(32);
}
