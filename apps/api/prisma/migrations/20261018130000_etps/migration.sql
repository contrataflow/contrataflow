-- US-019 · Criar ETP a partir de template com importação do DFD (entities.md §4.8 `Etp` ·
-- DEC-016/017/018/019 · ADR-006):
--  * `etps` (módulo etp): cabeçalho tipado 1:1 do `Document` do tipo ETP. O id do ETP é o próprio id
--    do documento (CHECK `etps_id_is_document`), como no DFD e na pesquisa de preços: a SCR-008
--    (`/processos/{id}/etp/{etpId}`), o painel de documentos, as seções (DOC-05), os itens
--    (DOC-06/07) e as versões usam o mesmo identificador. Sem status próprio (o do documento).
--  * `imported_from_dfd_version_id` aponta para a versão do DFD de origem da importação
--    (RN-ETP-04/05); os itens importados ficam em `document_items` (DEC-019 — nunca duplicam o
--    `ProcessItem`).
--  * `recommended_alternative_id` fica sem FK até `etp_alternatives` existir (US-021).

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "etp_conclusion" AS ENUM ('PENDING', 'VIABLE', 'NOT_VIABLE');
CREATE TYPE "parceling_decision" AS ENUM ('PARCELED', 'NOT_PARCELED', 'NOT_APPLICABLE');

-- 2. Cabeçalho do ETP.
CREATE TABLE "etps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "recommended_alternative_id" UUID,
    "parceling_decision" "parceling_decision",
    "conclusion" "etp_conclusion" NOT NULL DEFAULT 'PENDING',
    "estimated_total_value" DECIMAL(18,2),
    "estimated_value_source" "estimated_value_source",
    "price_research_id" UUID,
    "imported_from_dfd_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "etps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "etps_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "etps_document_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "etps_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "etps_imported_from_dfd_version_fkey"
      FOREIGN KEY ("tenant_id", "imported_from_dfd_version_id")
      REFERENCES "document_versions"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "etps_price_research_fkey"
      FOREIGN KEY ("tenant_id", "price_research_id") REFERENCES "price_research"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "etps_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "etps_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "etps_id_is_document" CHECK ("id" = "document_id"),
    CONSTRAINT "etps_estimated_value_source" CHECK (
      "estimated_value_source" IS NULL OR "estimated_value_source" IN ('MANUAL', 'PRICE_RESEARCH')
    ),
    CONSTRAINT "etps_estimated_total_not_negative" CHECK (
      "estimated_total_value" IS NULL OR "estimated_total_value" >= 0
    )
);

CREATE UNIQUE INDEX "etps_tenant_id_id_key" ON "etps"("tenant_id", "id");
-- 1:1 com o documento (entities.md §4.8).
CREATE UNIQUE INDEX "etps_tenant_id_document_id_key" ON "etps"("tenant_id", "document_id");
CREATE INDEX "etps_process_idx" ON "etps"("tenant_id", "process_id");

-- 3. O ETP nunca muda de tenant, processo ou documento.
CREATE FUNCTION cf_etps_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id" THEN
    RAISE EXCEPTION 'etps: tenant, processo e documento são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_etps_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "etps_immutable_columns" BEFORE UPDATE ON "etps"
  FOR EACH ROW EXECUTE FUNCTION cf_etps_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('etps');

-- 5. Privilégios mínimos: o ETP nunca é apagado (o documento tem exclusão lógica). O worker lê
-- (PDF e snapshot).
GRANT SELECT, INSERT, UPDATE ON "etps" TO cf_app;
GRANT SELECT ON "etps" TO cf_worker;

RESET ROLE;
