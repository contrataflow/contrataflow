-- US-074 · Selagem de integridade da trilha de auditoria (entities.md §4 `AuditSeal` · ADR-009 ·
-- RN-AUD-11..16). Um selo por tenant e hora cheia com atividade: imutável (trigger + só
-- INSERT/SELECT), isolado por RLS e idempotente por (tenant_id, period_start) — o worker grava com
-- ON CONFLICT DO NOTHING (RN-AUD-13). O encadeamento (`previous_seal_id`) é uma FK composta na
-- própria tabela (DEC-081). O selo de plataforma (tenant_id nulo) não entra no MVP 1: a aplicação
-- não lê os registros de plataforma da trilha (o CI só admite tenant_id nulo em audit_logs).

SET ROLE cf_owner;

CREATE TABLE "audit_seals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "first_audit_id" UUID NOT NULL,
    "last_audit_id" UUID NOT NULL,
    "record_count" INTEGER NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "previous_seal_id" UUID,
    "chain_hash" VARCHAR(64) NOT NULL,
    "sealed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_seals_pkey" PRIMARY KEY ("id"),
    -- RN-AUD-12: nunca selo vazio.
    CONSTRAINT "audit_seals_record_count_positive" CHECK ("record_count" >= 1),
    CONSTRAINT "audit_seals_digest_format" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "audit_seals_chain_hash_format" CHECK ("chain_hash" ~ '^[0-9a-f]{64}$'),
    -- Período = uma hora cheia UTC: [period_start, period_start + 1 h − 1 ms].
    CONSTRAINT "audit_seals_period_hour" CHECK (
      mod(extract(epoch FROM "period_start"), 3600) = 0
      AND "period_end" = "period_start" + interval '1 hour' - interval '1 millisecond'
    ),
    CONSTRAINT "audit_seals_not_self_chained" CHECK ("previous_seal_id" IS DISTINCT FROM "id")
);

-- Alvo da FK composta (DEC-081) e idempotência por período (RN-AUD-13). O índice único
-- (tenant_id, period_start) também atende a listagem (AUD-04, mais recente primeiro) e a busca do
-- selo anterior: o btree é percorrido de trás para frente, sem índice DESC separado.
CREATE UNIQUE INDEX "audit_seals_tenant_id_id_key" ON "audit_seals"("tenant_id", "id");
CREATE UNIQUE INDEX "audit_seals_tenant_id_period_start_key" ON "audit_seals"("tenant_id", "period_start");

-- Encadeamento: a FK é criada antes da RLS (README de prisma/ — validação como dona da tabela).
ALTER TABLE "audit_seals" ADD CONSTRAINT "audit_seals_tenant_id_previous_seal_id_fkey"
  FOREIGN KEY ("tenant_id", "previous_seal_id") REFERENCES "audit_seals"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Imutabilidade (entities.md §4 · ADR-009): UPDATE/DELETE/TRUNCATE falham para qualquer papel
-- sujeito a triggers — inclusive o dono. A aplicação, além disso, só tem INSERT/SELECT.
CREATE FUNCTION cf_audit_seals_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_seals é imutável: % não é permitido', TG_OP
    USING ERRCODE = 'integrity_constraint_violation', HINT = 'Selos de auditoria são imutáveis (ADR-009).';
END
$fn$;
REVOKE ALL ON FUNCTION cf_audit_seals_immutable() FROM PUBLIC;

CREATE TRIGGER "audit_seals_immutable" BEFORE UPDATE OR DELETE ON "audit_seals"
  FOR EACH ROW EXECUTE FUNCTION cf_audit_seals_immutable();
CREATE TRIGGER "audit_seals_no_truncate" BEFORE TRUNCATE ON "audit_seals"
  FOR EACH STATEMENT EXECUTE FUNCTION cf_audit_seals_immutable();

-- RLS (DEC-082): leitura e escrita só no tenant da transação.
SELECT cf_apply_tenant_rls('audit_seals');

-- Privilégios mínimos: o worker sela (INSERT), a API e o worker leem.
GRANT SELECT, INSERT ON "audit_seals" TO cf_app, cf_worker;

RESET ROLE;
