// Interessados na decisão para `APPROVAL_DECIDED` (US-052 · events.md §6) sobre PostgreSQL real, com
// o papel `cf_worker` (sem BYPASSRLS): quem solicitou e os responsáveis dos documentos cobertos
// (`approval_documents` e o documento da avulsa) — nada de outro tenant (RLS) nem de documento
// excluído. O cenário vem por SQL com as FKs desligadas (`session_replication_role`).
import type { DomainEventEnvelope } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApprovalStakeholdersLookup } from '../../src/notifications/approval-stakeholders.lookup.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

const id = (n: number) => `0192f052-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PROCESS = id(1);
const STAGE = id(2);
const TYPE = id(3);
const STAGE_APPROVAL = id(10);
const DOCUMENT_APPROVAL = id(11);
const APPROVAL_B = id(12);

const USERS = {
  requester: id(101),
  trResponsible: id(102),
  etpResponsible: id(103),
  deletedResponsible: id(104),
  standaloneResponsible: id(105),
  otherTenant: id(106),
} as const;

const DOCS = {
  tr: id(201),
  etp: id(202),
  deleted: id(203),
  standalone: id(204),
  otherTenant: id(205),
} as const;

let db: TestPostgres;
let worker: WorkerDatabase;
let seq = 1000;
const next = () => id((seq += 1));

function documentRow(
  documentId: string,
  responsibleId: string,
  options: { tenantId?: string; deleted?: boolean } = {},
) {
  return `INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status,
      responsible_id, created_by_id, deleted_at)
    VALUES ('${documentId}', '${options.tenantId ?? TENANT_A}', '${PROCESS}', '${TYPE}', 'Documento',
      'DRAFT', '${responsibleId}', '${USERS.requester}',
      ${options.deleted ? "'2026-10-01T00:00:00Z'" : 'NULL'});`;
}

function approvalRow(
  approvalId: string,
  options: { tenantId?: string; documentId?: string | null } = {},
) {
  const standalone = options.documentId !== undefined && options.documentId !== null;
  return `INSERT INTO approvals (id, tenant_id, process_id, subject_type, process_stage_id,
      document_id, title, requested_by_id, approver_type, approver_user_id, allow_deputy)
    VALUES ('${approvalId}', '${options.tenantId ?? TENANT_A}', '${PROCESS}',
      '${standalone ? 'DOCUMENT' : 'PROCESS_STAGE'}', ${standalone ? 'NULL' : `'${STAGE}'`},
      ${standalone ? `'${options.documentId}'` : 'NULL'}, 'Aprovação', '${USERS.requester}', 'USER',
      '${USERS.requester}', false);`;
}

function coverage(approvalId: string, documentId: string, tenantId: string = TENANT_A) {
  return `INSERT INTO approval_documents (id, tenant_id, approval_id, document_id, document_version_id)
    VALUES ('${next()}', '${tenantId}', '${approvalId}', '${documentId}', '${next()}');`;
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    SET session_replication_role = replica;
    INSERT INTO users (id, external_subject, email, name)
      SELECT u, NULL, u || '@a.test', 'Servidor' FROM unnest(ARRAY[
        '${USERS.requester}', '${USERS.trResponsible}', '${USERS.etpResponsible}',
        '${USERS.deletedResponsible}', '${USERS.standaloneResponsible}',
        '${USERS.otherTenant}']::uuid[]) AS u;
    ${documentRow(DOCS.tr, USERS.trResponsible)}
    ${documentRow(DOCS.etp, USERS.etpResponsible)}
    ${documentRow(DOCS.deleted, USERS.deletedResponsible, { deleted: true })}
    ${documentRow(DOCS.standalone, USERS.standaloneResponsible)}
    ${documentRow(DOCS.otherTenant, USERS.otherTenant, { tenantId: TENANT_B })}
    ${approvalRow(STAGE_APPROVAL)}
    ${coverage(STAGE_APPROVAL, DOCS.tr)}
    ${coverage(STAGE_APPROVAL, DOCS.etp)}
    ${coverage(STAGE_APPROVAL, DOCS.deleted)}
    ${approvalRow(DOCUMENT_APPROVAL, { documentId: DOCS.standalone })}
    ${approvalRow(APPROVAL_B, { tenantId: TENANT_B })}
    ${coverage(APPROVAL_B, DOCS.otherTenant, TENANT_B)}
    SET session_replication_role = origin;
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

const event = (approvalId: string) =>
  ({ processId: PROCESS, payload: { approvalId } }) as unknown as DomainEventEnvelope<
    Record<string, unknown>
  >;

describe('ApprovalStakeholdersLookup sobre PostgreSQL (US-052)', () => {
  const lookup = new ApprovalStakeholdersLookup();
  const stakeholders = (approvalId: string, tenantId = TENANT_A) =>
    worker.tenantTransaction(tenantId, (client) => lookup.resolve(client, event(approvalId)));

  it('[Sucesso] etapa: solicitante e responsáveis dos documentos cobertos, sem o documento excluído', async () => {
    expect([...(await stakeholders(STAGE_APPROVAL))].sort()).toEqual(
      [USERS.requester, USERS.trResponsible, USERS.etpResponsible].sort(),
    );
  });

  it('[FA-01] avulsa: solicitante e o responsável do documento submetido', async () => {
    expect([...(await stakeholders(DOCUMENT_APPROVAL))].sort()).toEqual(
      [USERS.requester, USERS.standaloneResponsible].sort(),
    );
  });

  it('[Tenant incorreto] na transação de B, a aprovação de A não aparece (e vice-versa)', async () => {
    expect(await stakeholders(STAGE_APPROVAL, TENANT_B)).toEqual([]);
    expect(await stakeholders(APPROVAL_B, TENANT_A)).toEqual([]);
    expect([...(await stakeholders(APPROVAL_B, TENANT_B))].sort()).toEqual(
      [USERS.requester, USERS.otherTenant].sort(),
    );
  });
});
