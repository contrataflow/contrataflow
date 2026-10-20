-- Fixture (US-079): a chamada cobre outra tabela (prefixo do nome) e a tabela nova fica sem RLS;
-- a chamada em comentário não conta.
SET ROLE cf_owner;

CREATE TABLE "fixture_items_archive" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    CONSTRAINT "fixture_items_archive_pkey" PRIMARY KEY ("id")
);

-- SELECT cf_apply_tenant_rls('fixture_items_archive');
SELECT cf_apply_tenant_rls('fixture_items');

RESET ROLE;
