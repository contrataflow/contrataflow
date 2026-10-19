-- US-022 · Estimar quantidades e vincular valor à pesquisa de preços (RN-ETP-29/31):
--  * o `EtpEstimateSynchronizer` do worker (papel `cf_worker`, RLS pelo `app.tenant_id` do evento)
--    copia o `total_estimated_value` da pesquisa vinculada para `etps.estimated_total_value` a cada
--    `PriceResearchRecalculated`/`PriceResearchCompleted` e desfaz o vínculo
--    (`estimated_value_source`/`price_research_id` nulos) quando a pesquisa é cancelada.
--  * Sem colunas novas (os campos vêm da US-019); só o privilégio mínimo de escrita nas colunas que
--    a sincronização altera (a leitura de `etps`, `price_research`, `documents` e a gravação em
--    `audit_logs` já são do `cf_worker`).

SET ROLE cf_owner;

GRANT UPDATE ("estimated_total_value", "estimated_value_source", "price_research_id", "updated_at",
  "version") ON "etps" TO cf_worker;

RESET ROLE;
