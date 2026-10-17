// Anexos sobre PostgreSQL real (US-068 · Tenant incorreto, Concorrência, Falha de integração): RLS
// de `attachments`, a guarda de chave de storage NO BANCO (prefixo `tenants/{tenantId}/` — RN-DOC-77),
// a máquina de estados do gatilho `attachments_guard` (nada vira AVAILABLE sem SCANNING — P3), o
// CHECK de AVAILABLE só com hash/MIME/data da varredura e a gravação condicional por versão do
// `PrismaAttachmentRepository` (duas travas da mesma versão → uma vence). Ativos do tenant
// (`TENANT_ASSET`) dispensam processo. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAttachment, startScanning } from '#modules/files/domain/attachment.js';
import type { Attachment } from '#modules/files/domain/attachment.js';
import { PrismaAttachmentRepository } from '#modules/files/infrastructure/prisma-attachment.repository.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192d068-0000-7000-8000-00000000068a';
const B = '0192d068-0000-7000-8000-00000000068b';
const USER_A = '0192d068-0000-7000-8000-0000000068a1';
const USER_B = '0192d068-0000-7000-8000-0000000068b1';
const NOW = new Date('2026-10-17T12:00:00.000Z');

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-att', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-att', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${USER_A}', 'sub-att-a', 'a@att.test', true, 'Usuária A'),
  ('${USER_B}', 'sub-att-b', 'b@att.test', true, 'Usuário B');
`;

let sequence = 0;

function asset(tenantId: string, overrides: Partial<Attachment> = {}): Attachment {
  sequence += 1;
  const id = `0192d068-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
  return {
    ...createAttachment({
      id,
      tenantId,
      processId: null,
      targetType: 'TENANT_ASSET',
      targetId: tenantId,
      categoryId: null,
      fileName: 'brasao.png',
      extension: 'png',
      declaredMimeType: 'image/png',
      sizeBytes: 1024,
      storageKey: `tenants/${tenantId}/assets/${id}/brasao.png`,
      quarantineKey: `tenants/${tenantId}/uploads/${id}`,
      description: null,
      uploadedById: tenantId === A ? USER_A : USER_B,
      now: NOW,
    }),
    ...overrides,
  };
}

describe('Feature: anexos isolados por tenant sobre PostgreSQL (US-068)', () => {
  let db: TestDatabase;
  let client: TenantPrismaClient;
  const repository = new PrismaAttachmentRepository();

  const inTenant = <T>(
    tenantId: string,
    work: Parameters<TenantPrismaClient['$tenantTransaction']>[0],
  ) => asTenant(tenantId, () => client.$tenantTransaction(work)) as Promise<T>;

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    client = db.client('cf_app');
  }, 180_000);

  afterAll(async () => {
    await db.stop();
  });

  it('[Tenant incorreto] o anexo de B não existe para A: leitura, uso e escrita', async () => {
    const ofB = asset(B);
    await inTenant(B, (tx) => repository.insert(tx, ofB));

    await expect(inTenant(A, (tx) => repository.findById(tx, ofB.id))).resolves.toBeNull();
    await expect(inTenant(A, (tx) => repository.findByIds(tx, [ofB.id]))).resolves.toEqual([]);
    await expect(inTenant(A, (tx) => repository.usedBytes(tx))).resolves.toBe(0);
    const confirmed = { ...ofB, status: 'UPLOADED' as const, version: 2 };
    await expect(inTenant(A, (tx) => repository.update(tx, confirmed, 1))).resolves.toBe(false);
    const [row] = await db.admin<{ status: string; version: number }>(
      'SELECT status, version FROM attachments WHERE id = $1',
      [ofB.id],
    );
    expect(row).toEqual({ status: 'PENDING_UPLOAD', version: 1 });
  });

  it('[Tenant incorreto] chave de storage fora do prefixo do tenant é recusada pelo banco', async () => {
    const foreign = asset(A);
    const leaked = {
      ...foreign,
      storageKey: `tenants/${B}/assets/${foreign.id}/brasao.png`,
    };
    await expect(inTenant(A, (tx) => repository.insert(tx, leaked))).rejects.toThrow();
    const quarantineLeak = { ...asset(A), quarantineKey: `tenants/${B}/uploads/x` };
    await expect(inTenant(A, (tx) => repository.insert(tx, quarantineLeak))).rejects.toThrow();
    const rows = await db.admin('SELECT id FROM attachments WHERE id = ANY($1::uuid[])', [
      [leaked.id, quarantineLeak.id],
    ]);
    expect(rows).toEqual([]);
    // O CHECK em si (o adaptador pode reescrever a mensagem): direto no banco.
    const valid = asset(A);
    await inTenant(A, (tx) => repository.insert(tx, valid));
    await expect(
      db.admin(`UPDATE attachments SET quarantine_key = $2 WHERE id = $1`, [
        valid.id,
        `tenants/${B}/uploads/x`,
      ]),
    ).rejects.toThrow(/attachments_quarantine_key_tenant/);
  });

  it('[Falha de integração] nada vira AVAILABLE sem SCANNING nem sem hash (P3 no banco)', async () => {
    const own = asset(A);
    await inTenant(A, (tx) => repository.insert(tx, own));
    await expect(
      db.admin(
        `UPDATE attachments SET status = 'AVAILABLE', sha256 = $2, scanned_at = now(),
                detected_mime_type = 'image/png' WHERE id = $1`,
        [own.id, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/transição de status inválida/);
    await db.admin(`UPDATE attachments SET status = 'UPLOADED' WHERE id = $1`, [own.id]);
    await db.admin(`UPDATE attachments SET status = 'SCANNING' WHERE id = $1`, [own.id]);
    await expect(
      db.admin(`UPDATE attachments SET status = 'AVAILABLE' WHERE id = $1`, [own.id]),
    ).rejects.toThrow(/attachments_available_scanned/);
    await expect(
      db.admin(`UPDATE attachments SET storage_key = 'tenants/x' WHERE id = $1`, [own.id]),
    ).rejects.toThrow(/imutáveis/);
  });

  it('[Concorrência] duas travas de varredura da mesma versão: só uma grava', async () => {
    const own = { ...asset(A), status: 'UPLOADED' as const };
    await inTenant(A, (tx) => repository.insert(tx, own));
    const claim = startScanning(own, 1, NOW);
    const results = await Promise.all([
      inTenant(A, (tx) => repository.update(tx, claim, own.version)),
      inTenant(A, (tx) => repository.update(tx, claim, own.version)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await inTenant<Attachment | null>(A, (tx) => repository.findById(tx, own.id));
    expect(stored).toMatchObject({ status: 'SCANNING', scanResult: { claim: { attempt: 1 } } });
  });

  it('o app não apaga anexos (exclusão só lógica — DEC-034)', async () => {
    const own = asset(A);
    await inTenant(A, (tx) => repository.insert(tx, own));
    await expect(
      inTenant(A, (tx) => tx.$executeRaw`DELETE FROM attachments WHERE id = ${own.id}::uuid`),
    ).rejects.toThrow();
    const [row] = await db.admin('SELECT id FROM attachments WHERE id = $1', [own.id]);
    expect(row).toBeDefined();
  });
});
