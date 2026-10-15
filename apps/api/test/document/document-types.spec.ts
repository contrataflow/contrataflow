// Tipos de documento contra PostgreSQL real (US-061 · Banco de dados): migrações reais, a aplicação
// como `cf_app` (RLS) pelo `PrismaDocumentTypeRepository` e a `TenantTransaction`. Cobre os checks,
// o trigger de imutabilidade de `code`/`kind`/`system_module`/`is_system`, a unicidade por tenant,
// a concorrência otimista, a semeadura idempotente e a ausência de DELETE (RN-DOC-11). Também na
// suíte "tenant leak" quando envolve isolamento. `pnpm --filter @contrataflow/api test:integration`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DocumentTypeCodeTakenError } from '#modules/document/application/ports.js';
import {
  createCustomDocumentType,
  updateDocumentType,
} from '#modules/document/domain/document-type.js';
import type { DocumentType } from '#modules/document/domain/document-type.js';
import { buildSystemDocumentTypes } from '#modules/document/domain/system-document-types.js';
import { PrismaDocumentTypeRepository } from '#modules/document/infrastructure/prisma-document-type.repository.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import { TenantIsolationViolationError } from '#shared/tenancy/isolation.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192f000-0000-7000-8000-00000000061a';
const B = '0192f000-0000-7000-8000-00000000061b';
const MARTA = '0192f000-0000-7000-8000-0000000006a1';
const NOW = new Date('2026-10-15T12:00:00.000Z');

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-dty', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-dty', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
`;

/** Mensagem de erro do Postgres (ou da cadeia de causas do Prisma) como texto. */
function messageOf(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    parts.push(current.message);
  }
  return parts.join(' | ');
}

describe('document_types no PostgreSQL (US-061)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;
  const repository = new PrismaDocumentTypeRepository();

  const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    runWithRequestContext({ correlationId: 'corr-dty', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'USER', userId: MARTA, membershipId: null, name: 'Marta' },
      });
      return fn();
    });

  const inTenant = <T>(
    tenantId: string,
    work: Parameters<TenantPrismaClient['$tenantTransaction']>[0],
  ) => asTenant(tenantId, () => app.$tenantTransaction(work) as Promise<T>);

  const custom = (tenantId: string, code: string, overrides: Partial<DocumentType> = {}) => ({
    ...createCustomDocumentType(
      {
        kind: 'FREE_TEXT',
        code,
        name: `Tipo ${code}`,
        allowMultiplePerProcess: true,
        numberingEnabled: true,
        numberingMask: 'PT {seq:3}/{year}',
        requiresApproval: false,
        defaultConfidentiality: 'INTERNAL',
      },
      { id: newId(), tenantId, now: NOW, userId: null },
    ),
    ...overrides,
  });

  const rows = (tenantId: string) =>
    db.admin<{ code: string; version: number; name: string }>(
      'SELECT code, version, name FROM document_types WHERE tenant_id = $1 ORDER BY sort_order, code',
      [tenantId],
    );

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    app = db.client('cf_app');
  });
  afterAll(async () => {
    await db.stop();
  });

  describe('semeadura (entities.md §7)', () => {
    it('[Sucesso] grava os 11 tipos de sistema do tenant; repetir é idempotente', async () => {
      const seed = (tenantId: string) =>
        inTenant<number>(tenantId, (tx) =>
          repository.insertMissing(tx, buildSystemDocumentTypes(tenantId, NOW, newId)),
        );
      expect(await seed(A)).toBe(11);
      expect(await seed(A)).toBe(0);
      expect(await seed(B)).toBe(11);

      const seeded = await db.admin<{
        code: string;
        kind: string;
        system_module: string | null;
        is_system: boolean;
        requires_approval: boolean;
        allow_multiple_per_process: boolean;
      }>('SELECT * FROM document_types WHERE tenant_id = $1 ORDER BY sort_order', [A]);
      expect(seeded.map((row) => row.code)).toEqual([
        'DFD',
        'ETP',
        'TR',
        'RISK_MAP',
        'PRICE_RESEARCH',
        'DESPACHO',
        'OFICIO',
        'NOTA_TECNICA',
        'AUTORIZACAO',
        'DECLARACAO',
        'DOCUMENTO_EXTERNO',
      ]);
      expect(seeded.every((row) => row.is_system && !row.requires_approval)).toBe(true);
      expect(seeded.find((row) => row.code === 'TR')).toMatchObject({
        kind: 'STRUCTURED',
        system_module: 'TERM_OF_REFERENCE',
        allow_multiple_per_process: false,
      });
    });

    it('a leitura devolve o domínio completo, só do tenant da transação', async () => {
      const types = await inTenant<DocumentType[]>(A, (tx) => repository.list(tx));
      expect(types).toHaveLength(11);
      expect(types.every((type) => type.tenantId === A)).toBe(true);
      expect(types[0]).toMatchObject({
        code: 'DFD',
        sortOrder: 10,
        version: 1,
        approvalPolicy: null,
      });
    });
  });

  describe('regras no banco', () => {
    it('[Validação] code, kind, system_module e is_system são imutáveis (trigger), até para o dono', async () => {
      const [target] = await rows(A);
      expect(target?.code).toBe('DFD');
      for (const assignment of [
        "code = 'DFD_NOVO'",
        "kind = 'FREE_TEXT', system_module = NULL",
        'is_system = false',
      ]) {
        await expect(
          db.admin(
            `UPDATE document_types SET ${assignment} WHERE tenant_id = $1 AND code = 'DFD'`,
            [A],
          ),
        ).rejects.toThrow(/imutáveis/);
      }
      // Campos editáveis passam.
      await db.admin(
        "UPDATE document_types SET name = 'DFD renomeado' WHERE tenant_id = $1 AND code = 'DFD'",
        [A],
      );
      expect((await rows(A)).find((row) => row.code === 'DFD')?.name).toBe('DFD renomeado');
    });

    it('[Validação] a aplicação (cf_app) também não consegue mudar o código', async () => {
      const type = (await inTenant<DocumentType[]>(A, (tx) => repository.list(tx))).find(
        (item) => item.code === 'OFICIO',
      );
      await expect(
        inTenant(A, (tx) =>
          tx.documentType.updateMany({ where: { id: type?.id ?? '' }, data: { code: 'OFICIO_X' } }),
        ),
      ).rejects.toThrow(/imutáveis/);
    });

    const STRUCTURED = { kind: "'STRUCTURED'", system_module: "'ETP'", is_system: 'true' };
    it.each([
      ['código fora do formato', { code: "'parecer'" }, 'document_types_code_format'],
      [
        'STRUCTURED sem módulo',
        { kind: "'STRUCTURED'", is_system: 'true', allow_multiple_per_process: 'false' },
        'document_types_structured_module',
      ],
      [
        'módulo em tipo não estruturado',
        { system_module: "'DFD'" },
        'document_types_structured_module',
      ],
      [
        'aprovação sem política',
        { requires_approval: 'true' },
        'document_types_approval_policy_required',
      ],
      [
        'STRUCTURED de tenant',
        { ...STRUCTURED, is_system: 'false', allow_multiple_per_process: 'false' },
        'document_types_structured_is_system',
      ],
      [
        'STRUCTURED múltiplo por processo',
        { ...STRUCTURED, allow_multiple_per_process: 'true' },
        'document_types_structured_single',
      ],
      [
        'STRUCTURED inativo',
        { ...STRUCTURED, allow_multiple_per_process: 'false', is_active: 'false' },
        'document_types_structured_active',
      ],
      ['ordem fora de 0–999', { sort_order: '1000' }, 'document_types_sort_order_range'],
    ])('[Validação] check do banco: %s', async (_name, extra, constraint) => {
      const columns: Record<string, string> = {
        id: `'${newId()}'`,
        tenant_id: `'${A}'`,
        code: `'CHK_${newId().slice(-8).toUpperCase()}'`,
        name: "'Check'",
        kind: "'FREE_TEXT'",
        ...extra,
      };
      await expect(
        db.admin(
          `INSERT INTO document_types (${Object.keys(columns).join(', ')}) VALUES (${Object.values(columns).join(', ')})`,
        ),
      ).rejects.toThrow(new RegExp(constraint));
    });

    it('[Duplicidade] código repetido no tenant → DocumentTypeCodeTakenError; em outro tenant é permitido', async () => {
      await inTenant(A, (tx) => repository.insert(tx, custom(A, 'PARECER_TECNICO')));
      await expect(
        inTenant(A, (tx) => repository.insert(tx, custom(A, 'PARECER_TECNICO'))),
      ).rejects.toBeInstanceOf(DocumentTypeCodeTakenError);
      await inTenant(B, (tx) => repository.insert(tx, custom(B, 'PARECER_TECNICO')));
      expect(await rows(B)).toContainEqual(expect.objectContaining({ code: 'PARECER_TECNICO' }));
    });

    it('[Concorrência] duas gravações com a mesma versão: uma vence, a outra → VersionConflictError', async () => {
      const type = (await inTenant<DocumentType[]>(A, (tx) => repository.list(tx))).find(
        (item) => item.code === 'PARECER_TECNICO',
      );
      if (!type) throw new Error('PARECER_TECNICO não criado');
      const edit = (name: string) =>
        inTenant(A, (tx) =>
          repository.update(
            tx,
            updateDocumentType(type, { name }, { now: NOW, userId: MARTA, documentsCount: 0 }).next,
            type.version,
          ),
        );
      const results = await Promise.allSettled([
        edit('Parecer jurídico'),
        edit('Parecer contábil'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(failed?.reason).toBeInstanceOf(VersionConflictError);
      expect((await rows(A)).find((row) => row.code === 'PARECER_TECNICO')?.version).toBe(2);
    });
  });

  describe('[Tenant incorreto] isolamento (RLS + extensão)', () => {
    it('A não enxerga nem altera os tipos de B', async () => {
      const [typeOfB] = await db.admin<{ id: string }>(
        "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'OFICIO'",
        [B],
      );
      expect(await inTenant(A, (tx) => repository.findById(tx, typeOfB?.id ?? ''))).toBeNull();
      expect(await inTenant(A, (tx) => repository.findByCode(tx, 'OFICIO'))).toMatchObject({
        tenantId: A,
      });
      // UPDATE com o id de B: 0 linhas (a RLS o esconde) → conflito de versão, nunca gravação em B.
      const stolen = {
        ...(await inTenant<DocumentType[]>(B, (tx) => repository.list(tx))).find(
          (type) => type.code === 'OFICIO',
        ),
      } as DocumentType;
      await expect(
        inTenant(A, (tx) => repository.update(tx, { ...stolen, name: 'invadido' }, stolen.version)),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect((await rows(B)).find((row) => row.code === 'OFICIO')?.name).toBe('Ofício');
    });

    it('INSERT com o tenant de B no contexto de A é barrado antes do banco', async () => {
      await expect(
        inTenant(A, (tx) => repository.insert(tx, custom(B, 'INVASOR'))),
      ).rejects.toBeInstanceOf(TenantIsolationViolationError);
      expect(await rows(B)).not.toContainEqual(expect.objectContaining({ code: 'INVASOR' }));
    });

    it('sem contexto de tenant a consulta falha fechada', async () => {
      await expect(
        db.client('cf_app').$tenantTransaction((tx) => repository.list(tx)),
      ).rejects.toThrow();
    });
  });

  it('[RN-DOC-11] nenhum tipo é excluído: cf_app não tem DELETE', async () => {
    await expect(
      inTenant(A, (tx) => tx.documentType.deleteMany({ where: { code: 'OFICIO' } })),
    ).rejects.toSatisfy((error: unknown) => /permission denied/i.test(messageOf(error)));
    expect(await rows(A)).toContainEqual(expect.objectContaining({ code: 'OFICIO' }));
  });
});
