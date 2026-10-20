import { describe, expect, it } from 'vitest';

import {
  digestOf,
  LONG_TEXT_LIMIT,
  maskChanges,
  maskCpf,
  maskMetadata,
  REDACTED,
} from './audit-masking.js';
import { canonicalJson, sha256Hex } from './canonical-json.js';

const RICH_TEXT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Justificativa sigilosa' }] }],
};

describe('mascaramento de changes e metadata (RN-AUD-03 · DEC-138 · V-04)', () => {
  it('CPF é mascarado por campo; formato desconhecido é redigido', () => {
    expect(maskCpf('123.456.789-09')).toBe('***.456.789-**');
    expect(maskCpf('12345678909')).toBe('***.456.789-**');
    expect(maskCpf('123')).toBe(REDACTED);
    expect(maskCpf(12_345_678_909)).toBe(REDACTED);
    expect(maskCpf(null)).toBeNull();
    expect(
      maskChanges([
        { path: 'requester.cpf', old: null, new: '123.456.789-09' },
        { path: 'responsibleCpf', old: '98765432100', new: '12345678909' },
        { path: 'cpf_hash', old: null, new: 'f'.repeat(64) },
      ]),
    ).toEqual([
      { path: 'requester.cpf', old: null, new: '***.456.789-**' },
      { path: 'responsibleCpf', old: '***.654.321-**', new: '***.456.789-**' },
      { path: 'cpf_hash', old: null, new: REDACTED },
    ]);
  });

  it('segredos nunca são gravados, em qualquer nível', () => {
    expect(
      maskMetadata({
        accessToken: 'eyJhbGciOi.eyJzdWIiOi.assinatura',
        nested: { refresh_token: 'abc', Password: 'segredo', ok: 'visível', none: null },
        list: [{ apiKey: 'k' }],
      }),
    ).toEqual({
      accessToken: REDACTED,
      nested: { refresh_token: REDACTED, Password: REDACTED, ok: 'visível', none: null },
      list: [{ apiKey: REDACTED }],
    });
  });

  it('valor com cara de segredo ou CPF em campo sem regra é redigido por inteiro (V-04)', () => {
    expect(
      maskMetadata({
        note: 'token Bearer abcdefghijklmnop',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl',
        free: 'CPF do fornecedor: 123.456.789-09',
        ok: 'processo 123/2026',
      }),
    ).toEqual({ note: REDACTED, jwt: REDACTED, free: REDACTED, ok: 'processo 123/2026' });
  });

  it('texto rico (TipTap) e campos de conteúdo viram { hash, length }', () => {
    const digest = {
      hash: sha256Hex(canonicalJson(RICH_TEXT)),
      length: canonicalJson(RICH_TEXT).length,
    };
    expect(digestOf(RICH_TEXT)).toEqual(digest);
    expect(
      maskChanges([
        { path: 'sections.JUSTIFICATION.content', old: null, new: RICH_TEXT },
        { path: 'description', old: RICH_TEXT, new: 'curto' },
        { path: 'body', old: 'oi', new: null },
      ]),
    ).toEqual([
      { path: 'sections.JUSTIFICATION.content', old: null, new: digest },
      { path: 'description', old: digest, new: 'curto' },
      { path: 'body', old: { hash: sha256Hex('oi'), length: 2 }, new: null },
    ]);
  });

  it('texto longo vira resumo; curto fica como está', () => {
    const long = 'x'.repeat(LONG_TEXT_LIMIT + 1);
    const [change] = maskChanges([{ path: 'items[2].notes', old: 'antes', new: long }]);
    expect(change).toEqual({
      path: 'items[2].notes',
      old: 'antes',
      new: { hash: sha256Hex(long), length: LONG_TEXT_LIMIT + 1 },
    });
    expect(JSON.stringify(change)).not.toContain(long);
  });

  it('converte valores da aplicação e ignora metadata que não é objeto', () => {
    expect(
      maskChanges([{ path: 'dueAt', old: new Date('2026-10-01T00:00:00Z'), new: undefined }]),
    ).toEqual([{ path: 'dueAt', old: '2026-10-01T00:00:00.000Z', new: null }]);
    expect(maskMetadata([] as unknown as Record<string, unknown>)).toEqual({});
  });
});
