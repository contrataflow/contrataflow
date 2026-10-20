-- Fixture (US-079): RLS pela função padrão `cf_apply_tenant_rls` (20261015120000_tenancy_foundation),
-- equivalente a ENABLE + FORCE + CREATE POLICY tenant_isolation. O gatilho BEFORE TRUNCATE não é
-- um TRUNCATE.
SET ROLE cf_owner;

CREATE TABLE "fixture_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    CONSTRAINT "fixture_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fixture_items_tenant_id_id_key" ON "fixture_items"("tenant_id", "id");

CREATE TABLE public.fixture_links (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);

CREATE TRIGGER "fixture_items_no_truncate" BEFORE TRUNCATE ON "fixture_items"
  FOR EACH STATEMENT EXECUTE FUNCTION cf_fixture_immutable();

-- SELECT cf_apply_tenant_rls('outra_tabela'); em comentário não conta.
SELECT cf_apply_tenant_rls('fixture_items');
SELECT cf_apply_tenant_rls('public.fixture_links'::regclass);

RESET ROLE;
