---
id: FT-086
title: "Políticas de SLA"
epic: EP-030
mvp: 2
priority: P1
stories: [US-189, US-190, US-191, US-192]
status: Especificada
---

# FT-086 — Políticas de SLA

## Título
Políticas de SLA

## Épico
EP-030 — SLA

## Descrição
O administrador cadastra **políticas de prazo** (`SlaPolicy`) com aplicabilidade em JSON Logic sobre o `RuleContext` v2 (tipo de contratação, modalidade, valor), prazos por etapa em dias úteis ou corridos, condições de pausa e degraus de escalonamento. Quando o processo entra numa etapa, a política aplicável define `ProcessStage.dueAt`; quando nenhuma política casa, vale o prazo da DEC-031 (`WorkflowStage.slaDays`), exatamente como no MVP 1.

Durante a etapa, o módulo `sla` pausa o prazo quando há condição de pausa (diligência do jurídico, suspensão do processo, condição própria), estende o vencimento pelo tempo pausado e retoma depois. O job `deadlines` consulta o `sla` para os avisos e para o **escalonamento em degraus**: antes do vencimento, no vencimento e depois dele, avisando responsável, titular ou substituto da unidade, gestor e titular da secretaria solicitante. A execução é assíncrona e idempotente no worker ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)).

## Valor para o usuário e para o órgão
- Prazos que refletem a realidade: um pregão de alto valor e uma compra direta pequena deixam de ter o mesmo número de dias.
- O jurídico não perde prazo enquanto aguarda a resposta a uma diligência.
- O gestor é avisado em degraus e age antes do atraso, não depois dele.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — cadastra e ajusta as políticas.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — recebe escalonamento e acompanha prazos.
- Responsável pela etapa (`PLANEJAMENTO`, `COMPRAS`, `JURIDICO`, `CONTROLE_INTERNO`) — vê o prazo aplicável e as pausas.
- Titular de unidade ou secretaria — recebe o escalonamento do que está sob sua chefia.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-189 | Cadastrar políticas de SLA | P1 | L | US-055, US-106, US-129 |
| US-190 | Aplicar a política de SLA ao processo e calcular prazos | P1 | M | US-047, US-189 |
| US-191 | Pausar e retomar prazos | P1 | M | US-008, US-153, US-190 |
| US-192 | Escalonar prazos em degraus | P1 | M | US-114, US-190 |

## Escopo
- Cadastro (SCR-121): chave imutável, nome, aplicabilidade (`RuleRef` inline ou da biblioteca), `priority`, restrição opcional a um workflow, prazos por etapa por chave estável (`SlaPolicyStage`), prazo por linha de aprovador (`approverDays`), pausas e degraus; ativar e desativar.
- Aplicação: escolha da política por `priority` na entrada da etapa; `ProcessStage.dueAt` com snapshot; exibição da política e do prazo no detalhe do processo.
- Pausas: `PROCESS_SUSPENDED` (sempre implícita), `LEGAL_DILIGENCE` e `CONDITION`; etapas com `pauseSlaWhileReturned` pausam ao devolver por diligência; `pausedSeconds` e novo `dueAt` na retomada.
- Escalonamento: até 5 degraus (`offsetBusinessDays` negativo antes do vencimento), destinatários por papel e repetição opcional (`repeatEveryBusinessDays`); `sla.escalationEnabled` desliga só os degraus.
- Reavaliação quando a política muda ou quando o evento de pausa chega.

## Fora de escopo
- Relatórios e gargalos de cumprimento de prazo (EP-028).
- Regras de notificação condicional (FT-087).
- Biblioteca de regras e simulador (EP-031); aqui só o consumo de `RuleRef`.
- Prazo da aprovação avulsa de documento (DT-17, EP-022).
- Alterar prazos de passagens já em curso por mudança de política.

## Regras de negócio da feature
- RN-SLA-01 — A política aplicável define o prazo por etapa e **substitui** `WorkflowStage.slaDays`; sem política que case, ou etapa sem linha na política, vale `slaDays` (DEC-205, DEC-031).
- RN-SLA-02 — Uma etapa nunca tem duas políticas: vence a de menor `priority`; no empate, a mais antiga (`createdAt`) (DEC-205, ADR-015).
- RN-SLA-03 — A alteração de uma política vale só para novas entradas em etapa; passagens em curso mantêm o snapshot em `ProcessStage` (DEC-205).
- RN-SLA-04 — `ProcessStage.dueAt` continua sendo o campo do prazo; dias úteis ou corridos conforme `dayCountType` da linha da política (DEC-205, DEC-031).
- RN-SLA-05 — `PROCESS_SUSPENDED` pausa sempre; `LEGAL_DILIGENCE` pausa a etapa em diligência do jurídico; `CONDITION` exige `RuleRef`; a pausa estende o prazo pelo tempo pausado e é registrada na timeline (DEC-205).
- RN-SLA-06 — Pausas de SLA não geram notificação, só timeline e auditoria (events.md §6).
- RN-SLA-07 — O escalonamento tem de 1 a 5 degraus e o degrau já disparado (`escalationLevel`) não se repete, salvo `repeatEveryBusinessDays`; com política, os degraus substituem o aviso `STAGE_DUE_SOON` e somam-se a `STAGE_OVERDUE` (DEC-205).
- RN-SLA-08 — Sem política aplicável, o job `deadlines` mantém os avisos do MVP 1 (`deadlines.warnBeforeBusinessDays`) (DEC-205, DEC-031).
- RN-SLA-09 — Cálculo e avaliação rodam no worker, sem custo na transação do comando de tramitação (DEC-205, ADR-015).
- RN-SLA-10 — Política sem permissão `SLA_POLICY_MANAGE` não é criada ou alterada; a mudança emite `SlaPolicyChanged` e é auditada (POL-27, DEC-205).

## Telas
- SCR-121 — Políticas de SLA (`/admin/prazos`).
- SCR-006 — Detalhe do processo: prazo, política aplicada, pausa e degrau.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /sla-policies` e `POST /sla-policies` — listar e criar
- `GET /sla-policies/{id}` e `PATCH /sla-policies/{id}` — consultar e editar (prazos, pausas e degraus)
- `POST /sla-policies/{id}/activate` e `POST /sla-policies/{id}/deactivate` — ativar e desativar
- `POST /sla-policies/preview` — qual política e quais prazos valeriam para um processo
- `GET /processes/{id}/sla` — política aplicada, prazos, pausas e degraus do processo

## Entidades
- `SlaPolicy` e `SlaPolicyStage` — política e prazos por etapa (módulo `sla`).
- `ProcessStage` — `dueAt`, `slaPolicyId`, pausa e `escalationLevel`; `WorkflowStage` — `slaDays`, `pauseSlaWhileReturned`.
- `RuleContext` v2 (`sla.*`); `TenantSetting` (`sla.escalationEnabled`).

## Eventos
- `SlaPolicyChanged` — ao criar, editar, ativar ou desativar.
- `ProcessStageSlaPaused` e `ProcessStageSlaResumed` — pausa e retomada.
- `ProcessStageEscalated` — a cada degrau; `ProcessStageDueSoon` e `ProcessStageOverdue` com `slaPolicyKey` e `escalationLevel`.

## Permissões
- `SLA_POLICY_MANAGE` — cadastrar e alterar políticas (POL-27).
- `RULE_VIEW` — usar regras da biblioteca na aplicabilidade.
- `PROCESS_VIEW` — ver prazo e política no processo.

## Dependências
- US-129 (`RuleContext` v2), US-047 (prazo e entrada em etapa), US-055 e US-106 (configurações e jobs), US-008 e US-153 (suspensão e diligência do jurídico), US-114 (notificações de prazo).
- EP-021 (`RuleContext` v2) e EP-025 (pausa na diligência); DEC-205, ADR-015.

## Critérios de aceite da feature
```gherkin
Feature: Políticas de SLA
  Scenario: Prazo por política, pausa na diligência e escalonamento
    Given que existe a política "PREGAO_ALTO_VALOR" com 15 dias úteis na etapa "JURIDICO" e um degrau 2 dias úteis antes do vencimento
    And o processo "0034/2026" é um pregão acima de R$ 1.000.000,00
    When o processo entrar na etapa "JURIDICO"
    Then "dueAt" deve ser calculado em 15 dias úteis e a política deve aparecer no detalhe
    When o jurídico registrar uma diligência por 4 dias úteis
    Then o prazo deve ficar pausado e voltar com novo vencimento 4 dias úteis depois
    And no degrau configurado o responsável e o titular da unidade devem receber o aviso uma única vez

  Scenario: Sem política aplicável vale o prazo da etapa
    Given que nenhuma política ativa casa com o processo "0035/2026"
    When o processo entrar na etapa "PLANEJAMENTO"
    Then "dueAt" deve usar "slaDays" da etapa e os avisos do MVP 1
```

## Métricas de sucesso
- ≥ 80% das passagens com prazo definido por política nos órgãos que cadastraram política.
- +10 p.p. de cumprimento de prazo por etapa em 6 meses.
- ≥ 90% dos atrasos escalonados antes do vencimento.

## Riscos
- Duas políticas casando na mesma etapa — `priority` e pré-visualização.
- Pausa que esconde atraso real — só pelas condições previstas, tudo na timeline e `pausedSeconds` exibido nos indicadores.
- Reavaliação custosa após mudança de política — montagem preguiçosa do contexto e processamento no worker.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
