-- US-115 · Camada de IA com registro e rastreabilidade das gerações (entities.md §4.11
-- `AiGeneration` · DEC-037/079 · RN-AI-01/03/11/12). Toda geração é registrada ANTES da chamada ao
-- provedor e nunca é excluída — só o status muda (o papel da aplicação não tem DELETE). O conteúdo
-- (`need_summary`, `instruction`, `output`) nunca vai para logs, eventos ou auditoria (só hashes).
-- Também entra no catálogo global a permissão `AI_GENERATE` (permissions.md §2.7 · POL-18).

SET ROLE cf_owner;

-- 1. Catálogo de permissões (plataforma): upsert por `code`, como na US-094.
INSERT INTO "permissions"
  ("code", "module", "name", "description", "risk_level", "scopable", "is_deprecated", "introduced_in")
VALUES
  ('AI_GENERATE', 'ai', 'Gerar conteúdo com IA',
   'Pedir rascunho completo ou ajuste de seção de DFD, ETP, mapa de riscos e TR (POL-18)',
   'MEDIUM', true, false, 'MVP1')
ON CONFLICT ("code") DO UPDATE SET
  "module" = EXCLUDED."module",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "risk_level" = EXCLUDED."risk_level",
  "scopable" = EXCLUDED."scopable",
  "is_deprecated" = EXCLUDED."is_deprecated",
  "introduced_in" = EXCLUDED."introduced_in",
  "updated_at" = CURRENT_TIMESTAMP
WHERE ("permissions"."module", "permissions"."name", "permissions"."description",
       "permissions"."risk_level", "permissions"."scopable", "permissions"."is_deprecated",
       "permissions"."introduced_in")
  IS DISTINCT FROM
      (EXCLUDED."module", EXCLUDED."name", EXCLUDED."description", EXCLUDED."risk_level",
       EXCLUDED."scopable", EXCLUDED."is_deprecated", EXCLUDED."introduced_in");

-- 2. Enums (entities.md §2).
CREATE TYPE "ai_generation_kind" AS ENUM ('DRAFT', 'SECTION');
CREATE TYPE "ai_section_action" AS ENUM ('REWRITE', 'COMPLETE', 'SUMMARIZE');
CREATE TYPE "ai_generation_status" AS ENUM (
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'APPLIED', 'DISCARDED', 'EXPIRED'
);

-- 3. Gerações.
CREATE TABLE "ai_generations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "document_id" UUID,
    "target_module" "system_document_module" NOT NULL,
    "kind" "ai_generation_kind" NOT NULL,
    "action" "ai_section_action",
    "section_key" VARCHAR(60),
    "base_revision" INTEGER,
    "status" "ai_generation_status" NOT NULL DEFAULT 'QUEUED',
    "need_summary" TEXT,
    "instruction" VARCHAR(500),
    "provider" VARCHAR(30) NOT NULL,
    "model" VARCHAR(100),
    "prompt_key" VARCHAR(60) NOT NULL,
    "prompt_version" VARCHAR(20) NOT NULL,
    "input_refs" JSONB NOT NULL DEFAULT '[]',
    "context_hash" VARCHAR(64),
    "output" JSONB,
    "output_hash" VARCHAR(64),
    "placeholders_count" INTEGER NOT NULL DEFAULT 0,
    "grounding_replacements" INTEGER NOT NULL DEFAULT 0,
    "reserved_tokens" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "pricing_version" VARCHAR(20),
    "latency_ms" INTEGER,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "provider_request_id" VARCHAR(200),
    "error_code" VARCHAR(40),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "applied_by_id" UUID,
    "applied_targets" JSONB,
    "discarded_at" TIMESTAMPTZ(6),
    "discarded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_generations_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- Processo e documento do mesmo tenant (DEC-081); solicitante com vínculo no tenant.
    CONSTRAINT "ai_generations_tenant_id_process_id_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "ai_generations_tenant_id_document_id_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "ai_generations_tenant_id_created_by_id_fkey"
      FOREIGN KEY ("tenant_id", "created_by_id")
      REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT,
    CONSTRAINT "ai_generations_target_module_check"
      CHECK ("target_module" IN ('DFD', 'ETP', 'RISK_MAP', 'TERM_OF_REFERENCE')),
    -- Ajuste de seção exige ação, seção e documento; rascunho não tem ação nem seção.
    CONSTRAINT "ai_generations_section_fields"
      CHECK ("kind" <> 'SECTION'
             OR ("action" IS NOT NULL AND "section_key" IS NOT NULL AND "document_id" IS NOT NULL)),
    CONSTRAINT "ai_generations_draft_fields"
      CHECK ("kind" <> 'DRAFT' OR ("action" IS NULL AND "section_key" IS NULL)),
    -- Documento nulo só no mapa de riscos ainda não emitido (US-119).
    CONSTRAINT "ai_generations_document_required"
      CHECK ("document_id" IS NOT NULL OR "target_module" = 'RISK_MAP'),
    CONSTRAINT "ai_generations_failed_has_error"
      CHECK ("status" <> 'FAILED' OR "error_code" IS NOT NULL),
    CONSTRAINT "ai_generations_error_code_check"
      CHECK ("error_code" IS NULL OR "error_code" IN (
        'PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED', 'TIMEOUT', 'CONTENT_FILTERED',
        'CONTEXT_TOO_LARGE', 'OUTPUT_INVALID', 'CANCELED_BY_POLICY')),
    CONSTRAINT "ai_generations_need_summary_length"
      CHECK ("need_summary" IS NULL OR char_length("need_summary") BETWEEN 20 AND 2000),
    CONSTRAINT "ai_generations_counters_non_negative"
      CHECK ("placeholders_count" >= 0 AND "grounding_replacements" >= 0
             AND "reserved_tokens" >= 0 AND "attempts" >= 0
             AND coalesce("input_tokens", 0) >= 0 AND coalesce("output_tokens", 0) >= 0),
    CONSTRAINT "ai_generations_hashes_format"
      CHECK (("context_hash" IS NULL OR "context_hash" ~ '^[0-9a-f]{64}$')
             AND ("output_hash" IS NULL OR "output_hash" ~ '^[0-9a-f]{64}$')),
    -- A proposta só existe com o hash dela (RN-AI-01); `SUCCEEDED` sempre com proposta.
    CONSTRAINT "ai_generations_output_hashed"
      CHECK (("output" IS NULL) = ("output_hash" IS NULL)),
    CONSTRAINT "ai_generations_succeeded_has_output"
      CHECK ("status" NOT IN ('SUCCEEDED', 'APPLIED') OR "output" IS NOT NULL),
    CONSTRAINT "ai_generations_input_refs_array" CHECK (jsonb_typeof("input_refs") = 'array')
);
CREATE UNIQUE INDEX "ai_generations_tenant_id_id_key" ON "ai_generations"("tenant_id", "id");
-- RN-AI-12 · V-08: uma geração ativa por alvo — a defesa definitiva sob concorrência.
CREATE UNIQUE INDEX "ai_generations_active_draft_key"
  ON "ai_generations"("tenant_id", "process_id", "target_module")
  WHERE "kind" = 'DRAFT' AND "status" IN ('QUEUED', 'RUNNING');
CREATE UNIQUE INDEX "ai_generations_active_section_key"
  ON "ai_generations"("tenant_id", "document_id", "section_key")
  WHERE "kind" = 'SECTION' AND "status" IN ('QUEUED', 'RUNNING');
CREATE INDEX "ai_generations_process_idx"
  ON "ai_generations"("tenant_id", "process_id", "created_at" DESC);
CREATE INDEX "ai_generations_requester_idx"
  ON "ai_generations"("tenant_id", "created_by_id", "created_at");
CREATE INDEX "ai_generations_created_idx" ON "ai_generations"("tenant_id", "created_at");
CREATE INDEX "ai_generations_status_expires_idx"
  ON "ai_generations"("tenant_id", "status", "expires_at");

-- 4. Imutabilidade (RN-AI-03): identidade e alvo não mudam; estados finais não voltam.
CREATE FUNCTION cf_ai_generations_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
     OR NEW."target_module" IS DISTINCT FROM OLD."target_module"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
     OR NEW."prompt_key" IS DISTINCT FROM OLD."prompt_key"
     OR NEW."prompt_version" IS DISTINCT FROM OLD."prompt_version" THEN
    RAISE EXCEPTION 'ai_generations: identidade e alvo da geração são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" IN ('FAILED', 'CANCELED', 'DISCARDED', 'EXPIRED')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'ai_generations: status final não muda'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Estados finais são imutáveis (RN-AI-03).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_ai_generations_guard() FROM PUBLIC;
CREATE TRIGGER "ai_generations_guard" BEFORE UPDATE ON "ai_generations"
  FOR EACH ROW EXECUTE FUNCTION cf_ai_generations_guard();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('ai_generations');

-- 6. Privilégios mínimos: nunca DELETE (RN-AI-01). O worker executa o job e as tarefas de
-- manutenção (`ai-proposals-expire`, `ai-generations-timeout` — queues.md §4.8).
GRANT SELECT, INSERT, UPDATE ON "ai_generations" TO cf_app;
GRANT SELECT, UPDATE ON "ai_generations" TO cf_worker;

RESET ROLE;
