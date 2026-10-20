-- US-079 · Catálogo de multi-tenancy (multi-tenancy.md §14 · DEC-081 · RN-TEN-27): toda tabela de
-- negócio expõe `UNIQUE (tenant_id, id)`, alvo das FKs compostas. Faltava em `tenant_settings`
-- (US-103), `number_sequences` (US-105) e `document_items` (US-014). Expand puro: `id` já é PK, o
-- índice novo não rejeita linha existente. `process_tags` (sem `id`) e o índice global do token de
-- convite ficam nas listas fechadas de exceção do CI (`tools/ci/lib/migrations.ts`).

SET ROLE cf_owner;

CREATE UNIQUE INDEX "tenant_settings_tenant_id_id_key" ON "tenant_settings"("tenant_id", "id");
CREATE UNIQUE INDEX "number_sequences_tenant_id_id_key" ON "number_sequences"("tenant_id", "id");
CREATE UNIQUE INDEX "document_items_tenant_id_id_key" ON "document_items"("tenant_id", "id");

RESET ROLE;
