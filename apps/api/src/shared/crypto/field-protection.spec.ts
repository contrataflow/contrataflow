import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EnvelopeFieldProtection,
  FieldProtectionUnavailableError,
  LocalKeyWrapper,
} from './field-protection.js';
import type { KeyWrapper } from './field-protection.js';

const protection = () =>
  new EnvelopeFieldProtection(new LocalKeyWrapper(randomBytes(32)), randomBytes(32));

describe('EnvelopeFieldProtection (DEC-086)', () => {
  it('cifra e decifra; o texto em claro não aparece no blob', async () => {
    const field = protection();
    const blob = await field.encrypt('11144477735');

    expect(blob.toString('utf8')).not.toContain('11144477735');
    expect(blob.toString('hex')).not.toContain(Buffer.from('11144477735').toString('hex'));
    expect(await field.decrypt(blob)).toBe('11144477735');
  });

  it('cada cifra usa chave de dados e IV novos (mesmo valor, blobs diferentes)', async () => {
    const field = protection();
    const [one, two] = await Promise.all([
      field.encrypt('11144477735'),
      field.encrypt('11144477735'),
    ]);

    expect(one.equals(two)).toBe(false);
    expect(await field.decrypt(one)).toBe(await field.decrypt(two));
  });

  it('blob adulterado ou de outra chave mestra não decifra', async () => {
    const field = protection();
    const blob = await field.encrypt('11144477735');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    await expect(field.decrypt(tampered)).rejects.toThrow();
    await expect(protection().decrypt(blob)).rejects.toBeInstanceOf(
      FieldProtectionUnavailableError,
    );
    await expect(field.decrypt(Buffer.from('curto'))).rejects.toThrow('inválido');
  });

  it('blind index: determinístico, hexadecimal de 64 e dependente da chave', () => {
    const key = randomBytes(32);
    const one = new EnvelopeFieldProtection(new LocalKeyWrapper(randomBytes(32)), key);
    const same = new EnvelopeFieldProtection(new LocalKeyWrapper(randomBytes(32)), key);
    const other = protection();

    expect(one.blindIndex('11144477735')).toMatch(/^[0-9a-f]{64}$/);
    expect(one.blindIndex('11144477735')).toBe(same.blindIndex('11144477735'));
    expect(one.blindIndex('11144477735')).not.toBe(one.blindIndex('11144477736'));
    expect(one.blindIndex('11144477735')).not.toBe(other.blindIndex('11144477735'));
  });

  it('KMS fora do ar: encrypt e decrypt viram FieldProtectionUnavailableError (503, Retry-After)', async () => {
    const working = protection();
    const blob = await working.encrypt('11144477735');
    const down: KeyWrapper = {
      wrap: () => Promise.reject(new Error('KMS timeout')),
      unwrap: () => Promise.reject(new Error('KMS timeout')),
    };
    const field = new EnvelopeFieldProtection(down, randomBytes(32));

    const failure = await field.encrypt('11144477735').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FieldProtectionUnavailableError);
    expect(failure).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503 });
    expect((failure as FieldProtectionUnavailableError).headers).toEqual({ 'Retry-After': '5' });
    await expect(field.decrypt(blob)).rejects.toBeInstanceOf(FieldProtectionUnavailableError);
  });

  it('exige chaves de 32 bytes', () => {
    expect(() => new LocalKeyWrapper(randomBytes(16))).toThrow();
    expect(
      () => new EnvelopeFieldProtection(new LocalKeyWrapper(randomBytes(32)), randomBytes(8)),
    ).toThrow();
  });
});
