---
id: FT-087
title: "Regras de notificação"
epic: EP-030
mvp: 2
priority: P1
stories: [US-193]
status: Especificada
---

# FT-087 — Regras de notificação

## Título
Regras de notificação

## Épico
EP-030 — SLA

## Descrição
O administrador configura **regras de notificação** (`NotificationRule`): um evento de domínio de origem, uma condição opcional em JSON Logic sobre o `RuleContext` v2 do processo do evento, os destinatários (por papel, unidade ou responsável) e o modelo de mensagem. A regra é entregue pelo módulo `notification` como o tipo `RULE_NOTIFICATION`, respeitando as preferências do usuário (US-113) e o e-mail do órgão.

A avaliação é **assíncrona e idempotente** no worker (`NotificationRuleDispatcher`), consumindo eventos do outbox, com chave `eventId` + regra (`NotificationRuleExecution`). Nunca ocorre dentro da transação do comando. Para evitar tempestade de notificações por regra mal escrita, há limite por regra e por destinatário, agrupamento e desligamento automático com alerta ao administrador ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)). A feature está no EP-030 por decisão da DEC-205.

## Valor para o usuário e para o órgão
- Cada órgão decide quem precisa saber de quê, sem pedir alteração de sistema.
- Avisos relevantes (processo urgente parado, valor alto entrando em etapa) chegam sem ruído extra.
- O administrador é avisado quando uma regra é desligada por excesso, em vez de descobrir pela reclamação.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — cria e mantém as regras.
- Gestor de contratações (`GESTOR_CONTRATACOES`), titulares de unidade e secretaria — destinatários típicos.
- Controle interno e auditoria — destinatários de avisos sobre valores e prazos.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-193 ⏳ | Regras de notificação condicional | P1 | M | US-083, US-111, US-112, US-129 |

## Escopo
- Cadastro (SCR-122): nome, evento de origem (só os marcados "notificável por regra"), condição (`RuleRef`), destinatários (`NotificationRecipientSpec`), título e corpo com variáveis da *allowlist*, prioridade, e-mail, limite diário por destinatário; ativar e desativar.
- Execução no worker: casamento do evento, avaliação da condição, resolução de destinatários (máx. 50), entrega e registro de `NotificationRuleExecution` (`matched`, `recipientsCount`, `suppressedCount`).
- Contenção: `maxPerRecipientPerDay` por regra, `notificationRules.maxPerRulePerHour` global; estouro leva a `AUTO_DISABLED` com a notificação `NOTIFICATION_RULE_DISABLED`.
- Histórico de execuções por regra (retenção de 90 dias) e pré-visualização do texto.

## Fora de escopo
- Escalonamento de prazo por degraus (FT-086; `SLA_ESCALATION`).
- Notificações fixas do sistema do MVP 1 (continuam como estão).
- Canais além de notificação interna e e-mail; destinatários externos ao órgão.
- Incluir valores de orçamento ou conteúdo de documentos no texto.

## Regras de negócio da feature
- RN-SLA-11 — Só eventos marcados "notificável por regra" (com `processId` e sem dado sensível no payload) podem ser origem de `NotificationRule` (DEC-205, events.md §1).
- RN-SLA-12 — A condição é avaliada sobre o `RuleContext` v2 do processo do evento; condição nula significa "sempre" (DEC-205, DEC-204).
- RN-SLA-13 — A execução é idempotente por `eventId` + regra (`NotificationRuleExecution`) e acontece apenas no worker, nunca na transação do comando (DEC-205, ADR-015).
- RN-SLA-14 — Os modelos de mensagem aceitam só as variáveis `{{process.code}}`, `{{process.title}}`, `{{stage.name}}`, `{{department.name}}`, `{{event.label}}`, `{{dueAt}}` e `{{link}}`; nunca valores de orçamento nem conteúdo de documento (DEC-086, DEC-205).
- RN-SLA-15 — O destinatário só recebe se tiver visibilidade do processo; as preferências do usuário (US-113) e `notifications.emailEnabled` continuam valendo (DEC-205, DEC-024).
- RN-SLA-16 — Regra que excede `maxPerRecipientPerDay` suprime o excedente (`suppressedCount`); regra que excede `notificationRules.maxPerRulePerHour` vai a `AUTO_DISABLED` e avisa quem tem `NOTIFICATION_RULE_MANAGE` (ADR-015).
- RN-SLA-17 — Alterar ou desativar uma regra só afeta eventos futuros; emite `NotificationRuleChanged` e é auditada (POL-27, DEC-205).

## Telas
- SCR-122 — Regras de notificação (`/admin/notificacoes/regras`).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /notification-rules` e `POST /notification-rules` — listar e criar
- `GET /notification-rules/{id}` e `PATCH /notification-rules/{id}` — consultar e editar
- `POST /notification-rules/{id}/activate` e `POST /notification-rules/{id}/deactivate` — ativar e desativar
- `GET /notification-rules/{id}/executions` — histórico de execuções
- `POST /notification-rules/{id}/preview` — texto e destinatários para um processo de exemplo
- `GET /notification-rules/event-types` — eventos notificáveis por regra

## Entidades
- `NotificationRule` e `NotificationRuleExecution` (módulo `notification`).
- `Notification` (tipos `RULE_NOTIFICATION` e `NOTIFICATION_RULE_DISABLED`), `NotificationPreference`, `RuleContext` v2.

## Eventos
- `NotificationRuleChanged` — criar, editar, ativar, desativar.
- `NotificationRuleAutoDisabled` — limite estourado.
- Eventos de origem marcados NR em [events.md](../mvp-02/events.md) (por exemplo `ProcessStageSkipped` e `ProcessStageEscalated`).

## Permissões
- `NOTIFICATION_RULE_MANAGE` — criar e manter regras (POL-27).
- `RULE_VIEW` — escolher a condição na biblioteca.

## Dependências
- US-111, US-112 e US-083 (central e e-mail de notificações, eventos), US-129 (`RuleContext` v2); FT-086 (eventos de escalonamento); EP-031 (condições da biblioteca).
- DEC-205, ADR-015.

## Critérios de aceite da feature
```gherkin
Feature: Regras de notificação
  Scenario: Avisar o gestor quando uma etapa é dispensada em processo urgente
    Given que existe a regra "Dispensa em urgente" para o evento "ProcessStageSkipped" com condição "prioridade = URGENT"
    And o destinatário da regra é o papel "GESTOR_CONTRATACOES"
    When uma etapa do processo urgente "0040/2026" for dispensada por regra de roteamento
    Then o gestor com visibilidade do processo deve receber a notificação "RULE_NOTIFICATION" com o texto do modelo
    And um novo processamento do mesmo evento não deve duplicar a notificação

  Scenario: Regra com excesso é desligada
    Given que a regra "Toda movimentação" estoura o limite por hora
    When o limite for ultrapassado
    Then a regra deve ficar "AUTO_DISABLED"
    And quem tem "NOTIFICATION_RULE_MANAGE" deve receber "NOTIFICATION_RULE_DISABLED"
```

## Métricas de sucesso
- ≥ 50% das notificações por regra abertas em 24 h.
- < 2% das regras ativas desligadas automaticamente.
- 0 duplicações por reprocessamento de evento.

## Riscos
- Tempestade de notificações — limites, agrupamento e `AUTO_DISABLED`.
- Texto vazar dado sensível — variáveis da *allowlist* e sem valores de orçamento.
- Destinatário sem visibilidade receber aviso de processo — filtro por visibilidade (DEC-024).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
