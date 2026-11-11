---
id: FT-090
title: "Simulador e testes de regras"
epic: EP-031
mvp: 2
priority: P1
stories: [US-199, US-200]
status: Especificada
---

# FT-090 — Simulador e testes de regras

## Título
Simulador e testes de regras

## Épico
EP-031 — Regras condicionais

## Descrição
O "testar regra" do MVP 1 (WF-23) avalia uma regra contra um processo real visível. O MVP 2 o estende de duas formas:

- **Simulador:** avaliar uma regra (da biblioteca ou em edição) sobre um **processo hipotético**, montado na tela com os campos do `RuleContext` v2 (valor, modalidade, tipo de contratação, estado da dotação, do jurídico, do Controle Interno, do edital, do SLA…), ou sobre um processo real visível. O resultado mostra o valor da expressão e, nas regras de alçada, a política ou o aprovador resolvido.
- **Casos de teste salvos:** cada versão de regra guarda até 50 `RuleTestCase` (nome, contexto parcial e resultado esperado). Antes de publicar, o sistema roda todos os casos; se algum falha, a **publicação é recusada** com o diff do resultado ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)).

Regras de roteamento e de alçada exigem pelo menos um caso verde. O contexto hipotético é completado com padrões neutros do schema, e valores de orçamento sigiloso ficam mascarados para quem não tem a permissão de sigilo.

## Valor para o usuário e para o órgão
- O administrador vê o efeito de uma regra antes de ela alterar processos reais.
- Regressões em regras publicadas são barradas por testes, não descobertas em produção.
- Casos salvos documentam a intenção da regra para quem a mantiver depois.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — simula, escreve casos e publica.
- Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — conferem os casos e usam o simulador para entender uma decisão.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-199 ⏳ | Simular regras com processo hipotético | P1 | M | US-194 |
| US-200 ⏳ | Casos de teste de regra e bloqueio da publicação | P1 | M | US-199 |

## Escopo
- Simulador na SCR-035: formulário de contexto hipotético por namespace, escolha de processo real visível, avaliação da expressão do rascunho ou de qualquer versão, trilha da avaliação (o que valeu em cada nó) e resultado.
- Casos de teste: criar, editar, duplicar e excluir casos da versão em rascunho; esperado booleano (ou política/aprovador em `APPROVAL_THRESHOLD`); "rodar todos" com resultado por caso.
- `testRunHash` guarda o hash da última execução verde; publicar exige que ele corresponda ao `expressionHash` atual.
- Bloqueio da publicação: `RULE_TESTS_FAILING` (422) com o diff esperado × obtido por caso; mínimo de 1 caso em `ROUTING` e `APPROVAL_THRESHOLD`.
- Mascaramento de valores sigilosos e restrição do processo real por `PROCESS_VIEW`.

## Fora de escopo
- Simular o workflow inteiro ou o efeito de várias regras em cadeia (encadeamento — critério de revisão da ADR-015).
- Testes de carga ou de desempenho das regras.
- Importar casos de processos reais em lote.
- Simulador de SLA ponta a ponta (a pré-visualização de política é do EP-030).

## Regras de negócio da feature
- RN-RULE-17 — O simulador aceita processo real visível (`PROCESS_VIEW` sobre ele) ou contexto hipotético montado na tela; ambos usam o mesmo executor JSON Logic com *allowlist* (DEC-204, ADR-008).
- RN-RULE-18 — O contexto hipotético é completado com padrões neutros do schema do `RuleContext` e só aceita caminhos do `contextVersion` da regra (DEC-204, entities.md §7.3).
- RN-RULE-19 — Cada versão guarda até 50 casos (`RuleTestCase`); `expected` é booleano ou, em `APPROVAL_THRESHOLD`, a política ou o aprovador esperado (entities.md §7.3).
- RN-RULE-20 — Publicar exige todos os casos verdes na expressão atual (`testRunHash` igual ao `expressionHash`); falha recusa a publicação com `RULE_TESTS_FAILING` e o diff por caso (DEC-204, POL-27).
- RN-RULE-21 — Versões `ROUTING` e `APPROVAL_THRESHOLD` exigem pelo menos 1 caso de teste (DEC-204, entities.md §4.8).
- RN-RULE-22 — O simulador mascara valores sigilosos para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` sobre o processo e nunca os grava em log nem em auditoria (POL-09, POL-27).
- RN-RULE-23 — Rodar o simulador e os casos não altera nenhum dado de processo; a execução fica na auditoria sem o conteúdo do contexto (DEC-204).

## Telas
- SCR-035 — Regras: simulador e aba de casos de teste (`/admin/regras/[ruleId]`).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /rule-versions/{versionId}/simulate` — avaliar com processo real ou contexto hipotético (estende WF-23, `POST /workflow-versions/{versionId}/rules/test`)
- `GET /rule-versions/{versionId}/test-cases` e `PUT /rule-versions/{versionId}/test-cases` — ler e salvar os casos
- `POST /rule-versions/{versionId}/test-cases/run` — rodar todos os casos e devolver o resultado por caso
- `POST /rule-versions/{versionId}/publish` — recusa com `RULE_TESTS_FAILING` quando há caso vermelho
- `GET /rule-context/schema` — campos disponíveis para montar o contexto hipotético (estende WF-19)

## Entidades
- `RuleDefinitionVersion` (`testCases`, `testRunHash`, `expressionHash`).
- `RuleTestCase` e `RuleContext` v2 (estruturas JSON); `Process` (leitura, no modo real).

## Eventos
- `RuleVersionPublished` — só ocorre depois dos casos verdes.
- A simulação e a execução dos casos não geram evento de domínio; ficam na auditoria (ação a definir no `api.md`).

## Permissões
- `RULE_VIEW` — usar o simulador com contexto hipotético.
- `RULE_MANAGE` — salvar casos de teste.
- `RULE_PUBLISH` — publicar após os casos verdes.
- `PROCESS_VIEW` e `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — processo real e valores sigilosos.

## Dependências
- US-194 (biblioteca e versões), US-199 (simulador, base da US-200); US-129 (`RuleContext` v2).
- DEC-204, ADR-015, ADR-008; POL-27 e POL-09.

## Critérios de aceite da feature
```gherkin
Feature: Simulador e testes de regras
  Scenario: Simular, salvar casos e publicar
    Given que "Admin" editou o rascunho da regra "CI_ACIMA_DE_VALOR" com limite de R$ 500.000,00
    When "Admin" simular um processo hipotético de R$ 900.000,00
    Then o simulador deve indicar que a etapa se aplica, com a trilha da avaliação
    When "Admin" salvar os casos "abaixo do limite" (esperado falso) e "acima do limite" (esperado verdadeiro)
    And publicar a versão
    Then a publicação deve ser aceita com "testRunHash" igual ao "expressionHash"

  Scenario: Caso de teste vermelho bloqueia a publicação
    Given que a versão tem o caso "valor exatamente no limite" esperado como falso, mas a expressão retorna verdadeiro
    When "Admin" tentar publicar a versão
    Then a publicação deve ser recusada com "RULE_TESTS_FAILING"
    And a resposta deve trazer o resultado esperado e o obtido do caso
```

## Métricas de sucesso
- 100% das versões de roteamento e alçada publicadas com casos verdes.
- ≥ 3 casos por regra de roteamento ou alçada em média.
- Redução de correções de regra publicada (nova versão em até 7 dias da publicação) para < 15%.

## Riscos
- Contexto hipotético irreal gerar falsa confiança — padrões neutros, casos de borda nos modelos e simulação com processo real quando possível.
- Vazamento de valor sigiloso — mascaramento, sem log e sem auditoria do contexto.
- Casos que não acompanham a regra — `testRunHash` ligado ao `expressionHash`.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
