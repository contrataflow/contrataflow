-- US-105 · Numeração configurável e segura sob concorrência (entities.md §4 `NumberSequence` ·
-- DEC-028 · RN-TEN-68/69). Tabela de tenant (RLS ENABLE + FORCE). Uma linha por
-- (tenant, sequenceKey), criada sob demanda (`INSERT … ON CONFLICT DO NOTHING`) e incrementada com
-- `UPDATE … SET last_value = last_value + 1 RETURNING last_value` NA MESMA transação do recurso
-- numerado: o bloqueio da linha serializa as numerações concorrentes e o rollback desfaz o
-- incremento (nenhum número confirmado é repetido nem pulado). Nunca é excluída.

SET ROLE cf_owner;

CREATE TABLE "number_sequences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sequence_key" VARCHAR(120) NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "number_sequences_tenant_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- RN-TEN-68: `PROCESS:<orgId|*>:<ano>` ou `DOCUMENT:<TYPE>:<orgId|*>:<ano>`.
    CONSTRAINT "number_sequences_key_format" CHECK (
      "sequence_key" ~ '^(PROCESS|DOCUMENT:[A-Z][A-Z0-9_]{1,39}):(\*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[0-9]{4}$'
    ),
    CONSTRAINT "number_sequences_last_value_non_negative" CHECK ("last_value" >= 0)
);

CREATE UNIQUE INDEX "number_sequences_tenant_id_sequence_key_key"
  ON "number_sequences"("tenant_id", "sequence_key");

-- A linha nunca muda de tenant nem de chave, e o último valor nunca volta atrás (um número já
-- confirmado não pode ser reemitido).
CREATE FUNCTION cf_number_sequences_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."sequence_key" IS DISTINCT FROM OLD."sequence_key" THEN
    RAISE EXCEPTION 'number_sequences: tenant_id e sequence_key são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'A sequência não muda de tenant nem de chave (US-105).';
  END IF;
  IF NEW."last_value" < OLD."last_value" THEN
    RAISE EXCEPTION 'number_sequences: last_value não pode diminuir'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Números confirmados não são reemitidos (US-105 · RN-TEN-69).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_number_sequences_guard() FROM PUBLIC;

CREATE TRIGGER "number_sequences_guard" BEFORE UPDATE ON "number_sequences"
  FOR EACH ROW EXECUTE FUNCTION cf_number_sequences_guard();

-- RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('number_sequences');

-- Privilégios mínimos: a aplicação cria e incrementa (sem DELETE); o worker só lê.
GRANT SELECT, INSERT, UPDATE ON "number_sequences" TO cf_app;
GRANT SELECT ON "number_sequences" TO cf_worker;

RESET ROLE;
