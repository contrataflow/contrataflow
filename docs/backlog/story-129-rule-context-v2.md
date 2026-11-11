---
id: US-129
title: "`RuleContext` v2: contrato versionado e provedores por módulo"
epic: EP-021
feature: FT-065
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-041, US-044]
modules: [workflow, process, access, audit, platform]
screens: [SCR-034]
endpoints: [WF-19, WF-16, WF-17, WF-20, WF-23, WF-60]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-129 — `RuleContext` v2: contrato versionado e provedores por módulo

## Título
Fixar o contrato do `RuleContext` v2 e o mecanismo de provedores por módulo

## Descrição
**Como** administrador do órgão e **como** desenvolvedor de módulo, **quero** que as regras do workflow possam ler os dados dos módulos novos (`pca.*`, `budget.*`, `legalReview.*`, `internalControl.*`, `tender.*`, `sla.*`) por um contexto versionado, montado só com o que a regra usa e fornecido por cada módulo dono do dado, **para** que as regras de saída das etapas novas (dotação, edital, jurídico, controle interno), o SLA e as regras de notificação sejam escritas sem quebrar nenhuma regra criada no MVP 1.

A story entrega o **contrato** (`ruleContextV2Schema`, superset do v1), o **mecanismo** (montador por `contextVersion`, montagem preguiçosa por namespace, registro de `RuleContextContributor` e falha fechada quando um provedor não responde) e as **superfícies** que o administrador usa: o schema versionado (WF-19), a gravação de `contextVersion` por regra (WF-16/WF-17), a validação de publicação (WF-20), o teste de regra com o contexto escolhido (WF-23) e a prévia técnica do contexto de um processo (WF-60). O conteúdo de cada namespace é publicado pela story do módulo dono (US-148, US-155, US-161, US-168, US-189 e as do PCA); aqui entram o provedor de `stages.active` e a adaptação dos provedores v1 existentes.

## Contexto
- O MVP 1 fixou o `RuleContext` v1 (DEC-016, entities MVP 1 §5.4) com `process.*`, `documents.<TYPE>.*`, `priceResearch.*`, `risks.*` e `stage.*`, montado pela `WorkflowFacade` com os `RuleContextContributor` de cada módulo (US-041, US-044). Novos dados exigem contexto novo, mas as regras já publicadas não podem mudar de significado (RN-WF-17 do MVP 1: só caminhos do schema valem).
- DEC-204 evolui a DEC-016: o v2 é um superset do v1; "regras v1 continuam avaliadas com o contexto v1 (cada regra grava a sua `contextVersion`); nada quebra". O ADR-015 fixa a montagem preguiçosa por namespace e o cache por requisição e diz que regras v1 "não migram à força — passam a v2 por edição do administrador".
- A ordem de entrega (features.md, notas de priorização) põe a US-129 cedo: as regras de saída de US-148, US-155, US-161 e US-168, o SLA (US-189), as regras de notificação (US-193) e a biblioteca (US-194) leem os novos namespaces. Cada story de módulo publica o provedor do seu namespace; a US-129 fixa contrato e mecanismo.
- O sigilo do orçamento (DEC-030, POL-09) vale também aqui: valores sigilosos entram no contexto porque a avaliação é do servidor, mas nunca saem em mensagens, eventos, auditoria, logs ou simulador para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (RN-WF2-18 da feature FT-065).
- O executor continua o do ADR-008 (JSON Logic com *allowlist*): o v2 acrescenta dados, não operadores.

## Objetivo
Garantir que 100% das regras do MVP 1 (todas com `contextVersion = 1`) tenham o mesmo resultado antes e depois do contexto v2 (teste de regressão com a suíte de regras do MVP 1 verde), que qualquer regra possa referenciar os seis namespaces novos com validação na publicação, e que a montagem do contexto toque apenas os módulos cujos namespaces a expressão referencia.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `WORKFLOW_VIEW` e `WORKFLOW_MANAGE`) que escreve e testa regras.
- **Secundárias:** Desenvolvedor de módulo (usuário técnico que publica o provedor do seu namespace); Gestor de contratações e Controle Interno (`WORKFLOW_VIEW`, leitura das regras e da `contextVersion`); Auditor (`AUDITOR`, lê a trilha `workflow.update`).

## Pré-condições
- Workflow com versão em `DRAFT` (US-043) para criar ou editar regras (RN-WF-54).
- Usuário com `WORKFLOW_MANAGE` para gravar e testar regras; `WORKFLOW_VIEW` para consultar o schema.
- Para "Testar regra" e para a prévia do contexto: processo visível ao usuário (`PROCESS_VIEW`, DEC-024).
- Provedores dos namespaces registrados no deploy; namespace sem provedor aparece como indisponível (FA-02).

## Fluxo principal
1. No editor do workflow (SCR-034), o administrador abre "Regras da versão" de uma etapa ou transição de uma versão em `DRAFT`.
2. O front consulta `GET /rule-context/schema?version=2` (WF-19) e monta o construtor de condições com os campos agrupados por namespace (`process`, `documents`, `priceResearch`, `risks`, `stage`, `stages`, `pca`, `budget`, `legalReview`, `internalControl`, `tender`, `sla`); namespaces sem provedor aparecem desabilitados com a nota "Indisponível neste ambiente".
3. Ao criar uma regra `CONDITION` (ou `REQUIRED_FIELD`), o seletor "Contexto da regra" vem em **v2** por padrão; o administrador pode manter v1 (só caminhos do v1).
4. O front envia `POST /workflow-versions/{versionId}/rules` (WF-16) com `contextVersion`; a API valida os caminhos da expressão contra o schema da `contextVersion` informada (RN-WF2-87) e persiste.
5. O administrador aciona "Testar regra" (WF-23) escolhendo um processo; a API monta o contexto **da versão da regra**, só com os namespaces que a expressão referencia, avalia a regra e devolve satisfeita ou não, os valores lidos (`contextUsed`, com valores sigilosos mascarados) e os avisos de namespace indisponível.
6. Em caso de dúvida sobre os dados, o administrador abre "Ver contexto do processo" (WF-60) e consulta o contexto montado para o processo, por namespace.
7. Ao validar e publicar a versão (WF-20/WF-21, US-045), cada regra é conferida contra o schema da sua `contextVersion` e o `definitionSnapshot` guarda a `contextVersion` das regras que usam o v2 (RN-WF2-89).
8. Na tramitação (US-041/US-047), `evaluateRules` monta o contexto de cada regra pela `contextVersion` gravada; falha de um provedor torna a regra não satisfeita (RN-WF2-84).

## Fluxos alternativos
- **FA-01 — Atualizar uma regra do MVP 1 para v2:** a regra aberta mostra "Contexto v1"; "Atualizar para v2" troca a `contextVersion` para 2 (PATCH com `If-Match`), exige a revalidação dos caminhos e fica registrado em auditoria. Editar a regra sem acionar o botão mantém a `contextVersion` (RN-WF2-87).
- **FA-02 — Provedor ausente ou fora do ar:** o namespace vem `UNAVAILABLE` no WF-19/WF-60; no WF-23 a regra é não satisfeita com o aviso `NAMESPACE_UNAVAILABLE`; no runtime a regra `BLOCKING` bloqueia com a mensagem de indisponibilidade e a `WARNING` aparece como não verificada.
- **FA-03 — Expressão que só usa caminhos do v1:** mesmo com `contextVersion = 2`, nenhum provedor novo é consultado (RN-WF2-82).
- **FA-04 — Caminho do v2 numa regra `contextVersion = 1`:** salvar é aceito no rascunho (como RN-WF-56) e a validação de publicação devolve `WF_RULE_PATH_UNKNOWN` com o namespace afetado.
- **FA-05 — Processo com orçamento sigiloso e usuário sem POL-09:** a prévia, o teste e as mensagens mostram `"[sigiloso]"` nos valores monetários; a avaliação usa o valor real no servidor (RN-WF2-85).
- **FA-06 — Etapas paralelas:** `stages.active[]` lista todas as etapas `ACTIVE` do processo (com `branchKey`); `stage.*` continua descrevendo a etapa avaliada pela regra (RN-WF2-80).

## Regras de negócio
- **RN-WF2-80** — O `RuleContext` v2 (`ruleContextV2Schema`) é um **superset** do v1: todos os caminhos do v1 mantêm tipo e significado (`stage.*` continua descrevendo a etapa de saída avaliada ou a etapa de origem da transição) e o v2 acrescenta `version: 2`, `stages.active[]` (`key`, `type`, `branchKey`, `enteredAt`, `businessDaysInStage`) e os namespaces `pca`, `budget`, `legalReview`, `internalControl`, `tender` e `sla` com os campos de entities MVP 2 §7.2. Remover ou mudar o significado de um caminho exige nova versão de contexto (v3). Reforça RN-WF2-17 da FT-065.
- **RN-WF2-81** — Toda `WorkflowRule` grava `contextVersion` (1 ou 2). A avaliação usa **exatamente** o montador da versão gravada: regra do MVP 1 (`contextVersion = 1`) é avaliada com o contexto v1, sem os namespaces novos, e tem resultado idêntico ao anterior à v2 (suíte de regressão com as regras semeadas e as regras de teste do MVP 1). O mesmo vale para `RuleRef` `INLINE` (`contextVersion` no próprio `RuleRef`).
- **RN-WF2-82** — A montagem é **preguiçosa por namespace**: o montador extrai os caminhos `var` da expressão (ou o `config.field`), mapeia cada um ao seu namespace e chama só os provedores necessários; o resultado de cada namespace é cacheado na requisição (chave `processId + contextVersion + namespace`) e reaproveitado entre regras da mesma avaliação (ADR-015).
- **RN-WF2-83** — Cada namespace tem **um único** `RuleContextContributor` dono (`process`: `process`, `stage`, `stages`, `pca` via fachada do `pca`; `document`/`price-research`/`risk`: namespaces do v1; `budget`: `budget`; `legal-review`: `legalReview`; `internal-control`: `internalControl`; `tender`: `tender`; `sla`: `sla`). Dois provedores para o mesmo namespace derrubam a inicialização do módulo (`RULE_CONTEXT_NAMESPACE_DUPLICATED`). O contrato do provedor declara as versões de contexto que atende; o provedor devolve só o seu fragmento, de forma somente leitura, sem expor tabelas de outro módulo.
- **RN-WF2-84** — **Falha fechada:** namespace sem provedor, provedor que lança erro ou excede o tempo (2 s por namespace) torna **não satisfeita** a regra que o usa, com `error = RULE_CONTEXT_UNAVAILABLE` e log `error`; a regra `BLOCKING` bloqueia e a `WARNING` aparece como "não verificada". Nunca se avalia com valores padrão silenciosos em produção.
- **RN-WF2-85** — Sigilo: o contexto é montado e avaliado só no servidor e nunca é serializado inteiro para o cliente fora de WF-60. Valores monetários de processo com `isBudgetConfidential = true` (`process.estimatedValue`, `pca.plannedValue`, `budget.confirmedTotal`) entram na avaliação e saem mascarados (`"[sigiloso]"`) em `contextUsed`, na prévia, em mensagens de regra, eventos, auditoria e logs para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo (POL-09); desmascarar só em leitura segue a exceção da POL-14 (sem exigir MFA, com `meta.confidentialStepUpAvailable`).
- **RN-WF2-86** — `GET /rule-context/schema` aceita `version` (`1` ou `2`, padrão `1` — mudança aditiva, DEC-108): `version=1` devolve exatamente a resposta do MVP 1; `version=2` devolve também `namespaces[]` (`key`, `label`, `available`) e `namespace` em cada campo. Os campos `documents.<CÓDIGO>.*` continuam gerados por tipo de documento ativo do tenant.
- **RN-WF2-87** — Criar regra (WF-16) sem `contextVersion` grava 2; editar (WF-17) sem `contextVersion` preserva a gravada; só valores 1 e 2 são aceitos. A validação de caminhos usa o schema da `contextVersion` da regra: caminho de v2 em regra v1 → `WF_RULE_PATH_UNKNOWN`; valor fora de 1/2 → `VALIDATION_ERROR` (`INVALID_ENUM`) na escrita e `WF_RULE_CONTEXT_VERSION_INVALID` na validação. Regras do MVP 1 **não migram à força**: passam a v2 por edição explícita do administrador (ADR-015).
- **RN-WF2-88** — Executor inalterado: a mesma *allowlist* de operadores do ADR-008, mesmos limites (profundidade ≤ 20, tamanho ≤ 10 KB), sem acesso a banco e sem efeito colateral. WF-23 e a avaliação em runtime usam o mesmo `RuleEvaluator`; o teste nunca diverge da execução. O relógio (`now`) é um só por avaliação.
- **RN-WF2-89** — Canonicalização: o `definitionSnapshot` inclui `contextVersion` **somente quando for 2** (e o mesmo vale para `RuleRef`), de modo que o `definitionHash` das versões publicadas no MVP 1 e o da semente v1 (US-130) continuem comparáveis. Publicar com regra de contexto v2 grava essa informação no snapshot imutável (RN-WF-64/65).
- **RN-WF2-90** — Consistência e leitura: o contexto de uma avaliação é montado em **um único retrato de leitura** (transação somente leitura do banco), de modo que dois namespaces da mesma avaliação nunca reflitam estados diferentes do processo; a montagem nunca escreve, nunca dispara evento e nunca persiste o contexto (só `contextVersion` e, nos testes de regra, o resumo do resultado).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Contexto da regra | `WorkflowRule.contextVersion` | seleção (1 \| 2) | Não (UI) | RN-WF2-87 | 2 em regra nova; preservado na edição |
| Versão do schema | `version` (query de WF-19) | inteiro (1 \| 2) | Não | RN-WF2-86 | 1 |
| Namespaces disponíveis | `namespaces[]` (`key`, `label`, `available`) | lista | — (resposta) | só em `version=2` | provedores registrados |
| Campo do contexto | `fields[].path`, `label`, `type`, `namespace` | texto | — (resposta) | `type` ∈ `string`, `number`, `boolean`, `date`, `list` | schema da versão |
| Processo de referência | `processId` | uuid (busca) | Sim (WF-23, WF-60) | visível ao usuário | — |
| Contexto do teste | `contextVersion` (corpo de WF-23) | inteiro (1 \| 2) | Não | padrão: o da regra enviada (ou 2 se a regra for nova) | RN-WF2-87 |
| Namespaces da prévia | `namespaces` (corpo de WF-60) | lista de chaves | Não | subconjunto de `process`, `stage`, `stages`, `pca`, `budget`, `legalReview`, `internalControl`, `tender`, `sla`, `documents`, `priceResearch`, `risks`; vazio = todos | todos |
| *(resposta)* Situação do namespace | `namespaces.<ns>.status` | `LOADED` \| `UNAVAILABLE` \| `SKIPPED` | — | `SKIPPED` = fora do pedido | montador |
| *(resposta)* Caminhos mascarados | `maskedPaths[]` | lista | — | POL-09 | montador |
| *(sistema)* Duração da montagem | `buildMs` | inteiro | — | por namespace e total | montador |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `contextVersion` ou `version` fora de 1/2 | Front + API (Zod) | "Selecione o contexto v1 ou v2." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | Caminho de variável da expressão inexistente no schema da `contextVersion` da regra (na publicação) | API | "A regra {nome} usa o campo {caminho}, que não existe no contexto v{N}." | `WORKFLOW_INVALID` (`WF_RULE_PATH_UNKNOWN`) |
| V-03 | `contextVersion` inválida numa regra já gravada ao validar a versão | API | "A regra {nome} usa um contexto não suportado." | `WORKFLOW_INVALID` (`WF_RULE_CONTEXT_VERSION_INVALID`) |
| V-04 | Operador fora da *allowlist* | API | "Esta condição usa um operador não permitido." | `WORKFLOW_INVALID` (`WF_RULE_OPERATOR_FORBIDDEN`) |
| V-05 | Escrita de regra em versão que não é `DRAFT` | API | "Esta versão não pode mais ser editada." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-06 | `If-Match` ausente ou divergente em WF-17 | API | "Os dados foram alterados. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-07 | `processId` ausente, inexistente, de outro tenant ou não visível (WF-23, WF-60) | API | "Selecione um processo válido." | `NOT_FOUND` |
| V-08 | `namespaces` com chave desconhecida (WF-60) | Front + API | "Namespace desconhecido: {chave}." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-09 | Dois provedores registrados para o mesmo namespace | Inicialização | (erro técnico no boot) | `RULE_CONTEXT_NAMESPACE_DUPLICATED` |
| V-10 | Provedor indisponível ou lento demais na avaliação | Runtime | "Não foi possível avaliar a regra {nome} agora. Tente novamente; se persistir, fale com o administrador." | `RULE_CONTEXT_UNAVAILABLE` |

## Permissões
- **Permissão:** `WORKFLOW_VIEW` para WF-19 e WF-20; `WORKFLOW_MANAGE` para WF-16/WF-17; WF-23 e WF-60 exigem `WORKFLOW_MANAGE` **e** `PROCESS_VIEW` do processo informado. `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo é o que desmascara valores (POL-09).
- **Políticas:** POL-09 (mascaramento em prévia, teste, mensagens, eventos, auditoria e logs); visibilidade de processo (DEC-024); POL-14 (MFA).
- **MFA:** `WORKFLOW_MANAGE` é risco `H`: exigido conforme `security.mfaPolicy` (`ADMINS` ou `ALL`). Desmascarar valores só em leitura não exige MFA (exceção da POL-14, com `meta.confidentialStepUpAvailable`).
- **Sem permissão:** painel de regras somente leitura sem `WORKFLOW_MANAGE`; "Testar regra" e "Ver contexto do processo" ocultos; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (`reasonCode = WORKFLOW_MANAGE`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio: gravar regra em rascunho não publica evento (como US-044) e a montagem do contexto é somente leitura. A publicação da versão continua gerando `WorkflowVersionPublished` (US-045). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: edição de rascunho e leitura de contexto não notificam ninguém. |

## Critérios de aceite em Gherkin
```gherkin
Feature: RuleContext v2 — contrato versionado e provedores por módulo

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And existe o workflow "Fase preparatória — Lei 14.133/2021" com uma versão em "DRAFT" e a etapa "JURIDICO"
    And "Carla" tem vínculo ativo com o perfil "ADMIN_ORGAO" (WORKFLOW_VIEW, WORKFLOW_MANAGE, PROCESS_VIEW)
    And existe o processo "0012/2026" com valor estimado de R$ 480.000,00 e 3 dotações confirmadas

  Scenario: [Sucesso] Regra do MVP 1 tem o mesmo resultado depois da publicação do contexto v2
    Given que a regra "ETP completo" foi criada no MVP 1 com "contextVersion" 1 e expressão sobre "documents.ETP.isComplete"
    When o motor avaliar a regra para o processo "0012/2026"
    Then o contexto montado deve ser o v1, sem os namespaces "budget", "legalReview", "internalControl", "tender", "pca" e "sla"
    And o resultado deve ser idêntico ao registrado antes da v2

  Scenario: [Sucesso] Regra v2 lê o namespace "budget" e só o provedor de dotação é consultado
    When "Carla" criar uma regra "CONDITION" com "contextVersion" 2 e expressão "budget.confirmedCount >= 1"
    Then a API deve responder 201 com "contextVersion" igual a 2
    And deve gerar registro de auditoria "workflow.update" com "metadata.contextVersion" igual a 2
    When "Carla" testar a regra contra o processo "0012/2026"
    Then a resposta deve ter "satisfied" verdadeiro e "contextUsed" com "budget.confirmedCount" igual a 3
    And apenas o provedor do namespace "budget" deve ter sido chamado

  Scenario: [Sucesso] Schema v2 traz os namespaces novos e o v1 permanece igual
    When "Carla" consultar o schema com "version" igual a 2
    Then a resposta deve listar os namespaces "pca", "budget", "legalReview", "internalControl", "tender" e "sla" e o campo "stages.active"
    When "Carla" consultar o schema sem informar "version"
    Then a resposta deve ser idêntica à do MVP 1, com "version" igual a 1

  Scenario: [Sucesso] Prévia do contexto com valor sigiloso mascarado
    Given que o processo "0031/2026" tem orçamento sigiloso e "Carla" não possui "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Carla" pedir a prévia do contexto do processo "0031/2026"
    Then a resposta deve trazer "estimatedValue" e "budget.confirmedTotal" como "[sigiloso]"
    And "maskedPaths" deve listar os dois caminhos
    And a avaliação de uma regra "budget.confirmedTotal >= process.estimatedValue" deve usar os valores reais no servidor

  Scenario: [Validação] Caminho do v2 numa regra com contexto v1
    Given que "Carla" salvou no rascunho uma regra com "contextVersion" 1 e expressão "legalReview.concluded"
    When "Carla" validar a versão
    Then a API deve responder 200 com "valid" falso
    And "errors" deve conter "WF_RULE_PATH_UNKNOWN" para a regra e o caminho "legalReview.concluded"
    When "Carla" tentar criar uma regra com "contextVersion" 3
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_ENUM" no campo "contextVersion"

  Scenario: [Permissão] Usuário somente leitura tenta testar regra e ver o contexto
    Given que "Bruno" possui apenas "WORKFLOW_VIEW"
    When "Bruno" enviar POST para testar uma regra ou pedir a prévia do contexto
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Bruno" consultar o schema com "version" igual a 2
    Then a API deve responder 200

  Scenario: [Tenant incorreto] Prévia do contexto de processo de outro tenant
    Given que existe o processo "0007/2026" no tenant "Prefeitura B"
    When "Carla" pedir a prévia do contexto desse processo
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Teste repetido e provedor duplicado
    Given que "Carla" já testou a mesma regra duas vezes contra o processo "0012/2026"
    When "Carla" testar a regra uma terceira vez
    Then a API deve responder 200 com o mesmo resultado
    And nenhuma "WorkflowRule", auditoria de domínio ou evento adicional deve ser criado
    Given que dois módulos registram um provedor para o namespace "tender"
    When a aplicação iniciar
    Then a inicialização deve falhar com "RULE_CONTEXT_NAMESPACE_DUPLICATED"

  Scenario: [Concorrência] Edição simultânea da mesma regra e mudança do processo durante a montagem
    Given que "Carla" e "Diego" abriram a mesma regra com ETag "4"
    When "Diego" salvar primeiro e "Carla" enviar PATCH com "If-Match" "4"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    Given que uma dotação é confirmada por outro usuário enquanto o contexto do processo "0012/2026" é montado
    When o contexto for montado
    Then "budget.allocationsCount" e "budget.confirmedCount" devem refletir o mesmo retrato de leitura

  Scenario: [Falha de banco] Banco indisponível na montagem do contexto
    Given que o banco de dados fica indisponível durante o teste de regra
    When "Carla" testar a regra contra o processo "0012/2026"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum registro deve ser criado

  Scenario: [Falha de integração] Provedor do namespace "tender" não responde
    Given que o provedor do namespace "tender" excede o tempo de 2 segundos
    And a regra "Edital completo" (BLOCKING) usa "tender.isComplete"
    When o processo "0012/2026" for encaminhado para fora da etapa "MINUTA_EDITAL"
    Then a regra deve ser tratada como não satisfeita com erro "RULE_CONTEXT_UNAVAILABLE"
    And a API deve responder 422 com código "TRANSITION_BLOCKED" e a mensagem "Não foi possível avaliar a regra Edital completo agora"
    And a prévia do contexto deve mostrar "tender" como "UNAVAILABLE" e os demais namespaces como "LOADED"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo ou query inválidos (`contextVersion`, `version`, `namespaces`) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca o campo |
| Caminho desconhecido no contexto da regra (publicação) | 422 | `WORKFLOW_INVALID` (`WF_RULE_PATH_UNKNOWN`) | "A regra {nome} usa o campo {caminho}, que não existe no contexto v{N}." | `ValidationResultPanel` com link para a regra |
| `contextVersion` inválida na validação | 422 | `WORKFLOW_INVALID` (`WF_RULE_CONTEXT_VERSION_INVALID`) | "A regra {nome} usa um contexto não suportado." | Idem |
| Operador fora da *allowlist* | 422 | `WORKFLOW_INVALID` (`WF_RULE_OPERATOR_FORBIDDEN`) | "Esta condição usa um operador não permitido." | Destaca o bloco da condição |
| Versão não é rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão não pode mais ser editada." | Oferece "Criar novo rascunho" |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "Os dados foram alterados. Recarregue e tente novamente." | Recarrega a regra |
| Processo inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Selecione um processo válido." | Limpa a seleção |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar regras." | Oculta as ações de edição e teste |
| Provedor do namespace indisponível (runtime) | 422 (via `TRANSITION_BLOCKED`) ou aviso | `RULE_CONTEXT_UNAVAILABLE` | "Não foi possível avaliar a regra {nome} agora. Tente novamente; se persistir, fale com o administrador." | Mostra a regra como "não verificada"; ação principal fica desabilitada se `BLOCKING` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível montar o contexto agora. Tente novamente em instantes." | Botão "Tentar novamente" |
| Provedor duplicado | — (boot) | `RULE_CONTEXT_NAMESPACE_DUPLICATED` | (log técnico) | Aplicação não inicia o módulo |

## Dependências
- **Stories:** US-041 (motor `evaluateRules`, `RuleContextV1` e `RuleContextBuilder` estendidos aqui) e US-044 (regras, WF-16/17/19/23). Habilita US-148, US-155, US-161 e US-168 (regras de saída), US-189 (SLA), US-193 (regras de notificação), US-194 a US-199 (biblioteca e simulador), US-130 (v2 semeada) e as stories do PCA (`pca.*`).
- **Decisões/ADRs:** DEC-016, DEC-204, DEC-030, DEC-108, DEC-024; ADR-008, ADR-015.
- **Configurações:** nenhuma nova.
- **Lacunas nas fontes canônicas:**
  1. `entities.md §7.2` define o tipo de `stages.active[]` mas não diz se `stage.*` do v1 passa a "etapa avaliada" no paralelismo; assumido (RN-WF2-80). Confirmar na implementação de US-124.
  2. A *allowlist* de operadores (ADR-008) não é listada nas fontes consultadas; expressões sobre `stages.active[]` (ex.: "alguma etapa ativa é X") podem exigir operador de lista (`some`/`all`) — confirmar se já está na *allowlist* ou se entra por *code review* (ADR-008).
  3. Os valores sigilosos de `budget.*` e `pca.*` seguem POL-09 por analogia (permissions MVP 2 §POL-09 cita `PcaItem.plannedValue` e `BudgetAllocation.reservedAmount`, não os campos agregados do contexto); proposta: tratar `budget.confirmedTotal` e `pca.plannedValue` como sigilosos.
  4. WF-60 não tem permissão própria em permissions.md; usada `WORKFLOW_MANAGE` + `PROCESS_VIEW` (como WF-23). `RULE_VIEW` (SCR-035, simulador) poderia ser alternativa; decisão de produto.
  5. A tela do painel de regras do workflow é a SCR-035 do MVP 1 (`/admin/workflows/[id]/regras`), mas `features.md` (Apêndice A) mapeia SCR-035 apenas à biblioteca (US-194 a US-200); esta story altera o painel pelo SCR-034 ("Regras da versão") e registra o seletor de contexto ali.

## Impacto técnico
- **Compatibilidade:** `ruleContextV2Schema` é construído como extensão tipada do v1 (`Omit<RuleContextV1, 'version'> & {...}`), com teste de tipo que quebra o *build* se um caminho do v1 sumir. WF-19 e WF-23 mudam de forma aditiva (DEC-108): clientes do MVP 1 recebem a mesma resposta.
- **Hash comparável:** `contextVersion` só entra no snapshot quando for 2 (RN-WF2-89); sem isso o `definitionHash` das versões do MVP 1 deixaria de bater com a semente v1 e a US-130 trataria todo tenant como "customizado".
- **Performance:** montagem preguiçosa e cache por requisição evitam custo dos seis módulos novos em regras que só usam o v1; meta inicial a calibrar na suíte de performance: montagem completa do v2 com p95 < 150 ms e regra só-v1 sem custo adicional mensurável (medido no endurecimento, não neste card).
- **Isolamento de módulos:** `workflow` não importa `budget`, `tender`, `legal-review`, `internal-control` nem `sla`; só a porta `RuleContextContributor` (regra D9, dependency-cruiser). O registro é por injeção no módulo dono.
- **Segurança:** o contexto nunca é logado nem serializado fora de WF-60; mascaramento no serializador central (`ConfidentialFieldsInterceptor`) e na montagem de `contextUsed`.
- **Fuso e relógio:** `now` e `businessDaysInStage` usam o calendário do tenant, como no v1.

## Backend
- **Módulo(s):** `workflow` (dono: `RuleContextBuilder`, esquemas, WF-19/WF-23/WF-60), `process` (provedor de `process`, `stage`, `stages.active` e a ponte para `pca`), módulos donos de cada namespace (publicam o provedor em suas stories), `access` (`AuthorizationService`), `audit`, `platform` (leitura em retrato).
- **Casos de uso:** `GetRuleContextSchemaQuery` (versão 1 ou 2), `PreviewRuleContextQuery` (WF-60), `TestWorkflowRuleQuery` (estendido com `contextVersion`), `CreateWorkflowRuleCommand`/`UpdateWorkflowRuleCommand` (grava `contextVersion`), `ValidateWorkflowVersionQuery` (confere caminhos por `contextVersion`).
- **Domínio:** `ruleContextV2Schema` (Zod, `packages/validation`); `RuleContextBuilder.build({ processId, contextVersion, namespaces })`; `RuleContextContributor` (`namespace`, `contextVersions`, `build(input, snapshot)`); `NamespaceRegistry`; `RulePathResolver` (extrai `var` e mapeia a namespace); `ContextMasker` (POL-09).
- **Integrações internas:** fachadas somente leitura dos módulos donos (`BudgetFacade`, `LegalReviewFacade`, `InternalControlFacade`, `TenderFacade`, `SlaFacade`, `PcaFacade`) invocadas pelos provedores, nunca pelo `workflow`.
- **Transação:** montagem em transação somente leitura com `app.tenant_id` (retrato único); WF-16/WF-17 em transação curta de escrita, incrementando `WorkflowVersion.version` (RN-WF-06).

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`), com o painel "Regras da versão" (ficha SCR-035 do MVP 1, `/admin/workflows/[id]/regras`).
- **Componentes:** `ContextVersionSelect`, `ConditionBuilder` (campos agrupados por namespace, desabilita os indisponíveis), `RuleContextBadge` ("Contexto v1" / "Contexto v2"), `UpgradeContextButton` ("Atualizar para v2"), `RuleTestPanel` (aviso de namespace indisponível), `ContextPreviewDrawer` (técnico: árvore por namespace com valores mascarados e situação de cada um).
- **Estados:** loading (skeleton ao carregar o schema); vazio ("Nenhuma regra configurada para esta etapa"); erro ("Não foi possível carregar os campos disponíveis. Tente novamente."); namespace indisponível (campos desabilitados com tooltip); sucesso (toast "Regra salva").
- **Acessibilidade e responsividade:** seletor e árvore navegáveis por teclado; situação do namespace comunicada por texto e ícone, não só por cor; resultado do teste e da prévia anunciado por `aria-live`; painel lateral vira modal abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflow_rules` (`context_version` já criada em M2-04), `workflow_versions` (`definition_snapshot` com `contextVersion` quando 2); leitura de `processes`, `process_stages` e das tabelas dos módulos pelos provedores.
- **Migrações:** nenhuma nova nesta story (M2-04 cria `workflow_rules.context_version`, padrão 1). O schema do snapshot é ampliado de forma aditiva.
- **Índices/constraints relevantes:** `workflow_rules` com `CHECK (context_version IN (1, 2))` e `CHECK (rule_definition_version_id IS NULL OR type = 'CONDITION')` (entities MVP 2 §5.8); nenhum índice novo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `WF-19` | GET | `/rule-context/schema` | query `version` (1 \| 2, padrão 1) | `200 { data: { version, namespaces?[], fields: [{ path, label, type, namespace? }] } }` | 200, 403, 422 |
| `WF-16` | POST | `/workflow-versions/{versionId}/rules` | corpo do MVP 1 + `contextVersion?` (padrão 2) | `201 { data: WorkflowRule }` com `contextVersion` | 201, 403, 409, 422 |
| `WF-17` | PATCH | `/workflow-rules/{ruleId}` | parcial + `contextVersion?` + `If-Match` | `200 { data: WorkflowRule }` | 200, 403, 409, 412, 422, 428 |
| `WF-20` | POST | `/workflow-versions/{versionId}/validate` | — | `200 { data: { valid, errors[], warnings[] } }` com os códigos novos em `errors[]` | 200, 404 |
| `WF-23` | POST | `/workflow-versions/{versionId}/rules/test` | `{ type, config, severity?, message?, processId, contextVersion? }` | `200 { data: { satisfied, severity, message, contextUsed, contextVersion, warnings[] } }` (aviso `NAMESPACE_UNAVAILABLE`) | 200, 403, 404, 422, 503 |
| `WF-60` | POST | `/rules/context-preview` | `{ processId, contextVersion? (padrão 2), namespaces?: string[] }` | `200 { data: { contextVersion, namespaces: { <ns>: 'LOADED'\|'UNAVAILABLE'\|'SKIPPED' }, context, maskedPaths[], buildMs } }` · `Cache-Control: no-store` | 200, 403, 404, 422, 503 |

## Logs
- `info` `workflow.rule_context_built` — `contextVersion`, `namespaces[]`, `cacheHits`, `durationMs`, `source` (`RUNTIME`, `TEST`, `PREVIEW`).
- `warn` `workflow.rule_context_namespace_unavailable` — `namespace`, classe do erro, `correlationId`.
- `error` `workflow.rule_context_provider_failed` — `namespace`, causa resumida, `ruleId?`.
- `info` `workflow.rule_saved` — `ruleId`, `contextVersion`, operação.
- **Nunca logar:** o contexto, valores de orçamento, conteúdo de documentos, nem a expressão com valores de processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.update` | `CONFIGURATION` | WF-16/WF-17 | `changes`: `contextVersion` (quando muda); `metadata`: `ruleId`, `type`, `scope`, `contextVersion` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = WORKFLOW_MANAGE` |

WF-19, WF-23 e WF-60 são leituras e, como o WF-23 do MVP 1, não geram auditoria de domínio.

## Testes necessários
- **Unitários:** `ruleContextV2Schema` como superset do v1 (teste de tipo e de dados); `RulePathResolver` (caminho → namespace, aninhados e `documents.<CÓDIGO>`); montagem preguiçosa (provedores espionados); cache por requisição; falha fechada (erro, tempo, ausência); mascaramento POL-09 em `contextUsed`, prévia e mensagens; canonicalização do snapshot (`contextVersion` só quando 2).
- **Integração (Testcontainers PostgreSQL + Redis):** suíte de regressão das regras do MVP 1 com resultado idêntico; montagem em retrato único durante escrita concorrente; WF-16/WF-17/WF-20 com `contextVersion`; `definitionHash` de versão v1 inalterado após a story.
- **API/contrato:** WF-19 com e sem `version`; WF-23 e WF-60 conforme a tabela; respostas do MVP 1 inalteradas (contrato).
- **RBAC e multi-tenant:** `WORKFLOW_VIEW` × `WORKFLOW_MANAGE`; WF-60 e WF-23 com processo de outro tenant → 404 (suíte `test/tenant-leak`); processo sigiloso com e sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.
- **Concorrência:** duas edições da mesma regra (412); escrita no processo durante a montagem.
- **E2E (Playwright):** criar regra v2, testar contra processo, ver prévia, publicar e ver a validação com caminho inválido.
- **Acessibilidade/performance:** axe no seletor de contexto, na árvore da prévia e no painel de teste; teste de performance da montagem completa do v2 (meta inicial na suíte de performance, medida no endurecimento).

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
- [ ] Suíte de regras do MVP 1 verde com o contexto v2 publicado (nenhuma regressão)
- [ ] `definitionHash` das versões do MVP 1 e da semente v1 inalterado (teste de snapshot)
- [ ] Teste de contrato dos provedores (`RuleContextContributor`) disponível para as stories de módulo

## Estimativa
**M** — não há tabela nova nem evento, mas o contrato versionado, a montagem preguiçosa com cache, a falha fechada, o mascaramento e a regressão total das regras do MVP 1 exigem cuidado; os provedores de conteúdo ficam nas stories dos módulos.

## Prioridade
**P0** — bloqueia as regras de saída das etapas novas (US-148, US-155, US-161, US-168), o SLA, as regras de notificação e a biblioteca; por isso vem cedo na ordem de entrega do MVP 2.
