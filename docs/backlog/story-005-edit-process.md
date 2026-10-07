---
id: US-005
title: "Editar dados do processo"
epic: EP-001
feature: FT-004
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-001]
modules: [process, catalog, organization, access, timeline, audit, platform]
screens: [SCR-006]
endpoints: [PRC-05, PRC-04, CAT-01, DEP-01, DEP-02, ORG-01]
permissions: [PROCESS_UPDATE, PROCESS_CREATE]
events: [ProcessUpdated]
---

# US-005 — Editar dados do processo

## Título
Editar os dados do processo

## Descrição
**Como** servidor que está com o processo (responsável atual ou membro da unidade atual), **quero** corrigir e completar os dados cadastrais do processo — título, objeto, tipo de contratação, modalidade prevista, prioridade, prazo alvo, valor estimado manual, origem, situação no PCA, código interno e observações —, **para** manter o processo fiel à demanda sem precisar recriá-lo.

A edição é feita no painel lateral **"Editar dados"** do detalhe (SCR-006). Cada campo obedece a uma política de bloqueio por status: unidade solicitante e órgão só mudam em rascunho; os demais campos mudam em rascunho, em andamento ou devolvido, sempre sob custódia (POL-01). A gravação é parcial (`PATCH`), com concorrência otimista (`If-Match`), e gera — na mesma transação — o evento `ProcessUpdated` com os nomes dos campos alterados, a entrada `PROCESS_UPDATED` na timeline e a auditoria `process.update` com o diff.

## Contexto
- Dados cadastrais mudam ao longo da fase preparatória (o objeto é refinado, a modalidade é definida, o prazo alvo é replanejado); recriar o processo perderia histórico e número.
- Regras de base: status só pelo ciclo de vida (DEC-013), versão do workflow imutável (DEC-014), custódia (DEC-023, POL-01), valor estimado por precedência de fonte (DEC-032), concorrência otimista (DEC-055/DEC-104), timeline × auditoria (DEC-025), campos imutáveis de `Process` (entities.md §4.4: `organizationId` e `requestingSecretariatId` imutáveis após sair de `DRAFT`).
- As regras de validação da criação (RN-PROC-01 a RN-PROC-18, US-001) continuam valendo para o estado resultante.

## Objetivo
Permitir a correção dos dados do processo em até 1 minuto, com 100% das alterações efetivas versionadas, auditadas com diff e refletidas na timeline, nenhuma alteração de campo bloqueado aceita pela API e nenhum conflito de edição concorrente perdido silenciosamente.

## Persona
- **Principal:** Área requisitante (`REQUISITANTE`) — com o processo em rascunho ou devolvido.
- **Secundárias:** Planejamento (`PLANEJAMENTO`), Compras (`COMPRAS`), Licitações (`LICITACOES`) e Gestor de contratações (`GESTOR_CONTRATACOES`), sempre que detiverem a custódia; Gestor de contrato (`GESTOR_CONTRATO`).

## Pré-condições
- Processo existente e visível (US-001, RN-PROC-19).
- Usuário com `PROCESS_UPDATE` em escopo que cubra o processo e custódia atual (POL-01).
- Processo em `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Catálogos e unidades ativos para os novos valores (US-104, US-102).

## Fluxo principal
1. No detalhe do processo (SCR-006), o usuário escolhe **"Editar dados"** (ação `EDIT` disponível em PRC-08).
2. O front abre o painel lateral com o formulário pré-preenchido a partir de `GET /processes/{id}` (PRC-04), guardando o `ETag` (ex.: `"8"`). Campos bloqueados pelo status aparecem somente leitura, com cadeado e a explicação (RN-PROC-60); o valor estimado aparece somente leitura quando houver fonte de maior precedência (RN-PROC-63).
3. O usuário altera os campos; o front valida com `updateProcessSchema` (Zod) e destaca os campos modificados.
4. O usuário clica em **"Salvar alterações"**. O front envia `PATCH /api/v1/processes/{id}` (PRC-05) somente com os campos alterados e `If-Match: "8"`.
5. A API, em uma transação com `app.tenant_id` e `SELECT … FOR UPDATE` no processo:
   1. valida o corpo (Zod `.strict()` — RN-PROC-65) e compara com o estado atual; sem diferença efetiva, encerra sem alterações (RN-PROC-67);
   2. confere `If-Match` × `version` (RN-PROC-66);
   3. autoriza `PROCESS_UPDATE` no escopo e POL-01 (custódia e status — RN-PROC-59);
   4. aplica a política de bloqueio por status (RN-PROC-60, RN-PROC-61) e as regras de valor estimado (RN-PROC-63), unidade solicitante (RN-PROC-62) e código interno (RN-PROC-70);
   5. revalida o estado resultante (RN-PROC-64);
   6. grava o processo (`version + 1`, `updatedAt`, `updatedById`), atualiza `ProcessAccess` se a unidade solicitante mudou;
   7. grava `AuditLog` `process.update` com o diff, o evento `ProcessUpdated` no outbox e — pelo projetor síncrono — a entrada `PROCESS_UPDATED` na timeline (RN-PROC-68);
   8. confirma a transação.
6. A API responde **200** com o processo atualizado e o novo `ETag` (`"9"`).
7. O front fecha o painel, exibe o toast "Dados do processo atualizados" e invalida as consultas do processo (detalhe, resumo, ações, timeline) e da lista.

## Fluxos alternativos
- **FA-01 — Campo bloqueado pelo status:** o campo aparece somente leitura com o texto "Definido na abertura. Não pode ser alterado depois do primeiro encaminhamento."; se a API receber a alteração, responde 422 `VALIDATION_ERROR` com `errors[].code = "NOT_ALLOWED"` no campo (api.md §2.1.1).
- **FA-02 — Processo em aprovação, suspenso ou finalizado:** a ação "Editar dados" aparece desabilitada com o motivo ("Não é possível editar enquanto o processo aguarda aprovação."); a API responde 409 `INVALID_PROCESS_STATUS`.
- **FA-03 — Valor estimado com fonte documental:** o campo mostra o valor (ou "Sigiloso", conforme POL-09) e "Valor obtido de {fonte} em {data}. Para alterá-lo, ajuste o documento de origem." (RN-PROC-63).
- **FA-04 — Troca da unidade solicitante em rascunho:** ao mudar secretaria/setor, o front recarrega as opções de setor (subárvore da secretaria) e avisa: "O DFD já criado não é alterado automaticamente; revise o campo Setor no DFD." e "O processo continua com {unidade atual} até ser encaminhado."
- **FA-05 — Conflito de edição (412):** o painel exibe "Este processo foi alterado por {usuário} às {hora}." com a comparação entre os valores atuais (`meta.current`) e os do usuário para cada campo em conflito; opções **"Reaplicar minhas alterações"** (novo PATCH com o `ETag` atual, apenas para campos não alterados pelo outro) e **"Descartar e recarregar"**.
- **FA-06 — Perda de custódia durante a edição:** se o processo for encaminhado ou reatribuído enquanto o painel está aberto, o salvamento retorna 403 `NOT_PROCESS_CUSTODIAN` (ou 412) e o painel informa "O processo saiu da sua responsabilidade. Suas alterações não foram salvas." com a opção de copiar os textos digitados.
- **FA-07 — Fechar com alterações não salvas:** o sistema pede confirmação antes de descartar.
- **FA-08 — Alteração sem diferença:** salvar sem mudanças efetivas fecha o painel com "Nenhuma alteração para salvar." (sem nova versão).

## Regras de negócio
- **RN-PROC-59** — Editar exige `PROCESS_UPDATE` com escopo que cubra o processo **e** custódia (POL-01: responsável atual, ou membro lotado na unidade atual quando não houver responsável) **e** status `DRAFT`, `IN_PROGRESS` ou `RETURNED`. Em `AWAITING_APPROVAL`, `SUSPENDED`, `CANCELED`, `COMPLETED` ou `PUBLISHED` → 409 `INVALID_PROCESS_STATUS`; sem custódia → 403 `NOT_PROCESS_CUSTODIAN`.
- **RN-PROC-60** — Política de bloqueio por status (tabela "Campos"): `organizationId`, `requestingSecretariatId` e `requestingDepartmentId` só podem ser alterados em `DRAFT`; os demais campos editáveis podem ser alterados em `DRAFT`, `IN_PROGRESS` e `RETURNED`. Alteração de campo bloqueado → 422 `VALIDATION_ERROR` com `errors[] { field, code: "NOT_ALLOWED", message }` (api.md §2.1.1); o processo inteiro fora dos status editáveis continua respondendo 409 `INVALID_PROCESS_STATUS` (RN-PROC-59).
- **RN-PROC-61** — Mesmo em `DRAFT`, `organizationId` fica bloqueado se o processo já tiver número e a numeração depender do órgão (`numbering.process.scope = ORGANIZATION` ou máscara `numbering.process.mask` com o token `{org}`), para não tornar o `code` incoerente. Trocar o órgão exige informar secretaria e setor do novo órgão na mesma requisição.
- **RN-PROC-62** — Troca de secretaria/setor solicitante (somente `DRAFT`): aplica RN-PROC-02 (setor na subárvore da secretaria, ambas ativas e do mesmo órgão) e exige que o escopo de `PROCESS_CREATE` do usuário cubra o novo setor (RN-PROC-03). Na mesma transação, as concessões `ProcessAccess` `REQUESTING` anteriores são revogadas (`revokedAt`) e as novas concedidas. A custódia atual (etapa, unidade e responsável) não muda, e o DFD já criado não é alterado.
- **RN-PROC-63** — Valor estimado manual (DEC-032): `estimatedValue` só é editável quando `estimatedValueSource` é nulo ou `MANUAL`; havendo fonte de maior precedência (`DFD`, `ETP`, `PRICE_RESEARCH`, `TERM`), a alteração é recusada com 422 `BUSINESS_RULE_VIOLATION` e a UI exibe o aviso da fonte. Ao informar valor, `estimatedValueSource = MANUAL`; ao limpá-lo, ambos ficam nulos. Valor ≥ 0 com até 2 casas (string decimal na API).
- **RN-PROC-64** — Revalidação do estado resultante: as regras de US-001 valem para o processo após a alteração (obrigatórios — RN-PROC-01; código interno — RN-PROC-09; prazo alvo ≥ hoje — RN-PROC-11; PCA — RN-PROC-12; catálogo ativo e do tipo correto — RN-PROC-16), mas **somente para os campos enviados** e para as regras cruzadas que eles afetam (ex.: mudar `pcaStatus` para `NOT_PLANNED` exige `pcaJustification`). Referências e datas não alteradas não são revalidadas (ex.: tipo de contratação que ficou inativo, prazo alvo que já passou).
- **RN-PROC-65** — Campos nunca editáveis por PATCH: `status`, `statusBeforeSuspension`, `workflowVersionId`, `currentStageId`, `currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`, `overdueSince`, `number`, `year`, `code`, `openedAt`, `creationChannel`, `duplicatedFromId`, `estimatedValueSource`, `isBudgetConfidential` (PRC-33, US-013) e os campos de conclusão, cancelamento e suspensão. O schema é estrito: campo fora da lista de editáveis → 422 `VALIDATION_ERROR` com `errors[].code = "NOT_ALLOWED"`.
- **RN-PROC-66** — Concorrência: `If-Match` com a `version` atual é obrigatório (ausente → 428 `PRECONDITION_REQUIRED`; divergente → 412 `VERSION_CONFLICT` com `currentVersion` e `meta.current`). A versão do processo também é incrementada por itens, etiquetas, sigilo, tramitações e derivação do valor estimado, que fazem parte do mesmo agregado.
- **RN-PROC-67** — PATCH sem diferença efetiva (valores iguais aos atuais após normalização — trim, decimal canônico) responde 200 com o recurso atual, **sem** incrementar a versão e sem evento, timeline ou auditoria.
- **RN-PROC-68** — Efeitos na mesma transação: `ProcessUpdated` com `changedFields` (nomes dos campos — nunca valores) e `version`; timeline `PROCESS_UPDATED` com `params.fields` (visibilidade `BUDGET_RESTRICTED` quando `changedFields` inclui `estimatedValue` de processo sigiloso); auditoria `process.update` com o diff (RN-PROC-64 de US-001: textos longos como hash + tamanho). `searchVector` é recalculado automaticamente (coluna gerada).
- **RN-PROC-69** — Alterar `contractingTypeId`, `modalityId`, `originId`, `isPriceRegistration` ou `estimatedValue` **não** troca a versão do workflow (DEC-014); as regras das próximas ações passam a considerar os novos valores pelo `RuleContext`. A UI informa: "O fluxo do processo não muda com esta alteração."
- **RN-PROC-70** — `internalCode` (até 60 caracteres, trim) deve ser único no tenant entre processos não descartados (409 `DUPLICATE_INTERNAL_CODE`); com `process.requireInternalCode = true` não pode ser removido (422 `VALIDATION_ERROR`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Editável em `DRAFT` | Editável em `IN_PROGRESS`/`RETURNED` |
|---|---|---|---|---|---|---|
| Órgão/entidade | `organizationId` | seleção | Sim | RN-PROC-61 | Sim (com ressalva) | Não |
| Secretaria solicitante | `requestingSecretariatId` | seleção | Sim | RN-PROC-62 | Sim | Não |
| Setor solicitante | `requestingDepartmentId` | seleção em árvore | Sim | RN-PROC-62 | Sim | Não |
| Título | `title` | texto curto | Sim | 5–200; sem quebra de linha | Sim | Sim |
| Objeto | `object` | texto longo | Sim | 10–2.000 | Sim | Sim |
| Descrição | `description` | texto longo | Não | até 10.000 | Sim | Sim |
| Tipo de contratação | `contractingTypeId` | catálogo `CONTRACTING_TYPE` | Sim | ativo se alterado; RN-PROC-69 | Sim | Sim |
| Modalidade prevista | `modalityId` | catálogo `MODALITY` | Não | ativo se alterado; vazio = "A definir" | Sim | Sim |
| Registro de preços (SRP) | `isPriceRegistration` | interruptor | Não | — | Sim | Sim |
| Prioridade | `priority` | `Priority` | Sim | enum | Sim | Sim |
| Prazo alvo | `targetDate` | data | Não | ≥ hoje se alterado | Sim | Sim |
| Valor estimado | `estimatedValue` | moeda (BRL) | Não | RN-PROC-63 | Sim (sem fonte superior) | Sim (sem fonte superior) |
| Origem | `originId` | catálogo `PROCESS_ORIGIN` | Sim | ativo se alterado | Sim | Sim |
| Situação no PCA | `pcaStatus`, `pcaYear`, `pcaItemCode`, `pcaJustification` | rádio + condicionais | Sim | RN-PROC-12 | Sim | Sim |
| Código interno | `internalCode` | texto curto | Condicional | RN-PROC-70 | Sim | Sim |
| Observações | `notes` | texto longo | Não | até 5.000 | Sim | Sim |
| *(sistema)* Origem do valor | `estimatedValueSource` | `EstimatedValueSource` | — | somente leitura | — | — |

Em `AWAITING_APPROVAL`, `SUSPENDED` e status finais nenhum campo é editável.

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Obrigatório removido / limites de tamanho | Front + API (Zod) | "Informe o {campo}." / "O {campo} deve ter entre X e Y caracteres." | `VALIDATION_ERROR` |
| V-02 | Campo bloqueado pelo status | API | "Este campo só pode ser alterado enquanto o processo é rascunho." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-03 | Campo não editável no corpo | API | "Há campos que não podem ser alterados por aqui." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-04 | Catálogo/unidade inexistente, inativa ou de outro tenant (quando alterada) | API | "Selecione um {campo} válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-05 | Setor fora da subárvore da secretaria | API | "O setor deve pertencer à secretaria selecionada." | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) |
| V-06 | Novo setor fora do escopo de `PROCESS_CREATE` | API | "Você não pode atribuir o processo a este setor solicitante." | `PERMISSION_DENIED` |
| V-07 | Valor estimado com fonte de maior precedência | Front + API | "O valor estimado é obtido de {fonte}. Para alterá-lo, ajuste o documento de origem." | `BUSINESS_RULE_VIOLATION` |
| V-08 | Valor negativo ou com mais de 2 casas | Front + API | "Informe um valor válido, com até 2 casas decimais." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-09 | Prazo alvo alterado para data passada | Front + API | "O prazo alvo não pode ser anterior a hoje." | `VALIDATION_ERROR` (`DATE_IN_PAST`) |
| V-10 | Regras de PCA no estado resultante | Front + API | "Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-11 | Código interno duplicado | API (+ índice único) | "Já existe um processo com o código interno {valor}." | `DUPLICATE_INTERNAL_CODE` |
| V-12 | Código interno removido com `process.requireInternalCode = true` | Front + API | "O código interno é obrigatório neste órgão." | `VALIDATION_ERROR` |
| V-13 | `If-Match` ausente / divergente | API | "Recarregue o processo e tente novamente." / "Este processo foi alterado por outra pessoa." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `PROCESS_UPDATE` com escopo que cubra o processo; para trocar o setor solicitante, também `PROCESS_CREATE` cobrindo o novo setor (RN-PROC-62).
- **Políticas:** POL-01 (custódia e status editável); POL-09 (o valor estimado de processo sigiloso é exibido ao custodiante pela cláusula de custódia).
- **MFA:** não exigido (`PROCESS_UPDATE` é `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `PROCESS_UPDATE` em nenhum escopo, a ação "Editar dados" não aparece; com permissão mas sem custódia ou em status bloqueado, aparece desabilitada com o motivo (PRC-08). A API responde 403 `PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN` ou 409 `INVALID_PROCESS_STATUS` e registra `access.denied` nos 403.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessUpdated` | `process.updated` | Commit de alteração efetiva | Payload: `changedFields` (ex.: `["title","priority","targetDate"]`) e `version`; nunca valores |

Projeção síncrona: `ProcessTimelineEntry` `PROCESS_UPDATED`; `ProcessAccess` atualizado na mesma transação quando a unidade solicitante muda (RN-PROC-62).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a alteração é feita por quem está com o processo e fica registrada na timeline. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Editar dados do processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo e hoje é "2026-10-05"
    And o processo "0012/2026" está "IN_PROGRESS" na versão 8, com "Ana" como responsável atual
    And "Ana" possui o perfil "REQUISITANTE" com escopo "OWN_DEPARTMENTS" e lotação no "Setor de Manutenção"

  Scenario: [Sucesso] Alterar título, prioridade e prazo alvo
    When "Ana" alterar o título para "Aquisição de cimento CP-II para manutenção de vias", a prioridade para "HIGH" e o prazo alvo para "2026-11-30" com "If-Match" igual a "8"
    Then a API deve responder 200 com o cabeçalho "ETag" igual a "9"
    And deve gerar o evento "ProcessUpdated" com "changedFields" igual a ["title","priority","targetDate"] e sem valores no payload
    And deve existir uma entrada "PROCESS_UPDATED" na timeline
    And deve gerar registro de auditoria "process.update" com o diff dos três campos

  Scenario: [Sucesso] Informar valor estimado manual sem fonte documental
    Given que o processo não tem "estimatedValueSource"
    When "Ana" informar o valor estimado "85000.00"
    Then o processo deve ter "estimatedValue" igual a "85000.00" e "estimatedValueSource" igual a "MANUAL"

  Scenario: [Sucesso] Trocar o setor solicitante em rascunho
    Given que o processo "0060/2026" está "DRAFT" com setor solicitante "Setor de Manutenção" e "Ana" como responsável
    And "Ana" também é lotada no "Setor de Pavimentação" da mesma secretaria
    When "Ana" alterar o setor solicitante para "Setor de Pavimentação"
    Then a concessão "REQUESTING" do "Setor de Manutenção" deve ser revogada e a do "Setor de Pavimentação" concedida na mesma transação
    And a etapa, a unidade atual e o responsável do processo não devem mudar

  Scenario: [Validação] Campo bloqueado depois do primeiro encaminhamento
    When "Ana" tentar alterar a secretaria solicitante do processo "0012/2026"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "requestingSecretariatId"
    And o processo deve permanecer na versão 8

  Scenario: [Validação] Valor estimado com fonte de maior precedência
    Given que o valor estimado do processo veio da pesquisa de preços concluída
    When "Ana" tentar alterar o valor estimado para "90000.00"
    Then a API deve responder 422 com código "BUSINESS_RULE_VIOLATION"
    And o painel deve exibir "O valor estimado é obtido de Pesquisa de preços. Para alterá-lo, ajuste o documento de origem."

  Scenario: [Validação] Campo que nunca é editável por PATCH
    When a API receber PATCH com o campo "status" igual a "COMPLETED"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "status"

  Scenario: [Permissão] Usuário com permissão, mas sem custódia
    Given que "Juliana" possui o perfil "COMPRAS" com escopo "TENANT" e não está com o processo
    When "Juliana" enviar PATCH alterando a prioridade
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    And deve gerar registro de auditoria "access.denied" com reasonCode "NOT_PROCESS_CUSTODIAN"

  Scenario: [Permissão] Processo aguardando aprovação
    Given que o processo "0045/2026" está "AWAITING_APPROVAL"
    When o responsável anterior abrir o detalhe do processo
    Then a ação "Editar dados" deve estar desabilitada com o motivo "Não é possível editar enquanto o processo aguarda aprovação."
    And um PATCH deve ser recusado com 409 e código "INVALID_PROCESS_STATUS"

  Scenario: [Tenant incorreto] Processo ou referência de outro tenant
    Given que existe o processo "0099/2026" e o tipo de contratação "OBRA" no tenant "Prefeitura B"
    When "Ana" enviar PATCH para o processo "0099/2026"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    When "Ana" enviar PATCH no processo "0012/2026" com "contractingTypeId" do tipo da "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "contractingTypeId"

  Scenario: [Duplicidade] Código interno já utilizado e PATCH repetido
    Given que o processo "0031/2026" tem o código interno "PROT-2026-0457"
    When "Ana" informar o código interno "PROT-2026-0457" no processo "0012/2026"
    Then a API deve responder 409 com código "DUPLICATE_INTERNAL_CODE"
    When "Ana" reenviar um PATCH com valores idênticos aos atuais
    Then a API deve responder 200 sem incrementar a versão e sem gerar evento, timeline ou auditoria

  Scenario: [Concorrência] Valor derivado por documento durante a edição
    Given que "Ana" abriu o painel com "ETag" igual a "8"
    And a conclusão da pesquisa de preços atualizou o valor estimado e levou o processo à versão 9
    When "Ana" salvar a alteração da prioridade com "If-Match" igual a "8"
    Then a API deve responder 412 com código "VERSION_CONFLICT", "currentVersion" igual a 9 e o processo atual em "meta.current"
    And o painel deve oferecer "Reaplicar minhas alterações" e "Descartar e recarregar"
    When "Ana" escolher "Reaplicar minhas alterações"
    Then a prioridade deve ser gravada com "If-Match" igual a "9" e o valor estimado derivado deve ser preservado

  Scenario: [Concorrência] Encaminhamento confirmado antes da gravação
    Given que "Ana" e o encaminhamento do processo disputam o bloqueio do processo
    When o encaminhamento for confirmado primeiro
    Then o PATCH de "Ana" deve ser recusado com 403 "NOT_PROCESS_CUSTODIAN" ou 412 "VERSION_CONFLICT"
    And o painel deve exibir "O processo saiu da sua responsabilidade. Suas alterações não foram salvas."

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados fica indisponível durante a transação
    When "Ana" salvar alterações
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma alteração, evento, entrada de timeline ou auditoria deve ser persistida
    And o painel deve manter os valores digitados e exibir "Não foi possível salvar agora. Tente novamente em instantes."

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Ana" salvar alterações válidas
    Then a API deve responder 200 e o evento "ProcessUpdated" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido / campo bloqueado ou não editável (`NOT_ALLOWED`) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca os campos com `errors[]`; campo bloqueado volta a somente leitura |
| Referência inexistente/inativa/de outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um {campo} válido." | Recarrega as opções |
| Valor estimado com fonte superior | 422 | `BUSINESS_RULE_VIOLATION` | "O valor estimado é obtido de {fonte}." | Campo somente leitura |
| Processo em status não editável | 409 | `INVALID_PROCESS_STATUS` | "Não é possível editar com o processo {status}." | Recarrega o processo; painel somente leitura |
| Código interno duplicado | 409 | `DUPLICATE_INTERNAL_CODE` | "Já existe um processo com o código interno {valor}." | Erro no campo |
| Sem permissão / escopo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar este processo." | Fecha o painel |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "O processo saiu da sua responsabilidade. Suas alterações não foram salvas." | Oferece copiar os textos |
| Processo não visível / outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | SCR-111 |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "Este processo foi alterado por outra pessoa." | Diálogo de conflito (FA-05) |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados |

## Dependências
- **Stories:** US-001 (processo, regras de validação da criação, `TransactionalCommandHandler`). Relacionadas: US-004 (ação `EDIT` e painel), US-059 (projeção na timeline), US-073 (auditoria), US-082 (outbox), US-017/US-023/US-032/US-039 (derivação do valor estimado por documentos), US-013 (sigilo e `BUDGET_RESTRICTED`).
- **Decisões/ADRs:** DEC-013, DEC-014, DEC-023, DEC-025, DEC-028, DEC-029, DEC-032, DEC-055, DEC-104, DEC-161; ADR-004.
- **Configurações:** `process.requireInternalCode`, `numbering.process.scope`, `numbering.process.mask`, `labels.secretariat`, `labels.department`.
- **Lacunas nas fontes canônicas:**
  1. **"Senão, aviso" de DEC-032** foi interpretado como bloqueio da edição manual com aviso na UI quando houver fonte de maior precedência. Proposta: explicitar em DEC-032.

## Impacto técnico
- Reutiliza o `TransactionalCommandHandler` de US-001 (contexto de tenant → validação → autorização → domínio → projeções → auditoria → outbox).
- `SELECT … FOR UPDATE` no processo serializa a edição com tramitações e com a derivação do valor estimado (DEC-055), evitando que um PATCH sob custódia antiga seja aplicado depois de um encaminhamento.
- O diff é calculado no domínio (`Process.applyChanges(patch)` retorna `ChangeSet`), alimentando `changedFields`, o `changes[]` da auditoria e o `params.fields` da timeline a partir da mesma fonte.
- O conflito 412 traz `meta.current` para permitir a reaplicação seletiva no front sem nova leitura.
- Revogação/concessão de `ProcessAccess` na troca da unidade solicitante deve usar o mesmo `ProcessAccessProjector` da criação para evitar divergência de regras.

## Backend
- **Módulo(s):** `process` (dono); `catalog`, `organization`, `access`, `timeline`, `audit`, `platform` via fachadas.
- **Casos de uso:** `UpdateProcessCommand` → `UpdateProcessHandler`.
- **Domínio:** `Process.applyChanges(patch, ctx)` — aplica RN-PROC-60 a RN-PROC-65 e RN-PROC-70, devolve `ChangeSet` e emite `ProcessUpdated`; `FieldLockPolicy` (matriz campo × status + RN-PROC-61); `EstimatedValuePolicy` (DEC-032).
- **Integrações internas:** `AuthorizationService.assertCan('PROCESS_UPDATE', process)` + `CustodyPolicy` (POL-01); `AuthorizationService.assertCan('PROCESS_CREATE', { departmentId })` na troca de setor; `CatalogFacade.assertActive`; `DepartmentFacade.assertInSubtree`; `ProcessAccessProjector`; `TimelineProjector`; `AuditService`; `OutboxWriter`.
- **Transação:** passos 5.1–5.8 em uma transação com `app.tenant_id`, `SELECT … FOR UPDATE` no processo e isolamento `READ COMMITTED`.

## Frontend
- **Tela(s):** SCR-006 — painel lateral "Editar dados" (Sheet).
- **Componentes:** `EditProcessSheet` (React Hook Form + `zodResolver(updateProcessSchema)`), `LockedField` (cadeado + explicação), `EstimatedValueField` (somente leitura com fonte, `ConfidentialValue` quando mascarado), `DepartmentTreeSelect` e `CatalogSelect` (reutilizados de US-001), `PcaFieldset`, `ConflictDialog` (comparação campo a campo com `meta.current`), `UnsavedChangesGuard`.
- **Dados:** `useMutation(updateProcess)` enviando apenas campos alterados (`dirtyFields`) com `If-Match`; após sucesso, invalidar `['t', tenantId, 'processes', id, *]` e `['t', tenantId, 'processes', 'list']`.
- **Estados:** skeleton no carregamento; botão "Salvar alterações" com "Salvando…"; erros por campo; diálogo de conflito; aviso de perda de custódia.
- **Acessibilidade:** painel com foco preso e retorno ao gatilho; campos bloqueados com `aria-readonly` e descrição; erros anunciados via `aria-live`; contraste AA.
- **Responsivo:** painel em tela cheia abaixo de 768 px, botões fixos no rodapé.

## Banco de dados
- **Tabelas escritas:** `processes`, `process_access` (troca de unidade solicitante), `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma (entidades de US-001).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, internal_code) WHERE internal_code IS NOT NULL AND deleted_at IS NULL`; checks de PCA e de `estimated_value >= 0`; `process_access` com unicidade parcial por motivo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-05 | PATCH | `/api/v1/processes/{id}` | Subconjunto de `{ organizationId, requestingSecretariatId, requestingDepartmentId, title, object, description, contractingTypeId, modalityId, isPriceRegistration, priority, targetDate, estimatedValue, originId, pcaStatus, pcaYear, pcaItemCode, pcaJustification, internalCode, notes }` + `If-Match` | `200 { data: Process }` + `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| PRC-04 | GET | `/api/v1/processes/{id}` | — | `200 { data: Process }` + `ETag` | 200, 404 |

Exemplo de resposta 412:
```json
{
  "type": "https://docs.contrataflow.com.br/errors/version-conflict",
  "title": "Este processo foi alterado por outra pessoa",
  "status": 412,
  "code": "VERSION_CONFLICT",
  "detail": "A versão enviada (8) é diferente da atual (9).",
  "currentVersion": 9,
  "meta": { "current": { "id": "…", "priority": "MEDIUM", "estimatedValue": "92450.00", "estimatedValueSource": "PRICE_RESEARCH", "version": 9, "updatedAt": "2026-10-05T15:02:10Z", "updatedBy": { "id": "…", "name": "Juliana Costa" } } },
  "correlationId": "c-91ab0e"
}
```

## Logs
- `info` `process.updated` — `processId`, `changedFields`, `version`, `durationMs`.
- `info` `process.update_noop` — PATCH sem diferença efetiva.
- `warn` `process.update_conflict` — 412, com versões enviada e atual.
- `error` `process.update_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** valores de título, objeto, descrição, observações, justificativas e valor estimado.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.update` | `DATA_CHANGE` | Commit de alteração efetiva | `changes`: `[{ path, old, new }]` dos campos alterados (IDs de catálogo/unidade, prioridade, datas, PCA status, valor estimado; textos longos como hash + tamanho). `metadata`: `processCode`, `version`, `requestingAccessChanged` |
| `access.denied` | `ACCESS` | 403 por permissão, escopo ou custódia | `reasonCode = PROCESS_UPDATE` ou `NOT_PROCESS_CUSTODIAN` |

A leitura do diff de `estimatedValue` de processo sigiloso é mascarada na consulta de auditoria para quem não atende POL-09 (regra de US-013).

## Testes necessários
- **Unitários:** `FieldLockPolicy` (cada campo × cada status; RN-PROC-61 com escopo de numeração e token `{org}`); `EstimatedValuePolicy` (fonte nula, `MANUAL` e superiores); revalidação parcial (RN-PROC-64); detecção de no-op com normalização.
- **Integração (Testcontainers):** transação única (falha induzida após gravar o processo → nada persiste); troca de unidade solicitante revoga/concede `ProcessAccess`; `FOR UPDATE` serializa PATCH × encaminhamento; timeline `BUDGET_RESTRICTED` para valor de processo sigiloso.
- **API/contrato:** PRC-05 conforme api.md; 412 com `currentVersion` e `meta.current`; 428 sem `If-Match`.
- **RBAC e multi-tenant:** matriz perfil × custódia × status; referências de outro tenant → 422 `REFERENCE_NOT_FOUND`; processo de outro tenant → 404 (suíte "tenant leak").
- **Concorrência:** duas edições com o mesmo `If-Match` → uma 200, outra 412; derivação de valor concorrente.
- **E2E (Playwright):** editar dados, campo bloqueado com explicação, conflito com reaplicação, perda de custódia durante a edição.
- **Acessibilidade/performance:** axe no painel; p95 do PATCH < 400 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Política de bloqueio por status coberta por teste table-driven (campo × status)
- [ ] POL-01 aplicada na API; ação "Editar dados" oculta/desabilitada conforme PRC-08
- [ ] Evento `ProcessUpdated` sem valores, timeline e auditoria com diff verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-05 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de conflitos 412
- [ ] Painel acessível (axe) e utilizável em 360 px
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — um comando com regras claras, mas com política de bloqueio campo × status, regra de precedência do valor estimado, troca de unidade solicitante com atualização de visibilidade, diff único para evento/timeline/auditoria e um diálogo de conflito com reaplicação seletiva.

## Prioridade
**P0** — dados do processo precisam ser corrigidos durante a fase preparatória; sem edição, erros de cadastro obrigariam a recriar processos e perder histórico.
