---
id: US-196
title: "Modelos prontos de regras"
epic: EP-031
feature: FT-088
mvp: 2
priority: P1
estimate: S
status: Especificada
depends_on: [US-194]
modules: [rules, tenant, access, audit]
screens: [SCR-035]
endpoints: [RUL-12, RUL-01, RUL-03]
permissions: [RULE_VIEW, RULE_MANAGE]
events: []
---

# US-196 — Modelos prontos de regras

## Título
Modelos prontos de regras

## Descrição
**Como** administrador do órgão, **quero** encontrar na biblioteca cinco modelos prontos de regras já testados e copiar o que me serve para o meu órgão, informando só o valor-limite ou a severidade, **para** começar de uma regra pronta em vez de escrever JSON Logic do zero.

A story semeia, por tenant, as regras-modelo `COBERTURA_DOTACAO` (`VALIDATION`), `CI_ACIMA_DE_VALOR` (`ROUTING`), `ALCADA_AUTORIDADE_POR_VALOR` (`APPROVAL_THRESHOLD`), `SLA_PREGAO` (`SLA`) e `NOTIFICAR_GESTOR_PRAZO_VENCIDO` (`NOTIFICATION`) como `RuleDefinition` com `isSystem = true`, versão 1 publicada, casos de teste e nenhuma referência de uso; entrega a ação "Copiar" (RUL-12), que cria uma regra do tenant em rascunho a partir de um modelo (ou de outra regra do tenant), com parâmetros guiados; e a aba "Modelos" da SCR-035. Modelos não são editáveis nem excluíveis; o tenant sempre trabalha em cópia.

## Contexto
- O risco "regras complexas demais para administradores" (roadmap §4.10, ADR-015) é mitigado por **modelos prontos**, simulador (US-199) e casos de teste (US-200). Esta story é a parte dos modelos.
- entities.md §9 lista os modelos semeados: "`COBERTURA_DOTACAO` (VALIDATION), `CI_ACIMA_DE_VALOR` (ROUTING, valor configurável), `ALCADA_AUTORIDADE_POR_VALOR` (APPROVAL_THRESHOLD), `SLA_PREGAO`, `NOTIFICAR_GESTOR_PRAZO_VENCIDO` (NOTIFICATION) — sem uso até o administrador adotar". Valores-limite e conteúdo ficam "a validar com o piloto".
- As sementes do MVP 2 são **incrementais** por tenant (`TenantSeeder` com `applyToExistingTenants`), respeitam customizações e entram no `tenant:seed`; a biblioteca de templates de documento (DT-15) usa o mesmo princípio: catálogo em código, comparação por hash para "atualização disponível".
- O modelo `COBERTURA_DOTACAO` lê `budget.coverageRatio` do `RuleContext` v2 (DEC-198: a regra de saída padrão de `DOTACAO` exige `budget.coverageRatio >= 1`, severidade `budget.coverageRuleSeverity`); `SLA_PREGAO` e `NOTIFICAR_GESTOR_PRAZO_VENCIDO` serão usados por `SlaPolicy` e `NotificationRule` (EP-030), que referenciam o `kind` correspondente.
- A US-194 já define imutabilidade, `isSystem` somente leitura e o ciclo de versões; aqui entram o catálogo, as sementes e a cópia.

## Objetivo
Entregar os cinco modelos em 100% dos tenants (novos e existentes), cada um com casos de teste verdes, e permitir criar uma regra a partir de modelo em até 10 minutos (KPI do épico) com o valor-limite e a severidade informados na própria cópia.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `RULE_VIEW` e `RULE_MANAGE`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, com `RULE_VIEW` e `RULE_MANAGE`, copia e adapta); Controle interno e Auditor (`RULE_VIEW`, leem os modelos); Operador da plataforma (suporte), que confere os modelos semeados.

## Pré-condições
- US-194 entregue (biblioteca, versões, publicação) e catálogo de modelos versionado em código (`RuleTemplateCatalog`).
- Para ler: `RULE_VIEW`. Para copiar: `RULE_MANAGE`. Publicar a cópia é da US-194 (`RULE_PUBLISH`) e exige os casos de teste verdes (US-200).
- Tenant com a semente aplicada (`tenant:seed` na provisão ou migração dos existentes).

## Fluxo principal
1. O administrador abre SCR-035 (`/admin/regras`) e a aba "Modelos"; o sistema chama RUL-01 com `isSystem = true` e lista os cinco modelos com nome, descrição, tipo, "Quando usar" e o selo "Modelo do sistema".
2. Abre um modelo (RUL-03): vê a expressão em leitura (como texto e no `ConditionBuilder` somente leitura), os casos de teste e os parâmetros que a cópia pede (`templateParameters`).
3. Clica em "Copiar e adaptar", informa a **chave** e o **nome** da nova regra e os parâmetros (por exemplo, o **valor-limite** de `CI_ACIMA_DE_VALOR`, sugerido R$ 500.000,00) e confirma; o front envia RUL-12 com `Idempotency-Key`.
4. A API cria na mesma transação a `RuleDefinition` do tenant (`isSystem = false`, mesmo `kind`, etiquetas do modelo e a descrição "Copiada do modelo {chave}") e a versão 1 em `DRAFT` com expressão, `contextVersion`, severidade/mensagem e casos de teste gerados com os parâmetros informados; audita `rule.create` e responde 201.
5. A tela abre `/admin/regras/[ruleId]` no rascunho. O administrador ajusta o que quiser (editor da US-194), vê os casos de teste que acompanham a cópia (US-200), simula (US-199) e publica (US-194, `RULE_PUBLISH`).
6. Só depois de publicada a cópia aparece no seletor de uso dos workflows (US-195). O modelo em si nunca aparece no seletor nem recebe uso direto.

## Fluxos alternativos
- **FA-01 — Copiar uma regra do próprio tenant:** RUL-12 também aceita como origem qualquer regra não-modelo do tenant; copia a versão vigente (ou a mais recente, se não houver vigente), sem parâmetros, com nova chave e nome; não copia `isActive` nem usos.
- **FA-02 — Severidade padrão do modelo de cobertura:** ao copiar `COBERTURA_DOTACAO`, a severidade vem preenchida com `budget.coverageRuleSeverity` do tenant (padrão `BLOCKING`) e pode ser trocada para `WARNING` na própria cópia.
- **FA-03 — Modelo sem parâmetro:** `SLA_PREGAO` e `NOTIFICAR_GESTOR_PRAZO_VENCIDO` copiam sem parâmetros; o diálogo pede só chave e nome.
- **FA-04 — Tentar editar o modelo:** botões de edição ficam ocultos; as rotas de escrita da US-194 respondem 409 `RULE_SYSTEM_READONLY`. Excluir não existe para regras.
- **FA-05 — Atualização do catálogo:** quando a plataforma publica uma nova revisão de um modelo, o `TenantSeeder` publica uma nova versão do modelo (a anterior é aposentada); cópias já feitas não mudam e o administrador compara à mão pela aba "Versões" do modelo.
- **FA-06 — Modelo ainda não semeado no tenant:** a aba "Modelos" mostra o que existe; um tenant sem a semente recebe-a ao reexecutar `tenant:seed` (idempotente); não há ação manual de reimportar.
- **FA-07 — Leitura sem cópia:** Controle interno e Auditor veem os modelos e os casos de teste, mas não veem "Copiar e adaptar".

## Regras de negócio
- **RN-RULE-43** — Cada tenant recebe cinco `RuleDefinition` `isSystem = true` e `isActive = true`: `COBERTURA_DOTACAO` (`VALIDATION`), `CI_ACIMA_DE_VALOR` (`ROUTING`), `ALCADA_AUTORIDADE_POR_VALOR` (`APPROVAL_THRESHOLD`), `SLA_PREGAO` (`SLA`), `NOTIFICAR_GESTOR_PRAZO_VENCIDO` (`NOTIFICATION`), cada uma com a versão 1 `PUBLISHED` (`contextVersion` 2, `expressionHash` e `testRunHash` iguais, `publishedById` nulo, autor do sistema), casos de teste e **nenhum uso** em workflow, política de SLA ou regra de notificação (entities.md §9).
- **RN-RULE-44** — As sementes são **incrementais, idempotentes e por tenant** (`TenantSeeder`, `applyToExistingTenants`): rodar de novo não duplica (unique `(tenant_id, key)`), não toca regras do tenant e respeita customizações; as `key` dos modelos são reservadas (criar regra com essa chave dá 409 `CONFLICT`).
- **RN-RULE-45** — Modelos não são editáveis, versionáveis pelo tenant, inativáveis nem excluíveis (`RULE_SYSTEM_READONLY`); só o `TenantSeeder` altera um modelo, publicando nova versão quando o hash da expressão do catálogo difere do da versão vigente (padrão DT-15); cópias já criadas não mudam.
- **RN-RULE-46** — **Conteúdo dos modelos** (propostas, "a validar com o piloto"): `COBERTURA_DOTACAO`: `budget.coverageRatio` não nulo e `>= 1`, severidade padrão `BLOCKING` (lida de `budget.coverageRuleSeverity` ao copiar) e mensagem "A dotação confirmada não cobre o valor estimado do processo. Confirme as reservas na etapa de dotação."; `CI_ACIMA_DE_VALOR`: `process.estimatedValue` nulo **ou** maior que o limite (na dúvida, aplica a etapa); `ALCADA_AUTORIDADE_POR_VALOR`: faixa "acima do limite" com a mesma forma (valor nulo cai na faixa mais rigorosa); `SLA_PREGAO`: `process.modalityCode == "PREGAO"`; `NOTIFICAR_GESTOR_PRAZO_VENCIDO`: `sla.overdue == true`.
- **RN-RULE-47** — **Parâmetros da cópia** (`templateParameters`): `limitValue` em `CI_ACIMA_DE_VALOR` e `ALCADA_AUTORIDADE_POR_VALOR` (obrigatório, maior que 0, até 2 casas decimais; sugestão R$ 500.000,00); `severity` em `COBERTURA_DOTACAO` (`BLOCKING` ou `WARNING`); nenhum nos demais. Parâmetro não aplicável ao modelo é recusado (`NOT_ALLOWED`).
- **RN-RULE-48** — A cópia (RUL-12) cria, atomicamente, uma `RuleDefinition` do tenant (`isSystem = false`, `isActive = true`, mesmo `kind` e etiquetas, `key` e `name` informados, descrição "Copiada do modelo {chave}") e a versão 1 em `DRAFT` com a expressão **gerada pelo catálogo com os parâmetros** e os casos de teste regenerados em torno do valor informado; `testRunHash` fica nulo e a publicação passa pelos gates da US-194/US-200 como qualquer regra.
- **RN-RULE-49** — **Casos de teste que acompanham cada modelo** (verdes na semente): `COBERTURA_DOTACAO` — cobertura total (verdadeiro), parcial 0,5 (falso), sem dotação confirmada (falso); `CI_ACIMA_DE_VALOR` e `ALCADA_AUTORIDADE_POR_VALOR` — valor um centavo abaixo do limite (falso), exatamente no limite (falso), um centavo acima (verdadeiro) e valor não informado (verdadeiro); `SLA_PREGAO` — `PREGAO` (verdadeiro), `DISPENSA` (falso); `NOTIFICAR_GESTOR_PRAZO_VENCIDO` — vencido (verdadeiro), no prazo (falso).
- **RN-RULE-50** — A origem da cópia fica registrada em auditoria (`rule.create` com `metadata.copiedFromRuleDefinitionId`, `copiedFromKey` e `parameters`) e na descrição inicial; não há vínculo persistente entre cópia e modelo (ver Lacunas L-01).
- **RN-RULE-51** — O seletor de uso (US-195) e a validação de referência nunca aceitam modelo `isSystem`; modelos aparecem apenas na aba "Modelos" e na lista geral com o selo; a leitura exige `RULE_VIEW`, a cópia `RULE_MANAGE`.
- **RN-RULE-52** — Toda expressão de modelo passa pelo mesmo validador da *allowlist* (ADR-008) e tem casos verdes **no CI**: um teste do catálogo falha o build se qualquer modelo usar operador proibido, caminho fora do contexto v2 ou tiver caso vermelho; modelos nunca contêm valor de processo, dado sigiloso nem identificador de tenant.

Regras que se aplicam, sem renumerar: **RN-RULE-04** e **RN-RULE-15** (US-194: imutabilidade e `isSystem` somente leitura), **RN-RULE-27** e **RN-RULE-35** (US-195: seletor sem modelos).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nova chave | `key` | texto | Sim | SCREAMING_SNAKE, 2–60; única no tenant; não pode repetir chave de modelo | — |
| Novo nome | `name` | texto | Sim | 3–150; único no tenant sem diferenciar maiúsculas | nome do modelo |
| Descrição | `description` | texto | Não | até 2.000 | "Copiada do modelo {chave}" |
| Etiquetas | `tags` | lista | Não | como US-194 | etiquetas do modelo |
| Valor-limite | `parameters.limitValue` | número | Condicional (`CI_ACIMA_DE_VALOR`, `ALCADA_AUTORIDADE_POR_VALOR`) | > 0, até 2 casas decimais | R$ 500.000,00 (sugestão, a validar com o piloto) |
| Severidade | `parameters.severity` | lista | Condicional (`COBERTURA_DOTACAO`) | `BLOCKING` ou `WARNING` | `budget.coverageRuleSeverity` |
| *(sistema)* Modelo do sistema | `isSystem` | booleano | — | verdadeiro nos modelos; falso na cópia | semente |
| *(sistema)* Parâmetros do modelo | `templateParameters` | lista | — | `[{ name, label, type, default, min? }]` na resposta de RUL-03 de modelos | catálogo |
| *(sistema)* Texto "Quando usar" | `templateUsageHint` | texto | — | somente leitura | catálogo |
| *(sistema)* Origem da cópia | `metadata.copiedFromKey` | texto | — | só na auditoria | RUL-12 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `key` ou `name` ausentes ou fora do formato | Front + API (Zod) | "Informe a chave e o nome da nova regra." | `VALIDATION_ERROR` |
| V-02 | `key` ou `name` já usados, ou chave reservada de modelo | API | "Já existe uma regra com esta chave ou nome. Escolha outro." | `CONFLICT` |
| V-03 | `limitValue` ausente, menor ou igual a zero, ou com mais de 2 casas | Front + API | "Informe um valor-limite maior que zero, com até 2 casas decimais." | `VALIDATION_ERROR` |
| V-04 | Parâmetro que o modelo não aceita | API | "Este modelo não usa esse parâmetro." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-05 | `severity` fora de `BLOCKING` ou `WARNING` | Front + API | "Escolha Bloqueia ou Avisa." | `VALIDATION_ERROR` |
| V-06 | Copiar regra inexistente ou de outro tenant | API | "Regra não encontrada." | `NOT_FOUND` |
| V-07 | Tentativa de editar modelo | API | "Modelos do sistema não podem ser alterados. Copie o modelo para adaptá-lo." | `RULE_SYSTEM_READONLY` |
| V-08 | Regra de origem sem nenhuma versão | API | "Esta regra ainda não tem conteúdo para copiar." | `BUSINESS_RULE_VIOLATION` |

## Permissões
- **Permissão:** `RULE_VIEW` (risco L) para ver a aba "Modelos" e os modelos; `RULE_MANAGE` (risco M) para copiar. Publicar a cópia exige `RULE_PUBLISH` (US-194). Nenhuma é escopável.
- **Políticas:** POL-27 (a publicação da cópia exige casos verdes; US-200). Nenhuma política contextual nova.
- **MFA:** copiar não exige MFA (risco `M`), salvo `security.mfaPolicy = ALL`; publicar a cópia segue a US-194.
- **Sem permissão:** sem `RULE_MANAGE`, o botão "Copiar e adaptar" fica oculto e a API responde 403 `PERMISSION_DENIED` com auditoria `access.denied`; sem `RULE_VIEW`, a aba e a rota não são exibidas.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum: semear modelos e copiar são configuração em rascunho (sem evento de domínio). `RuleVersionPublished` só ocorre na publicação da cópia (US-194). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: não há notificação nem entrada na timeline para semente ou cópia de regra. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Modelos prontos de regras

  Background:
    Given que o tenant "Prefeitura A" está ativo com a semente de modelos aplicada
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (RULE_VIEW, RULE_MANAGE, RULE_PUBLISH)
    And "Rafael" tem vínculo ativo com o perfil "GESTOR_CONTRATACOES" (RULE_VIEW, RULE_MANAGE)
    And "Paulo" tem vínculo ativo com o perfil "CONTROLE_INTERNO" (RULE_VIEW)
    And "budget.coverageRuleSeverity" do tenant é "BLOCKING"

  Scenario: [Sucesso] Os cinco modelos existem, publicados e sem uso
    When "Marina" listar as regras com "isSystem" verdadeiro
    Then a API deve responder 200 com as chaves "COBERTURA_DOTACAO", "CI_ACIMA_DE_VALOR", "ALCADA_AUTORIDADE_POR_VALOR", "SLA_PREGAO" e "NOTIFICAR_GESTOR_PRAZO_VENCIDO"
    And cada uma deve ter a versão 1 "PUBLISHED" com "testRunHash" igual ao "expressionHash" e "contextVersion" 2
    And nenhuma deve ter uso em workflow, política de SLA ou regra de notificação
    And não deve gerar evento de domínio

  Scenario: [Sucesso] Copiar CI_ACIMA_DE_VALOR com o limite do órgão
    When "Marina" copiar "CI_ACIMA_DE_VALOR" com a chave "CI_ACIMA_DE_400K", o nome "Controle Interno acima de R$ 400.000" e "limitValue" igual a 400000.00
    Then a API deve responder 201 com a regra "isSystem" falso do tipo "ROUTING" e a versão 1 em "DRAFT"
    And a expressão deve comparar "process.estimatedValue" com 400000 e tratar valor nulo como "aplica"
    And a versão deve trazer 4 casos de teste: 399999.99 (falso), 400000.00 (falso), 400000.01 (verdadeiro) e nulo (verdadeiro)
    And deve gerar registro de auditoria "rule.create" com "metadata.copiedFromKey" igual a "CI_ACIMA_DE_VALOR"
    And não deve gerar evento de domínio

  Scenario: [Sucesso] Copiar COBERTURA_DOTACAO herda a severidade do tenant
    When "Marina" copiar "COBERTURA_DOTACAO" com a chave "COBERTURA_DO_ORGAO" sem informar a severidade
    Then a versão 1 da cópia deve ter "severity" igual a "BLOCKING" e a mensagem do modelo
    And deve gerar registro de auditoria "rule.create" e nenhum evento
    When "Rafael" copiar o mesmo modelo com a chave "COBERTURA_AVISO" e "severity" igual a "WARNING"
    Then a versão 1 da cópia deve ter "severity" igual a "WARNING"

  Scenario: [Sucesso] Copiar uma regra do próprio tenant e publicar a cópia
    Given que a regra "COBERTURA_DO_ORGAO" tem a versão 1 "PUBLISHED" com 3 casos verdes
    When "Marina" copiar "COBERTURA_DO_ORGAO" com a chave "COBERTURA_FUNDO" e publicar a versão 1 da cópia
    Then a cópia deve nascer em "DRAFT" com os mesmos 3 casos e, depois da publicação, ficar "PUBLISHED"
    And deve gerar registro de auditoria "rule.create" e "rule.version_publish" da US-194

  Scenario: [Validação] Parâmetros inválidos
    When "Marina" copiar "CI_ACIMA_DE_VALOR" com "limitValue" igual a 0
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "parameters.limitValue"
    When "Marina" copiar "SLA_PREGAO" com "limitValue" igual a 100000
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    When "Marina" copiar "COBERTURA_DOTACAO" com "severity" igual a "CRITICAL"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And nenhuma regra deve ter sido criada

  Scenario: [Validação] Modelo não é editável
    When "Marina" tentar alterar o nome do modelo "SLA_PREGAO" e criar uma nova versão dele
    Then cada chamada deve responder 409 com código "RULE_SYSTEM_READONLY"
    And o modelo deve continuar com a versão 1 "PUBLISHED"

  Scenario: [Permissão] Quem só lê não copia
    When "Paulo" abrir a aba "Modelos"
    Then a API deve responder 200 com os cinco modelos e os casos de teste
    When "Paulo" tentar copiar "SLA_PREGAO"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Bruno" tem o perfil "PLANEJAMENTO" sem "RULE_VIEW"
    When "Bruno" listar as regras
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Modelo ou regra de outro tenant
    Given que existe a regra "LIMITE_PREFEITURA_B" no tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", copiar essa regra
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado
    And os modelos de "Prefeitura A" não devem ser alterados por nenhuma semente de "Prefeitura B"

  Scenario: [Duplicidade] Chave repetida, chave reservada, reenvio e semente repetida
    Given que a regra "CI_ACIMA_DE_400K" já existe
    When "Marina" copiar o modelo outra vez com a chave "CI_ACIMA_DE_400K"
    Then a API deve responder 409 com código "CONFLICT"
    When "Marina" copiar "SLA_PREGAO" com a chave "SLA_PREGAO"
    Then a API deve responder 409 com código "CONFLICT"
    When "Marina" reenviar a mesma cópia "COBERTURA_FUNDO" com a mesma "Idempotency-Key"
    Then a API deve responder com a mesma resposta e "Idempotent-Replayed" verdadeiro
    And deve existir uma só regra "COBERTURA_FUNDO"
    When o "TenantSeeder" for executado de novo no tenant
    Then não deve haver modelo duplicado nem nova versão dos modelos sem mudança no catálogo

  Scenario: [Concorrência] Duas cópias simultâneas com a mesma chave
    When "Marina" e "Rafael" copiarem "CI_ACIMA_DE_VALOR" com a chave "CI_CONCORRENTE" ao mesmo tempo
    Then uma requisição deve responder 201 e a outra 409 com código "CONFLICT"
    And deve existir uma só regra "CI_CONCORRENTE" com uma só versão 1 em "DRAFT" e uma só auditoria "rule.create"

  Scenario: [Falha de banco] Banco indisponível durante a cópia
    Given que o banco de dados fica indisponível durante a transação de RUL-12
    When "Marina" copiar "ALCADA_AUTORIDADE_POR_VALOR" com "limitValue" igual a 500000.00
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And não deve existir regra sem versão, nem auditoria, para a chave pedida

  Scenario: [Falha de integração] Job de semente interrompido e retomado
    Given que o job "tenant-seed" foi interrompido no meio do tenant "Prefeitura A" por falha de fila, com 3 dos 5 modelos criados
    When o job for reexecutado
    Then os 2 modelos faltantes devem ser criados sem duplicar os 3 existentes
    And os cinco modelos devem ter a versão 1 "PUBLISHED" com casos verdes
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campos ou parâmetros inválidos | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca o campo; mantém o diálogo |
| Chave ou nome repetidos / chave reservada | 409 | `CONFLICT` | "Já existe uma regra com esta chave ou nome. Escolha outro." | Marca o campo |
| Escrita em modelo | 409 | `RULE_SYSTEM_READONLY` | "Modelos do sistema não podem ser alterados. Copie o modelo para adaptá-lo." | Oferece "Copiar e adaptar" |
| Regra de origem sem versão | 422 | `BUSINESS_RULE_VIOLATION` | "Esta regra ainda não tem conteúdo para copiar." | Fecha o diálogo |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para copiar regras." | Oculta a ação |
| Regra inexistente / outro tenant | 404 | `NOT_FOUND` | "Regra não encontrada." | Volta à lista |
| `Idempotency-Key` reutilizada com outro corpo | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta operação já foi enviada com outros dados. Recarregue a tela." | Recarrega |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível copiar agora. Tente novamente em instantes." | Mantém o diálogo; "Tentar novamente" |

## Dependências
- **Stories:** US-194 (biblioteca, versões, `isSystem` somente leitura, publicação). Habilita US-195 (seletor sem modelos), US-197 e US-198 (regras de roteamento e alçada partem destes modelos), US-199/US-200 (modelos trazem casos e servem de exemplo do simulador), EP-030 (`SLA_PREGAO` e `NOTIFICAR_GESTOR_PRAZO_VENCIDO`).
- **Decisões/ADRs:** DEC-204, DEC-198 (cobertura da dotação), DEC-196 (sementes incrementais), DEC-108; ADR-015, ADR-008. Princípio do DT-15 (catálogo em código, atualização por hash).
- **Configurações:** `budget.coverageRuleSeverity` (severidade sugerida na cópia de `COBERTURA_DOTACAO`); `tender.riskMatrixValueThreshold` não é usado por nenhum dos cinco modelos desta story.
- **Lacunas nas fontes canônicas:**
  1. **L-01 — Origem da cópia:** `RuleDefinition` não tem campo de origem. Proposta: `templateKey` (varchar(60), nulo) em `rule_definitions`, preenchido nas cópias, para a aba "Usos" do modelo e para sugerir atualização; sem ele a origem fica só na auditoria e na descrição.
  2. **L-02 — Valor-limite "configurável por tenant":** o card do épico diz que o valor-limite do `CI_ACIMA_DE_VALOR` é configurável por tenant, mas entities.md §8 não tem chave. Aqui o valor é parâmetro da **cópia** (sem nova chave); se o produto quiser um padrão por tenant, propor `rules.defaultValueThreshold` (number, nulo).
  3. **L-03 — Conteúdo dos modelos:** expressões, mensagens, casos e o limite sugerido de R$ 500.000,00 (exemplo da feature) são propostas "a validar com o piloto" (entities.md §9). Em particular, o tratamento de valor nulo como "aplica a etapa" e "faixa mais rigorosa" é decisão deste card.
  4. **L-04 — Ator da semente:** `publishedById` nulo e `actorType = SYSTEM` na auditoria da semente; confirmar com `audit`.
  5. **L-05 — Parâmetros do catálogo:** `templateParameters` na resposta de RUL-03 e o corpo `parameters` de RUL-12 não existem no api.md; propostos aqui.

## Impacto técnico
- **Catálogo em código:** `RuleTemplateCatalog` (em `rules`) define, por modelo, chave, tipo, nome, descrição, "Quando usar", parâmetros, gerador de expressão e de casos de teste e um `catalogHash`; é testado no CI (RN-RULE-52).
- **Semente:** `TenantSeeder` (incremental, `applyToExistingTenants`) cria a regra-modelo e a versão 1 já `PUBLISHED` num caminho de sistema que **não** passa pelo gate manual (os casos são verificados no CI e na semente); alterações de catálogo publicam nova versão do modelo por comparação de hash. Entra no `tenant:seed` e na migração de dados dos tenants existentes.
- **Compatibilidade:** nenhuma rota do MVP 1 muda; RUL-12 é nova; `isSystem` já é campo de `RuleDefinition`. Modelos não têm uso até o administrador adotar.
- **Segurança:** o gerador de expressão só produz JSON Logic da *allowlist*; os parâmetros são números e enumerações validados (nunca texto livre injetado na expressão).
- **Performance:** a cópia é uma transação curta; a lista de modelos é a mesma RUL-01 com filtro.

## Backend
- **Módulo(s):** `rules` (catálogo, cópia, leitura), `tenant` (`TenantSeeder`), `access`, `audit`.
- **Casos de uso:** `CopyRuleCommand` (RUL-12), `SeedRuleTemplatesCommand` (sementes), consultas RUL-01/RUL-03 com `isSystem` e `templateParameters`.
- **Domínio:** `RuleTemplateCatalog`, `RuleTemplate` (parâmetros, geradores), `RuleCopier` (modelo ou regra do tenant), `TemplateParameterValidator`.
- **Integrações internas:** `SettingsFacade` (`budget.coverageRuleSeverity`), `AuthorizationService.assertCan(RULE_MANAGE)`, validador da US-194 (`RuleExpressionValidator`), executor para verificar os casos gerados.
- **Transação:** RUL-12 cria `RuleDefinition` e versão 1 `DRAFT` com `app.tenant_id`, audita e confirma de uma vez; a semente é uma transação por tenant e por modelo, idempotente.

## Frontend
- **Tela(s):** SCR-035 (`/admin/regras`, aba "Modelos"; `/admin/regras/[ruleId]` para a cópia em rascunho).
- **Componentes:** `RuleTemplateCard` (nome, tipo, "Quando usar", selo "Modelo do sistema"), `RuleTemplateDetail` (expressão somente leitura e casos), `CopyRuleDialog` (chave, nome, parâmetros guiados com máscara de moeda e pré-visualização da condição em português: "Aplica quando o valor estimado for maior que R$ 400.000,00 ou não estiver informado").
- **Estados:** carregando (skeleton), vazio ("Nenhum modelo disponível. Entre em contato com o suporte" — só se a semente faltar), erro ("Tentar novamente"), sem permissão (sem botão de copiar), sucesso (toast e redireciona ao rascunho).
- **Acessibilidade e responsividade:** cartões navegáveis por teclado; diálogo com foco preso e rótulos associados; valor monetário com `inputmode` numérico; tela cheia abaixo de 768 px; contraste 4,5:1.

## Banco de dados
- **Tabelas:** `rule_definitions` e `rule_definition_versions` (US-194); `audit_logs`.
- **Migrações:** nenhuma de esquema (a proposta L-01 `template_key` seria aditiva); migração de dados/semente para os tenants existentes, idempotente, no pacote de sementes do MVP 2 (entities.md §9).
- **Índices/constraints relevantes:** unique `(tenant_id, key)` e `(tenant_id, lower(name))` garantem chave e nome únicos e a idempotência da semente; check/trigger de `isSystem` somente leitura (US-194).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `RUL-12` | POST | `/rules/{id}/copy` | `{ key, name, description?, tags?, parameters?: { limitValue?, severity? } }`; `Idempotency-Key` | `201 { data: RuleDefinition }` com `draftVersion` 1 e casos de teste | 201, 403, 404, 409, 422, 503 |
| `RUL-01` | GET | `/rules` | `isSystem = true` para a aba "Modelos" (demais filtros da US-194) | lista de modelos | 200, 403 |
| `RUL-03` | GET | `/rules/{id}` | — | modelo com `templateParameters`, `templateUsageHint` e `currentPublishedVersion` | 200, 403, 404 |

## Logs
- `info` `rule.template_copied` — `sourceRuleDefinitionId`, `sourceKey`, `newRuleDefinitionId`, `parametersPresent[]`, `durationMs`.
- `info` `rule.templates_seeded` — `tenantId`, `created`, `updated`, `skipped`.
- `warn` `rule.template_seed_retry` (reexecução após interrupção); `error` `rule.template_seed_failed` — `tenantId`, `templateKey`, causa resumida.
- **Nunca logar:** a expressão gerada, o valor-limite informado em texto livre associado a usuário, e qualquer valor de processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `rule.create` | `CONFIGURATION` | RUL-12 (cópia) e semente (`actorType = SYSTEM`) | `metadata`: `ruleDefinitionId`, `key`, `kind`, `copiedFromRuleDefinitionId`, `copiedFromKey`, `parameters` (nomes e valores informados, nunca valor de processo) |
| `rule.version_publish` | `CONFIGURATION` | Semente da versão 1 dos modelos e atualizações de catálogo (`actorType = SYSTEM`) | `metadata`: `key`, `versionNumber`, `expressionHash`, `source = TEMPLATE_CATALOG` |
| `access.denied` | `ACCESS` | Cópia sem permissão | `reasonCode = RULE_MANAGE` |

## Testes necessários
- **Unitários:** cada gerador de expressão e de casos (limites 399999,99/400000,00/400000,01/nulo); `TemplateParameterValidator` (limite, casas decimais, severidade); idempotência da semente; comparação de hash do catálogo; regra de chave reservada.
- **Integração (Testcontainers PostgreSQL):** semente em tenant novo e existente (5 modelos, versão 1, casos verdes, sem uso); reexecução sem duplicar; interrupção e retomada; RUL-12 atômico (regra, versão, auditoria); concorrência pela unique de chave; modelo bloqueado para escrita (409).
- **API/contrato:** RUL-12, RUL-01 e RUL-03 conforme este card; `Idempotency-Key`; resposta de modelo com `templateParameters`.
- **RBAC e multi-tenant:** `RULE_VIEW`/`RULE_MANAGE`; semente de um tenant não toca outro; cópia de regra de outro tenant retorna 404 (suíte `test/tenant-leak`).
- **Concorrência:** duas cópias com a mesma chave; semente × cópia da mesma chave reservada.
- **E2E (Playwright):** abrir "Modelos" → copiar `CI_ACIMA_DE_VALOR` com limite → ver casos → simular → publicar; Controle interno sem botão de copiar.
- **Acessibilidade/performance:** axe nos cartões e no diálogo; 360 px; teste do catálogo no CI (RN-RULE-52).

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
- [ ] Semente dos cinco modelos aplicada a tenants novos e existentes e verificada
- [ ] Teste do catálogo no CI (allowlist, caminhos do contexto v2 e casos verdes)

## Estimativa
**S** — o modelo de dados, a edição e a publicação já existem (US-194); resta o catálogo de cinco modelos com geradores de expressão e de casos, a semente incremental idempotente, uma rota de cópia e a aba "Modelos".

## Prioridade
**P1** — os modelos são a principal mitigação de "regras complexas demais para administradores" e o ponto de partida dos KPIs do épico (regra criada a partir de modelo em até 10 minutos); sem eles o administrador começa do zero.
