---
id: FT-080
title: "Read model de indicadores"
epic: EP-028
mvp: 2
priority: P1
stories: [US-170, US-171]
status: Especificada
---

# FT-080 — Read model de indicadores

## Título
Read model de indicadores

## Épico
EP-028 — Indicadores e gargalos

## Descrição
A base de dados que sustenta todos os relatórios e a análise de gargalos (DEC-206, [ADR-014](../adr/adr-014-indicators-read-model.md)). O módulo `analytics` mantém tabelas de fatos próprias, com `tenant_id` e RLS:
- `AnalyticsStageFact`: uma linha por passagem de etapa (entrada, saída, duração em dias úteis e corridos, unidade, responsável, devolução, prazo vencido, pausas de SLA);
- `AnalyticsProcessFact`: uma linha por processo com a situação corrente e os marcos (abertura, DFD aprovado, conclusão da fase preparatória, desfechos do jurídico e do Controle Interno, valor estimado, modalidade, secretaria, item do PCA, devoluções);
- `AnalyticsPcaItemFact`: execução do PCA por item.

O **worker** (e só ele) projeta nessas tabelas os eventos do outbox, de forma idempotente por `eventId` e por chave natural. A defasagem-alvo é de até 5 minutos. Um job noturno por tenant **reconcilia** os fatos contra as tabelas transacionais e corrige divergências; o mesmo mecanismo reconstrói tudo depois de uma mudança de definição de indicador. Os agregados ficam em **visões materializadas** (`mv_analytics_stage_monthly`, `mv_analytics_process_monthly`, `mv_analytics_pca_execution`) atualizadas com `REFRESH ... CONCURRENTLY`. A API só tem `SELECT`, e os relatórios **nunca** leem `ProcessStage` ou `ProcessMovement` em produção.

## Valor para o usuário e para o órgão
- Relatórios e gargalos com custo previsível, sem competir com a tramitação.
- Medidas derivadas (dias úteis, pausas, devoluções) calculadas uma vez, de forma consistente.
- Confiança nos números: divergências detectadas e corrigidas todas as noites, com relatório.

## Personas
- Operação da plataforma e administrador do órgão (`ADMIN_ORGAO`) — acompanham a saúde da projeção e disparam reconstrução.
- Gestor de contratações (`GESTOR_CONTRATACOES`), Controle Interno e Auditor — consumidores indiretos, pelas features seguintes.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-170 ⏳ | Alimentar o read model de indicadores pelos eventos | P1 | L | US-059, US-082, US-083 |
| US-171 ⏳ | Reconstruir e reconciliar o read model | P1 | M | US-170 |

## Escopo
- Migrações das tabelas de fatos, de idempotência (`AnalyticsProcessedEvent`, retenção de 30 dias) e de execução da reconciliação (`AnalyticsReconciliationRun`), com RLS.
- Projetor `AnalyticsProjector` no worker, consumindo `process.*`, `approval.*`, `document.*`, `pca.*`, `legal_review.*`, `internal_control_review.*`, `budget_allocation.*` e `workflow_migration.*`.
- Cálculo dos fatos: dias úteis e corridos, pausas, devoluções, atraso, desfechos e marcos.
- Reconstrução por tenant (total ou por período) e reconciliação noturna com relatório de divergências (amostra de até 50 chaves, sem valores).
- Visões materializadas, índices únicos para `CONCURRENTLY`, agenda de refresh e leitura por funções `security definer` com o tenant da sessão.
- Métricas de operação: defasagem, fila, duração do refresh e divergências.

## Fora de escopo
- Telas, relatórios e exportação (FT-081) e gargalos (FT-082).
- Réplica de leitura, data warehouse e BI externo (ADR-014).
- Projeção síncrona de fatos específicos (critério de revisão da ADR-014).

## Regras de negócio da feature
- RN-ANL-01 — Só o worker escreve nas tabelas de fatos; a API (`cf_app`) tem apenas `SELECT`, e as visões materializadas são lidas só por funções `security definer` com o tenant da sessão (DEC-206, ADR-014).
- RN-ANL-02 — A projeção é idempotente por `eventId` e por chave natural (`processStageId`, `processId`, `pcaItemId`); evento repetido ou fora de ordem não altera o resultado (ADR-014).
- RN-ANL-03 — Os fatos não têm chave estrangeira para tabelas transacionais: sobrevivem a rascunho descartado e a reconstrução não trava a tramitação (entities.md §4.11).
- RN-ANL-04 — Durações são em dias úteis e corridos, **descontadas as pausas de SLA**, calculadas uma vez no fechamento da passagem (DEC-206, DEC-205).
- RN-ANL-05 — Valores de processos com orçamento sigiloso ficam gravados, mas as somas das visões os **excluem** e a soma deles entra em coluna separada, exibida só a quem tem a permissão de sigilo (DEC-206, DEC-030, POL-09).
- RN-ANL-06 — Os relatórios nunca consultam `ProcessStage`/`ProcessMovement` diretamente em produção; só o read model (DEC-206).
- RN-ANL-07 — O job noturno reconcilia fatos × tabelas transacionais por tenant, fora do horário de uso, e há no máximo uma execução `RUNNING` por tenant (DEC-206, ADR-014).
- RN-ANL-08 — A reconstrução é a mesma rotina da reconciliação e roda depois de mudança de definição de indicador, auditada como `analytics.rebuild` (ADR-014).
- RN-ANL-09 — A defasagem-alvo é de até 5 minutos e a data da última atualização é exposta às telas (DEC-206).
- RN-ANL-10 — O refresh das visões usa `CONCURRENTLY`, com agenda fora do pico e meta de duração monitorada (ADR-014).

## Telas
- Nenhuma tela própria; consumida por SCR-027 e SCR-028. A saúde da projeção aparece nas métricas operacionais e no backoffice da plataforma (EP-029) quando disponível.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /analytics/status` — data da última atualização, defasagem e última reconciliação do tenant.
- `POST /analytics/rebuild` — solicitar reconstrução do read model do tenant (operação administrativa, auditada).
- `GET /analytics/reconciliation-runs` — histórico das execuções e divergências corrigidas.

## Entidades
- `AnalyticsStageFact`, `AnalyticsProcessFact`, `AnalyticsPcaItemFact` — fatos (dono `analytics`).
- `AnalyticsProcessedEvent` — idempotência da projeção.
- `AnalyticsReconciliationRun` — execuções de reconciliação e reconstrução.
- Visões materializadas `mv_analytics_stage_monthly`, `mv_analytics_process_monthly` e `mv_analytics_pca_execution`.

## Eventos
- Consome os eventos do outbox listados acima (projetor `AnalyticsProjector`).
- `AnalyticsReconciliationCompleted` — publicado ao fim da reconciliação noturna ou da reconstrução (`runId`, `scope`, `factsChecked`, `divergencesFixed`).
- Auditoria `analytics.rebuild` (SYSTEM).

## Permissões
- Projeção e reconciliação rodam com o papel do worker; nenhuma permissão de usuário.
- A reconstrução manual e o status exigem permissão administrativa do tenant (matriz do card de API; `SETTINGS_MANAGE` como candidata).

## Dependências
- US-059 (projeção de eventos do processo na timeline), US-082 (outbox) e US-083 (worker, filas e retries) do MVP 1.
- EP-016 (RLS e papéis), EP-023 (eventos `pca.*` para `AnalyticsPcaItemFact`) e EP-030 (pausas e prazos, quando existirem).
- DEC-205 (cumprimento de prazo sai deste read model).

## Critérios de aceite da feature
```gherkin
Feature: Read model de indicadores
  Scenario: Evento vira fato em poucos minutos e a reconciliação corrige divergência
    Given o processo "0012/2026" na etapa "ETP" de uma secretaria
    When o processo for encaminhado para a etapa seguinte
    Then a passagem de etapa deve existir em "AnalyticsStageFact" com entrada, saída e duração em dias úteis
    And a defasagem entre o evento e o fato deve ser de até 5 minutos
    When um fato for alterado manualmente fora do projetor e o job noturno rodar
    Then a divergência deve ser corrigida e contada em "divergencesFixed"
    And "AnalyticsReconciliationCompleted" deve ser publicado

  Scenario: Reprocessar o mesmo evento não duplica
    Given um evento já processado
    When o mesmo "eventId" for entregue de novo
    Then o fato deve permanecer idêntico
```

## Métricas de sucesso
- Defasagem p95 ≤ 5 min.
- Reconciliação com ≤ 0,1% de fatos corrigidos e 0 divergências sem explicação.
- Refresh das visões ≤ 5 min por tenant.

## Riscos
- Evento perdido ou fora de ordem — idempotência, chave natural e reconciliação noturna.
- Refresh disputando recursos com a tramitação — `CONCURRENTLY`, agenda fora do pico e monitoramento.
- Mudança de definição exigir reconstrução cara — rotina única de reconstrução, por tenant e por período.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
