---
id: EP-030
title: "SLA"
mvp: 2
priority: P1
features: [FT-086, FT-087]
status: Especificado
---

# EP-030 — SLA

## Título
SLA

## Objetivo
Dar ao gestor prazos que refletem o tipo de contratação, a modalidade e o valor, com pausa quando o processo está parado por motivo legítimo (diligência do jurídico, suspensão) e escalonamento em degraus antes e depois do vencimento. Somar a isso regras de notificação condicional, para que o administrador decida quem é avisado de quê, sem depender de código.

## Contexto e problema
- No MVP 1 o prazo é um número de dias por etapa (`WorkflowStage.slaDays`, DEC-031), igual para qualquer processo, com aviso e atraso simples. Um pregão de alto valor e uma compra direta pequena têm prazos diferentes, e a análise jurídica devolvida em diligência não deveria "gastar" prazo da etapa.
- A DEC-205 cria o módulo `sla` e a `SlaPolicy`, com aplicabilidade em JSON Logic, prazos por etapa, pausas e degraus de escalonamento; e a `NotificationRule`, entregue pelo módulo `notification`. Ambas rodam de forma assíncrona e idempotente no worker, sobre o mesmo executor JSON Logic da ADR-008 ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)).
- O prazo da DEC-031 continua a base: quando nenhuma política casa, vale `WorkflowStage.slaDays`, e `ProcessStage.dueAt` continua sendo o campo do prazo.
- As regras de notificação (`NotificationRule`) ficam neste épico por decisão da DEC-205, ainda que o contexto das regras venha do EP-031 e do `RuleContext` v2 (EP-021).
- Base legal e de gestão: Lei 14.133/2021, art. 11 (governança) e art. 53, § 1º, I (prioridade objetiva); indicadores de cumprimento por etapa saem do read model do EP-028 (DEC-206).

## Escopo
- Módulo `sla` e `SlaPolicy` (SCR-121, `/admin/prazos`): aplicabilidade por `RuleRef`, `priority` (menor vence), restrição opcional a um workflow, prazos por etapa em dias úteis ou corridos (`SlaPolicyStage`), prazo por linha de aprovador.
- Aplicação ao processo: ao entrar na etapa, a política aplicável define `ProcessStage.dueAt`; passagens em curso mantêm o snapshot.
- Pausas por condição (`PROCESS_SUSPENDED`, `LEGAL_DILIGENCE`, `CONDITION`): estendem o prazo pelo tempo pausado, com registro na timeline.
- Escalonamento em até 5 degraus (`SlaEscalationStep`): aviso antes, no vencimento e depois, para responsável, titular ou substituto da unidade, gestor e titular da secretaria; `escalationLevel` evita repetição.
- `NotificationRule` (SCR-122, `/admin/notificacoes/regras`): evento notificável + condição + destinatários + modelo de mensagem, contenção por regra e destinatário, desligamento automático com alerta; preferências do usuário (US-113) continuam valendo.

## Fora de escopo
- Indicadores e relatórios de cumprimento de prazo (EP-028 — DEC-206).
- Biblioteca de regras, simulador e testes (EP-031); o EP-030 só consome `RuleRef` e `RuleContext` v2.
- Prazo de aprovação avulsa de documento (DT-17 — EP-022).
- Notificações por canais novos (SMS, mensageria) e escalonamento para pessoas fora do órgão.
- Calendário próprio de feriados além do que o MVP 1 já resolve para dias úteis.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Administrador do órgão | `ADMIN_ORGAO` | Cadastrar políticas de prazo e regras de notificação, sem código |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Acompanhar prazos realistas e ser avisado nos degraus de escalonamento |
| Responsável pela etapa | `PLANEJAMENTO`, `COMPRAS`, `JURIDICO`, `CONTROLE_INTERNO` | Saber o prazo aplicável e ter o prazo pausado quando o processo está em diligência |
| Titular de unidade / secretaria | Chefias | Receber o escalonamento do que está sob sua responsabilidade |
| Auditor / Controle interno | `AUDITOR`, `CONTROLE_INTERNO` | Ver qual política e qual degrau valeram para cada atraso |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-086 | Políticas de SLA | US-189, US-190, US-191, US-192 | P1 |
| FT-087 | Regras de notificação | US-193 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-189 ⏳ | Cadastrar políticas de SLA | P1 | L | 8 |
| US-190 ⏳ | Aplicar a política de SLA ao processo e calcular prazos | P1 | M | 5 |
| US-191 ⏳ | Pausar e retomar prazos | P1 | M | 5 |
| US-192 ⏳ | Escalonar prazos em degraus | P1 | M | 5 |
| US-193 ⏳ | Regras de notificação condicional | P1 | M | 5 |
| **Total** | | | | **28** |

## Módulos e entidades
- Módulos: `sla` (novo), `notification` (regras e entrega), leitura de `process`, `workflow`, `legal-review` e `rules`; worker (jobs `deadlines`, `notifications`).
- Entidades: `SlaPolicy`, `SlaPolicyStage` (dono `sla`); `NotificationRule`, `NotificationRuleExecution` (dono `notification`); `ProcessStage` (`dueAt`, pausa e `escalationLevel` — dono `process`); `WorkflowStage` (`slaDays` como base, `pauseSlaWhileReturned`); `RuleContext` v2 (`sla.*`).

## Telas
- SCR-121 — Políticas de SLA (`/admin/prazos`).
- SCR-122 — Regras de notificação (`/admin/notificacoes/regras`).
- SCR-006 — Detalhe do processo (prazo, política aplicada, pausa e degrau na linha do tempo).

## Integrações
- Internas: outbox e `SlaEvaluator` / `NotificationRuleDispatcher` (worker), job `deadlines`, `NotificationDispatcher`, `TimelineProjector`, e-mail (SES) respeitando as preferências do usuário. Sem integração externa.

## Eventos principais
- `SlaPolicyChanged`, `ProcessStageSlaPaused`, `ProcessStageSlaResumed`, `ProcessStageEscalated`, `ProcessStageDueSoon`/`ProcessStageOverdue` (ampliados com `slaPolicyKey` e `escalationLevel`), `NotificationRuleChanged`, `NotificationRuleAutoDisabled`.
- Consumidos como origem de regras de notificação: os eventos marcados NR em [events.md](../mvp-02/events.md).

## Permissões envolvidas
- `SLA_POLICY_MANAGE` (nova, risco H, POL-27), `NOTIFICATION_RULE_MANAGE` (nova, POL-27); `RULE_VIEW` para escolher regras da biblioteca; `PROCESS_VIEW` para o prazo no detalhe.

## Regras configuráveis
- `sla.escalationEnabled` — desliga só os degraus; os avisos do MVP 1 continuam (padrão `true`).
- `deadlines.warnBeforeBusinessDays` — avisos do MVP 1 quando nenhuma política se aplica.
- `notificationRules.maxPerRulePerHour` — acima disso a regra vai a `AUTO_DISABLED` (padrão 500).
- Política modelo `PADRAO_FASE_PREPARATORIA` (inativa, com prazos sugeridos) e a regra de modelo `SLA_PREGAO` / `NOTIFICAR_GESTOR_PRAZO_VENCIDO` (semeadas, sem uso até a adoção).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Etapas com prazo definido por política (nos órgãos que cadastraram política) | ≥ 80% das passagens | `ProcessStage.slaPolicyId` (read model) |
| Cumprimento de prazo por etapa | +10 p.p. em 6 meses nos órgãos com política | `AnalyticsStageFact.wasOverdue` |
| Atrasos escalonados antes de 3 dias úteis do vencimento | ≥ 90% | `ProcessStageEscalated` × `ProcessStageOverdue` |
| Notificações condicionais que levam a ação | ≥ 50% abertas em 24 h | `Notification` do tipo `RULE_NOTIFICATION` |
| Regras de notificação desligadas automaticamente | < 2% das regras ativas | `NotificationRuleAutoDisabled` |

## Dependências
- **Depende de:** EP-008 (tramitação e prazos), EP-017 (configurações), EP-019 (notificações); EP-021 (`RuleContext` v2, US-129, namespace `sla.*`); EP-025 (pausa na diligência do jurídico).
- **Habilita:** EP-028 (cumprimento de prazo por etapa e unidade); EP-031 (regras do tipo `SLA` e `NOTIFICATION` na biblioteca).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Duas políticas casam na mesma etapa | Média | Médio | Vence a de menor `priority` e, no empate, a mais antiga; pré-visualização da política aplicada |
| Pausa indevida esconde atraso real | Média | Alto | Pausas só pelas condições listadas, tudo na timeline e na auditoria; indicadores descontam e exibem `pausedSeconds` |
| Tempestade de notificações por regra mal escrita | Média | Médio | Limite por regra e por destinatário, agrupamento, `AUTO_DISABLED` com alerta ao administrador (ADR-015) |
| Mudança de política altera processos em curso | Baixa | Médio | Só vale para novas entradas em etapa; passagens mantêm o snapshot |
| Custo de montar o `RuleContext` v2 em cada avaliação | Média | Baixo | Montagem preguiçosa por namespace e cache por requisição |

## Pontos em aberto
- Prazos sugeridos por etapa no modelo `PADRAO_FASE_PREPARATORIA`: "a validar com o piloto" (entities.md §9).
- Lista final de eventos notificáveis por regra e telas SCR-121/SCR-122: fechadas no `api.md` e no `screens.md` do MVP 2.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (política → prazo → pausa na diligência → escalonamento; regra de notificação com contenção)
- [ ] Teste de idempotência por `eventId` + regra e de reavaliação após mudança de política
- [ ] Documentação e treinamento (guia do administrador) atualizados
