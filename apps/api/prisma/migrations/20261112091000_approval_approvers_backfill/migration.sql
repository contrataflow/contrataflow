-- US-133 · M2-03 (dados — entities.md MVP 2 §5.9/§10 · DEC-193 · RN-APV-30): toda `Approval`
-- existente ganha a linha `ApprovalApprover` `sequence = 1` com o aprovador gravado e o estado
-- equivalente (`PENDING`, `APPROVED`, `RETURNED`, `REJECTED` ou `CANCELED`); decidida, também
-- `decision`, `decided_by_id`, `decided_at`, `decision_comment` e `decided_as_deputy`; `CANCELED`
-- (retirada, processo cancelado…) vira linha `CANCELED` com `skipped_reason = 'WITHDRAWN'` (lacuna
-- 3 da story). `decision_policy` já é `ANY` em todas (padrão da M2-02).
--
-- - Por tenant (a RLS vale para o dono: `app.tenant_id` local à transação), em lotes de 1.000.
-- - Idempotente por `(approval_id, sequence)`: só aprovações sem a linha 1; rodar de novo não cria
--   nada. O lote trava as aprovações (`FOR UPDATE`) — uma decisão concorrente espera o commit.
-- - Id UUIDv7 a partir de `approvals.created_at` (o PostgreSQL 17 não tem `uuidv7()`).
-- - Relatório de reconciliação: `RAISE NOTICE` por lote (`approval.backfill_batch`) e por tenant
--   (`approval.backfill_reconciled`, contagens por status antes/depois); qualquer aprovação sem a
--   linha equivalente aborta a migração inteira (`approval.backfill_failed`).
-- - As linhas do backfill têm `created_by_id` nulo (as da aplicação têm o solicitante).
-- - A view `v_inbox_pending_approvals` v2 é da US-136 (lacuna 4 da story).
-- - Rodar fora do horário de uso: decisões do código ANTERIOR feitas depois do commit não
--   atualizam a linha (o código desta story as mantém em sincronia).
--
-- Desfazer (down): DELETE FROM "approval_approvers" WHERE "sequence" = 1 AND "created_by_id" IS NULL
-- (por tenant, com `app.tenant_id`).

SET ROLE cf_owner;

BEGIN;

DO $backfill$
DECLARE
  v_tenant record;
  v_batch integer;
  v_created integer;
  v_total integer;
  v_before jsonb;
  v_after jsonb;
  v_missing integer;
BEGIN
  FOR v_tenant IN SELECT "id" FROM "tenants" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', v_tenant."id"::text, true);

    SELECT COALESCE(jsonb_object_agg(s."status", s."total"), '{}'::jsonb)
      INTO v_before
      FROM (SELECT "status"::text AS "status", count(*) AS "total"
              FROM "approvals" WHERE "tenant_id" = v_tenant."id" GROUP BY "status") s;

    v_batch := 0;
    v_total := 0;
    LOOP
      WITH "batch" AS (
        SELECT a.*
          FROM "approvals" a
         WHERE a."tenant_id" = v_tenant."id"
           AND NOT EXISTS (
             SELECT 1 FROM "approval_approvers" l
              WHERE l."tenant_id" = a."tenant_id" AND l."approval_id" = a."id" AND l."sequence" = 1)
         ORDER BY a."id"
         LIMIT 1000
           FOR UPDATE OF a
      )
      INSERT INTO "approval_approvers" (
        "id", "tenant_id", "approval_id", "sequence", "approver_type", "approver_user_id",
        "approver_role_id", "approver_department_id", "allow_deputy", "status", "activated_at",
        "due_at", "decision", "decided_by_id", "decided_at", "decision_comment",
        "decided_as_deputy", "skipped_reason", "created_at", "updated_at", "created_by_id",
        "updated_by_id", "version")
      SELECT
        encode(
          set_bit(set_bit(
            overlay(uuid_send(gen_random_uuid())
                    PLACING substring(int8send(floor(extract(epoch FROM b."created_at") * 1000)::bigint) FROM 3)
                    FROM 1 FOR 6),
            52, 1), 53, 1),
          'hex')::uuid,
        b."tenant_id", b."id", 1, b."approver_type", b."approver_user_id", b."approver_role_id",
        b."approver_department_id", b."allow_deputy",
        b."status"::text::"approval_approver_status",
        b."requested_at",
        NULL,
        CASE WHEN b."status" IN ('APPROVED', 'RETURNED', 'REJECTED') THEN
          COALESCE(b."decision",
                   CASE b."status" WHEN 'APPROVED' THEN 'APPROVE'::"approval_decision"
                                   WHEN 'RETURNED' THEN 'RETURN'::"approval_decision"
                                   ELSE 'REJECT'::"approval_decision" END)
        END,
        CASE WHEN b."status" IN ('APPROVED', 'RETURNED', 'REJECTED') THEN b."decided_by_id" END,
        CASE WHEN b."status" IN ('APPROVED', 'RETURNED', 'REJECTED')
             THEN COALESCE(b."decided_at", b."updated_at") END,
        CASE WHEN b."status" IN ('APPROVED', 'RETURNED', 'REJECTED') THEN b."decision_comment" END,
        b."status" IN ('APPROVED', 'RETURNED', 'REJECTED') AND b."decided_as_deputy",
        CASE WHEN b."status" = 'CANCELED' THEN 'WITHDRAWN' END,
        b."created_at",
        b."updated_at",
        NULL,
        NULL,
        1
      FROM "batch" b
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_created = ROW_COUNT;
      EXIT WHEN v_created = 0;
      v_batch := v_batch + 1;
      v_total := v_total + v_created;
      RAISE NOTICE 'approval.backfill_batch tenantId=% batch=% linesCreated=%',
        v_tenant."id", v_batch, v_created;
    END LOOP;

    -- Reconciliação: toda aprovação tem a linha 1; a do backfill, no estado equivalente (as da
    -- aplicação — `created_by_id` preenchido — seguem a política da própria aprovação).
    SELECT count(*) INTO v_missing
      FROM "approvals" a
     WHERE a."tenant_id" = v_tenant."id"
       AND NOT EXISTS (
         SELECT 1 FROM "approval_approvers" l
          WHERE l."tenant_id" = a."tenant_id" AND l."approval_id" = a."id" AND l."sequence" = 1
            AND (l."created_by_id" IS NOT NULL OR l."status"::text = a."status"::text));
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'approval.backfill_failed tenantId=% divergentApprovals=%',
        v_tenant."id", v_missing;
    END IF;

    SELECT COALESCE(jsonb_object_agg(s."status", s."total"), '{}'::jsonb)
      INTO v_after
      FROM (SELECT l."status"::text AS "status", count(*) AS "total"
              FROM "approval_approvers" l
             WHERE l."tenant_id" = v_tenant."id" AND l."sequence" = 1
               AND l."created_by_id" IS NULL
             GROUP BY l."status") s;
    RAISE NOTICE 'approval.backfill_reconciled tenantId=% batches=% linesCreated=% before=% after=%',
      v_tenant."id", v_batch, v_total, v_before, v_after;
  END LOOP;
END
$backfill$;

COMMIT;

RESET ROLE;
