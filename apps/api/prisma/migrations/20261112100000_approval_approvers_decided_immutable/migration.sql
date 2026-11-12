-- US-134 · RN-APV-42 (aprovação múltipla — entities.md MVP 2 §4.6/§10 · DEC-193): o voto registrado é
-- imutável. Linha com decisão (`APPROVED`, `RETURNED`, `REJECTED`) não muda mais — nem a decisão,
-- nem quem decidiu, nem o comentário, nem o aprovador — e não volta a nenhum outro estado: não há
-- retirada nem troca de voto. A aplicação já recusa (`APPROVAL_LINE_NOT_PENDING` — a trava da
-- aprovação serializa); o gatilho é a rede de segurança no banco (inclusive para `cf_owner`).
-- Expand puro, reversível; nenhuma linha muda.
--
-- Desfazer (down): DROP TRIGGER "approval_approvers_decided_immutable" ON "approval_approvers";
-- DROP FUNCTION cf_approval_approvers_decided_immutable().

SET ROLE cf_owner;

CREATE FUNCTION cf_approval_approvers_decided_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD."status" IN ('APPROVED', 'RETURNED', 'REJECTED')
     AND (NEW."status" IS DISTINCT FROM OLD."status"
          OR NEW."decision" IS DISTINCT FROM OLD."decision"
          OR NEW."decided_by_id" IS DISTINCT FROM OLD."decided_by_id"
          OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
          OR NEW."decision_comment" IS DISTINCT FROM OLD."decision_comment"
          OR NEW."decided_as_deputy" IS DISTINCT FROM OLD."decided_as_deputy"
          OR NEW."approver_type" IS DISTINCT FROM OLD."approver_type"
          OR NEW."approver_user_id" IS DISTINCT FROM OLD."approver_user_id"
          OR NEW."approver_role_id" IS DISTINCT FROM OLD."approver_role_id"
          OR NEW."approver_department_id" IS DISTINCT FROM OLD."approver_department_id"
          OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
          OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id"
          OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id") THEN
    RAISE EXCEPTION 'approval_approvers: a decisão registrada na linha % é imutável', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Voto registrado não se altera nem se retira (US-134 · RN-APV-42).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_approval_approvers_decided_immutable() FROM PUBLIC;

CREATE TRIGGER "approval_approvers_decided_immutable" BEFORE UPDATE ON "approval_approvers"
  FOR EACH ROW EXECUTE FUNCTION cf_approval_approvers_decided_immutable();

RESET ROLE;
