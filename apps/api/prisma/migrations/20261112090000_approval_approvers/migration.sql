-- US-133 · M2-02 (aprovação múltipla — entities.md MVP 2 §4.6/§5.9/§10 · DEC-193 · DEC-014).
-- Expand, reversível: a política copiada na solicitação (`approvals.decision_policy`, padrão `ANY`
-- = MVP 1) e a tabela `approval_approvers`, uma linha por aprovador da `Approval`, fonte de verdade
-- de quem decide. As colunas de aprovador de `approvals` continuam e espelham a linha 1 (`ANY`/`ALL`)
-- ou a corrente (`SEQUENTIAL`) até o contract (M2-22). Ficam para as stories donas: `pca_id` (a
-- tabela `pcas` é da M2-11 — EP-023) e o relaxamento de `approver_type` para nulo (nenhum caminho do
-- MVP 2 até aqui grava aprovação sem linha resolvida a espelhar — RN-APV-24). O backfill das
-- aprovações existentes é a migração seguinte (M2-03).
--
-- Desfazer (down): DROP TABLE "approval_approvers"; ALTER TABLE "approvals" DROP COLUMN
-- "decision_policy"; DROP TYPE "approval_approver_status".

SET ROLE cf_owner;

-- 1. Enum (entities.md MVP 2 §2).
CREATE TYPE "approval_approver_status" AS ENUM (
  'WAITING', 'PENDING', 'APPROVED', 'RETURNED', 'REJECTED', 'SKIPPED', 'CANCELED'
);

-- 2. Política da aprovação (RN-APV-16/17). ADD COLUMN com padrão constante não reescreve a tabela.
ALTER TABLE "approvals"
  ADD COLUMN "decision_policy" "approval_decision_policy" NOT NULL DEFAULT 'ANY';

-- 3. Linhas da aprovação (RN-APV-17..19 · RN-APV-32).
CREATE TABLE "approval_approvers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,
    "sequence" SMALLINT NOT NULL,
    "approver_type" "approver_type" NOT NULL,
    "approver_user_id" UUID,
    "approver_role_id" UUID,
    "approver_department_id" UUID,
    "allow_deputy" BOOLEAN NOT NULL,
    "status" "approval_approver_status" NOT NULL,
    "activated_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "decision" "approval_decision",
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_comment" TEXT,
    "decided_as_deputy" BOOLEAN NOT NULL DEFAULT false,
    "reassigned_from_id" UUID,
    "skipped_reason" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_approvers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_approvers_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- A linha pertence à aprovação do MESMO tenant (DEC-081); excluir a aprovação leva as linhas.
    CONSTRAINT "approval_approvers_approval_fkey"
      FOREIGN KEY ("tenant_id", "approval_id") REFERENCES "approvals"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "approval_approvers_sequence_range" CHECK ("sequence" BETWEEN 1 AND 20),
    -- Mesmas regras de tipo × coluna da `Approval` do MVP 1.
    CONSTRAINT "approval_approvers_user_approver"
      CHECK ("approver_type" <> 'USER' OR "approver_user_id" IS NOT NULL),
    CONSTRAINT "approval_approvers_role_approver"
      CHECK ("approver_type" <> 'ROLE' OR "approver_role_id" IS NOT NULL),
    CONSTRAINT "approval_approvers_department_approver"
      CHECK ("approver_type" <> 'DEPARTMENT_HEAD' OR "approver_department_id" IS NOT NULL),
    -- Linha decidida tem decisão e data; devolver/indeferir exige o motivo (RN-TRAM-55).
    CONSTRAINT "approval_approvers_decided"
      CHECK ("status" NOT IN ('APPROVED', 'RETURNED', 'REJECTED')
             OR ("decided_at" IS NOT NULL AND "decision" IS NOT NULL)),
    CONSTRAINT "approval_approvers_decision_comment"
      CHECK ("decision" IS NULL OR "decision" NOT IN ('RETURN', 'REJECT')
             OR "decision_comment" IS NOT NULL),
    -- RN-APV-18: linha em `PENDING` foi ativada; `WAITING` ainda não.
    CONSTRAINT "approval_approvers_activation"
      CHECK (("status" <> 'PENDING' OR "activated_at" IS NOT NULL)
             AND ("status" <> 'WAITING' OR "activated_at" IS NULL)),
    CONSTRAINT "approval_approvers_skipped_reason"
      CHECK ("skipped_reason" IS NULL
             OR "skipped_reason" IN ('NEGATIVE_DECISION', 'ANY_DECIDED', 'REASSIGNED', 'WITHDRAWN'))
);
CREATE UNIQUE INDEX "approval_approvers_tenant_id_id_key"
  ON "approval_approvers"("tenant_id", "id");
-- O redirecionamento (US-135) cancela a linha e cria outra com o mesmo `sequence`.
ALTER TABLE "approval_approvers"
  ADD CONSTRAINT "approval_approvers_reassigned_from_fkey"
  FOREIGN KEY ("tenant_id", "reassigned_from_id")
  REFERENCES "approval_approvers"("tenant_id", "id") ON DELETE RESTRICT;
-- RN-APV-32: uma linha viva por posição.
CREATE UNIQUE INDEX "approval_approvers_sequence_key"
  ON "approval_approvers"("tenant_id", "approval_id", "sequence") WHERE "status" <> 'CANCELED';
-- Leitura das linhas da aprovação (APV-02, decisão, retirada).
CREATE INDEX "approval_approvers_approval_idx"
  ON "approval_approvers"("tenant_id", "approval_id");
-- Caixa de tarefas (US-136): só linhas `PENDING`.
CREATE INDEX "approval_approvers_pending_user_idx"
  ON "approval_approvers"("tenant_id", "approver_user_id") WHERE "status" = 'PENDING';
CREATE INDEX "approval_approvers_pending_department_idx"
  ON "approval_approvers"("tenant_id", "approver_department_id") WHERE "status" = 'PENDING';
CREATE INDEX "approval_approvers_pending_role_idx"
  ON "approval_approvers"("tenant_id", "approver_role_id") WHERE "status" = 'PENDING';

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('approval_approvers');

-- 5. Privilégios mínimos (como `approvals`: sem DELETE — a exclusão vem pelo CASCADE da aprovação).
GRANT SELECT, INSERT, UPDATE ON "approval_approvers" TO cf_app;
GRANT SELECT ON "approval_approvers" TO cf_worker;

RESET ROLE;
