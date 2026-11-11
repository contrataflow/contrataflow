---
id: FT-089
title: "Roteamento condicional e alçadas"
epic: EP-031
mvp: 2
priority: P1
stories: [US-197, US-198]
status: Especificada
---

# FT-089 — Roteamento condicional e alçadas

## Título
Roteamento condicional e alçadas

## Épico
EP-031 — Regras condicionais

## Descrição
As regras deixam de apenas bloquear a saída de uma etapa e passam a **decidir o caminho** do processo. Duas capacidades:

- **Roteamento:** `WorkflowStage.applicabilityRule` dispensa a etapa automaticamente quando a regra é falsa ao entrar nela (exemplo: "valor acima de X exige Controle Interno", portanto abaixo de X a etapa é dispensada), e `WorkflowTransition.condition` deixa uma transição disponível só quando a condição é verdadeira. A dispensa gera o movimento `SKIP`, a etapa fica `SKIPPED` e a timeline mostra a regra e a versão.
- **Alçadas por valor:** a resolução do aprovador (`WorkflowStageApprover.applicabilityRule`) e da política de decisão (`WorkflowStage.decisionPolicyRules`, `ANY`/`ALL`/`SEQUENTIAL` do EP-022) varia por faixa de valor, avaliada sobre o `RuleContext` v2.

Tudo usa o mesmo executor JSON Logic e regras da biblioteca por versão fixada (FT-088). Etapas legalmente obrigatórias (`isLegallyRequired`, como `JURIDICO` na licitação) não aceitam dispensa ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)).

## Valor para o usuário e para o órgão
- Processos de baixo valor deixam de passar por etapas que não se aplicam, e os de alto valor ganham mais controle automaticamente.
- A alçada de decisão acompanha o valor sem manter workflows paralelos por faixa.
- O motivo de cada dispensa ou escolha fica visível, evitando a impressão de "pulo".

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — configura aplicabilidade, condições e alçadas.
- Gestor de contratações (`GESTOR_CONTRATACOES`) e responsáveis pelas etapas — percebem o novo caminho.
- Autoridade competente (`AUTORIDADE_COMPETENTE`) e demais aprovadores — decidem conforme a alçada.
- Controle interno e Auditor — conferem por que uma etapa foi dispensada.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-197 ⏳ | Roteamento condicional: etapa dispensada e transição condicional | P1 | L | US-041, US-047, US-195 |
| US-198 ⏳ | Alçadas por valor | P1 | M | US-133, US-195 |

## Escopo
- Aplicabilidade de etapa: configuração no editor de workflow (SCR-034); avaliação na entrada da etapa; `ProcessStageStatus.SKIPPED`, `MovementAction.SKIP`, evento, timeline e auditoria; o processo segue para a próxima etapa aplicável.
- Transição condicional: `WorkflowTransition.condition`; só as transições verdadeiras aparecem como destino disponível, e o encaminhamento revalida no servidor.
- Alçadas: faixas de valor para a política de decisão da etapa e para a escolha do aprovador por linha; resolução registrada na `Approval` com a regra e a versão aplicadas.
- Validações na publicação do workflow: regra de roteamento fora de etapa `isLegallyRequired`, casos de teste verdes e grafo íntegro (inclusive com ramos paralelos).
- Visibilidade: motivo da dispensa e da alçada no detalhe do processo (SCR-006) e na timeline.

## Fora de escopo
- Biblioteca, versões e modelos (FT-088) e simulador e casos de teste (FT-090).
- Definição das políticas `ANY`, `ALL` e `SEQUENTIAL` e da segregação entre aprovadores (EP-022); aqui só a escolha da política por faixa.
- Dispensar etapas legalmente obrigatórias.
- Reordenar etapas ou criar etapas dinamicamente em tempo de execução.
- Migração de processos em andamento por mudança de regra (EP-021).

## Regras de negócio da feature
- RN-RULE-09 — `applicabilityRule` falsa na entrada da etapa a dispensa (`SKIPPED`) com movimento `SKIP`, registro na timeline e na auditoria, com a regra, a versão e o `contextVersion`, sem o valor avaliado quando o orçamento é sigiloso (DEC-204, ADR-015).
- RN-RULE-10 — Etapa com `isLegallyRequired` não aceita `applicabilityRule`; a publicação do workflow recusa com `RULE_NOT_ALLOWED_ON_LEGAL_STAGE` (POL-27, ADR-015).
- RN-RULE-11 — `WorkflowTransition.condition` só deixa a transição disponível quando verdadeira; o servidor revalida no encaminhamento (DEC-204).
- RN-RULE-12 — Regra de roteamento e de alçada exige pelo menos um caso de teste verde na publicação da versão da regra (DEC-204, entities.md §4.8).
- RN-RULE-13 — A alçada escolhe a política de decisão (`decisionPolicyRules`, `[{ when, policy }]`) e o aprovador (`WorkflowStageApprover.applicabilityRule`) pelo valor do processo; sem faixa que case, vale a política padrão da etapa (DEC-204, DEC-193).
- RN-RULE-14 — A resolução da alçada é gravada na `Approval` no momento da criação; mudança posterior de valor não reescreve aprovações já abertas (DEC-204, DEC-193).
- RN-RULE-15 — Valores de orçamento sigiloso entram na avaliação, mas nunca saem em mensagens, eventos, auditoria ou para quem não tem a permissão de sigilo (DEC-204, POL-09).
- RN-RULE-16 — A dispensa de etapa é um fato visível: aparece no detalhe do processo e no relatório de tramitação com a etiqueta "dispensada por regra" (ADR-015).

## Telas
- SCR-034 — Workflow (aplicabilidade, condição de transição e faixas de alçada).
- SCR-006 — Detalhe do processo (etapa dispensada e alçada aplicada).
- SCR-014 e SCR-015 — Aprovações e detalhe da aprovação (política e aprovadores resolvidos por faixa).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `PATCH /workflow-stages/{stageId}` — define `applicabilityRule` e `decisionPolicyRules` (estende WF-11)
- `PATCH /workflow-transitions/{transitionId}` — define `condition` (estende WF-14)
- `PUT /workflow-stages/{stageId}/approvers` — faixas de alçada por aprovador
- `POST /workflow-versions/{versionId}/publish` — valida roteamento e alçadas na publicação (estende o endpoint existente de publicação)
- `GET /processes/{id}/routing` — etapas dispensadas e regras aplicadas

## Entidades
- `WorkflowStage` (`applicabilityRule`, `decisionPolicyRules`, `isLegallyRequired`), `WorkflowTransition` (`condition`), `WorkflowStageApprover` (`applicabilityRule`).
- `ProcessStage` (`SKIPPED`), `ProcessMovement` (`SKIP`), `Approval` e `ApprovalApprover`.
- `RuleDefinitionVersion` (tipos `ROUTING` e `APPROVAL_THRESHOLD`).

## Eventos
- `ProcessStageSkipped` — etapa dispensada por regra.
- `RuleVersionPublished` — origem das versões fixadas.
- `ApprovalRequested` (MVP 1) — com a resolução da alçada.

## Permissões
- `WORKFLOW_MANAGE` e `WORKFLOW_PUBLISH` — configurar e publicar.
- `RULE_VIEW` — escolher regras da biblioteca.
- `PROCESS_VIEW` e `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver motivo da dispensa e valores.

## Dependências
- US-041 e US-047 (grafo e encaminhamento), US-133 (política de decisão), US-195 (regras da biblioteca nos workflows); US-125 (ramos paralelos, para a validação do grafo).
- EP-021 (`RuleContext` v2), EP-022 (alçadas sobre a política de decisão); DEC-204, DEC-193, ADR-015.

## Critérios de aceite da feature
```gherkin
Feature: Roteamento condicional e alçadas
  Scenario: Controle Interno só para valores acima do limite e alçada por faixa
    Given que o workflow tem a etapa "CONTROLE_INTERNO" com a regra "CI_ACIMA_DE_VALOR" (limite R$ 500.000,00)
    And a etapa "AUTORIZACAO_LICITACAO" usa "ALCADA_AUTORIDADE_POR_VALOR": até R$ 500.000,00 "ANY", acima "ALL"
    When o processo "0050/2026" de R$ 120.000,00 chegar à etapa "CONTROLE_INTERNO"
    Then a etapa deve ficar "SKIPPED" com o motivo na linha do tempo
    And a autorização deve usar a política "ANY"
    When o processo "0051/2026" de R$ 900.000,00 chegar às mesmas etapas
    Then a etapa "CONTROLE_INTERNO" deve ser executada e a autorização deve usar a política "ALL"

  Scenario: Etapa legalmente obrigatória não pode ser dispensada
    Given que a etapa "JURIDICO" está marcada como "isLegallyRequired"
    When "Admin" tentar publicar o workflow com uma "applicabilityRule" nessa etapa
    Then a publicação deve ser recusada com "RULE_NOT_ALLOWED_ON_LEGAL_STAGE"
```

## Métricas de sucesso
- ≥ 95% das etapas dispensadas sem devolução por "pulo indevido".
- 100% das regras de roteamento e alçada publicadas com casos de teste verdes.
- 0 dispensas de etapas legalmente obrigatórias.

## Riscos
- Dispensa indevida — `isLegallyRequired`, testes obrigatórios e revisão por especialista sugerida.
- Dispensa parecer "pulo" — evento, timeline e etiqueta visível.
- Alçada divergente do ato oficial do órgão — modelos prontos como ponto de partida, simulação antes de publicar (FT-090).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
