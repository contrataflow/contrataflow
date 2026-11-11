---
id: US-200
title: "Casos de teste de regra e bloqueio da publicação"
epic: EP-031
feature: FT-090
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-199]
modules: [rules, access, audit, platform]
screens: [SCR-035]
endpoints: [RUL-14, RUL-15, RUL-16, RUL-09, WF-19]
permissions: [RULE_VIEW, RULE_MANAGE, RULE_PUBLISH]
events: [RuleVersionPublished]
---

# US-200 — Casos de teste de regra e bloqueio da publicação

## Título
Casos de teste de regra e bloqueio da publicação

## Descrição
**Como** administrador do órgão, **quero** salvar casos de teste na versão de uma regra (nome, contexto e resultado esperado), rodar todos de uma vez e ter a publicação recusada, com o resultado esperado e o obtido de cada caso que falha, **para** barrar regressões e regras erradas antes que alterem processos reais e deixar documentada a intenção da regra para quem a mantiver depois.

A story entrega os `RuleTestCase` (até 50 por versão, entities.md §7.3) guardados em `RuleDefinitionVersion.testCases`, a aba "Casos de teste" da SCR-035 (criar, editar, duplicar, excluir e "Rodar todos" com resultado por caso), o `testRunHash` (hash da última execução verde, ligado ao `expressionHash`), o *gate* de publicação da US-194 (todos os casos verdes na expressão atual, recusa `RULE_TESTS_FAILING` com o diff por caso) e a exigência de **pelo menos 1 caso** nas versões `ROUTING` e `APPROVAL_THRESHOLD`. Reusa o avaliador e o contexto hipotético da US-199.

## Contexto
- A ADR-015 (decisão 7) e a DEC-204: "falha de caso = publicação recusada, com o diff do resultado"; POL-27: publicar versão de regra "exige casos de teste verdes na expressão atual". entities.md §4.8 e §6.9: `testCases` obrigatório com ≥ 1 em `ROUTING` e `APPROVAL_THRESHOLD`; `testRunHash` é o "hash da última execução verde dos casos (publicar exige o hash da expressão atual)"; transição `DRAFT → PUBLISHED` exige "casos de teste verdes com `testRunHash` atual".
- É a mitigação mais forte do risco "regras complexas demais" (roadmap §4.10): em roteamento e alçada, que alteram caminho e decisão (US-197, US-198), nenhuma versão chega a `PUBLISHED` sem testes.
- O ponto de extensão `PublishGate` da US-194 é preenchido aqui; o simulador (US-199) fornece o avaliador, a fábrica de contexto hipotético (padrões neutros) e o formulário por namespace, reusados no editor de casos.
- Os casos são **dados hipotéticos digitados pelo administrador**: não há importação de processos reais (fora de escopo da feature), portanto não guardam valor de orçamento sigiloso de processo algum.
- Modelos prontos (US-196) já nascem com casos de borda (valor um centavo abaixo, no limite e um centavo acima, e valor nulo); uma cópia de regra e uma nova versão (US-194, RN-RULE-16) herdam os casos como suíte de regressão.

## Objetivo
Garantir que 100% das versões de roteamento e alçada publicadas tenham casos de teste verdes (meta de KPI), com média de pelo menos 3 casos por regra, e que 100% das publicações com caso vermelho sejam recusadas com o diff esperado × obtido.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `RULE_VIEW`, `RULE_MANAGE` e `RULE_PUBLISH`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, `RULE_VIEW` e `RULE_MANAGE`: escreve e roda os casos, mas não publica); Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), com `RULE_VIEW`, que conferem os casos de uma versão publicada para entender a intenção da regra.

## Pré-condições
- US-194 (versão `DRAFT` com expressão válida e o ponto de extensão `PublishGate`) e US-199 (avaliador, contexto hipotético e schema com `default`/`options`).
- Para editar casos e rodar no rascunho: `RULE_MANAGE`. Para ler e rodar em versão publicada ou aposentada: `RULE_VIEW`. Para publicar: `RULE_PUBLISH` e, conforme `security.mfaPolicy`, sessão com MFA (POL-14).

## Fluxo principal
1. No rascunho da regra `CI_ACIMA_DE_VALOR` (limite de R$ 500.000,00, valor nulo aplica), na aba "Casos de teste", o administrador clica em "Novo caso".
2. Informa o **nome** ("abaixo do limite"), monta o **contexto parcial** no mesmo formulário por namespace do simulador (`process.estimatedValue = 499999.99`) e o **resultado esperado** (falso). Repete para "valor exatamente no limite" (500000,00 → falso), "acima do limite" (500000,01 → verdadeiro) e "valor não informado" (nulo → verdadeiro).
3. O front salva a lista com RUL-15 e `If-Match`. A API valida cada caso (caminhos do `contextVersion`, tipos, tipo do esperado), substitui a lista, zera o `testRunHash`, audita `rule.update` (seção `TEST_CASES`) e responde 200.
4. O administrador clica em "Rodar todos" (RUL-16). A API avalia **todos** os casos com o executor do runtime (sem parar no primeiro erro), compara o esperado com o obtido e devolve o resultado por caso; se todos passam, grava `testRunHash` igual ao hash da expressão atual e audita `rule.test_run`.
5. A tela mostra, por caso, "Passou" ou "Falhou: esperado falso, obtido verdadeiro", com atalho "Simular este caso" (abre o simulador com o contexto do caso) e o selo "Testes verdes para esta expressão".
6. Com todos verdes, o administrador publica (RUL-09). O *gate* **roda os casos de novo dentro da transação** (a execução manual não é confiada), exige o mínimo de casos do tipo, e, estando verdes, publica, grava `testRunHash = expressionHash`, audita `rule.version_publish`, aposenta a anterior e grava `RuleVersionPublished` (US-194).
7. Se um caso falha (por exemplo, "valor exatamente no limite" esperado falso, mas a expressão usa `>=` e devolve verdadeiro), a API responde 422 `RULE_TESTS_FAILING` com o diff por caso, a versão continua `DRAFT` e nada é gravado além da auditoria da tentativa; a tela abre a aba de testes com os casos vermelhos em destaque.
8. O administrador corrige a expressão (ou o caso, se o esperado estava errado) e repete; ao criar uma nova versão depois (RUL-06), os casos da publicada vêm copiados como suíte de regressão.

## Fluxos alternativos
- **FA-01 — Duplicar caso:** a ação "Duplicar" cria na tela um caso novo com o mesmo contexto e nome "{nome} (cópia)"; só vale ao salvar a lista (RUL-15).
- **FA-02 — Excluir caso:** remove da lista; salvar zera `testRunHash`; em `ROUTING`/`APPROVAL_THRESHOLD`, deixar a lista vazia é permitido no rascunho, mas bloqueia a publicação (`RULE_TESTS_REQUIRED`).
- **FA-03 — Resultado esperado textual:** em `APPROVAL_THRESHOLD`, o esperado pode ser um texto (política `ANY`, `ALL` ou `SEQUENTIAL`, ou rótulo de aprovador) quando a expressão devolve texto; nos demais tipos só booleano (L-02).
- **FA-04 — Caso que falha na avaliação:** erro do executor (caminho ausente, tempo excedido) conta como **vermelho** com `error`, `obtained = null` e a mensagem; o "Rodar todos" segue com os demais.
- **FA-05 — Rodar em versão publicada:** RUL-16 em versão `PUBLISHED` ou `RETIRED` apenas reporta (a versão é imutável e o `testRunHash` já foi gravado na publicação); exige só `RULE_VIEW`.
- **FA-06 — Expressão alterada depois da execução verde:** editar a expressão ou o `contextVersion` zera o `testRunHash` e o selo "Testes verdes" some; a publicação roda de novo mesmo assim.
- **FA-07 — Regras sem mínimo de casos:** `VALIDATION`, `SLA` e `NOTIFICATION` publicam com zero caso; se houver casos, todos precisam estar verdes.
- **FA-08 — Sugestão de cobertura:** o editor sugere (sem bloquear) "adicione um caso verdadeiro e um falso" e destaca limites numéricos da expressão para casos de borda.
- **FA-09 — Muitos casos:** a 51ª entrada é recusada no front e na API (limite de 50 por versão).

## Regras de negócio
- **RN-RULE-111** — Cada `RuleDefinitionVersion` guarda até **50** casos em `testCases` (`RuleTestCase`: `name`, `context` parcial, `expected`); `name` de 1 a 120 caracteres (L-03), **único** na versão sem diferenciar maiúsculas; `context` aceita só caminhos do `contextVersion` da versão; excesso de casos: `VALIDATION_ERROR` (`TOO_MANY`).
- **RN-RULE-112** — Os casos só são editados na versão `DRAFT` (RUL-15 com `If-Match`, substituição atômica da lista); versão `PUBLISHED`/`RETIRED` é imutável (trigger, US-194) e responde `RULE_VERSION_NOT_DRAFT`. Qualquer mudança em casos, expressão ou `contextVersion` **zera `testRunHash`**.
- **RN-RULE-113** — `expected` é **booleano** em todos os tipos; em `APPROVAL_THRESHOLD` pode ser **texto** (política ou aprovador esperado, 1 a 120 caracteres) quando a expressão devolve texto (entities.md §7.3). A comparação é estrita em tipo e valor: esperado booleano contra resultado textual (ou o inverso) é caso vermelho.
- **RN-RULE-114** — O contexto do caso é completado com os **padrões neutros do schema** (mesma fábrica da US-199) e avaliado com o **mesmo executor com *allowlist*** do runtime; os casos são determinísticos (`now` fixo por execução) e usam só dados hipotéticos: **não há importação de processos reais** nem valor de orçamento sigiloso nos casos.
- **RN-RULE-115** — "Rodar todos" (RUL-16) avalia **todos** os casos da versão, sem interromper no primeiro vermelho, e devolve por caso `{ index, name, expected, obtained, passed, error? }`; em rascunho, se `allPassed` e houver ao menos 1 caso, grava `testRunHash` igual ao hash **atual** da expressão (`currentExpressionHash`); caso contrário, deixa `testRunHash` nulo. Em versão publicada ou aposentada só reporta.
- **RN-RULE-116** — O hash comparado é o `expressionHash` definido na US-194 (SHA-256 da forma canônica JCS de `{ contextVersion, expression }`); durante o rascunho calcula-se o `currentExpressionHash` sob demanda. `testRunHash` válido = igual ao `currentExpressionHash`.
- **RN-RULE-117** — **Gate de publicação (POL-27):** RUL-09 reavalia **todos** os casos **dentro da transação de publicação**, sob o mesmo bloqueio da versão; se algum falhar, responde 422 `RULE_TESTS_FAILING` com `details.cases[]` (`index`, `name`, `expected`, `obtained`, `error?`) e **nada muda** (versão continua `DRAFT`, sem `expressionHash`, sem evento); se todos passarem, grava `testRunHash = expressionHash` na mesma transação. A execução manual de RUL-16 **não** dispensa o gate.
- **RN-RULE-118** — Versões `ROUTING` e `APPROVAL_THRESHOLD` exigem **pelo menos 1 caso** para publicar (`RULE_TESTS_REQUIRED`, 422); `VALIDATION`, `SLA` e `NOTIFICATION` publicam sem casos, mas, havendo casos, todos devem estar verdes. Meta de qualidade: média ≥ 3 casos por regra de roteamento ou alçada.
- **RN-RULE-119** — A criação de nova versão (RUL-06) e a cópia de regra (US-196) **copiam os casos** da versão de origem; assim, os casos viram regressão: alterar a expressão pode deixar casos vermelhos, e o administrador decide corrigir a expressão ou ajustar os casos (com `changeNotes`).
- **RN-RULE-120** — **Auditoria e sigilo:** salvar casos grava `rule.update` (`metadata.section = TEST_CASES`, `casesCount`), rodar grava `rule.test_run` (`trigger` `MANUAL` ou `PUBLISH`, `total`, `passed`, `failed`, `result`) — inclusive a tentativa de publicação recusada — **sem** o contexto dos casos nem as expressões; a resposta de falha traz o esperado e o obtido (valores lógicos ou textos), e o resultado dos casos nunca é persistido além do `testRunHash`.

Regras que se aplicam, sem renumerar: **RN-RULE-10, RN-RULE-11 e RN-RULE-16** (US-194: publicação, hash e cópia das versões), **RN-RULE-97 a RN-RULE-104** (US-199: executor único, contexto hipotético, sem efeito colateral), **RN-WF-58** (executor com *allowlist*).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome do caso | `cases[].name` | texto | Sim | 1–120 caracteres; único na versão | — |
| Contexto do caso | `cases[].context` | `DeepPartial<RuleContext>` | Não | só caminhos do `contextVersion`; tipos do schema; completado com padrões neutros | `{}` |
| Resultado esperado | `cases[].expected` | booleano ou texto | Sim | booleano; texto só em `APPROVAL_THRESHOLD` (1–120) | — |
| Lista de casos | `cases` | lista | Sim (PUT) | 0 a 50 itens | versão corrente |
| *(sistema)* Hash atual da expressão | `currentExpressionHash` | texto (64) | — | SHA-256 JCS de `{ contextVersion, expression }` | calculado |
| *(sistema)* Hash da última execução verde | `testRunHash` | texto (64) | — | zerado por qualquer mudança em casos ou expressão | nulo |
| *(sistema)* Testes verdes | `lastRunGreen` | booleano | — | `testRunHash = currentExpressionHash` | calculado |
| *(resposta)* Resultado por caso | `results[]` | lista | — | `index`, `name`, `expected`, `obtained`, `passed`, `error?` | calculado |
| *(resposta)* Totais | `total`, `passed`, `failed`, `allPassed` | inteiros/booleano | — | — | calculado |
| *(resposta)* Diff da recusa | `details.cases[]` | lista | — | casos vermelhos com esperado e obtido | calculado |
| Notas da alteração | `changeNotes` | texto | Condicional | obrigatório a partir da v2 (US-194) | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `name` vazio ou acima de 120 caracteres | Front + API (Zod) | "Dê um nome ao caso (até 120 caracteres)." | `VALIDATION_ERROR` |
| V-02 | Nome de caso repetido na versão | Front + API | "Já existe um caso com este nome nesta regra." | `VALIDATION_ERROR` (`DUPLICATE`) |
| V-03 | Mais de 50 casos | Front + API | "Use até 50 casos de teste por versão." | `VALIDATION_ERROR` (`TOO_MANY`) |
| V-04 | Caminho do `context` fora do schema do `contextVersion` | Front + API | "O campo {caminho} não existe nesta versão do contexto." | `VALIDATION_ERROR` (`PATH_UNKNOWN`) |
| V-05 | Tipo do valor diferente do tipo do campo | Front + API | "O campo {rótulo} espera {tipo}." | `VALIDATION_ERROR` (`TYPE_MISMATCH`) |
| V-06 | `expected` textual fora de `APPROVAL_THRESHOLD`, ou booleano ausente | Front + API | "O resultado esperado deve ser Verdadeiro ou Falso." | `VALIDATION_ERROR` (`NOT_ALLOWED`/`REQUIRED`) |
| V-07 | `expected` textual vazio ou acima de 120 caracteres | Front + API | "Informe a política ou o aprovador esperado (até 120 caracteres)." | `VALIDATION_ERROR` |
| V-08 | Salvar casos em versão que não é `DRAFT` | API | "Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão." | `RULE_VERSION_NOT_DRAFT` |
| V-09 | Publicar `ROUTING` ou `APPROVAL_THRESHOLD` sem nenhum caso | API (RUL-09) | "Regras de roteamento e de alçada precisam de ao menos um caso de teste." | `RULE_TESTS_REQUIRED` |
| V-10 | Publicar com algum caso vermelho | API (RUL-09) | "Há casos de teste que não passam. Corrija a regra ou os casos." | `RULE_TESTS_FAILING` |
| V-11 | `If-Match` ausente ou divergente (RUL-15) | API | "Os dados foram alterados por outra pessoa. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-12 | Editar casos de modelo do sistema | API | "Modelos do sistema não podem ser alterados. Copie o modelo para adaptá-lo." | `RULE_SYSTEM_READONLY` |

## Permissões
- **Permissão:** `RULE_VIEW` (risco L) para ler os casos (RUL-14) e rodar em versão publicada ou aposentada; `RULE_MANAGE` (risco M) para salvar casos (RUL-15) e rodar no rascunho (RUL-16, que grava o `testRunHash`); `RULE_PUBLISH` (risco H) para publicar com o *gate* (RUL-09). Nenhuma é escopável.
- **Políticas:** POL-27 (publicar exige casos verdes na expressão atual); POL-14 na publicação (`HIGH`).
- **MFA:** publicar exige sessão com MFA quando `security.mfaPolicy` for `ADMINS` ou `ALL` (`MFA_REQUIRED`, 403); salvar casos e rodar não exigem MFA própria (risco `M`).
- **Sem permissão:** a aba "Casos de teste" fica em leitura sem `RULE_MANAGE` (botões de criar, editar, duplicar, excluir e "Rodar todos" ocultos no rascunho); "Publicar" oculto sem `RULE_PUBLISH`; a API responde 403 `PERMISSION_DENIED` com `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `RuleVersionPublished` | `rule.version_published` | Commit de RUL-09, **somente depois dos casos verdes** | Payload da US-194 (`ruleDefinitionId`, `key`, `kind`, `ruleDefinitionVersionId`, `versionNumber`, `contextVersion`, `expressionHash`); publicação recusada não gera evento |

Salvar casos e rodar não geram evento de domínio (feature FT-090): ficam na auditoria (`rule.update`, `rule.test_run`).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: o resultado dos casos é mostrado na própria tela e na resposta da API; não há notificação nem entrada na timeline de processo. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Casos de teste de regra e bloqueio da publicação

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (RULE_VIEW, RULE_MANAGE, RULE_PUBLISH)
    And "Rafael" tem vínculo ativo com o perfil "GESTOR_CONTRATACOES" (RULE_VIEW, RULE_MANAGE)
    And "Paulo" tem vínculo ativo com o perfil "CONTROLE_INTERNO" (RULE_VIEW)
    And a regra "CI_ACIMA_DE_VALOR" (tipo "ROUTING") tem o rascunho da versão 1 com a condição "valor nulo ou process.estimatedValue > 500000"

  Scenario: [Sucesso] Salvar os casos, rodar todos e ver tudo verde
    When "Marina" salvar os casos "abaixo do limite" (499999,99, falso), "valor exatamente no limite" (500000,00, falso), "acima do limite" (500000,01, verdadeiro) e "valor não informado" (nulo, verdadeiro)
    Then a API deve responder 200 com 4 casos e "testRunHash" nulo
    And deve gerar registro de auditoria "rule.update" com "metadata.section" "TEST_CASES" e "casesCount" 4
    When "Marina" rodar todos os casos
    Then a API deve responder 200 com "total" 4, "passed" 4 e "allPassed" verdadeiro
    And "testRunHash" deve ser igual ao "currentExpressionHash"
    And deve gerar registro de auditoria "rule.test_run" com "trigger" "MANUAL" e "result" de sucesso
    And não deve gerar evento de domínio

  Scenario: [Sucesso] Publicar com casos verdes grava o hash e emite o evento
    Given que os 4 casos estão verdes para a expressão atual
    When "Marina" publicar a versão 1 com o "If-Match" atual
    Then a API deve responder 200 com status "PUBLISHED" e "testRunHash" igual ao "expressionHash"
    And deve gerar registro de auditoria "rule.test_run" com "trigger" "PUBLISH" e "rule.version_publish"
    And deve gerar o evento "RuleVersionPublished" com "versionNumber" 1

  Scenario: [Sucesso] Nova versão herda os casos como regressão
    Given que a versão 1 de "CI_ACIMA_DE_VALOR" está "PUBLISHED" com 4 casos
    When "Marina" criar a versão 2 trocando o limite para 400000 e rodar todos os casos
    Then o rascunho da versão 2 deve ter os mesmos 4 casos e "testRunHash" nulo antes da execução
    And a execução deve devolver "failed" 2 (os casos de 499999,99 e de 500000,00 agora são verdadeiros)
    When "Marina" ajustar o esperado dos dois casos para verdadeiro, rodar de novo e publicar com "changeNotes"
    Then a versão 2 deve ficar "PUBLISHED" e deve gerar o evento "RuleVersionPublished" e a auditoria "rule.version_publish"

  Scenario: [Sucesso] Caso com resultado esperado textual em regra de alçada
    Given que a regra "ALCADA_POR_VALOR" (tipo "APPROVAL_THRESHOLD") devolve a política "ALL" acima de R$ 500.000,00 e "ANY" no restante
    When "Marina" salvar o caso "acima do limite" com 900000 e esperado "ALL" e rodar todos
    Then o caso deve passar com "obtained" igual a "ALL"
    And deve gerar registro de auditoria "rule.update" e "rule.test_run"

  Scenario: [Validação] Caso vermelho bloqueia a publicação com o diff
    Given que o caso "valor exatamente no limite" (500000,00) espera falso mas a expressão usa ">=" e devolve verdadeiro
    When "Marina" tentar publicar a versão
    Then a API deve responder 422 com código "RULE_TESTS_FAILING"
    And "details.cases" deve trazer o caso "valor exatamente no limite" com "expected" falso e "obtained" verdadeiro
    And a versão deve continuar "DRAFT", sem "expressionHash" e sem evento "RuleVersionPublished"
    And deve gerar registro de auditoria "rule.test_run" com "trigger" "PUBLISH" e "result" de falha

  Scenario: [Validação] Casos inválidos e mínimo de casos
    When "Marina" salvar 51 casos
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_MANY"
    When "Marina" salvar um caso com "expected" igual a "ALL" na regra do tipo "ROUTING"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "expected"
    When "Marina" salvar dois casos com o nome "acima do limite"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE"
    When "Marina" salvar um caso com o campo "process.valorEstimado"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "PATH_UNKNOWN"
    Given que a versão "ROUTING" não tem nenhum caso
    When "Marina" tentar publicar
    Then a API deve responder 422 com código "RULE_TESTS_REQUIRED"

  Scenario: [Permissão] Gestor escreve os casos mas não publica; leitor só lê
    When "Rafael" salvar os casos e rodar todos
    Then a API deve responder 200 nas duas chamadas
    When "Rafael" tentar publicar a versão
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Paulo" consultar os casos da versão
    Then a API deve responder 200
    When "Paulo" tentar salvar os casos
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que o tenant exige MFA para administradores e a sessão de "Marina" não tem MFA
    When "Marina" publicar a versão com casos verdes
    Then a API deve responder 403 com código "MFA_REQUIRED" e a versão deve continuar "DRAFT"

  Scenario: [Tenant incorreto] Casos de regra de outro tenant
    Given que a versão "V7" da regra "CI_ACIMA_DE_1M" pertence ao tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", consultar, salvar e rodar os casos da versão "V7"
    Then cada chamada deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Salvar e rodar repetidos
    Given que "Marina" salvou a lista de 4 casos com sucesso
    When "Marina" reenviar exatamente a mesma lista com o "If-Match" atual
    Then a API deve responder 200 sem alterar a lista nem gerar nova auditoria "rule.update"
    When "Marina" rodar todos os casos duas vezes seguidas
    Then as duas respostas devem trazer os mesmos resultados
    And o "testRunHash" deve permanecer o mesmo

  Scenario: [Concorrência] Casos alterados durante a publicação
    Given que "Marina" e "Rafael" carregaram a lista de casos com o mesmo "If-Match"
    When "Rafael" salvar a lista e "Marina" salvar outra com o "If-Match" antigo
    Then a segunda chamada deve responder 412 com código "VERSION_CONFLICT"
    Given que "Marina" carregou a versão na "version" 6 com todos os casos verdes
    And "Rafael" salvou um caso vermelho, gerando a "version" 7
    When "Marina" publicar com o "If-Match" da "version" 6
    Then a API deve responder 412 com código "VERSION_CONFLICT" e a versão deve continuar "DRAFT"
    When "Marina" recarregar e publicar com o "If-Match" da "version" 7
    Then a API deve responder 422 com código "RULE_TESTS_FAILING"
    And não deve existir versão "PUBLISHED" com "testRunHash" diferente do "expressionHash"

  Scenario: [Falha de banco] Banco indisponível na publicação com os casos
    Given que o banco de dados fica indisponível durante a transação de publicação
    When "Marina" publicar a versão com casos verdes
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a versão deve continuar "DRAFT", sem "testRunHash" gravado pela publicação, sem "expressionHash" e sem evento

  Scenario: [Falha de integração] Executor lento num caso e relay do outbox parado
    Given que o executor excede o tempo limite ao avaliar o caso "expressão pesada"
    When "Marina" rodar todos os casos
    Then esse caso deve vir "passed" falso com "error" "EVALUATION_TIMEOUT" e os demais devem ser avaliados normalmente
    Given que o relay do outbox está indisponível
    When "Marina" publicar uma versão com casos verdes
    Then a API deve responder 200
    And o evento "RuleVersionPublished" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Caso ou lista inválidos | 422 | `VALIDATION_ERROR` | "Revise os casos destacados." | Marca o caso e o campo; mantém o editor |
| Versão não é rascunho | 409 | `RULE_VERSION_NOT_DRAFT` | "Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão." | Oferece "Nova versão" |
| Modelo do sistema | 409 | `RULE_SYSTEM_READONLY` | "Modelos do sistema não podem ser alterados. Copie o modelo para adaptá-lo." | Oculta a edição |
| Faltam casos de teste | 422 | `RULE_TESTS_REQUIRED` | "Regras de roteamento e de alçada precisam de ao menos um caso de teste." | Abre a aba de casos com "Novo caso" |
| Caso vermelho na publicação | 422 | `RULE_TESTS_FAILING` | "Há casos de teste que não passam. Corrija a regra ou os casos." | Mostra esperado × obtido por caso; destaca os vermelhos |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta botões |
| MFA exigida | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para publicar." | Abre o passo de MFA e repete a ação |
| Versão inexistente / outro tenant | 404 | `NOT_FOUND` | "Regra não encontrada." | Volta à lista |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "Os dados foram alterados por outra pessoa. Recarregue e tente novamente." | Recarrega os casos |
| Estado da versão inválido para publicar | 409 | `INVALID_STATE` | "A versão não está mais neste estado. Atualize a página." | Recarrega a versão |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém a tela; "Tentar novamente" |

## Dependências
- **Stories:** US-199 (avaliador, contexto hipotético com padrões neutros, formulário por namespace e WF-19 com `default`/`options`); US-194 (versões, `testCases`, `expressionHash`, `PublishGate` e RUL-09). Relacionadas: US-196 (modelos com casos), US-197 e US-198 (consomem a garantia de testes verdes), US-129 (contexto v2).
- **Decisões/ADRs:** DEC-204, DEC-108; ADR-015, ADR-008; POL-27, POL-14.
- **Configurações:** `security.mfaPolicy` (publicação).
- **Lacunas nas fontes canônicas:**
  1. **L-01 — Endpoints:** RUL-14 (`GET`), RUL-15 (`PUT`) e RUL-16 (`POST .../run`) seguem os caminhos indicativos da feature FT-090; contrato final no card 9. Código novo `RULE_TESTS_REQUIRED` e subcódigos `DUPLICATE`, `TOO_MANY`, `EVALUATION_TIMEOUT` não estão no api.md.
  2. **L-02 — Resultado textual em `APPROVAL_THRESHOLD`:** entities.md §7.3 admite `expected` textual ("política/aprovador esperado"), mas não define como a expressão JSON Logic devolve texto nem como o texto se liga ao uso em `decisionPolicyRules`/`WorkflowStageApprover.applicabilityRule` (US-198, que usam booleano). Este card aceita o texto nos casos quando a expressão o devolve e confirma que a execução em workflow usa o booleano; definir com o produto se o texto tem uso próprio.
  3. **L-03 — Limite do nome do caso:** não definido; proposto 1 a 120 caracteres.
  4. **L-04 — Ação de auditoria:** `rule.test_run` existe (events.md §7); aqui se define que registra também a tentativa de publicação recusada (`result` de falha) e o `trigger` (`MANUAL`/`PUBLISH`).
  5. **L-05 — Persistência do resultado dos casos:** apenas o `testRunHash`; o resultado por caso não é guardado. Confirmar que o histórico de execuções não é requisito.
  6. **D-01 (dúvida de produto) — Regras não obrigadas a ter casos:** `VALIDATION`, `SLA` e `NOTIFICATION` podem publicar sem caso (entities.md só obriga `ROUTING` e `APPROVAL_THRESHOLD`); confirmar se o produto quer exigir ao menos um caso também nelas.

## Impacto técnico
- **Gate na transação:** `TestsPublishGate` executa dentro da transação de RUL-09, depois do bloqueio da versão (`FOR UPDATE`): lê `testCases` e a expressão do mesmo instante, avalia todos com o executor e só então publica; evita corrida entre salvar casos e publicar (o `testRunHash` manual é só um selo de UI).
- **Reuso:** o avaliador, a fábrica de contexto hipotético e o validador de caminhos vêm da US-199; os mesmos componentes de formulário alimentam o editor de casos.
- **Armazenamento:** casos em `rule_definition_versions.test_cases` (jsonb, ≤ 50 itens); o tamanho total é limitado pela soma dos contextos parciais (limite do `context` por caso definido no api.md, L-01 da US-199).
- **Performance:** execução de 50 casos é local e curta; cada caso com limite de tempo do executor; "Rodar todos" e o gate seguem a meta de comando do api.md.
- **Compatibilidade (DEC-108):** campos e rotas novos aditivos; regras e versões existentes (modelos, regras sem casos) continuam válidas; o gate é ativado na migração para regras `ROUTING`/`APPROVAL_THRESHOLD` já em rascunho.
- **Observabilidade:** métrica `cf_rule_test_runs_total{result}` e `cf_rule_publish_rejected_total{reason="RULE_TESTS_FAILING"}` (KPI "publicações recusadas por teste falhando").

## Backend
- **Módulo(s):** `rules` (dono), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `ListRuleTestCasesQuery` (RUL-14), `SaveRuleTestCasesCommand` (RUL-15), `RunRuleTestCasesCommand` (RUL-16), extensão de `PublishRuleVersionCommand` (RUL-09) com `TestsPublishGate`.
- **Domínio:** `RuleTestCase` (value object e validador), `RuleTestRunner` (avalia, compara e devolve o diff), `TestsPublishGate` (mínimo por tipo + casos verdes), `ExpressionHasher` (US-194), `HypotheticalContextFactory` (US-199).
- **Integrações internas:** `RuleSimulator`/`RuleEvaluator` (US-199), `RuleContextSchemaProvider` (WF-19), `AuthorizationService`, `AuditService`, `OutboxWriter`.
- **Transação:** RUL-15 substitui a lista sob `FOR UPDATE` da versão com `If-Match`, zera `testRunHash`, audita e confirma; RUL-16 avalia e, em rascunho verde, grava `testRunHash` sob o mesmo bloqueio; RUL-09 executa o gate, publica, aposenta a anterior, audita e grava o outbox atomicamente.

## Frontend
- **Tela(s):** SCR-035 (`/admin/regras/[ruleId]`, aba "Casos de teste"; dialog de publicação na aba "Versões").
- **Componentes:** `RuleTestCaseList` (tabela com status por caso, ações Duplicar/Excluir), `RuleTestCaseEditor` (nome, `HypotheticalContextForm` da US-199 e resultado esperado Verdadeiro/Falso ou texto), `RunAllTestsButton`, `TestResultBadge` ("Passou"/"Falhou"), `TestDiffPanel` (esperado × obtido), `TestsGreenSeal` ("Testes verdes para esta expressão"), `PublishRuleDialog` com a lista dos vermelhos quando a API recusa.
- **Estados:** carregando (skeleton), vazio ("Nenhum caso de teste. Regras de roteamento e de alçada precisam de ao menos um"), erro ("Tentar novamente"), sem permissão (leitura), conflito (recarrega), versão publicada (somente leitura com "Rodar todos" para conferência).
- **Acessibilidade e responsividade:** passou/falhou por texto e ícone, nunca só por cor (contraste 4,5:1 nos dois temas); resultado da execução anunciado por `aria-live`; tabela navegável por teclado; coluna única e editor em tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas:** `rule_definition_versions` (`test_cases`, `test_run_hash`, `expression_hash`); `audit_logs`; `outbox_events`.
- **Migrações:** nenhuma nova (colunas da M2-09); a migração de dados de regras já existentes em rascunho não é necessária.
- **Índices/constraints relevantes:** check de que `jsonb_array_length(test_cases) <= 50` e de que `test_run_hash IS NULL` fora do rascunho verde ou igual ao `expression_hash` ao publicar; trigger de imutabilidade da US-194 cobre `test_cases` e `test_run_hash` de versões `PUBLISHED`/`RETIRED`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `RUL-14` | GET | `/rule-versions/{versionId}/test-cases` | — | `200 { data: { cases: RuleTestCase[], count, currentExpressionHash, testRunHash, lastRunGreen } }` + `ETag` | 200, 403, 404 |
| `RUL-15` | PUT | `/rule-versions/{versionId}/test-cases` | `{ cases: [{ name, context, expected }] }`; `If-Match` | `200 { data: { cases, count, testRunHash: null } }` + `ETag` nova | 200, 403, 404, 409, 412, 422, 428 |
| `RUL-16` | POST | `/rule-versions/{versionId}/test-cases/run` | `{}` | `200 { data: { results: [{ index, name, expected, obtained, passed, error? }], total, passed, failed, allPassed, currentExpressionHash, testRunHash } }` | 200, 403, 404, 503 |
| `RUL-09` | POST | `/rule-versions/{versionId}/publish` | `{ changeNotes? }`; `If-Match` | `200 { data: RuleDefinitionVersion }`; recusas `422 RULE_TESTS_FAILING` (com `details.cases[]`) e `422 RULE_TESTS_REQUIRED` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `WF-19` | GET | `/rule-context/schema` | query `version` | campos para montar o contexto do caso (US-199) | 200, 403 |

## Logs
- `info` `rule.test_cases_saved` — `ruleDefinitionVersionId`, `casesCount`, `durationMs`.
- `info` `rule.tests_run` — `ruleDefinitionVersionId`, `trigger`, `total`, `passed`, `failed`, `durationMs`.
- `warn` `rule.publish_rejected_tests` — `ruleDefinitionVersionId`, `failedCount`, nomes dos casos (sem contexto); `warn` `rule.test_case_timeout`.
- `error` `rule.tests_error` — causa resumida e `correlationId`.
- **Nunca logar:** o `context` dos casos, a expressão, os valores lidos e qualquer valor de orçamento sigiloso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `rule.update` | `CONFIGURATION` | RUL-15 (lista alterada) | `metadata`: `ruleDefinitionId`, `ruleDefinitionVersionId`, `section = TEST_CASES`, `casesCount`; **sem** contextos |
| `rule.test_run` | `CONFIGURATION` | RUL-16 e gate da publicação (inclusive recusada) | `metadata`: `ruleDefinitionVersionId`, `trigger` (`MANUAL`/`PUBLISH`), `total`, `passed`, `failed`, `allPassed`, `expressionHash`; `result` de sucesso ou falha |
| `rule.version_publish` | `CONFIGURATION` | RUL-09 aceita | como US-194, com `testRunHash` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = permissão exigida |

## Testes necessários
- **Unitários:** `RuleTestRunner` (booleano, texto, tipo divergente, erro e tempo excedido contam como vermelho); validador de `RuleTestCase` (nome, duplicidade, limite de 50, caminho, tipo, `expected` por tipo); `TestsPublishGate` (mínimo por tipo, todos verdes, hash igual); tabela de limites do modelo `CI_ACIMA_DE_VALOR` (499.999,99 / 500.000,00 / 500.000,01 / nulo); zerar `testRunHash` em toda mudança.
- **Integração (Testcontainers PostgreSQL):** RUL-15 atômico com `If-Match`; RUL-16 grava o hash só quando tudo passa; RUL-09 recusa e aceita com atomicidade (nada muda na recusa; versão, hash, anterior aposentada, auditoria e outbox na aceitação); herança de casos em RUL-06; imutabilidade dos casos em versão publicada.
- **API/contrato:** RUL-14, RUL-15, RUL-16 e RUL-09 conforme este card; formato do `details.cases[]`; compatibilidade aditiva.
- **RBAC e multi-tenant:** `RULE_VIEW`/`RULE_MANAGE`/`RULE_PUBLISH` e MFA; casos de versão de outro tenant retornam 404 (suíte `test/tenant-leak`); varredura de auditoria e logs sem contextos.
- **Concorrência:** duas gravações com `If-Match`; salvar casos × publicar (o gate vê o conjunto sob bloqueio); duas publicações simultâneas.
- **E2E (Playwright):** escrever os 4 casos de `CI_ACIMA_DE_VALOR` → rodar → publicar; introduzir caso vermelho → publicação recusada com diff; nova versão com regressão; gestor sem botão de publicar.
- **Acessibilidade/performance:** axe sem violações sérias na tabela de casos, no editor e no painel de diff; 50 casos executados dentro da meta de comando do api.md; 360 px.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Gate de publicação comprovado: nenhuma versão `PUBLISHED` com `testRunHash` diferente do `expressionHash` (teste automatizado)
- [ ] Versões `ROUTING` e `APPROVAL_THRESHOLD` não publicam sem caso verde (teste automatizado)
- [ ] Resultado do gate (esperado × obtido) exibido corretamente na tela e na API

## Estimativa
**M** — o avaliador, o contexto hipotético e o formulário vêm da US-199; o esforço está no armazenamento e na validação dos casos, no `testRunHash` ligado ao hash da expressão, no *gate* atômico dentro da publicação (inclusive concorrência), nos três endpoints e na aba de casos com o diff de falha.

## Prioridade
**P1** — é o que torna segura a publicação de regras que mudam o caminho e a decisão do processo (US-197, US-198) e é meta do épico (100% das versões de roteamento e alçada com casos verdes); sem o gate, o simulador seria opcional e o risco de regra errada em produção permaneceria.
