import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { EmailPreparation } from './email-source.js';
import { InvitationEmailSource, generateInviteToken } from './invitation-email-source.js';
import { formatInvitationDeadline } from './invitation-template.js';

const MEMBERSHIP = '0192f111-0000-7000-8000-0000000000c1';
const TENANT = '0192f111-0000-7000-8000-00000000000a';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const EXPIRES = '2026-10-22T12:00:00.123456+00';
const BASE_URL = 'https://app.contrataflow.test/';

interface Scripted {
  readonly row?: Record<string, unknown> | null;
  readonly rowCount?: number;
}

/** `SqlClient` roteirizado: devolve a linha do vínculo e o `rowCount` das gravações. */
function client(script: Scripted) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const sql: SqlClient = {
    query: (text: string, params: readonly unknown[] = []) => {
      calls.push({ sql: text, params });
      if (text.includes('FROM tenant_memberships m')) {
        return Promise.resolve({ rows: (script.row ? [script.row] : []) as never[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] as never[], rowCount: script.rowCount ?? 1 });
    },
  };
  return { sql, calls };
}

const invitedRow = {
  status: 'INVITED',
  invite_token_hash: null,
  invite_expires_at: new Date('2026-10-22T12:00:00.123Z'),
  invite_expires_raw: EXPIRES,
  job_title: 'Analista de Contratações',
  type: 'INTERNAL',
  email: ' bruno@pmsj.gov.br ',
  name: 'Bruno Alves Costa',
  tenant_name: 'Prefeitura de São José',
  tenant_status: 'ACTIVE',
};

function source(generateToken?: () => string) {
  return new InvitationEmailSource(BASE_URL, { now: () => NOW, generateToken });
}

async function prepare(row: Record<string, unknown> | null, src = source()) {
  return src.prepare(client({ row }).sql, MEMBERSHIP, TENANT);
}

function sendOf(preparation: EmailPreparation) {
  if (preparation.kind !== 'send') throw new Error(`esperava send, veio ${preparation.kind}`);
  return preparation;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('InvitationEmailSource.prepare (US-091)', () => {
  it('[Sucesso] convite pendente → send com o link /convite/{token} e o marcador da geração', async () => {
    const { sql, calls } = client({ row: invitedRow });
    const result = sendOf(await source().prepare(sql, MEMBERSHIP, TENANT));

    expect(calls[0]?.params).toEqual([MEMBERSHIP, TENANT]);
    expect(result.to).toBe('bruno@pmsj.gov.br');
    expect(result.type).toBe('INVITATION');
    expect(result.content.subject).toBe(
      'Convite para acessar o ContrataFlow — Prefeitura de São José',
    );
    const token = /\/convite\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(result.content.text)?.[1];
    expect(token).toBeDefined();
    expect(result.content.text).toContain(
      `Aceitar convite: https://app.contrataflow.test/convite/${token ?? ''}`,
    );
    expect(result.content.html).toContain(
      `href="https://app.contrataflow.test/convite/${token ?? ''}"`,
    );
    expect(JSON.parse(result.receipt ?? '{}')).toEqual({
      hash: sha256(token ?? ''),
      expiresAt: EXPIRES,
    });
  });

  it('o conteúdo traz saudação, instituição, cargo, validade em Brasília e a orientação de senha', async () => {
    const { content } = sendOf(await prepare(invitedRow));
    expect(content.text).toContain('Olá, Bruno!');
    expect(content.text).toContain('Prefeitura de São José');
    expect(content.text).toContain('Cargo informado no convite: Analista de Contratações.');
    // 22/10/2026 12:00 UTC = 09:00 em America/Sao_Paulo (UTC-3).
    expect(content.text).toContain('O convite vale até 22/10/2026 09:00');
    expect(content.text).toContain(
      'Se ainda não tem senha no ContrataFlow, você vai defini-la no primeiro acesso. Se não esperava este convite, ignore este e-mail.',
    );
    expect(content.html).toContain('lang="pt-BR"');
    expect(content.html).toContain('Aceitar convite');
  });

  it('sem cargo, omite a linha do cargo; escapa HTML do nome da instituição', async () => {
    const { content } = sendOf(
      await prepare({ ...invitedRow, job_title: null, tenant_name: 'Câmara <b>&"Z' }),
    );
    expect(content.text).not.toContain('Cargo informado');
    expect(content.html).not.toContain('<b>');
    expect(content.html).toContain('Câmara &lt;b&gt;&amp;&quot;Z');
  });

  it('o prazo é formatado em America/Sao_Paulo (dd/mm/aaaa HH:mm)', () => {
    expect(formatInvitationDeadline(new Date('2026-10-22T02:30:00.000Z'))).toBe('21/10/2026 23:30');
  });

  it('gera um token novo a cada preparação (43 caracteres base64url)', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('[Validação] vínculo inexistente (ou de outro tenant, escondido pela RLS) → missing', async () => {
    await expect(prepare(null)).resolves.toEqual({ kind: 'missing' });
  });

  it('[Duplicidade] já aceito/revogado → not-pending com o status', async () => {
    await expect(prepare({ ...invitedRow, status: 'ACTIVE' })).resolves.toEqual({
      kind: 'not-pending',
      status: 'ACTIVE',
    });
  });

  it('[Duplicidade] convite já enviado (hash gravado) → not-pending SENT, sem novo token', async () => {
    await expect(prepare({ ...invitedRow, invite_token_hash: 'a'.repeat(64) })).resolves.toEqual({
      kind: 'not-pending',
      status: 'SENT',
    });
  });

  it('[Validação] prazo vencido ou ausente → not-pending EXPIRED', async () => {
    const expired = { ...invitedRow, invite_expires_at: new Date(NOW.getTime() - 1_000) };
    await expect(prepare(expired)).resolves.toEqual({ kind: 'not-pending', status: 'EXPIRED' });
    await expect(
      prepare({ ...invitedRow, invite_expires_at: NOW, invite_expires_raw: EXPIRES }),
    ).resolves.toEqual({ kind: 'not-pending', status: 'EXPIRED' });
    await expect(
      prepare({ ...invitedRow, invite_expires_at: null, invite_expires_raw: null }),
    ).resolves.toEqual({ kind: 'not-pending', status: 'EXPIRED' });
  });

  it('[Tenant incorreto] tenant que não está ACTIVE → skip TENANT_INACTIVE', async () => {
    await expect(prepare({ ...invitedRow, tenant_status: 'SUSPENDED' })).resolves.toEqual({
      kind: 'skip',
      reason: 'TENANT_INACTIVE',
    });
  });

  it('[Validação] endereço inválido → fail NO_RECIPIENT', async () => {
    await expect(prepare({ ...invitedRow, email: 'sem-arroba' })).resolves.toMatchObject({
      kind: 'fail',
      code: 'NO_RECIPIENT',
    });
    await expect(prepare({ ...invitedRow, email: null })).resolves.toMatchObject({
      kind: 'fail',
      code: 'NO_RECIPIENT',
    });
  });

  it('o convite é obrigatório: não consulta notifications.emailEnabled', async () => {
    const { sql, calls } = client({ row: invitedRow });
    await source().prepare(sql, MEMBERSHIP, TENANT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).not.toMatch(/tenant_settings|emailEnabled/);
  });
});

describe('InvitationEmailSource.markSent / markFailed / markSkipped (US-091)', () => {
  it('o hash gravado é o SHA-256 do token do link e o e-mail não traz o hash', async () => {
    const prepared = sendOf(await prepare(invitedRow));
    const { sql, calls } = client({ row: invitedRow, rowCount: 1 });
    await expect(source().markSent(sql, MEMBERSHIP, NOW, prepared.receipt)).resolves.toBe(true);

    const token = /\/convite\/([A-Za-z0-9_-]{43})/.exec(prepared.content.text)?.[1] ?? '';
    const [id, hash, expiresAt] = calls[0]?.params ?? [];
    expect(id).toBe(MEMBERSHIP);
    expect(hash).toBe(sha256(token));
    expect(expiresAt).toBe(EXPIRES);
    expect(prepared.content.text + prepared.content.html).not.toContain(String(hash));
    expect(calls[0]?.sql).toMatch(/invite_token_hash IS NULL/);
    expect(calls[0]?.sql).toMatch(/status = 'INVITED'/);
    expect(calls[0]?.sql).toMatch(/invite_expires_at = \$3::timestamptz/);
    // transição técnica: não incrementa `version`
    expect(calls[0]?.sql).not.toMatch(/version/);
  });

  it('[Concorrência] reenvio durante o envio (geração mudou): o UPDATE não aplica → false', async () => {
    const prepared = sendOf(await prepare(invitedRow));
    const { sql } = client({ row: invitedRow, rowCount: 0 });
    await expect(source().markSent(sql, MEMBERSHIP, NOW, prepared.receipt)).resolves.toBe(false);
  });

  it('sem recibo (ou corrompido) nada é gravado', async () => {
    const { sql, calls } = client({ row: invitedRow });
    await expect(source().markSent(sql, MEMBERSHIP, NOW)).resolves.toBe(false);
    await expect(source().markSent(sql, MEMBERSHIP, NOW, 'não-é-json')).resolves.toBe(false);
    await expect(source().markSent(sql, MEMBERSHIP, NOW, '{"hash":1}')).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('markFailed e markSkipped não gravam (o convite não tem coluna de estado de e-mail)', async () => {
    const src = source();
    await expect(src.markFailed()).resolves.toBe(false);
    await expect(src.markSkipped()).resolves.toBe(false);
  });
});
