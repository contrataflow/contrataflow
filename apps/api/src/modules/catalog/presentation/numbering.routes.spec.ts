import { problemDetailsSchema } from '@contrataflow/validation';
import type { NumberingPreviewResult } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { CATALOG_CLOCK, CATALOG_TRANSACTIONS } from '../application/catalog-ports.js';
import type { CatalogTransactions } from '../application/catalog-ports.js';
import {
  InMemoryNumberingSettingsReader,
  InMemoryNumberSequenceRepository,
} from '../infrastructure/in-memory-number-sequence.repository.js';

/*
 * US-105 — SET-04 (prévia de máscara) pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * validação Zod, filtro RFC 9457) com a identidade fake e as sequências em memória. O `PATCH` das
 * chaves `numbering.*` (SET-02) está em `tenancy/presentation/settings.routes.spec.ts`; os mesmos
 * cenários contra o PostgreSQL (prévia + salvamento, 50 numerações simultâneas, rollback, RLS) em
 * `test/tenant-leak/numbering.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta; // ADMIN_ORGAO (tem SETTINGS_MANAGE)
const LUCIA = FAKE_USERS.lucia; // GESTOR_CONTRATACOES (sem SETTINGS_MANAGE)
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');
const ORG_A = '0192a000-0000-7000-8000-0000000105a1';

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Pré-visualizar a numeração de processos e documentos (US-105 · SET-04)', () => {
  let api: TestApi;
  let sequences: InMemoryNumberSequenceRepository;

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: CATALOG_CLOCK, value: () => NOW }] });
    sequences = api.app.get(InMemoryNumberSequenceRepository, { strict: false });
    const settings = api.app.get(InMemoryNumberingSettingsReader, { strict: false });
    settings.addOrganization(A, { id: ORG_A, shortName: 'PMSJ' });
    // Background: último número de processo do tenant A em 2026 é 11; o tenant B já está no 900.
    sequences.seed(A, 'PROCESS:*:2026', 11);
    sequences.seed(A, 'DOCUMENT:DFD:*:2026', 4);
    sequences.seed(B, 'PROCESS:*:2026', 900);
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const preview = (
    body: Record<string, unknown>,
    options: { user?: { subject: string }; amr?: readonly string[]; tenant?: string } = {},
  ) =>
    request(api.server)
      .post('/api/v1/numbering/preview')
      .set(
        'Authorization',
        api.bearer((options.user ?? MARTA).subject, { amr: options.amr ?? MFA }),
      )
      .set('X-Tenant-Id', options.tenant ?? A)
      .send(body);

  describe('[Sucesso]', () => {
    it('máscara "{seq:4}/{year}" com o último número 11: exemplo "0012/2026" sem alterar a sequência', async () => {
      const response = await preview({ mask: '{seq:4}/{year}' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { data: NumberingPreviewResult }).data).toEqual({
        example: '0012/2026',
        nextValue: '12',
      });
      expect(sequences.valueOf(A, 'PROCESS:*:2026')).toBe(11);
      // Prévia não grava: sem auditoria nem evento.
      expect(api.auditRecords().filter((r) => r.tenantId === A && r.result === 'SUCCESS')).toEqual(
        [],
      );
      expect(api.outboxRows()).toHaveLength(0);
    });

    it('FA-04: a máscara informada (não a gravada), com escopo por órgão e a sigla do órgão principal', async () => {
      const response = await preview({ mask: '{org}-{seq:5}/{year}', scope: 'ORGANIZATION' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { data: NumberingPreviewResult }).data).toEqual({
        example: 'PMSJ-00001/2026',
        nextValue: '1',
      });
    });

    it('máscara padrão de documento para um tipo ("{type} {seq:4}/{year}" → "DFD 0005/2026")', async () => {
      const response = await preview({ mask: '{type} {seq:4}/{year}', documentTypeCode: 'DFD' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { data: NumberingPreviewResult }).data).toEqual({
        example: 'DFD 0005/2026',
        nextValue: '5',
      });
    });
  });

  describe('[Validação]', () => {
    it('máscara sem {year}: 422 NUMBERING_MASK_INVALID com o campo e log numbering.mask_invalid', async () => {
      const error = silence();
      const response = await preview({ mask: '{seq:4}' });

      const problem = expectProblem(response, 422, 'NUMBERING_MASK_INVALID');
      expect(problem.errors).toEqual([
        {
          field: 'mask',
          code: 'INVALID_FORMAT',
          message: 'A máscara deve conter {seq:N} e {year}; verifique os marcadores usados.',
        },
      ]);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'numbering.mask_invalid',
          mask: '{seq:4}',
          reason: 'MISSING_YEAR',
        }),
        'numbering.mask_invalid',
      );
    });

    it.each(['{seq}/{year}', '{seq:7}/{year}', '{seq:4}/{year}/{mes}', '{type} {seq:4}/{year}'])(
      'máscara de processo %s: 422 NUMBERING_MASK_INVALID',
      async (mask) => {
        silence();
        expectProblem(await preview({ mask }), 422, 'NUMBERING_MASK_INVALID');
      },
    );

    it('escopo ORGANIZATION sem {org}: 422 com a mensagem própria (V-02)', async () => {
      silence();
      const problem = expectProblem(
        await preview({ mask: '{seq:4}/{year}', scope: 'ORGANIZATION' }),
        422,
        'NUMBERING_MASK_INVALID',
      );
      expect(problem.errors[0]?.message).toBe(
        'Com numeração por órgão, a máscara deve incluir {org}.',
      );
    });

    it('corpo fora do contrato: 422 VALIDATION_ERROR', async () => {
      silence();
      expectProblem(
        await preview({ mask: '{seq:4}/{year}', scope: 'SETOR' }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(await preview({}), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('usuária sem SETTINGS_MANAGE: 403 PERMISSION_DENIED e access.denied', async () => {
      silence();
      const denials = api.auditRecords().filter((r) => r.action === 'access.denied').length;

      expectProblem(
        await preview({ mask: '{seq:4}/{year}' }, { user: LUCIA }),
        403,
        'PERMISSION_DENIED',
      );

      const records = api.auditRecords().filter((r) => r.action === 'access.denied');
      expect(records).toHaveLength(denials + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: LUCIA.id,
        reasonCode: 'SETTINGS_MANAGE',
        result: 'DENIED',
      });
    });

    it('administradora sem MFA na sessão (POL-14): 403 MFA_REQUIRED', async () => {
      silence();
      expectProblem(
        await preview({ mask: '{seq:4}/{year}' }, { amr: ['pwd'] }),
        403,
        'MFA_REQUIRED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('X-Tenant-Id de um tenant sem vínculo: 403 MEMBERSHIP_INACTIVE e nada da sequência de B', async () => {
      silence();
      const response = await preview({ mask: '{seq:4}/{year}' }, { tenant: B });
      expectProblem(response, 403, 'MEMBERSHIP_INACTIVE');
      // O correlationId é aleatório e pode conter "901" por acaso.
      const { correlationId: _correlationId, ...problem } = response.body as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(problem)).not.toContain('901');
      expect(sequences.valueOf(B, 'PROCESS:*:2026')).toBe(900);
    });

    it('a prévia do tenant A nunca usa a sequência do tenant B', async () => {
      const response = await preview({ mask: '{seq:4}/{year}' });
      expect((response.body as { data: NumberingPreviewResult }).data.nextValue).toBe('12');
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After', async () => {
      silence();
      const down = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const failing: CatalogTransactions = {
        run: () => Promise.reject(down),
        read: () => Promise.reject(down),
      };
      const broken = await createTestApi({
        providers: [
          { token: CATALOG_TRANSACTIONS, value: failing },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        const response = await request(broken.server)
          .post('/api/v1/numbering/preview')
          .set('Authorization', broken.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({ mask: '{seq:4}/{year}' });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBeDefined();
      } finally {
        await broken.close();
      }
    });
  });
});
