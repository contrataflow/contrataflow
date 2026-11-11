---
id: US-199
title: "Simular regras com processo hipotético"
epic: EP-031
feature: FT-090
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-194]
modules: [rules, process, access, audit]
screens: [SCR-035]
endpoints: [RUL-13, WF-19, PRC-01]
permissions: [RULE_VIEW, RULE_MANAGE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-199 — Simular regras com processo hipotético

## Título
Simular regras com processo hipotético

## Descrição
**Como** administrador do órgão, **quero** simular uma regra da biblioteca (ou o rascunho que estou escrevendo) sobre um processo hipotético que eu monto na tela, ou sobre um processo real que posso ver, e ler a trilha da avaliação, **para** entender o efeito da regra antes de ela alterar processos reais.

A story estende o "testar regra" do MVP 1 (WF-23, que avalia uma regra local contra um processo real) à biblioteca: o simulador da SCR-035 avalia qualquer versão (`DRAFT`, `PUBLISHED` ou `RETIRED`) — inclusive uma expressão ainda não salva do editor — sobre um **contexto hipotético** montado por namespace do `RuleContext` (completado com padrões neutros do schema) ou sobre o contexto de um **processo real visível**. A resposta mostra o resultado, a **trilha da avaliação** (o que valeu em cada nó da expressão), os campos que usaram padrão e os avisos. Nada é gravado em processo, movimento, aprovação ou evento; a execução fica na auditoria sem o conteúdo do contexto.

## Contexto
- A DEC-204 e a ADR-015 (decisão 7) estendem o "testar regra" (WF-23) a **processo real visível ou contexto hipotético** e a casos de teste salvos (US-200), mantendo o **mesmo executor JSON Logic com *allowlist*** da ADR-008: o simulador não é outro motor.
- O risco central do épico é regras complexas demais para administradores (roadmap §4.10). O simulador, junto de modelos (US-196) e testes (US-200), é a mitigação para ver o efeito "antes de publicar".
- WF-23 do MVP 1 (`POST /workflow-versions/{versionId}/rules/test`) continua para regras locais (`WorkflowRule`), sem mudança. O novo endpoint opera sobre `RuleDefinitionVersion` e sobre o `RuleContext` v1 ou v2, conforme a `contextVersion` da versão.
- Valores de orçamento sigiloso entram na avaliação do servidor mas nunca saem para quem não tem a permissão de sigilo (POL-09; POL-27: "o simulador com processo real exige `PROCESS_VIEW` sobre ele e mascara valores sigilosos sem POL-09").
- O schema do contexto (US-194, WF-19 estendido) é a fonte dos campos do formulário hipotético; cada provedor de namespace é da US-129 e das stories de cada módulo. No modo hipotético não há dado de processo: o contexto é digitado.
- O simulador de **alçada na etapa** (política e aprovadores resolvidos) é a WF-83 da US-198; aqui se simula a **regra** isoladamente.

## Objetivo
Permitir que o administrador veja o resultado e a trilha de uma regra em até 1 minuto e sem risco, com 100% das simulações sem efeito colateral em dados de processo e nenhum valor de orçamento sigiloso exposto a quem não tem a permissão.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `RULE_VIEW` e `RULE_MANAGE`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, `RULE_VIEW` e `RULE_MANAGE`); Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), com `RULE_VIEW`, que simulam para entender uma decisão (por exemplo, por que uma etapa foi dispensada).

## Pré-condições
- US-194 entregue (regras, versões, WF-19 com `version=1|2`) e US-129 (contexto v2) quando a versão for `contextVersion = 2`.
- Usuário com `RULE_VIEW` (simular versão salva com contexto hipotético); `PROCESS_VIEW` sobre o processo no modo real; `RULE_MANAGE` para simular uma expressão ainda não salva do rascunho.
- No modo real, processo visível ao usuário (DEC-024) e do mesmo tenant.

## Fluxo principal
1. Em `/admin/regras/[ruleId]`, aba "Simulador", o administrador escolhe a **versão** (por padrão, o rascunho; ou a vigente) e o **modo** "Processo hipotético".
2. O front consulta WF-19 (`?version=<contextVersion>`) e monta o formulário agrupado por namespace (`process`, `documents`, `pca`, `budget`, `legalReview`, `internalControl`, `tender`, `sla`, …): só os namespaces citados pela expressão vêm abertos; os demais ficam recolhidos com "padrão neutro".
3. O administrador preenche os campos que importam (por exemplo, `process.estimatedValue = 900000`) e clica em "Simular".
4. O front envia RUL-13 com `source = HYPOTHETICAL`, o `context` parcial e, se o editor tiver mudanças não salvas, `expression` e `contextVersion` (só rascunho).
5. A API valida o contexto contra o schema, completa os campos ausentes com padrões neutros, avalia a expressão com o executor da *allowlist* e monta a **trilha** nó a nó; audita `rule.simulate` (sem o contexto) e responde 200 com `result`, `trace`, `contextUsed`, `defaultedPaths` e `warnings`.
6. A tela mostra o veredito em linguagem do tipo da regra (por exemplo, para `ROUTING`: "A etapa **se aplica**" ou "A etapa **seria dispensada**"), a trilha em árvore ("process.estimatedValue > 500000 → verdadeiro") e a lista "Campos com valor padrão: …".
7. Alternativamente, o administrador escolhe o modo "Processo real", busca o processo (PRC-01 `?q=`) e simula com os dados reais; valores sigilosos aparecem mascarados para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.
8. O administrador ajusta a regra e repete até estar satisfeito; depois segue para os casos de teste (US-200) e a publicação (US-194).

## Fluxos alternativos
- **FA-01 — Simular sem salvar:** com `expression` e `contextVersion` no corpo (rascunho e `RULE_MANAGE`), a versão salva não muda; a resposta indica `usedOverride = true`.
- **FA-02 — Versão publicada ou aposentada:** simula a expressão imutável como está; `expression` e `contextVersion` no corpo são recusados (`RULE_VERSION_NOT_DRAFT`).
- **FA-03 — Regra com resultado textual (`APPROVAL_THRESHOLD`):** o resultado pode ser um texto (política ou rótulo); a tela mostra "Resolve: ALL" e `resultType = STRING`; a política resolvida numa etapa específica é da WF-83 (US-198).
- **FA-04 — Caminho que não existe no contexto:** o campo digitado fora do schema é recusado no corpo (422); caminho **dentro da expressão** que não existe aparece como `warnings[PATH_UNKNOWN]` e resultado nulo.
- **FA-05 — Erro de avaliação:** `warnings[EVALUATION_FAILED]` com `result = null`; a tela mostra "Não foi possível avaliar: revise a condição" e destaca o nó.
- **FA-06 — Trilha longa:** acima do limite do executor a trilha é truncada com `warnings[TRACE_TRUNCATED]`; o resultado continua correto.
- **FA-07 — Campo de data relativa:** `now` pode ser informado no contexto hipotético para simular regras sensíveis ao tempo (por exemplo, "mais de 10 dias na etapa"); sem ele vale o instante da requisição.
- **FA-08 — Processo sigiloso sem permissão:** resultado calculado com o valor real no servidor; a resposta devolve os valores lidos como `{ value: null, masked: true }` (D-01 em Lacunas).
- **FA-09 — Muitas simulações:** o limite de requisições por usuário responde 429 `RATE_LIMITED`; a tela orienta aguardar e não perde o formulário.

## Regras de negócio
- **RN-RULE-97** — O simulador (RUL-13) aceita dois modos: **processo real** (`source = PROCESS`, com `processId` visível ao usuário por `PROCESS_VIEW`, DEC-024) e **contexto hipotético** (`source = HYPOTHETICAL`, com `context` parcial montado na tela); ambos usam o **mesmo executor JSON Logic com *allowlist*** do runtime (ADR-008), sem `eval` e sem acesso a banco pela expressão.
- **RN-RULE-98** — A versão simulada pode ser qualquer `RuleDefinitionVersion` do tenant (`DRAFT`, `PUBLISHED`, `RETIRED`) lida por `RULE_VIEW`; o contexto é montado na `contextVersion` **da versão** (v1 ou v2) e só os caminhos desse schema são aceitos.
- **RN-RULE-99** — **Contexto hipotético:** o `context` é um `DeepPartial` do `RuleContext` da versão, validado campo a campo (existência do caminho, tipo, nulabilidade); o que faltar é completado com **padrões neutros do schema** (listas vazias, booleanos falsos, contagens zero, textos vazios, valores e datas nulos) e a resposta lista `defaultedPaths[]` para que a tela diga o que é padrão e o administrador não tenha falsa confiança.
- **RN-RULE-100** — **Rascunho em edição:** `expression` e `contextVersion` no corpo substituem, só para a avaliação, o conteúdo salvo e só valem para versão `DRAFT` e com `RULE_MANAGE`; nada é persistido. Expressão enviada passa pelo validador da US-194 (operador fora da *allowlist* é `RULE_INVALID`; caminho desconhecido é aviso).
- **RN-RULE-101** — **Trilha da avaliação:** `trace[]` descreve, por nó avaliado da expressão, `{ nodeId, parentId, path, operator, result, reads[] }` com os valores lidos de cada `var`; reflete o curto-circuito (`and`/`or`): nós não avaliados são marcados `evaluated = false`. A trilha usa o mesmo executor (teste de paridade com o resultado direto) e tem tamanho limitado (L-02).
- **RN-RULE-102** — **Resultado:** `result` é booleano (todos os tipos) ou texto (`APPROVAL_THRESHOLD`); `resultType` informa `BOOLEAN`, `STRING` ou `ERROR`; a tela traduz o resultado conforme o `kind` ("se aplica / seria dispensada", "faixa casa / não casa", "satisfeita / não satisfeita — {mensagem}", "política se aplica", "notificaria").
- **RN-RULE-103** — **Sem efeito colateral:** simular não cria nem altera `Process`, `ProcessStage`, `ProcessMovement`, `Approval`, evento de domínio, notificação ou versão de regra; é leitura com auditoria própria (`rule.simulate`). O mesmo corpo com o mesmo `now` devolve o mesmo resultado (determinismo).
- **RN-RULE-104** — **Sigilo (POL-09/POL-27):** no modo real, os caminhos marcados `confidential` no schema (valores de orçamento sigiloso) saem como `{ value: null, masked: true }` em `contextUsed` e na trilha para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem a custódia; o valor real entra na avaliação do servidor e nunca é gravado em log, auditoria ou evento. No modo hipotético não há mascaramento: o administrador digita os valores.
- **RN-RULE-105** — **Permissões:** `RULE_VIEW` basta para simular versão salva com contexto hipotético; `PROCESS_VIEW` é exigido no modo real; `RULE_MANAGE` é exigido para `expression` não salva. Processo inexistente, de outro tenant ou não visível: 404 `NOT_FOUND`, sem revelar existência.
- **RN-RULE-106** — **Auditoria:** cada simulação grava `rule.simulate` (`CONFIGURATION`) com `ruleDefinitionId`, `ruleDefinitionVersionId`, `source`, `processId` (só no modo real), `usedOverride`, `defaultedPathsCount` e `resultType` — **sem** o contexto, a expressão, os valores e o resultado.
- **RN-RULE-107** — **Contrato do formulário:** WF-19 passa a devolver, por campo, `default` (valor neutro) e, quando o domínio é fechado, `options` (por exemplo, os códigos do catálogo de modalidades para `process.modalityCode`), além de `confidential`; os campos refletem os provedores registrados (US-129) e só os do `contextVersion` pedido.
- **RN-RULE-108** — **Limites de uso:** a simulação tem limite de requisições por usuário (`RATE_LIMITED`), tamanho máximo do `context` e da expressão e tempo máximo de avaliação do executor; estourar o tempo devolve `warnings[EVALUATION_FAILED]` sem derrubar a requisição (valores a definir no api.md, L-02).
- **RN-RULE-109** — **Consistência de leitura:** a resposta devolve `versionStatus` e `versionEtag` da versão avaliada; a avaliação lê a versão e o contexto num único instante, de modo que uma edição concorrente do rascunho não produz resultado misto; a tela avisa "A regra foi alterada depois desta simulação" quando o `ETag` atual difere.
- **RN-RULE-110** — O simulador **não** substitui o simulador de alçada na etapa (WF-83), os casos de teste salvos (US-200) nem o "testar regra" local do MVP 1 (WF-23); modelos e regras de outras permissões (SLA, notificação) usam o mesmo endpoint, e o resultado diz apenas "verdadeiro ou falso" para esses tipos.

Regras do MVP 1 que se aplicam, sem renumerar: **RN-WF-58** e **RN-WF-59** (executor com *allowlist* e teste que não persiste), **RN-FND-11** (sem dependência nova para o construtor), POL-09 (sigilo).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Versão a simular | `versionId` (path) | uuid | Sim | versão do tenant; qualquer estado | rascunho ou vigente |
| Modo | `source` | `HYPOTHETICAL` \| `PROCESS` | Sim | — | `HYPOTHETICAL` |
| Processo | `processId` | uuid | Condicional (`PROCESS`) | visível ao usuário; recusado se `source = HYPOTHETICAL` | busca por código ou título (PRC-01) |
| Contexto hipotético | `context` | `DeepPartial<RuleContext>` | Não (`HYPOTHETICAL`) | só caminhos do `contextVersion` da versão; tipos do schema | `{}` |
| Expressão em edição | `expression` | JSON Logic | Não | só rascunho; `RULE_MANAGE`; *allowlist* | expressão salva |
| Versão do contexto em edição | `contextVersion` | 1 ou 2 | Não | só junto de `expression` | da versão |
| Incluir trilha | `trace` | booleano | Não | — | `true` |
| *(resposta)* Resultado | `result`, `resultType` | booleano/texto | — | `BOOLEAN`, `STRING` ou `ERROR` | calculado |
| *(resposta)* Trilha | `trace[]` | lista | — | nó, operador, resultado, leituras, avaliado ou não | calculado |
| *(resposta)* Valores lidos | `contextUsed` | mapa | — | caminho → `{ value, masked }` | calculado |
| *(resposta)* Campos com padrão | `defaultedPaths` | lista | — | caminhos completados com padrão neutro | calculado |
| *(resposta)* Avisos | `warnings[]` | lista | — | `PATH_UNKNOWN`, `MISSING_PATH`, `EVALUATION_FAILED`, `TRACE_TRUNCATED` | calculado |
| *(resposta)* Versão avaliada | `versionStatus`, `versionEtag`, `contextVersion`, `usedOverride` | vários | — | RN-RULE-109 | calculado |
| *(schema)* Padrão e opções do campo | `default`, `options?`, `confidential` | vários | — | RN-RULE-107 | WF-19 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `source` ausente ou inválido; `processId` com `HYPOTHETICAL`; `processId` ausente com `PROCESS`; `context` com `PROCESS` | Front + API (Zod) | "Escolha simular com um processo real ou com dados informados por você." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`NOT_ALLOWED`) |
| V-02 | Campo do `context` fora do schema da `contextVersion` | Front + API | "O campo {caminho} não existe nesta versão do contexto." | `VALIDATION_ERROR` (`PATH_UNKNOWN`) |
| V-03 | Tipo do valor diferente do tipo do campo (ex.: texto em número) | Front + API | "O campo {rótulo} espera {tipo}." | `VALIDATION_ERROR` (`TYPE_MISMATCH`) |
| V-04 | `expression` ou `contextVersion` em versão que não é `DRAFT` | API | "Só o rascunho pode ser simulado com alterações não salvas." | `RULE_VERSION_NOT_DRAFT` |
| V-05 | `expression` com operador fora da *allowlist* ou grande demais | API | "Esta condição usa um operador não permitido." | `RULE_INVALID` (`RULE_OPERATOR_FORBIDDEN`/`RULE_EXPRESSION_TOO_LARGE`) |
| V-06 | `context` acima do tamanho máximo | API | "Os dados informados são grandes demais." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-07 | Processo inexistente, de outro tenant ou não visível | API | "Selecione um processo válido." | `NOT_FOUND` |
| V-08 | Versão de regra inexistente ou de outro tenant | API | "Regra não encontrada." | `NOT_FOUND` |
| V-09 | `expression` não salva sem `RULE_MANAGE` | API | "Você não tem permissão para simular alterações não salvas." | `PERMISSION_DENIED` (`reasonCode = RULE_MANAGE`) |
| V-10 | Limite de requisições por usuário | API | "Muitas simulações seguidas. Aguarde alguns segundos." | `RATE_LIMITED` |
| V-11 | `now` do contexto fora de data/hora válida | Front + API | "Informe uma data e hora válidas." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `RULE_VIEW` (risco L) para simular; `PROCESS_VIEW` sobre o processo no modo real; `RULE_MANAGE` (risco M) para simular `expression` não salva do rascunho; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` para ver valores sigilosos. Nenhuma é escopável, exceto o escopo próprio de visibilidade do processo (DEC-024).
- **Políticas:** POL-27 (o simulador com processo real exige `PROCESS_VIEW` e mascara valores sigilosos sem POL-09), POL-09 (orçamento sigiloso).
- **MFA:** não exigido (risco `L`/`M`); o desmascaramento de valores sigilosos segue a exceção de POL-14 (leitura sem MFA exigido, valores mascarados e `meta.confidentialStepUpAvailable`).
- **Sem permissão:** a aba "Simulador" fica oculta sem `RULE_VIEW`; o modo "Processo real" fica oculto sem `PROCESS_VIEW`; a API responde 403 `PERMISSION_DENIED` com `access.denied`, e 404 para processo não visível.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum: a simulação é leitura e **não gera evento de domínio** (feature FT-090); apenas a auditoria `rule.simulate`. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: simular é ação interativa do próprio usuário; não notifica ninguém nem entra na timeline do processo. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Simular regras com processo hipotético

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (RULE_VIEW, RULE_MANAGE, RULE_PUBLISH)
    And "Paulo" tem vínculo ativo com o perfil "CONTROLE_INTERNO" (RULE_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET)
    And "Bruno" tem vínculo ativo com o perfil "PLANEJAMENTO" sem "RULE_VIEW"
    And a regra "CI_ACIMA_DE_VALOR" (tipo "ROUTING") tem o rascunho da versão 1 com a condição "valor nulo ou process.estimatedValue > 500000"
    And o processo "0050/2026" de R$ 120.000,00 e o processo sigiloso "0060/2026" de R$ 800.000,00 são visíveis para "Marina" e "Paulo"

  Scenario: [Sucesso] Simular processo hipotético de R$ 900.000,00
    When "Marina" simular o rascunho com "process.estimatedValue" igual a 900000
    Then a API deve responder 200 com "result" verdadeiro e "resultType" "BOOLEAN"
    And a trilha deve mostrar "process.estimatedValue > 500000" como verdadeiro com o valor lido 900000
    And a resposta deve listar os demais campos em "defaultedPaths"
    And deve gerar registro de auditoria "rule.simulate" com "source" "HYPOTHETICAL" e sem o contexto
    And não deve gerar evento de domínio

  Scenario: [Sucesso] Valor abaixo do limite e valor nulo
    When "Marina" simular com "process.estimatedValue" igual a 120000
    Then "result" deve ser falso e a tela deve indicar "A etapa seria dispensada"
    When "Marina" simular sem informar "process.estimatedValue"
    Then "result" deve ser verdadeiro (valor nulo aplica) e "process.estimatedValue" deve constar em "defaultedPaths"

  Scenario: [Sucesso] Simular sobre processo real visível
    When "Marina" simular o rascunho com "source" "PROCESS" e o processo "0050/2026"
    Then "result" deve ser falso e "contextUsed" deve trazer "process.estimatedValue" igual a 120000
    And deve gerar registro de auditoria "rule.simulate" com "processId" do processo "0050/2026"
    And nenhum dado do processo, movimento ou aprovação deve ser alterado

  Scenario: [Sucesso] Simular expressão não salva sem alterar o rascunho
    When "Marina" simular com "expression" do limite 400000 e "process.estimatedValue" igual a 450000, sem salvar
    Then "result" deve ser verdadeiro e "usedOverride" verdadeiro
    And a expressão salva do rascunho deve continuar com o limite 500000

  Scenario: [Sucesso] Valor sigiloso fica mascarado sem a permissão
    When "Paulo" simular com "source" "PROCESS" e o processo sigiloso "0060/2026"
    Then "contextUsed" deve trazer o valor real de "process.estimatedValue"
    Given que "Rafael" tem "PROCESS_VIEW" sobre "0060/2026" e "RULE_VIEW" mas não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Rafael" simular com "source" "PROCESS" e o mesmo processo
    Then "result" deve ser calculado e "contextUsed" deve trazer "process.estimatedValue" com "value" nulo e "masked" verdadeiro
    And a trilha não deve conter o número
    And a auditoria "rule.simulate", os logs e qualquer evento não devem conter o valor

  Scenario: [Validação] Contexto, modo e expressão inválidos
    When "Marina" simular com o campo "process.valorEstimado"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "PATH_UNKNOWN"
    When "Marina" simular com "process.estimatedValue" igual a "novecentos mil"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TYPE_MISMATCH"
    When "Marina" simular com "source" "PROCESS" sem "processId"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED"
    When "Marina" simular uma "expression" com o operador "eval"
    Then a API deve responder 422 com código "RULE_INVALID" e erro "RULE_OPERATOR_FORBIDDEN"
    When "Marina" simular a versão 1 publicada com uma "expression" no corpo
    Then a API deve responder 409 com código "RULE_VERSION_NOT_DRAFT"

  Scenario: [Permissão] Sem permissão sobre a regra, o processo ou a expressão
    When "Bruno" simular uma regra
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Paulo" simular com uma "expression" não salva
    Then a API deve responder 403 com código "PERMISSION_DENIED" e "reasonCode" igual a "RULE_MANAGE"
    Given que o processo "0070/2026" não é visível para "Paulo"
    When "Paulo" simular com "source" "PROCESS" e o processo "0070/2026"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Tenant incorreto] Versão e processo de outro tenant
    Given que existem a regra "CI_ACIMA_DE_1M" e o processo "0099/2026" no tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", simular a versão dessa regra
    Then a API deve responder 404 com código "NOT_FOUND"
    When "Marina" simular a regra de "Prefeitura A" com o processo "0099/2026" de "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Simulação repetida é determinística e sem efeito
    Given que "Marina" simulou com "process.estimatedValue" igual a 900000 e "now" fixo
    When "Marina" enviar exatamente o mesmo corpo de novo
    Then a API deve responder com o mesmo "result" e a mesma trilha
    And não deve ser criado nenhum dado de domínio além de uma nova auditoria "rule.simulate" por execução

  Scenario: [Concorrência] Rascunho alterado durante a simulação
    Given que "Marina" simula o rascunho enquanto "Rafael" salva uma nova expressão no mesmo rascunho
    When a simulação de "Marina" for concluída
    Then a resposta deve trazer o "versionEtag" da versão realmente avaliada
    And a tela deve avisar "A regra foi alterada depois desta simulação" quando o "ETag" atual for diferente
    And o resultado não deve misturar a expressão antiga com a nova

  Scenario: [Falha de banco] Banco indisponível na simulação com processo real
    Given que o banco de dados fica indisponível ao ler o processo "0050/2026"
    When "Marina" simular com "source" "PROCESS" e esse processo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And não deve haver resultado parcial nem auditoria "rule.simulate"

  Scenario: [Falha de integração] Provedor de contexto e cache do schema indisponíveis
    Given que o provedor do namespace "budget" falha ao montar o contexto do processo "0050/2026"
    When "Marina" simular com "source" "PROCESS" uma regra que lê "budget.coverageRatio"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    When "Marina" simular a mesma regra com "source" "HYPOTHETICAL" e "budget.coverageRatio" igual a 0.9
    Then a API deve responder 200 sem depender do provedor
    Given que o Redis está indisponível
    When "Marina" abrir o simulador
    Then o schema deve ser montado sem cache e a simulação deve funcionar normalmente
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (modo, campos, tipos, tamanho) | 422 | `VALIDATION_ERROR` | "Revise os dados informados." | Marca o campo no formulário |
| Expressão enviada inválida | 422 | `RULE_INVALID` | "Esta condição usa um operador não permitido." | Destaca o nó no editor |
| Alterações não salvas em versão não rascunho | 409 | `RULE_VERSION_NOT_DRAFT` | "Só o rascunho pode ser simulado com alterações não salvas." | Desabilita "Simular sem salvar" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta simulação." | Oculta o modo ou a ação |
| Regra, versão ou processo inexistente / outro tenant / não visível | 404 | `NOT_FOUND` | "Registro não encontrado." | Volta à busca de processo |
| Muitas simulações | 429 | `RATE_LIMITED` | "Muitas simulações seguidas. Aguarde alguns segundos." | Mantém o formulário; reabilita o botão após a espera |
| Banco ou provedor de contexto indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível simular agora. Tente novamente em instantes." | Mantém o formulário; "Tentar novamente" |
| Avaliação falhou (resposta 200) | 200 | `warnings[EVALUATION_FAILED]` | "Não foi possível avaliar a condição. Revise a regra." | Mostra o aviso e destaca o nó |

## Dependências
- **Stories:** US-194 (regras, versões e WF-19 estendido); US-129 (contexto v2 e provedores). Habilita US-200 (casos de teste e bloqueio da publicação, que reusam o avaliador e o formulário de contexto). Relacionadas: US-044 (WF-23 do MVP 1, mesmo executor), US-195, US-197 e US-198 (usos que o administrador quer simular), US-196 (modelos com casos).
- **Decisões/ADRs:** DEC-204, DEC-016, DEC-108; ADR-015, ADR-008; POL-27, POL-09, POL-14.
- **Configurações:** nenhuma nova; limites de uso (taxa, tamanho, tempo) seguem o api.md.
- **Lacunas nas fontes canônicas:**
  1. **L-01 — Ação de auditoria:** `rule.simulate` existe (events.md §7: "com processo real também registra `processId`"); definido aqui o que entra em `metadata` (RN-RULE-106). Confirmar com `audit`.
  2. **L-02 — Limites sem valor definido:** tamanho do `context`, tamanho/profundidade da expressão, número de nós da trilha, tempo máximo de avaliação e taxa de simulações por usuário não estão no api.md; usar "limites do executor" e definir no `api.md` do MVP 2.
  3. **L-03 — WF-19 ampliado:** `default`, `options` e `confidential` por campo são propostos aqui (aditivos); o MVP 1 só devolve `{ path, label, type }`.
  4. **L-04 — Endpoint:** RUL-13 (`POST /rule-versions/{versionId}/simulate`) estende a WF-23 conforme a feature; contrato final no card 9.
  5. **D-01 (dúvida de produto) — Resultado e sigilo:** para um processo sigiloso, quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` não vê o valor, mas o resultado booleano da regra revela se o valor passa do limite. O card segue POL-27 (mascarar valores) e aceita o resultado; confirmar se o produto prefere bloquear o modo "Processo real" nesses casos.

## Impacto técnico
- **Executor único:** `RuleEvaluator.evaluate` e `TracingEvaluator.evaluate` compartilham a *allowlist*; um teste de propriedade garante que o resultado da versão com trilha é igual ao do executor de runtime para o mesmo par expressão/contexto. A trilha é montada avaliando sub-expressões com o executor e replicando o curto-circuito, sem interpretador próprio de operadores.
- **Contexto hipotético:** `HypotheticalContextFactory` completa o `DeepPartial` com os `default` do schema; o schema é a única fonte de verdade (US-129), de modo que um provedor novo aparece no simulador sem alterar esta story.
- **Isolamento do runtime:** o simulador não grava nada e roda numa transação somente leitura; avaliação com limite de tempo, tamanho e profundidade para não permitir negação de serviço por expressão custosa; limite de taxa por usuário.
- **Sigilo:** `ConfidentialFieldsInterceptor` do contexto aplica a máscara na resposta; a avaliação é feita com o valor real no servidor; logs e auditoria nunca recebem contexto.
- **Compatibilidade (DEC-108):** WF-23 e WF-19 sem parâmetro seguem iguais; campos novos do schema são aditivos.
- **Observabilidade:** span `rules.simulate` (`cf.rules.contextVersion`, `cf.rules.source`), métrica `cf_rule_simulations_total`.

## Backend
- **Módulo(s):** `rules` (dono do simulador e do avaliador com trilha), `process` (provedor do contexto do processo real e visibilidade), `access`, `audit`.
- **Casos de uso:** `SimulateRuleVersionQuery` (RUL-13), `GetRuleContextSchemaQuery` com `default`/`options`/`confidential` (WF-19).
- **Domínio:** `RuleSimulator`, `TracingEvaluator`, `HypotheticalContextFactory`, `SimulationContextValidator`, `ConfidentialMasker`, `SimulationResult` (value object).
- **Integrações internas:** `RuleContextBuilder` (v1 e v2, por processo) com provedores de cada módulo, `ProcessVisibilityService` (DEC-024), `AuthorizationService`, `AuditService`.
- **Transação:** leitura em uma única transação somente leitura (`REPEATABLE READ`) da versão e do contexto; a auditoria `rule.simulate` é gravada depois da avaliação, fora do caminho de dados de processo.

## Frontend
- **Tela(s):** SCR-035 (`/admin/regras/[ruleId]`, aba "Simulador").
- **Componentes:** `RuleSimulatorPanel`, `SimulationModeSwitch` (hipotético / processo real), `HypotheticalContextForm` (acordeão por namespace, campos tipados, `options` como lista, badge "padrão"), `ProcessPicker` (PRC-01), `EvaluationTrace` (árvore com ícone e texto de verdadeiro/falso/não avaliado), `SimulationVerdict` (texto por tipo de regra), `DefaultedPathsNote`, `StaleSimulationBanner`.
- **Estados:** carregando (skeleton do schema e do resultado), vazio ("Preencha os dados e clique em Simular"), erro ("Tentar novamente"), sem permissão (modo ou aba oculta), valor sigiloso (ícone de cadeado e "Valor sigiloso" no lugar do número), resultado desatualizado.
- **Acessibilidade e responsividade:** resultado e cada nó da trilha anunciados por `aria-live`; verdadeiro/falso por texto e ícone, nunca só por cor (contraste 4,5:1 nos dois temas); formulário e trilha navegáveis por teclado; layout em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** leitura de `rule_definition_versions` e de `processes` e tabelas associadas ao contexto; `audit_logs` (escrita de `rule.simulate`). Nenhuma tabela nova.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** nenhum novo; a leitura usa índices existentes de versão (`(tenant_id, rule_definition_id, version_number)`) e de processo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `RUL-13` | POST | `/rule-versions/{versionId}/simulate` | `{ source: 'HYPOTHETICAL' \| 'PROCESS', processId?, context?, expression?, contextVersion?, trace? }` | `200 { data: { result, resultType, trace[], contextUsed, defaultedPaths[], warnings[], contextSource, contextVersion, versionStatus, versionEtag, usedOverride } }` | 200, 403, 404, 409, 422, 429, 503 |
| `WF-19` | GET | `/rule-context/schema` | query `version` (1 ou 2) | campos com `path`, `label`, `type`, `default`, `options?`, `confidential` (aditivo) | 200, 403 |
| `PRC-01` | GET | `/processes` | `q` (≥ 2 caracteres) para a busca de processo | processos visíveis ao usuário | 200, 403 |

## Logs
- `info` `rule.simulated` — `ruleDefinitionVersionId`, `source`, `contextVersion`, `usedOverride`, `defaultedPathsCount`, `resultType`, `durationMs`.
- `warn` `rule.simulation_failed` (códigos de aviso, sem valores), `rule.simulation_rate_limited`, `rule_context.cache_unavailable`.
- `error` `rule.simulation_error` — causa resumida e `correlationId`.
- **Nunca logar:** o `context`, a expressão, os valores lidos, o resultado e qualquer valor de orçamento sigiloso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `rule.simulate` | `CONFIGURATION` | Cada execução de RUL-13 com avaliação concluída | `metadata`: `ruleDefinitionId`, `ruleDefinitionVersionId`, `source`, `processId?` (modo real), `usedOverride`, `defaultedPathsCount`, `resultType`; **sem** contexto, expressão, valores e resultado |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = permissão exigida |

## Testes necessários
- **Unitários:** `HypotheticalContextFactory` (padrões neutros por tipo); `SimulationContextValidator` (caminho, tipo, nulabilidade); `TracingEvaluator` (curto-circuito de `and`/`or`, nós não avaliados, truncamento); **teste de propriedade de paridade** entre trilha e executor; `ConfidentialMasker`; determinismo com `now` fixo.
- **Integração (Testcontainers PostgreSQL + Redis):** simulação com contexto v1 e v2 de processo real; sem escrita em tabelas de processo (asserção por contagem de linhas antes e depois); auditoria sem contexto; rascunho concorrente (versão lida num instante); *fallback* sem Redis; provedor indisponível → 503 e hipotético ainda funciona.
- **API/contrato:** RUL-13 e WF-19 conforme este card; regressão de WF-19 sem `version` e de WF-23.
- **RBAC e multi-tenant:** `RULE_VIEW`, `RULE_MANAGE` (expressão não salva), `PROCESS_VIEW`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; versão e processo de outro tenant retornam 404 (suíte `test/tenant-leak`); varredura que prova que valor sigiloso não aparece em resposta, log nem auditoria sem a permissão.
- **Concorrência:** simulação × salvar rascunho; simulação × publicar; várias simulações simultâneas do mesmo usuário (taxa).
- **E2E (Playwright):** simular hipotético 900.000 e 120.000, ver a trilha e o veredito; "Simular sem salvar"; modo processo real; usuário sem permissão de sigilo vê o cadeado.
- **Acessibilidade/performance:** axe sem violações sérias no formulário, na trilha e no veredito; simulação típica dentro da meta de leitura/comando do api.md; 360 px.

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
- [ ] Teste de propriedade: trilha e executor de runtime sempre concordam
- [ ] Simulação comprovadamente sem escrita em dados de processo
- [ ] Valor sigiloso ausente de resposta (sem permissão), log e auditoria

## Estimativa
**M** — reaproveita o executor e o schema (US-194, US-129); o esforço está no avaliador com trilha e curto-circuito, na fábrica de contexto hipotético com padrões neutros, no mascaramento por POL-09, no endpoint com limites de uso e na aba de simulação com formulário por namespace.

## Prioridade
**P1** — é a principal mitigação do risco "regras complexas demais para administradores" e pré-requisito dos casos de teste (US-200) e do bloqueio da publicação; sem ele o administrador só descobriria o efeito de uma regra de roteamento ou de alçada em processos reais.
