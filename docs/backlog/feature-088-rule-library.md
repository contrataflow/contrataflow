---
id: FT-088
title: "Biblioteca de regras"
epic: EP-031
mvp: 2
priority: P1
stories: [US-194, US-195, US-196]
status: Especificada
---

# FT-088 — Biblioteca de regras

## Título
Biblioteca de regras

## Épico
EP-031 — Regras condicionais

## Descrição
Uma biblioteca de regras reutilizáveis do tenant, no módulo `rules` (SCR-035). Cada regra (`RuleDefinition`) tem nome, descrição, etiquetas e um tipo que diz onde pode ser usada (`VALIDATION`, `ROUTING`, `APPROVAL_THRESHOLD`, `SLA`, `NOTIFICATION`). Cada versão publicada (`RuleDefinitionVersion`) é **imutável** e carrega a expressão JSON Logic, o `contextVersion` (1 ou 2), a mensagem ao usuário e os casos de teste.

Os workflows usam a regra da biblioteca por **versão fixada** na publicação (`RuleRef` em modo `LIBRARY`), como já ocorre com as versões de workflow (DEC-014): editar a regra cria nova versão e não altera o que está publicado. `WorkflowRule` continua existindo para regras locais e para as do MVP 1, que seguem no contexto v1. A feature entrega também **modelos prontos** semeados, que o administrador copia e adapta ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)).

## Valor para o usuário e para o órgão
- A mesma regra vale em vários workflows, sem copiar e colar nem divergir.
- Uma correção é publicada uma vez e adotada nos workflows por escolha, com impacto visível.
- O administrador começa de modelos prontos em vez de escrever JSON Logic do zero.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — cria, publica e adota regras.
- Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — leem a biblioteca e o histórico de versões.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-194 ⏳ | Biblioteca de regras reutilizáveis com versões | P1 | L | US-044, US-129 |
| US-195 ⏳ | Usar regras da biblioteca nos workflows por versão fixada | P1 | M | US-045, US-194 |
| US-196 ⏳ | Modelos prontos de regras | P1 | S | US-194 |

## Escopo
- Cadastro (SCR-035): chave imutável, nome, descrição, tipo, etiquetas, ativa ou inativa; listagem e busca por tipo e etiqueta.
- Versões: rascunho único por regra, publicação, aposentadoria (`RETIRED`), `changeNotes` obrigatório a partir da v2, `expressionHash` na publicação; versão publicada nunca é excluída.
- Editor de expressão guiado pelo schema do `RuleContext` (v1 ou v2), restrito à *allowlist* da ADR-008, com mensagem e severidade para `VALIDATION`.
- Uso nos workflows: seletor de regra da biblioteca em regras de saída, e versões fixadas em `WorkflowVersion.ruleRefs`; indicação de quais workflows usam cada versão.
- Modelos prontos (`isSystem`, semeados): `COBERTURA_DOTACAO`, `CI_ACIMA_DE_VALOR`, `ALCADA_AUTORIDADE_POR_VALOR`, `SLA_PREGAO`, `NOTIFICAR_GESTOR_PRAZO_VENCIDO`; copiar para o tenant; não excluíveis.

## Fora de escopo
- Roteamento e alçadas em execução (FT-089) e simulador e testes (FT-090).
- Encadeamento de regras e tabelas de decisão DMN (critério de revisão da ADR-015).
- Migração automática de regras v1 para v2: passam por edição do administrador.
- Políticas de SLA e regras de notificação em si (EP-030).

## Regras de negócio da feature
- RN-RULE-01 — `RuleDefinition` é do tenant, com `key` imutável e nome único; o tipo (`kind`) define onde a regra pode ser usada (DEC-204).
- RN-RULE-02 — A versão publicada é imutável e nunca excluída; publicar aposenta a versão publicada anterior; usos já publicados continuam na versão fixada (DEC-204, ADR-015).
- RN-RULE-03 — Cada versão grava `contextVersion`; regras v1 continuam avaliadas com o contexto v1 e nada quebra; o montador de contexto entrega a versão pedida (DEC-204).
- RN-RULE-04 — A expressão usa só o executor JSON Logic com *allowlist* e apenas caminhos do contexto da versão; sem código arbitrário e sem acesso a banco (DEC-016, ADR-008).
- RN-RULE-05 — Na publicação do workflow, `RuleRef` em modo `LIBRARY` exige versão `PUBLISHED` cujo `kind` combine com o uso, e fixa a versão em `ruleRefs` (DEC-204, entities.md §7.1).
- RN-RULE-06 — Regra inativa não é oferecida a novos usos, mas os usos publicados continuam (DEC-204).
- RN-RULE-07 — Modelos `isSystem` não são excluíveis nem editáveis; o tenant trabalha em cópia, e os modelos ficam sem uso até o administrador adotar (DEC-204, entities.md §9).
- RN-RULE-08 — Publicar versão exige `RULE_PUBLISH` e emite `RuleVersionPublished`; aposentar emite `RuleVersionRetired`; ambos são auditados (POL-27, DEC-204).

## Telas
- SCR-035 — Regras: biblioteca (`/admin/regras` e `/admin/regras/[ruleId]`).
- SCR-034 — Workflow: seletor de regra da biblioteca.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /rules` e `POST /rules` — listar e criar regras
- `GET /rules/{id}` e `PATCH /rules/{id}` — consultar e editar metadados
- `POST /rules/{id}/versions` — criar rascunho de nova versão
- `PATCH /rule-versions/{versionId}` — editar expressão e mensagem do rascunho
- `POST /rule-versions/{versionId}/publish` e `POST /rule-versions/{versionId}/retire` — publicar e aposentar
- `GET /rules/{id}/usages` — workflows e versões que usam a regra
- `POST /rules/{id}/copy` — copiar modelo ou regra
- `POST /workflow-versions/{versionId}/rules` — estende WF-16 com `ruleDefinitionVersionId`
- `GET /rule-context/schema` — estende WF-19 com o schema do `RuleContext` v2

## Entidades
- `RuleDefinition` e `RuleDefinitionVersion` (módulo `rules`).
- `WorkflowRule` (`ruleDefinitionVersionId`, `contextVersion`), `WorkflowVersion` (`ruleRefs`).
- `RuleRef` e `RuleContext` v2 (estruturas JSON).

## Eventos
- `RuleVersionPublished` — ao publicar versão.
- `RuleVersionRetired` — ao aposentar.
- `WorkflowVersionPublished` (MVP 1) — fixa as versões de regra usadas.

## Permissões
- `RULE_VIEW` — ver a biblioteca.
- `RULE_MANAGE` — criar e editar rascunhos.
- `RULE_PUBLISH` — publicar e aposentar versões (POL-27).
- `WORKFLOW_MANAGE` — usar regras da biblioteca no workflow.

## Dependências
- US-044 e US-045 (regras e versões de workflow do MVP 1), US-129 (`RuleContext` v2); DEC-204, ADR-015, ADR-008.

## Critérios de aceite da feature
```gherkin
Feature: Biblioteca de regras
  Scenario: Publicar uma regra e usá-la em dois workflows
    Given que "Admin" é "ADMIN_ORGAO" e adaptou o modelo "COBERTURA_DOTACAO" para a regra "COBERTURA_DO_ORGAO"
    When "Admin" publicar a versão 1 da regra
    And usar a regra na saída da etapa "DOTACAO" dos workflows "Fase preparatória" e "Contratação direta"
    Then os dois workflows devem registrar a versão 1 em "ruleRefs"
    When "Admin" publicar a versão 2 da regra
    Then os workflows já publicados devem continuar usando a versão 1
    And a tela de usos deve listar os dois workflows como candidatos à adoção da versão 2

  Scenario: Regras do MVP 1 continuam funcionando
    Given que um workflow publicado tem uma regra local "REQUIRED_DOCUMENT" do MVP 1
    When um processo tentar sair da etapa sem o documento
    Then a regra deve ser avaliada com o contexto v1 e bloquear a saída como antes
```

## Métricas de sucesso
- ≥ 30% das regras ativas usadas em mais de um workflow.
- 100% das versões publicadas com `expressionHash` e `changeNotes` (a partir da v2).
- Tempo de criar regra a partir de modelo ≤ 10 min.

## Riscos
- Regras complexas demais — modelos prontos e o simulador (FT-090).
- Regra editada alterar workflows publicados — versão imutável e referência por versão fixada.
- Contexto v2 maior aumentar o custo de avaliação — montagem preguiçosa por namespace.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
