---
id: US-194
title: "Biblioteca de regras reutilizáveis com versões"
epic: EP-031
feature: FT-088
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-044, US-129]
modules: [rules, workflow, access, audit, platform]
screens: [SCR-035]
endpoints: [RUL-01, RUL-02, RUL-03, RUL-04, RUL-05, RUL-06, RUL-07, RUL-08, RUL-09, RUL-10, WF-19]
permissions: [RULE_VIEW, RULE_MANAGE, RULE_PUBLISH]
events: [RuleVersionPublished, RuleVersionRetired]
---

# US-194 — Biblioteca de regras reutilizáveis com versões

## Título
Biblioteca de regras reutilizáveis com versões

## Descrição
**Como** administrador do órgão, **quero** cadastrar regras reutilizáveis (`RuleDefinition`) com versões imutáveis, escrevê-las num editor guiado pelo schema do `RuleContext` e publicá-las ou aposentá-las, **para** escrever uma regra uma vez e usá-la em vários workflows sem copiar e colar, sem divergência e sem alterar o que já está publicado.

A story entrega o módulo `rules` (dono de `RuleDefinition` e `RuleDefinitionVersion`) e a tela SCR-035 em `/admin/regras` e `/admin/regras/[ruleId]`: listagem e busca por tipo e etiqueta, cadastro, ciclo de vida da versão (`DRAFT` → `PUBLISHED` → `RETIRED`), editor da expressão JSON Logic restrito à *allowlist* da ADR-008, mensagem e severidade para regras de validação, `expressionHash` na publicação e os eventos `RuleVersionPublished` e `RuleVersionRetired`. O uso das regras nos workflows (versão fixada), os modelos prontos, o simulador e os casos de teste são das US-195, US-196, US-199 e US-200; aqui ficam os pontos de extensão que elas usam.

## Contexto
- No MVP 1 as regras (`WorkflowRule`, DEC-016) são escritas uma a uma dentro de cada versão de workflow, sobre o `RuleContext` v1. A DEC-204 cria a biblioteca no módulo `rules` e mantém o **único executor JSON Logic com *allowlist*** da ADR-008: a biblioteca acrescenta *onde* uma condição pode ser usada, não uma nova linguagem ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)).
- A versão publicada é imutável e nunca excluída, como a `WorkflowVersion` (DEC-014): workflows, políticas de SLA e regras de notificação referenciam a versão por `RuleRef` em modo `LIBRARY` (entities.md §7.1), e uma correção vira nova versão, adotada por escolha.
- Cada versão grava `contextVersion` (1 ou 2). A v2 é superset da v1 e é montada por provedores de cada módulo (US-129); regras v1 não migram à força (DEC-204, ADR-015).
- A SCR-035 do MVP 1 era o painel de regras do workflow (`/admin/workflows/[id]/regras`, US-044). Ele continua como aba "Regras" do editor de workflow (regras locais, `INLINE`); a SCR-035 do MVP 2 é a biblioteca completa e evolui essa ficha (features.md, Apêndice A).
- Risco central do épico (roadmap §4.10): regras complexas demais para administradores. Esta story entrega a base (editor guiado, validação forte, mensagens claras); modelos prontos (US-196), simulador (US-199) e testes obrigatórios (US-200) completam a mitigação.
- A publicação de versão de regra é permissão de risco alto (`RULE_PUBLISH`, POL-27). O gate de casos de teste verdes é plugado pela US-200; esta story deixa o ponto de extensão `PublishGate` na ordem de execução da publicação.

## Objetivo
Permitir que o administrador crie, versione, publique e aposente uma regra em até 10 minutos, com 100% das versões publicadas com `expressionHash`, `contextVersion` e `changeNotes` (a partir da v2), nenhuma versão publicada alterável e nenhuma expressão fora da *allowlist* gravada.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, com `RULE_VIEW`, `RULE_MANAGE` e `RULE_PUBLISH`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, com `RULE_VIEW` e `RULE_MANAGE`: cria e edita rascunhos, não publica); Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), com `RULE_VIEW` (leitura da biblioteca e do histórico de versões).

## Pré-condições
- Tenant ativo, usuário autenticado com vínculo ativo e a permissão da ação (`RULE_VIEW` para ler; `RULE_MANAGE` para criar e editar; `RULE_PUBLISH` para publicar e aposentar). As permissões `RULE_*` não são escopáveis: valem em qualquer atribuição vigente.
- Migração M2-09 aplicada (`rule_definitions`, `rule_definition_versions`) e o contrato do `RuleContext` v2 publicado (US-129), com o schema consultável em `GET /rule-context/schema?version=2`.
- Para publicar: sessão com MFA quando `security.mfaPolicy` exigir (POL-14, permissão `HIGH`).

## Fluxo principal
1. O administrador abre "Administração › Regras" (SCR-035, `/admin/regras`); o sistema chama RUL-01 e lista as regras do tenant com nome, chave, tipo, etiquetas, situação, versão publicada e se há rascunho.
2. Clica em "Nova regra", informa **chave** (SCREAMING_SNAKE), **nome**, **descrição**, **tipo** (`VALIDATION`, `ROUTING`, `APPROVAL_THRESHOLD`, `SLA`, `NOTIFICATION`) e **etiquetas**; o front envia RUL-02 com `Idempotency-Key`.
3. A API cria a `RuleDefinition` e a versão 1 em `DRAFT` (expressão inicial constante `true`, `contextVersion` 2) na mesma transação, audita `rule.create` e responde 201 com a regra e o `draftVersion`.
4. A tela abre `/admin/regras/[ruleId]` na aba "Expressão". O editor chama WF-19 (`?version=2`) e monta o `ConditionBuilder` com os campos do `RuleContext`; o administrador monta a condição (E/OU e linhas campo/operador/valor, com edição em JSON como alternativa) e, para `VALIDATION`, informa **severidade** (`BLOCKING` ou `WARNING`) e **mensagem ao usuário**.
5. Cada alteração salva o rascunho por RUL-08 com `If-Match`. A API valida a expressão contra a *allowlist* e o schema do `contextVersion` e devolve `validation.errors[]` e `validation.warnings[]` para o editor exibir ao lado do campo.
6. Com a expressão pronta, o administrador abre a aba "Versões", informa as **notas da alteração** (obrigatórias a partir da v2) e clica em "Publicar versão". O front envia RUL-09 com `If-Match`.
7. A API revalida dentro da transação, executa os *gates* de publicação (expressão válida; `changeNotes`; casos de teste verdes — US-200), calcula o `expressionHash`, marca a versão `PUBLISHED`, aposenta a anterior, atualiza `currentPublishedVersionId`, audita `rule.version_publish`, grava `RuleVersionPublished` (e `RuleVersionRetired` da anterior) no outbox e responde 200.
8. Para editar uma regra publicada, o administrador clica em "Nova versão": RUL-06 cria o rascunho copiando expressão, severidade, mensagem, `contextVersion` e casos de teste da versão publicada vigente. Os workflows já publicados continuam na versão anterior (US-195).
9. Para tirar uma versão de uso, "Aposentar" chama RUL-10; a versão fica `RETIRED` e deixa de ser oferecida a novos usos.

## Fluxos alternativos
- **FA-01 — Editar só os metadados:** nome, descrição, etiquetas e situação (ativa/inativa) mudam por RUL-04 com `If-Match`, sem criar versão; a `key` e o `kind` são imutáveis.
- **FA-02 — Inativar a regra:** `isActive = false` retira a regra do seletor de novos usos (US-195); usos já publicados continuam; o rascunho pode ser editado e publicado, mas a regra só volta ao seletor ao reativar.
- **FA-03 — Já existe rascunho:** RUL-06 responde 409 `RULE_DRAFT_EXISTS` com o `draftVersionId`; a tela leva o administrador ao rascunho aberto (há no máximo um rascunho por regra).
- **FA-04 — Caminho desconhecido no rascunho:** como em RN-WF-56, salvar o rascunho aceita um caminho fora do schema com `validation.warnings[]` (`RULE_PATH_UNKNOWN`); a publicação o recusa como erro.
- **FA-05 — Regra em contexto v1:** o administrador pode fixar `contextVersion = 1` no rascunho para escrever sobre o `RuleContext` v1 (só caminhos da v1); `contextVersion = 2` é o padrão. Trocar o valor revalida os caminhos.
- **FA-06 — Aposentar a versão vigente sem sucessora:** `currentPublishedVersionId` fica nulo; a regra deixa de ser oferecida a novos usos até uma nova publicação, e os usos existentes continuam na versão fixada.
- **FA-07 — Modelo do sistema:** regra `isSystem` aparece com o selo "Modelo do sistema", somente leitura; as ações de edição ficam ocultas e a API responde 409 `RULE_SYSTEM_READONLY` (cópia na US-196).
- **FA-08 — Leitura sem edição:** perfis só com `RULE_VIEW` (Controle interno, Auditor) abrem listagem, regra, versões e expressão em modo leitura; o simulador (US-199) fica disponível.
- **FA-09 — Publicação recusada:** com `validation.errors[]` ou *gate* de testes vermelho (US-200), nada muda; a tela lista os erros por campo e mantém o rascunho.

## Regras de negócio
- **RN-RULE-01** — `RuleDefinition` é do tenant: `key` em SCREAMING_SNAKE (`^[A-Z][A-Z0-9_]{1,59}$`), imutável, única por tenant; `name` de 3 a 150 caracteres, único por tenant sem diferenciar maiúsculas; a `key` é definida no cadastro e nunca muda, o `name` pode ser editado (DEC-204, entities.md §4.8).
- **RN-RULE-02** — O `kind` (`VALIDATION`, `ROUTING`, `APPROVAL_THRESHOLD`, `SLA`, `NOTIFICATION`) define onde a regra pode ser usada, é escolhido no cadastro e é imutável: mudar de tipo exige nova regra. Na publicação do workflow, `LIBRARY` exige versão cujo `kind` combine com o uso (entities.md §7.1; US-195).
- **RN-RULE-03** — Toda `RuleDefinition` nasce com a versão 1 em `DRAFT`; há no máximo um `DRAFT` por regra (unique parcial) e `versionNumber` cresce de 1 em 1 sem lacunas.
- **RN-RULE-04** — A versão `PUBLISHED` ou `RETIRED` é imutável e nunca excluída (trigger de banco, como em `WorkflowVersion`); não existe exclusão de regra com versão publicada: usa-se inativar. Editar uma regra publicada cria nova versão (RUL-06).
- **RN-RULE-05** — A expressão é JSON Logic avaliada pelo **mesmo executor com *allowlist*** da ADR-008: operador fora da lista é recusado **ao salvar** (`RULE_OPERATOR_FORBIDDEN`), nunca há `eval`, código arbitrário ou acesso direto ao banco, e o tamanho/profundidade respeitam o limite do executor (`RULE_EXPRESSION_TOO_LARGE`).
- **RN-RULE-06** — Só são válidos os caminhos do schema do `contextVersion` da versão (v1: `process.*`, `documents.<TYPE>.*`, `priceResearch.*`, `risks.*`, `stage.*`, `now`; v2: superset com `stages.active[]`, `pca.*`, `budget.*`, `legalReview.*`, `internalControl.*`, `tender.*`, `sla.*`). No rascunho, caminho desconhecido é aviso; na publicação, erro (`RULE_PATH_UNKNOWN`).
- **RN-RULE-07** — Cada versão grava `contextVersion` (1 ou 2, padrão 2). O montador de contexto entrega a versão pedida; regras v1 seguem avaliadas com o contexto v1 e nada quebra (DEC-204, ADR-015).
- **RN-RULE-08** — `VALIDATION` exige `severity` (`BLOCKING` ou `WARNING`) e `message` de até 500 caracteres; nos demais tipos `severity` e `message` não se aplicam e são recusados (`NOT_ALLOWED`). Avisos `WARNING` seguem a regra do MVP 1 (reconhecimento explícito, DEC-016).
- **RN-RULE-09** — O resultado da expressão é booleano em todos os tipos; em `APPROVAL_THRESHOLD` também é aceita a forma textual (política `ANY`/`ALL`/`SEQUENTIAL` ou rótulo de aprovador), conforme entities.md §7.3 (detalhe nas US-198 e US-200). Resultado de outro tipo é `RULE_RESULT_TYPE_INVALID`.
- **RN-RULE-10** — Publicar (RUL-09) exige: `RULE_PUBLISH`; versão em `DRAFT`; expressão válida e não constante (referencia ao menos um caminho do contexto); avaliação com o contexto neutro do schema sem erro; `changeNotes` (1 a 2.000 caracteres) a partir da v2; e os *gates* de teste da US-200 (todos os casos verdes na expressão atual; mínimo de 1 caso em `ROUTING` e `APPROVAL_THRESHOLD`).
- **RN-RULE-11** — Ao publicar: grava `expressionHash` (SHA-256 da forma canônica JCS/RFC 8785 de `{ contextVersion, expression }`), `publishedAt`, `publishedById`; define `status = PUBLISHED`; aposenta a versão `PUBLISHED` anterior (`RETIRED`) e atualiza `currentPublishedVersionId` — tudo na mesma transação (DEC-204, entities.md §6.9).
- **RN-RULE-12** — Publicar emite `RuleVersionPublished` (`rule.version_published`) e, para a versão aposentada por substituição, `RuleVersionRetired` (`rule.version_retired`); aposentar (RUL-10) emite `RuleVersionRetired`; ambos são auditados (`rule.version_publish`, `rule.version_retire`) e gravados no outbox na mesma transação.
- **RN-RULE-13** — Aposentar (RUL-10) só aceita versão `PUBLISHED`; a versão `RETIRED` deixa de ser oferecida a novos usos, e os usos publicados continuam na versão fixada. Se era a vigente, `currentPublishedVersionId` fica nulo (DEC-204, ADR-015).
- **RN-RULE-14** — Regra inativa (`isActive = false`) e regra sem versão vigente não são oferecidas a novos usos; os usos publicados continuam (DEC-204).
- **RN-RULE-15** — Modelos `isSystem` não são editáveis nem excluíveis: RUL-04, RUL-06 e RUL-08 respondem 409 `RULE_SYSTEM_READONLY`; o tenant trabalha em cópia (US-196).
- **RN-RULE-16** — Criar nova versão (RUL-06) copia expressão, `contextVersion`, `severity`, `message` e `testCases` da versão `PUBLISHED` vigente (ou da mais recente `RETIRED`, se não houver vigente); `testRunHash` e `expressionHash` ficam nulos e `changeNotes` é preenchido pelo administrador.
- **RN-RULE-17** — O editor só oferece campos do schema (WF-19 estendido): `GET /rule-context/schema` aceita `version=1|2` (padrão 1, compatível com o MVP 1), exige `WORKFLOW_VIEW` **ou** `RULE_VIEW`, devolve `confidential` por campo (valores de orçamento sigiloso, POL-09) e só lista namespaces cujo provedor está registrado (US-129).
- **RN-RULE-18** — Metadados (RUL-04) e rascunho (RUL-08) usam `If-Match` (`version`); publicar e aposentar também. Criações (RUL-02, RUL-06) usam `Idempotency-Key` (mesma chave e corpo em 24 h devolvem a mesma resposta).
- **RN-RULE-19** — Listagem (RUL-01): filtros `kind`, `tag`, `isActive`, `isSystem`, `hasPublishedVersion`, `q` (nome ou chave, ≥ 2 caracteres), paginação padrão (api.md §1.2) e ordem por nome; resposta traz o resumo da versão vigente e do rascunho, sem a expressão.
- **RN-RULE-20** — A biblioteca é isolada por tenant (RLS): nenhuma regra, versão ou schema vaza entre tenants; recursos de outro tenant respondem 404 `NOT_FOUND`.
- **RN-RULE-21** — Etiquetas: até 40 caracteres cada, em minúsculas sem acento normalizadas pela API, sem repetição por regra; o filtro por etiqueta é exato (limite de quantidade por regra: ver Lacunas, L-04).
- **RN-RULE-22** — Publicar uma versão `ROUTING` ou `APPROVAL_THRESHOLD` exibe, antes da confirmação, a sugestão não bloqueante de revisão por especialista do órgão ("Esta regra altera o caminho do processo. Peça a revisão de quem conhece o ato normativo do órgão antes de publicar") — mitigação do risco da ADR-015.
- **RN-RULE-23** — A API nunca devolve valor de orçamento sigiloso em mensagem, auditoria ou evento de regra: a biblioteca guarda somente a expressão e a configuração; valores de processo só existem na simulação (US-199) e na avaliação em execução (US-197 e US-198).
- **RN-RULE-24** — Toda ação de configuração é auditada em `CONFIGURATION` com `changes` dos metadados e `metadata` com `ruleDefinitionId`, `versionNumber` e `expressionHash`; o conteúdo da expressão fica na própria versão imutável, não duplicado no log.
- **RN-RULE-25** — Os usos de regra por outros módulos (`SlaPolicy`, `NotificationRule`, `InternalControlChecklist`) leem a mesma biblioteca por `RuleRef`; esta story não cria nenhum desses usos, mas garante que a versão referenciada nunca desapareça (RN-RULE-04) e que o `kind` seja consultável para a validação deles.

Regras do MVP 1 que se aplicam, sem renumerar: **RN-WF-56** (caminho desconhecido aceito no rascunho e recusado na publicação), **RN-WF-58** (executor compartilhado com *allowlist*), **RN-WF-60** (severidade padrão e mensagem), **RN-WF-63/64** (notas obrigatórias a partir da v2; hash canônico na publicação) e **RN-WF-65** (imutabilidade após publicar).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Chave | `key` | texto | Sim (criação) | SCREAMING_SNAKE, 2–60 caracteres, imutável, única no tenant | — |
| Nome | `name` | texto | Sim | 3–150 caracteres; único por tenant sem diferenciar maiúsculas | — |
| Descrição | `description` | texto longo | Não | até 2.000 caracteres | — |
| Tipo | `kind` | lista (`RuleDefinitionKind`) | Sim (criação) | `VALIDATION`, `ROUTING`, `APPROVAL_THRESHOLD`, `SLA`, `NOTIFICATION`; imutável | — |
| Etiquetas | `tags` | lista de texto | Não | cada uma até 40 caracteres, sem repetição | `[]` |
| Ativa | `isActive` | interruptor | Não | inativa não é oferecida a novos usos | `true` |
| *(sistema)* Modelo do sistema | `isSystem` | booleano | — | somente leitura | `false` |
| *(sistema)* Versão vigente | `currentPublishedVersionId` | uuid | — | atualizado na publicação | nulo |
| Versão do contexto | `contextVersion` | lista (1, 2) | Sim | define os caminhos válidos | `2` |
| Expressão | `expression` | JSON Logic | Sim | *allowlist* da ADR-008; só caminhos do `contextVersion`; resultado booleano (ou textual em `APPROVAL_THRESHOLD`) | `true` (rascunho inicial) |
| Severidade | `severity` | lista (`RuleSeverity`) | Condicional (`VALIDATION`) | `BLOCKING` ou `WARNING`; recusada nos demais tipos | `BLOCKING` |
| Mensagem ao usuário | `message` | texto | Condicional (`VALIDATION`) | até 500 caracteres; sem dados sigilosos | — |
| Notas da alteração | `changeNotes` | texto longo | Condicional (publicar a partir da v2) | 1–2.000 caracteres | — |
| *(sistema)* Número da versão | `versionNumber` | inteiro | — | 1..n, sem lacunas | calculado |
| *(sistema)* Situação da versão | `status` | `RuleVersionStatus` | — | `DRAFT`, `PUBLISHED`, `RETIRED` | `DRAFT` |
| *(sistema)* Hash da expressão | `expressionHash` | texto (64) | — | SHA-256 canônico na publicação | nulo até publicar |
| *(sistema)* Hash da última execução verde | `testRunHash` | texto (64) | — | preenchido pela US-200 | nulo |
| *(sistema)* Publicação | `publishedAt`, `publishedById` | data/uuid | — | gravados ao publicar | — |
| *(sistema)* Concorrência | `version` (ETag) | inteiro | — | `If-Match` em PATCH e ações | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `key`, `name`, `kind` ausentes ou fora do formato | Front + API (Zod) | "Informe uma chave em MAIÚSCULAS com letras, números e _ (até 60 caracteres)." / "Informe o nome da regra (3 a 150 caracteres)." | `VALIDATION_ERROR` |
| V-02 | `key` ou `name` já usados no tenant | API | "Já existe uma regra com esta chave ou nome. Escolha outro." | `CONFLICT` |
| V-03 | `severity` ausente em `VALIDATION`, ou `severity`/`message` informadas em outro tipo | Front + API | "Regras de validação precisam de severidade e mensagem." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`NOT_ALLOWED`) |
| V-04 | `message` acima de 500 caracteres | Front + API | "A mensagem deve ter até 500 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-05 | Operador fora da *allowlist* | API | "Esta condição usa um operador não permitido." | `RULE_INVALID` (`RULE_OPERATOR_FORBIDDEN`) |
| V-06 | Expressão grande ou profunda demais | API | "A condição está grande demais. Divida em mais de uma regra." | `RULE_INVALID` (`RULE_EXPRESSION_TOO_LARGE`) |
| V-07 | Caminho fora do schema do `contextVersion` (aviso no rascunho; erro ao publicar) | API | "O campo {caminho} não existe nesta versão do contexto." | `RULE_INVALID` (`RULE_PATH_UNKNOWN`) |
| V-08 | Expressão constante na publicação | API | "A condição não usa nenhum campo do processo. Ajuste antes de publicar." | `RULE_INVALID` (`EXPRESSION_CONSTANT`) |
| V-09 | Resultado fora do tipo esperado ou erro ao avaliar com o contexto neutro | API | "A condição não devolve verdadeiro ou falso. Revise a expressão." | `RULE_INVALID` (`RULE_RESULT_TYPE_INVALID`/`RULE_EVALUATION_FAILED`) |
| V-10 | `changeNotes` ausente a partir da v2 | Front + API | "Descreva o que mudou nesta versão." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-11 | Editar versão que não está em `DRAFT` | API | "Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão." | `RULE_VERSION_NOT_DRAFT` |
| V-12 | Criar rascunho com outro já aberto | API | "Já existe um rascunho desta regra. Continue a edição dele." | `RULE_DRAFT_EXISTS` |
| V-13 | Editar ou versionar modelo do sistema | API | "Modelos do sistema não podem ser alterados. Copie o modelo para adaptá-lo." | `RULE_SYSTEM_READONLY` |
| V-14 | Publicar versão que não é `DRAFT`; aposentar versão que não é `PUBLISHED` | API | "A versão não está mais neste estado. Atualize a página." | `INVALID_STATE` |
| V-15 | `If-Match` ausente ou divergente | API | "Os dados foram alterados por outra pessoa. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-16 | `contextVersion` fora de 1 ou 2 | API | "Selecione a versão do contexto: 1 ou 2." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `RULE_VIEW` (risco L) para listar, ler regras, versões e o schema; `RULE_MANAGE` (risco M) para criar regra, editar metadados e rascunhos e criar nova versão; `RULE_PUBLISH` (risco H) para publicar e aposentar. Nenhuma é escopável.
- **Políticas:** POL-27 (publicar versão exige os casos de teste verdes; ver US-200). POL-14 para a publicação (`HIGH`).
- **MFA:** `RULE_PUBLISH` é `HIGH`: com `security.mfaPolicy` `ADMINS` ou `ALL`, publicar e aposentar exigem sessão com MFA (`MFA_REQUIRED`, 403). Criar e editar rascunho (risco `M`) não exigem MFA, salvo `ALL`.
- **Matriz padrão:** `RULE_VIEW` em `ADMIN_ORGAO`, `GESTOR_CONTRATACOES`, `CONTROLE_INTERNO` e `AUDITOR`; `RULE_MANAGE` em `ADMIN_ORGAO` e `GESTOR_CONTRATACOES`; `RULE_PUBLISH` só em `ADMIN_ORGAO` (permissions.md §3).
- **Sem permissão:** o item "Regras" do menu exige `RULE_VIEW`; sem ela, a rota responde com a página 403 e a API 403 `PERMISSION_DENIED` com auditoria `access.denied`. Sem `RULE_MANAGE`, os botões de criar/editar ficam ocultos; sem `RULE_PUBLISH`, "Publicar" e "Aposentar" ficam ocultos e a API recusa.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `RuleVersionPublished` | `rule.version_published` | Commit de RUL-09 | Payload: `ruleDefinitionId`, `key`, `kind`, `ruleDefinitionVersionId`, `versionNumber`, `contextVersion`, `expressionHash`; consumidor `C` (cache de configuração); sem a expressão e sem valores |
| `RuleVersionRetired` | `rule.version_retired` | Commit de RUL-10, e na publicação que aposenta a versão anterior | Payload: `ruleDefinitionId`, `ruleDefinitionVersionId`; consumidor `C` |

Criar regra, editar metadados e rascunhos e criar versão não geram evento de domínio (edição de configuração em rascunho, como WF-10 a WF-18): apenas auditoria.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. A biblioteca é configuração: publicar e aposentar ficam na auditoria e no evento; não há notificação nem entrada na timeline de processo (events.md §8 não prevê). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Biblioteca de regras reutilizáveis com versões

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (RULE_VIEW, RULE_MANAGE, RULE_PUBLISH)
    And "Rafael" tem vínculo ativo com o perfil "GESTOR_CONTRATACOES" (RULE_VIEW, RULE_MANAGE)
    And "Paulo" tem vínculo ativo com o perfil "CONTROLE_INTERNO" (RULE_VIEW)
    And "Bruno" tem vínculo ativo com o perfil "PLANEJAMENTO" sem nenhuma permissão "RULE_*"

  Scenario: [Sucesso] Criar regra com a versão 1 em rascunho
    When "Marina" criar a regra "COBERTURA_DO_ORGAO" do tipo "VALIDATION" com o nome "Cobertura da dotação" e a etiqueta "orcamento"
    Then a API deve responder 201 com a regra ativa, "isSystem" falso e "draftVersion" de número 1
    And a versão 1 deve ter status "DRAFT" e "contextVersion" 2
    And deve gerar registro de auditoria "rule.create"
    And não deve gerar evento de domínio

  Scenario: [Sucesso] Salvar o rascunho com expressão válida do contexto v2
    Given que a regra "COBERTURA_DO_ORGAO" tem o rascunho da versão 1
    When "Marina" salvar a expressão "budget.coverageRatio >= 1" com severidade "BLOCKING" e a mensagem "A dotação não cobre o valor estimado."
    Then a API deve responder 200 com "validation.errors" vazio
    And deve gerar registro de auditoria "rule.update"

  Scenario: [Sucesso] Publicar a versão 1
    Given que o rascunho da versão 1 de "COBERTURA_DO_ORGAO" tem a expressão válida
    When "Marina" publicar a versão 1 com o "If-Match" atual
    Then a API deve responder 200 com status "PUBLISHED" e "expressionHash" de 64 caracteres
    And "currentPublishedVersionId" da regra deve apontar para a versão 1
    And deve gerar registro de auditoria "rule.version_publish"
    And deve gerar o evento "RuleVersionPublished" com "versionNumber" 1 e "contextVersion" 2

  Scenario: [Sucesso] Publicar a versão 2 aposenta a versão 1
    Given que a versão 1 de "COBERTURA_DO_ORGAO" está "PUBLISHED"
    When "Marina" criar a versão 2, trocar o limite para "budget.coverageRatio >= 0.95" e publicar com as notas "Tolerância de 5% na cobertura"
    Then a versão 1 deve ficar "RETIRED" e a versão 2 "PUBLISHED"
    And deve gerar registro de auditoria "rule.version_publish" para a versão 2 e "rule.version_retire" para a versão 1
    And deve gerar os eventos "RuleVersionPublished" (versão 2) e "RuleVersionRetired" (versão 1)

  Scenario: [Sucesso] Aposentar a versão vigente
    Given que a versão 2 de "COBERTURA_DO_ORGAO" é a vigente
    When "Marina" aposentar a versão 2
    Then a versão deve ficar "RETIRED" e "currentPublishedVersionId" deve ficar nulo
    And a regra não deve ser oferecida a novos usos
    And deve gerar registro de auditoria "rule.version_retire" e o evento "RuleVersionRetired"

  Scenario: [Sucesso] Rascunho copia a última versão e o schema oferece os namespaces da v2
    Given que a versão 2 de "COBERTURA_DO_ORGAO" está "PUBLISHED" com 2 casos de teste
    When "Marina" criar uma nova versão e consultar o schema do contexto com "version=2"
    Then o rascunho da versão 3 deve ter a mesma expressão, "contextVersion" e os 2 casos, com "testRunHash" nulo
    And o schema deve listar os campos "budget.coverageRatio" e "legalReview.concluded"
    And o campo "process.estimatedValue" deve vir marcado como "confidential"
    And deve gerar registro de auditoria "rule.version_create" e nenhum evento

  Scenario: [Validação] Operador fora da allowlist e publicação sem notas
    When "Marina" tentar salvar uma expressão com o operador "eval"
    Then a API deve responder 422 com código "RULE_INVALID" e erro "RULE_OPERATOR_FORBIDDEN"
    Given que a regra tem a versão 2 em rascunho
    When "Marina" publicar a versão 2 sem "changeNotes"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "changeNotes"
    And a versão 2 deve continuar "DRAFT"

  Scenario: [Validação] Tipo exige severidade, caminho desconhecido e expressão constante
    When "Marina" criar a regra "CI_VALOR" do tipo "ROUTING" com severidade "BLOCKING"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "severity"
    Given que o rascunho usa o campo "process.valorEstimado"
    Then salvar deve devolver o aviso "RULE_PATH_UNKNOWN"
    And publicar deve responder 422 com código "RULE_INVALID" e erro "RULE_PATH_UNKNOWN"
    Given que o rascunho tem a expressão constante "true"
    When "Marina" publicar
    Then a API deve responder 422 com erro "EXPRESSION_CONSTANT"

  Scenario: [Permissão] Gestor não publica e usuário sem permissão não lê
    When "Rafael" tentar publicar a versão 1 de "COBERTURA_DO_ORGAO"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Bruno" consultar a lista de regras
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    When "Paulo" tentar criar uma regra
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que o tenant exige MFA para administradores e a sessão de "Marina" não tem MFA
    When "Marina" publicar a versão 1
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Regra de outro tenant
    Given que existe a regra "CI_ACIMA_DE_VALOR" no tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", consultar essa regra, listar suas versões e tentar publicá-la
    Then cada chamada deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado
    And a lista de regras de "Marina" não deve conter regras do tenant "Prefeitura B"

  Scenario: [Duplicidade] Chave repetida e reenvio idempotente
    Given que a regra "COBERTURA_DO_ORGAO" já existe
    When "Marina" criar outra regra com a chave "COBERTURA_DO_ORGAO"
    Then a API deve responder 409 com código "CONFLICT"
    When "Marina" reenviar a mesma criação de "LIMITE_ALCADA" com a mesma "Idempotency-Key" e o mesmo corpo
    Then a API deve responder com a mesma resposta e o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir uma só regra "LIMITE_ALCADA" e uma só auditoria "rule.create" para ela
    When "Marina" criar uma nova versão com um rascunho já aberto
    Then a API deve responder 409 com código "RULE_DRAFT_EXISTS"

  Scenario: [Concorrência] Duas publicações simultâneas da mesma versão
    Given que "Marina" e outro administrador abriram a versão 3 em rascunho com o mesmo "If-Match"
    When os dois publicarem ao mesmo tempo
    Then uma publicação deve responder 200 e a outra 412 com código "VERSION_CONFLICT"
    And deve existir uma única auditoria "rule.version_publish" e um único evento "RuleVersionPublished" para a versão 3
    And a versão anterior deve ter sido aposentada uma única vez

  Scenario: [Concorrência] Edição do rascunho sobre dados desatualizados
    Given que "Marina" carregou o rascunho na "version" 4
    When "Rafael" salvar o rascunho gerando a "version" 5
    And "Marina" salvar com "If-Match" da "version" 4
    Then a API deve responder 412 com código "VERSION_CONFLICT" e devolver a versão atual em "meta.current"

  Scenario: [Falha de banco] Banco indisponível na publicação
    Given que o banco de dados fica indisponível durante a transação de publicação
    When "Marina" publicar a versão 1
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a versão deve continuar "DRAFT", sem "expressionHash", sem auditoria e sem evento

  Scenario: [Falha de integração] Relay do outbox indisponível na publicação
    Given que o relay do outbox está indisponível
    When "Marina" publicar a versão 1 com sucesso
    Then a API deve responder 200
    And o evento "RuleVersionPublished" deve permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Falha de integração] Cache de configuração indisponível ao consultar o schema
    Given que o Redis está indisponível
    When "Marina" consultar o schema do contexto com "version=2"
    Then a API deve responder 200 com o schema montado sem cache
    And deve registrar o aviso "rule_context.cache_unavailable" no log
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (campos, tamanhos, tipo × severidade) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca cada campo; mantém o formulário |
| Expressão inválida (operador, caminho, tamanho, resultado, constante) | 422 | `RULE_INVALID` | "A condição tem problemas. Corrija os itens abaixo antes de publicar." | Lista `validation.errors[]` ao lado do editor, com o nó da expressão |
| Chave ou nome já usados | 409 | `CONFLICT` | "Já existe uma regra com esta chave ou nome. Escolha outro." | Marca o campo |
| Rascunho já existe | 409 | `RULE_DRAFT_EXISTS` | "Já existe um rascunho desta regra. Continue a edição dele." | Botão "Abrir rascunho" |
| Versão não é rascunho | 409 | `RULE_VERSION_NOT_DRAFT` | "Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão." | Oferece "Nova versão" |
| Modelo do sistema | 409 | `RULE_SYSTEM_READONLY` | "Modelos do sistema não podem ser alterados. Copie o modelo para adaptá-lo." | Oculta edição; oferece "Copiar modelo" |
| Estado da versão inválido para a ação | 409 | `INVALID_STATE` | "A versão não está mais neste estado. Atualize a página." | Recarrega a versão |
| Casos de teste vermelhos (gate da US-200) | 422 | `RULE_TESTS_FAILING` | "Há casos de teste que não passam. Corrija a regra ou os casos." | Abre a aba de testes com o diff |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta botões; página 403 na rota |
| MFA exigida | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para publicar." | Abre o passo de MFA e repete a ação |
| Regra ou versão inexistente / outro tenant | 404 | `NOT_FOUND` | "Regra não encontrada." | Volta à lista |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Os dados foram alterados por outra pessoa. Recarregue e tente novamente." | Recarrega e mostra o que mudou |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega |
| Chave de idempotência reutilizada com outro corpo | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta operação já foi enviada com outros dados. Recarregue a tela." | Recarrega |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém a tela; botão "Tentar novamente" |

Subcódigos de `RULE_INVALID` (campo `validation.errors[].code`): `RULE_OPERATOR_FORBIDDEN`, `RULE_EXPRESSION_TOO_LARGE`, `RULE_PATH_UNKNOWN`, `EXPRESSION_CONSTANT`, `RULE_RESULT_TYPE_INVALID`, `RULE_EVALUATION_FAILED`, `RULE_CONTEXT_VERSION_INVALID`.

## Dependências
- **Stories:** US-044 (regras de etapa e de transição do MVP 1: `ConditionBuilder`, WF-19, executor com *allowlist*); US-129 (`RuleContext` v2: contrato e provedores). Habilita US-195 (usar a biblioteca nos workflows), US-196 (modelos), US-199 (simulador) e US-200 (casos de teste e *gate* de publicação). Indiretas: US-043/US-045 (editor e publicação do workflow, que passam a consumir a biblioteca).
- **Decisões/ADRs:** DEC-204, DEC-016, DEC-014, DEC-084 (hash canônico), DEC-108 (mudanças aditivas), ADR-015, ADR-008; POL-27, POL-14.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **L-01 — Subcódigos de erro da biblioteca** (`RULE_INVALID` e `validation.errors[].code`, `RULE_DRAFT_EXISTS`, `RULE_VERSION_NOT_DRAFT`, `RULE_SYSTEM_READONLY`): não estão em api.md; propostos aqui, a consolidar no catálogo do card 9.
  2. **L-02 — Ações de auditoria**: `rule.create`, `rule.update`, `rule.version_create`, `rule.version_publish` e `rule.version_retire` já existem em events.md §7; falta definir se a substituição por nova publicação registra `rule.version_retire` própria (aqui: sim, com `metadata.reason = SUPERSEDED`).
  3. **L-03 — `expressionHash`**: entities.md diz "SHA-256 canônico"; aqui o hash cobre `{ contextVersion, expression }` (JCS) para que a mesma expressão em contextos diferentes não colida. Confirmar.
  4. **L-04 — Limites sem valor definido**: quantidade máxima de etiquetas por regra, tamanho e profundidade máximos da expressão e limite de tempo de avaliação do executor (ADR-008 não fixa). Aqui se usa "o limite do executor"; a definir no `api.md` do MVP 2.
  5. **L-05 — Filtro `GET /rules`**: filtros `hasPublishedVersion` e `isSystem` não aparecem na feature; adicionados por necessidade do seletor (US-195) e da aba de modelos (US-196).
  6. **L-06 — Imutabilidade do `kind`**: entities.md não diz se o `kind` pode mudar; aqui é imutável (os usos validam o tipo).

## Impacto técnico
- **Compatibilidade:** campos e parâmetros novos são aditivos (DEC-108): WF-19 mantém o padrão `version=1` quando o parâmetro não vem; nenhuma rota do MVP 1 muda. As regras `WorkflowRule` do MVP 1 continuam avaliadas com o contexto v1 sem migração.
- **Executor único:** a validação da *allowlist* roda na API (ao salvar e ao publicar) e no avaliador de execução; um teste de paridade garante que o validador e o executor usam a mesma lista. Nunca há `eval`; a expressão é dado.
- **Imutabilidade:** triggers de banco bloqueiam `UPDATE` e `DELETE` em versões `PUBLISHED`/`RETIRED` (exceção apenas à transição `PUBLISHED → RETIRED`, que só altera `status`), como na `WorkflowVersion`.
- **Ordem de publicação:** `PublishGate` executa em sequência (1) forma e *allowlist*, (2) caminhos do contexto, (3) avaliação com o contexto neutro, (4) `changeNotes`, (5) casos de teste (US-200). Até a US-200 estar entregue, as versões `ROUTING` e `APPROVAL_THRESHOLD` não devem ser publicadas em produção; os módulos consumidores (US-195, US-197, US-198) dependem dela.
- **Performance:** a listagem não carrega a expressão; o schema do contexto é cacheado por `contextVersion` e pelo conjunto de provedores registrados (Redis, com *fallback* sem cache).
- **Migração:** M2-09 (`rule_definitions`, `rule_definition_versions`) antes de `sla` e `notification` (entities.md §10).

## Backend
- **Módulo(s):** `rules` (dono), `workflow` (WF-19 estendido, validador compartilhado), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `CreateRuleCommand`, `UpdateRuleMetadataCommand`, `CreateRuleVersionCommand`, `UpdateRuleDraftCommand`, `PublishRuleVersionCommand` (com `PublishGate[]`), `RetireRuleVersionCommand`; `ListRulesQuery`, `GetRuleQuery`, `ListRuleVersionsQuery`, `GetRuleVersionQuery`, `GetRuleContextSchemaQuery` (v1 e v2).
- **Domínio:** agregado `RuleDefinition` (versões, regra de um rascunho), `RuleDefinitionVersion` (máquina de estados `DRAFT → PUBLISHED → RETIRED`), `RuleExpressionValidator` (*allowlist*, caminhos, tamanho, avaliação neutra), `ExpressionHasher` (JCS + SHA-256), `RuleContextSchemaProvider` (contribuições por módulo, US-129).
- **Integrações internas:** `RuleContextContributor` de cada módulo (apenas o schema), `AuthorizationService.assertCan(RULE_*)`, `AuditService`, `OutboxWriter`.
- **Transação:** criação, rascunho, publicação e aposentadoria são atômicas com `app.tenant_id`: bloqueio da `RuleDefinition` (`FOR UPDATE`) → conferência de `If-Match` e estado → validação → gravação da versão, da anterior e do ponteiro → auditoria → outbox → commit.

## Frontend
- **Tela(s):** SCR-035 (`/admin/regras`, `/admin/regras/[ruleId]`); a aba "Regras" do editor de workflow (SCR-034/MVP 1) permanece para regras locais.
- **Componentes:** `RuleLibraryList` (modelo `ListPage`, filtros de tipo/etiqueta/situação, busca), `RuleForm` (metadados), `RuleKindBadge`, `RuleVersionTimeline` (versões com estado e notas), `RuleExpressionEditor` (reusa o `ConditionBuilder` do MVP 1 com os campos de WF-19 v2, edição em JSON como alternativa e painel `validation.errors/warnings`), `PublishRuleDialog` (notas, aviso de revisão por especialista, resumo do impacto), `RetireRuleDialog`, abas "Expressão", "Versões", "Usos" (US-195), "Simulador" (US-199) e "Casos de teste" (US-200).
- **Estados:** carregando (skeleton), vazio ("Nenhuma regra ainda. Crie uma ou copie um modelo"), erro ("Tentar novamente"), sem permissão (ações ocultas), conflito de edição (recarrega), rascunho × publicado (campos bloqueados com selo), regra inativa.
- **Acessibilidade e responsividade:** o editor navegável por teclado; erros de validação anunciados por `aria-live`; estado da versão comunicado por texto e ícone, nunca só por cor; contraste 4,5:1 nos dois temas; lista em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `rule_definitions`, `rule_definition_versions` (entities.md §4.8); `audit_logs` e `outbox_events` (existentes).
- **Migrações:** M2-09 (expand, reversível): criação das duas tabelas com `tenant_id`, `UNIQUE (tenant_id, id)`, FKs compostas, RLS `ENABLE`/`FORCE`, *grants* de `cf_app` e `cf_worker`; trigger de imutabilidade das versões `PUBLISHED`/`RETIRED`; entrada nas suítes de tenant leak e autorização.
- **Índices/constraints relevantes:** unique `(tenant_id, key)` e `(tenant_id, lower(name))` em `rule_definitions`; unique `(tenant_id, rule_definition_id, version_number)` e unique parcial `(tenant_id, rule_definition_id) WHERE status = 'DRAFT'` em `rule_definition_versions`; índice `(tenant_id, kind, is_active)` para a listagem; FK `current_published_version_id` composta e adiável.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `RUL-01` | GET | `/rules` | query `kind`, `tag`, `isActive`, `isSystem`, `hasPublishedVersion`, `q`, `page`, `pageSize` | `200 { data: RuleDefinition[], meta }` (resumo de versão vigente e rascunho) | 200, 401, 403 |
| `RUL-02` | POST | `/rules` | `{ key, name, description?, kind, tags?, contextVersion?, expression?, severity?, message? }`; `Idempotency-Key` | `201 { data: RuleDefinition }` com `draftVersion` 1 | 201, 403, 409, 422, 503 |
| `RUL-03` | GET | `/rules/{id}` | — | `200 { data: RuleDefinition }` + `ETag` | 200, 403, 404 |
| `RUL-04` | PATCH | `/rules/{id}` | `{ name?, description?, tags?, isActive? }`; `If-Match` | `200 { data: RuleDefinition }` + `ETag` nova | 200, 403, 404, 409, 412, 422, 428 |
| `RUL-05` | GET | `/rules/{id}/versions` | paginação | `200 { data: RuleDefinitionVersion[] }` por `versionNumber` decrescente, sem a expressão | 200, 403, 404 |
| `RUL-06` | POST | `/rules/{id}/versions` | `{}`; `Idempotency-Key` | `201 { data: RuleDefinitionVersion }` (rascunho copiado da vigente) | 201, 403, 404, 409, 503 |
| `RUL-07` | GET | `/rule-versions/{versionId}` | — | `200 { data: RuleDefinitionVersion }` com `expression`, `testCases` e `validation` | 200, 403, 404 |
| `RUL-08` | PATCH | `/rule-versions/{versionId}` | `{ contextVersion?, expression?, severity?, message?, changeNotes? }`; `If-Match` | `200 { data: RuleDefinitionVersion, validation: { errors[], warnings[] } }` | 200, 403, 404, 409, 412, 422, 428 |
| `RUL-09` | POST | `/rule-versions/{versionId}/publish` | `{ changeNotes? }`; `If-Match` | `200 { data: RuleDefinitionVersion }` com `status = PUBLISHED`, `expressionHash`, `publishedAt` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `RUL-10` | POST | `/rule-versions/{versionId}/retire` | `{}`; `If-Match` | `200 { data: RuleDefinitionVersion }` com `status = RETIRED` | 200, 403, 404, 409, 412, 428 |
| `WF-19` | GET | `/rule-context/schema` | query `version` (1 ou 2, padrão 1) | `200 { data: { version, fields: [{ path, label, type, confidential, default }] } }` (aditivo; `RULE_VIEW` também autoriza) | 200, 403 |

## Logs
- `info` `rule.created`, `rule.version_published`, `rule.version_retired` — `ruleDefinitionId`, `kind`, `versionNumber`, `contextVersion`, `durationMs`, `correlationId`.
- `info` `rule.draft_saved` — `ruleDefinitionId`, `versionNumber`, `errorsCount`, `warningsCount`.
- `warn` `rule.publish_rejected` (códigos dos erros, sem a expressão), `rule.version_conflict`, `rule_context.cache_unavailable`.
- `error` `rule.publish_failed` — causa resumida e `correlationId`.
- **Nunca logar:** a expressão JSON Logic completa, valores de contexto, mensagens digitadas pelo administrador em texto livre e qualquer valor de orçamento sigiloso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `rule.create` | `CONFIGURATION` | RUL-02 | `metadata`: `ruleDefinitionId`, `key`, `kind`, `tags`; `changes`: campos criados |
| `rule.update` | `CONFIGURATION` | RUL-04 e RUL-08 | `changes`: antes/depois dos metadados; no rascunho, `metadata.section = EXPRESSION` e `expressionHash` provisório, sem a expressão |
| `rule.version_create` | `CONFIGURATION` | RUL-06 | `metadata`: `ruleDefinitionId`, `versionNumber`, `copiedFromVersionNumber` |
| `rule.version_publish` | `CONFIGURATION` | RUL-09 | `metadata`: `ruleDefinitionId`, `key`, `kind`, `versionNumber`, `contextVersion`, `expressionHash`, `changeNotes` |
| `rule.version_retire` | `CONFIGURATION` | RUL-10 e substituição na publicação | `metadata`: `ruleDefinitionId`, `versionNumber`, `reason` (`MANUAL` ou `SUPERSEDED`) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = permissão exigida |

## Testes necessários
- **Unitários:** `RuleExpressionValidator` (tabela de operadores permitidos e proibidos, caminhos v1 e v2, tamanho/profundidade, constante, tipo de resultado); `ExpressionHasher` (mesma expressão com chaves em outra ordem gera o mesmo hash; contextos diferentes, hashes diferentes); máquina de estados da versão; regra de um rascunho; normalização de etiquetas; severidade × tipo.
- **Integração (Testcontainers PostgreSQL):** criação com versão 1; publicação atômica (versão, anterior `RETIRED`, ponteiro, auditoria, outbox); triggers de imutabilidade (UPDATE/DELETE de versão publicada falham); uniques (chave, nome, rascunho único); RLS por tenant; aposentar a vigente zera o ponteiro.
- **API/contrato:** RUL-01 a RUL-10 e WF-19 conforme este card; cabeçalhos `Idempotency-Key` e `If-Match`; WF-19 sem `version` mantém a resposta do MVP 1 (regressão).
- **RBAC e multi-tenant:** matriz de perfis em `RULE_VIEW`/`RULE_MANAGE`/`RULE_PUBLISH` (teste de autorização gerado); MFA em publicar; recursos de outro tenant retornam 404 (suíte `test/tenant-leak`).
- **Concorrência:** duas publicações da mesma versão (uma 200, uma 412), publicar × editar rascunho, criar rascunho duplicado.
- **E2E (Playwright):** criar regra → montar condição → salvar → publicar → nova versão → publicar (a anterior aposenta) → aposentar; leitura por Controle interno; modelo do sistema sem edição.
- **Acessibilidade/performance:** axe sem violações sérias no editor e nos diálogos; listagem de 200 regras com resposta p95 abaixo da meta de leitura do api.md; 360 px.

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
- [ ] Teste de paridade entre o validador da *allowlist* e o executor de execução
- [ ] Triggers de imutabilidade das versões comprovados em teste de integração
- [ ] Regressão: WF-19 sem `version` e regras `WorkflowRule` do MVP 1 inalterados

## Estimativa
**L** — módulo novo com agregado versionado, máquina de estados, validador da *allowlist* e hash canônico, publicação atômica com eventos, extensão do schema para a v2 e uma tela nova (lista, formulário, editor, versões); a reutilização do `ConditionBuilder` e do padrão de versão do workflow reduz o risco, mas a superfície (10 endpoints + RLS, triggers e testes de segurança) justifica o porte.

## Prioridade
**P1** — a biblioteca é a base do épico: roteamento (US-197), alçadas (US-198), SLA (EP-030) e regras de notificação consomem `RuleRef` em modo `LIBRARY`; sem ela o MVP 2 não passa de regras copiadas dentro de cada workflow.
