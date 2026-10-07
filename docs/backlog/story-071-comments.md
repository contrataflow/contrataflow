---
id: US-071
title: "Comentar no processo e em documentos"
epic: EP-012
feature: FT-043
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-001, US-059]
modules: [collaboration, process, document, access, timeline, notification, audit, platform]
screens: [SCR-006, SCR-007, SCR-008, SCR-009, SCR-011, SCR-012, SCR-105]
endpoints: [CMT-01, CMT-02, CMT-03, CMT-04]
permissions: [PROCESS_VIEW, COMMENT_CREATE, COMMENT_MODERATE, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [CommentCreated, CommentUpdated, CommentDeleted]
---

# US-071 — Comentar no processo e em documentos

## Título
Comentar no processo e em documentos

## Descrição
**Como** servidor que participa da instrução de um processo (ou colaborador/consultor convidado), **quero** registrar comentários no processo e nos documentos — inclusive ancorados em uma seção —, responder a comentários e corrigir ou excluir o que escrevi, **para** discutir a instrução dentro do próprio processo, com histórico rastreável, em vez de e-mail e mensageiros.

Os comentários ficam na aba **Comentários** do detalhe do processo (SCR-006) e no painel lateral dos editores de documento, com indicador por seção. O texto usa rich text **restrito** (parágrafo, negrito, itálico, link, lista e menção), validado e sanitizado no servidor. Há respostas de **um nível**, edição pelo autor em até **15 minutos**, exclusão lógica pelo autor e **moderação** com motivo por quem tem `COMMENT_MODERATE`. Quem vê o processo vê os comentários; processos em status final ficam **somente leitura**. Cada comentário gera a entrada `COMMENT_ADDED` na timeline e, quando é resposta, a notificação `COMMENT_REPLY` ao autor do comentário original.

## Contexto
- Hoje a discussão da instrução acontece em e-mails, mensageiros e despachos impressos; o que motivou uma alteração no ETP ou no TR se perde e não fica vinculado ao processo.
- Comentário é artefato do processo (`processId` obrigatório — DEC-010), do módulo `collaboration` (DEC-040). Participantes `OBSERVER`, `COLLABORATOR` e `CONSULTANT` podem comentar por força da participação (DEC-036; permissions.md §4).
- Visibilidade = visibilidade do processo (DEC-024); comentários restritos por unidade não existem no MVP 1 (PEND-11). Orçamento sigiloso é protegido pela política central (DEC-030, POL-09).
- Rich text é validado contra schema permitido e nunca renderizado como HTML do cliente (DEC-056; risco RS-03 de XSS). Nada é excluído fisicamente (DEC-034); conteúdo de comentários é dado potencialmente pessoal (RL-05, LGPD).
- Timeline é a narrativa curada; auditoria é a evidência (DEC-025). Em mobile, leitura e comentários são plenamente suportados (DEC-183).
- **Decisão desta story (comportamento em status final):** processos `CANCELED`, `COMPLETED` (e `PUBLISHED`, no MVP 3) ficam com comentários **somente leitura**, exceto moderação. Motivos: são status finais no MVP 1 (DEC-013) sem reabertura (PEND-03); os autos encerrados preservam o registro para o controle; esclarecimentos de fases seguintes ocorrerão em etapas do workflow do MVP 2, antes da conclusão. Revisar quando o MVP 3 tornar `COMPLETED → PUBLISHED` operacional.

## Objetivo
Permitir que qualquer pessoa com acesso ao processo registre e responda comentários em até 3 cliques, com 100% dos comentários vinculados a processo, autor, data e alvo (processo, documento ou seção); nenhum conteúdo fora do schema persistido; criação com p95 < 300 ms; e comentários em documentos com orçamento sigiloso nunca expostos a quem não atende POL-09.

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`) e Área requisitante (`REQUISITANTE`) discutindo ETP, TR e DFD.
- **Secundárias:** Compras (`COMPRAS`), Jurídico e Licitações como participantes, Controle Interno (`CONTROLE_INTERNO`), Consultoria externa (participação `CONSULTANT`); Gestor de contratações (`GESTOR_CONTRATACOES`) e Administrador do órgão (`ADMIN_ORGAO`) como moderadores.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` e não expirado (US-087, US-097).
- Processo existente e visível ao usuário (US-001; DEC-024).
- Para comentar em documento: documento existente no processo (US-065), com template publicado quando houver seções (US-108).
- Timeline e outbox operacionais (US-059, US-082); auditoria transacional (US-073).

## Fluxo principal
1. O usuário abre a aba **Comentários** do processo (SCR-006). O front chama `CMT-01` (`GET /processes/{id}/comments?limit=20`) e exibe skeleton até a resposta.
2. O sistema lista as threads (comentários raiz mais recentes primeiro), cada uma com autor, unidade, data relativa ("há 5 min", com data absoluta no `title`), alvo ("Processo" ou "ETP 0003/2026 › Requisitos da contratação"), texto formatado e respostas.
3. O usuário escreve no compositor (negrito, itálico, lista, link) e clica em **"Comentar"** (ou `Ctrl+Enter`). O front valida tamanho e conteúdo vazio e envia `POST /processes/{id}/comments` com `Idempotency-Key`.
4. A API, em uma transação com `app.tenant_id`:
   1. valida o corpo (Zod) e o `body` contra o schema restrito de comentário (`packages/editor`);
   2. verifica visibilidade do processo (404 se não visível) e autoriza `COMMENT_CREATE` (perfil com escopo que cubra o processo ou participação ativa);
   3. verifica o status do processo (RN-CMT-08) e, se houver, o alvo documento/seção e o comentário pai (RN-CMT-01/02);
   4. deriva `bodyText` e insere `Comment` (`authorId` = usuário do contexto);
   5. grava `AuditLog` `comment.create`, o evento `CommentCreated` no outbox e, pelo projetor síncrono, a entrada `COMMENT_ADDED` na timeline;
   6. confirma a transação.
5. A API responde **201** com o comentário, `Location` e `ETag: "1"`. O front insere a thread no topo, limpa o compositor e anuncia "Comentário publicado" em região `aria-live`.
6. Para comentar um documento, o usuário usa o painel **Comentários** do editor (SCR-007, SCR-008, SCR-009, SCR-011, SCR-012, SCR-105) ou o ícone de balão ao lado de uma seção; o alvo vem preenchido (`targetType = DOCUMENT`, `documentId`, `sectionKey`).

## Fluxos alternativos
- **FA-01 — Responder:** em uma thread, "Responder" abre o compositor inline; o envio inclui `parentId`. O autor do comentário pai recebe `COMMENT_REPLY` (se não for o próprio ator).
- **FA-02 — Editar (até 15 min):** o autor vê "Editar (até HH:mm)"; o compositor abre com o conteúdo; o envio usa `PATCH /comments/{id}` com `If-Match`. O comentário passa a exibir "(editado)". Após o prazo a opção some; se a API recusar (`INVALID_STATE`), o front informa "O prazo de 15 minutos para editar terminou." e mantém o texto copiável.
- **FA-03 — Excluir o próprio comentário:** "Excluir" pede confirmação ("O comentário será removido para todos. As respostas permanecem."); `DELETE /comments/{id}` com `If-Match`. A thread mostra "Comentário excluído pelo autor".
- **FA-04 — Moderar:** quem tem `COMMENT_MODERATE` vê "Remover por moderação" em comentários de terceiros; o diálogo exige motivo (10–1.000 caracteres); `DELETE /comments/{id}` com `{ reason }`. A thread mostra "Comentário removido por moderação" e a timeline recebe `COMMENT_REMOVED`.
- **FA-05 — Processo em status final:** em `CANCELED`/`COMPLETED`, o compositor é substituído por "Este processo está encerrado; os comentários estão disponíveis apenas para leitura." Editar/excluir próprios ficam ocultos; moderação continua disponível.
- **FA-06 — Documento com orçamento sigiloso:** comentários em documento `RESTRICTED` são exibidos a quem não atende POL-09 como "Comentário em documento com orçamento sigiloso — conteúdo restrito", com autor e data.
- **FA-07 — Aviso de sigilo:** em processo com `isBudgetConfidential = true`, o compositor exibe "Não informe valores estimados em comentários: este processo tem orçamento sigiloso."
- **FA-08 — Falha ao enviar:** o texto permanece no compositor (e em `sessionStorage` por processo/alvo) e a mensagem traz o `correlationId`; reenvio usa a mesma `Idempotency-Key`.
- **FA-09 — Filtrar:** filtros "Todos", "Do processo", "Deste documento"/"Desta seção" (no editor), via `targetType`, `documentId` e `sectionKey` em `CMT-01`.
- **FA-10 — Mais respostas:** threads com mais de 20 respostas exibem "Ver mais N respostas" (`CMT-01?parentId=`).

## Regras de negócio
- **RN-CMT-01** — Alvo: `targetType = PROCESS` (com `documentId` e `sectionKey` nulos) ou `DOCUMENT` (`documentId` obrigatório, documento do mesmo processo, não excluído logicamente e não `CANCELED`). `sectionKey` é opcional e deve existir nas seções da versão de template do documento; documentos `UPLOADED` não aceitam `sectionKey`.
- **RN-CMT-02** — Resposta: `parentId` deve ser um comentário **raiz** (`parentId` nulo) do mesmo processo e não excluído. A resposta herda `targetType`, `documentId` e `sectionKey` do pai; valores divergentes no corpo são rejeitados. Só há um nível de resposta.
- **RN-CMT-03** — `body` é documento TipTap com nós `doc`, `paragraph`, `text`, `bulletList`, `orderedList`, `listItem`, `hardBreak`, `mention` e marcas `bold`, `italic`, `link`. Qualquer outro nó, marca ou atributo é rejeitado (`RICH_TEXT_INVALID`) — não há "limpeza silenciosa".
- **RN-CMT-04** — Links aceitam apenas `https:`, `http:` e `mailto:` (até 2.048 caracteres) e são renderizados com `rel="noopener noreferrer nofollow ugc"` e `target="_blank"`.
- **RN-CMT-05** — `bodyText` é derivado no servidor (texto puro; menções como "@Nome") e deve ter 1–10.000 caracteres após trim; o JSON de `body` tem no máximo 100 KB. Conteúdo só com espaços ou parágrafos vazios é inválido.
- **RN-CMT-06** — O conteúdo é exibido renderizando o JSON com as mesmas extensões em modo leitura; HTML vindo do cliente nunca é aceito nem renderizado.
- **RN-CMT-07** — Criar ou responder exige processo visível e `COMMENT_CREATE` por perfil com escopo que cubra o processo **ou** participação ativa (`OBSERVER`, `COLLABORATOR`, `CONSULTANT`).
- **RN-CMT-08** — Criar, responder, editar e excluir o próprio comentário só com o processo em `DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED` ou `SUSPENDED`. Em `CANCELED`, `COMPLETED` ou `PUBLISHED` os comentários são somente leitura (`INVALID_PROCESS_STATUS`); a moderação continua permitida.
- **RN-CMT-09** — Edição: somente o autor, até 15 minutos após `createdAt` (relógio do servidor), em comentário não excluído; grava `editedAt`. Não há histórico de versões do comentário (a auditoria guarda hash e tamanho antes/depois).
- **RN-CMT-10** — Exclusão pelo autor: lógica (`deletedAt`, `deletedById`), sem limite de tempo, respeitando RN-CMT-08. Respostas permanecem; o item excluído é exibido como "Comentário excluído pelo autor".
- **RN-CMT-11** — Moderação: `COMMENT_MODERATE` com escopo que cubra o processo, motivo obrigatório (`deletionReason`, 10–1.000 caracteres), em qualquer status do processo. Moderador que exclui o próprio comentário age como autor (sem motivo).
- **RN-CMT-12** — Conteúdo excluído nunca é devolvido pela API (nem a moderadores); permanece no banco (DEC-034, PEND-07). O motivo da moderação é exibido ao autor e a quem tem `COMMENT_MODERATE`.
- **RN-CMT-13** — Quem vê o processo vê seus comentários. Exceção: em comentário cujo documento-alvo é `RESTRICTED`, `body` só é retornado a quem atende POL-09 no processo; os demais recebem `body: null` e `bodyMasked: true` (serializador central).
- **RN-CMT-14** — Em processo com orçamento sigiloso o compositor exibe aviso de não registrar valores (não há detecção automática de valores no texto).
- **RN-CMT-15** — A criação gera `COMMENT_ADDED` na timeline com `excerpt` (até 140 caracteres de `bodyText`) e `documentLabel` quando o alvo for documento; edição e exclusão pelo autor não geram entrada. Moderação gera `COMMENT_REMOVED`.
- **RN-CMT-16** — Resposta gera `COMMENT_REPLY` ao autor do comentário pai, se ele não for o ator, tiver vínculo ativo e ainda vir o processo no momento do envio.
- **RN-CMT-17** — Listagem: raízes por `createdAt` decrescente com cursor (`limit` padrão 20, máx. 100); até 20 respostas por thread em ordem crescente, com `replyCount`; demais via `parentId`.
- **RN-CMT-18** — Edição e exclusão exigem `If-Match` com a `version` do comentário; a criação aceita `Idempotency-Key`.
- **RN-CMT-19** — O nó `mention` pertence ao schema; validação de alvos, registro `Mention` e `UserMentioned` são entregues em US-072. Enquanto US-072 não estiver ativa, o compositor não oferece `@` e a API rejeita `mention` com `RICH_TEXT_INVALID`.
- **RN-CMT-20** — Comentários não alteram o processo nem seus documentos: não exigem custódia (DEC-023), não mudam `Process.version` nem afetam prazos.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Comentário | `body` | rich text restrito (TipTap JSON) | Sim | RN-CMT-03..06 | — |
| Alvo | `targetType` | `CommentTargetType` | Sim | `PROCESS` ou `DOCUMENT` | pela tela de origem |
| Documento | `documentId` | uuid | Condicional | RN-CMT-01 | editor de origem |
| Seção | `sectionKey` | texto (SCREAMING_SNAKE) | Não | existe no template | seção clicada |
| Em resposta a | `parentId` | uuid | Não | RN-CMT-02 | thread de origem |
| Motivo da remoção | `reason` → `deletionReason` | texto | Condicional (moderação) | 10–1.000 caracteres | — |
| *(sistema)* Autor, texto puro, edição | `authorId`, `bodyText`, `editedAt` | — | — | RN-CMT-05/09 | gerados |
| *(sistema)* Exclusão | `deletedAt`, `deletedById` | — | — | RN-CMT-10/11 | gerados |
| *(sistema)* Concorrência | `version` | int | — | `ETag` | `1` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Comentário vazio ou acima de 10.000 caracteres | Front + API | "Escreva um comentário de até 10.000 caracteres." | `VALIDATION_ERROR` |
| V-02 | Nó, marca ou atributo fora do schema; JSON > 100 KB | API | "O comentário contém formatação não permitida." | `RICH_TEXT_INVALID` |
| V-03 | Link com protocolo não permitido | Front + API | "Use apenas links http, https ou mailto." | `RICH_TEXT_INVALID` |
| V-04 | `documentId` inexistente, excluído, de outro processo ou tenant | API | "Documento não encontrado neste processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Documento `CANCELED` | API | "Não é possível comentar um documento cancelado." | `INVALID_STATE` |
| V-06 | `sectionKey` fora do template / em documento externo | API | "Seção inexistente neste documento." | `SECTION_NOT_IN_TEMPLATE` |
| V-07 | `parentId` inexistente, de outro processo, excluído ou já resposta | API | "Não é possível responder a este comentário." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-08 | Alvo divergente do comentário pai | API | "A resposta deve ter o mesmo alvo do comentário original." | `VALIDATION_ERROR` |
| V-09 | Processo em status final (criar/editar/excluir próprio) | API | "Este processo está encerrado; os comentários estão disponíveis apenas para leitura." | `INVALID_PROCESS_STATUS` |
| V-10 | Edição após 15 min (comentário excluído → `INVALID_STATE`) | API | "O prazo de 15 minutos para editar terminou." | `COMMENT_EDIT_WINDOW_EXPIRED` |
| V-11 | Moderação sem motivo ou motivo fora de 10–1.000 | Front + API | "Informe o motivo da remoção (mín. 10 caracteres)." | `VALIDATION_ERROR` |
| V-12 | `If-Match` ausente/divergente | API | "O comentário foi alterado por outra pessoa. Recarregue." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Ler (CMT-01):** `PROCESS_VIEW` (perfil com escopo ou participação) — processo visível (DEC-024).
- **Criar/responder (CMT-02):** `COMMENT_CREATE` por perfil com escopo que cubra o processo ou por participação ativa (permissions.md §4).
- **Editar (CMT-03):** somente o autor, até 15 min. **Excluir (CMT-04):** autor ou `COMMENT_MODERATE` com escopo que cubra o processo.
- **Políticas:** POL-09 para conteúdo em documento `RESTRICTED`; custódia (POL-01) **não** se aplica.
- **MFA:** não exigido (`COMMENT_CREATE` L, `COMMENT_MODERATE` M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** perfis sem `COMMENT_CREATE` (padrão: `ADMIN_ORGAO`, `AUDITOR`, `SOMENTE_LEITURA`) veem a aba em modo leitura com "Você pode ler os comentários, mas não comentar neste processo." A API responde 403 `PERMISSION_DENIED` (+ `access.denied`); edição por não autor → 403 `PERMISSION_DENIED`; processo não visível → 404 `PROCESS_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `CommentCreated` | `comment.created` | Commit da criação/resposta | `commentId`, `targetType`, `documentId?`, `sectionKey?`, `parentId?`, `parentAuthorId?` |
| `CommentUpdated` | `comment.updated` | Commit da edição | `commentId` |
| `CommentDeleted` | `comment.deleted` | Commit da exclusão | `byModerator: boolean` |

Projeções síncronas: `COMMENT_ADDED` (criação) e `COMMENT_REMOVED` (moderação). `UserMentioned` é tratado em US-072.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `COMMENT_REPLY` | Autor do comentário pai (≠ ator, vínculo ativo, com visibilidade) | In-app (e-mail desligado por padrão) | Resposta criada (via `NotificationDispatcher`, US-111) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Comentar no processo e em documentos

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está "IN_PROGRESS" e é visível para "Marcos" (PLANEJAMENTO) e "Cláudia" (REQUISITANTE)
    And o processo possui o ETP "ETP 0003/2026" em "DRAFT" com a seção "REQUIREMENTS"

  Scenario: [Sucesso] Comentar no processo
    When "Marcos" publicar o comentário "Precisamos rever as quantidades do item 2." no processo
    Then a API deve responder 201 com "ETag" igual a "1"
    And o comentário deve aparecer no topo da aba "Comentários" com autor "Marcos"
    And deve existir a entrada "COMMENT_ADDED" na timeline com o trecho do texto
    And deve gerar registro de auditoria "comment.create"
    And deve gerar o evento "CommentCreated"

  Scenario: [Sucesso] Responder a comentário ancorado em seção do ETP
    Given que "Cláudia" comentou a seção "REQUIREMENTS" do "ETP 0003/2026"
    When "Marcos" responder a esse comentário
    Then a resposta deve herdar o documento e a seção do comentário original
    And "Cláudia" deve receber a notificação "COMMENT_REPLY"
    And "Marcos" não deve receber notificação pela própria resposta

  Scenario: [Sucesso] Editar dentro de 15 minutos e excluir o próprio comentário
    Given que "Marcos" publicou um comentário há 5 minutos
    When "Marcos" editar o texto com "If-Match" igual à versão atual
    Then o comentário deve exibir "(editado)" e a auditoria "comment.update" deve guardar hash e tamanho antes e depois
    When "Marcos" excluir o comentário
    Then o comentário deve aparecer como "Comentário excluído pelo autor" e a API não deve devolver seu conteúdo

  Scenario: [Validação] Formatação não permitida
    When "Marcos" enviar um comentário com um nó "image" ou um link "javascript:alert(1)"
    Then a API deve responder 422 com código "RICH_TEXT_INVALID"
    And nenhum comentário deve ser criado

  Scenario: [Validação] Edição após o prazo e seção inexistente
    Given que "Marcos" publicou um comentário há 16 minutos
    When "Marcos" tentar editá-lo
    Then a API deve responder 409 com código "COMMENT_EDIT_WINDOW_EXPIRED" e a mensagem "O prazo de 15 minutos para editar terminou."
    When "Marcos" comentar o ETP com "sectionKey" "SECAO_INEXISTENTE"
    Then a API deve responder 422 com código "SECTION_NOT_IN_TEMPLATE"

  Scenario: [Validação] Processo encerrado é somente leitura
    Given que o processo "0012/2026" está "COMPLETED"
    When "Marcos" tentar comentar
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"
    And a aba deve exibir "Este processo está encerrado; os comentários estão disponíveis apenas para leitura."

  Scenario: [Permissão] Usuário sem COMMENT_CREATE e edição por terceiro
    Given que "Tatiane" possui apenas o perfil "SOMENTE_LEITURA" com escopo que cobre o processo
    When "Tatiane" abrir a aba "Comentários"
    Then deve ver os comentários sem o compositor
    When "Tatiane" enviar POST para "/api/v1/processes/{id}/comments"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    When "Cláudia" tentar editar um comentário de "Marcos"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Permissão] Moderação com motivo
    Given que "Patrícia" possui "COMMENT_MODERATE" com escopo "TENANT"
    When "Patrícia" remover o comentário de "Cláudia" com o motivo "Contém dados pessoais de terceiro."
    Then o comentário deve aparecer como "Comentário removido por moderação"
    And deve existir a entrada "COMMENT_REMOVED" na timeline
    And deve gerar auditoria "comment.moderate" com o motivo em "metadata"
    And o evento "CommentDeleted" deve ter "byModerator" verdadeiro

  Scenario: [Permissão] Comentário em documento com orçamento sigiloso
    Given que o processo tem orçamento sigiloso e a pesquisa de preços está "RESTRICTED"
    And "Marcos" comentou a pesquisa de preços
    When "Cláudia", sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" e sem custódia, listar os comentários
    Then o comentário deve vir com "body" nulo e "bodyMasked" verdadeiro
    And a interface deve exibir "Comentário em documento com orçamento sigiloso — conteúdo restrito"

  Scenario: [Tenant incorreto] Comentário e documento de outro tenant
    Given que existe o comentário "C9" no tenant "Prefeitura B"
    When "Marcos" enviar DELETE para "/api/v1/comments/C9"
    Then a API deve responder 404 com código "COMMENT_NOT_FOUND"
    When "Marcos" comentar o processo "0012/2026" informando "documentId" de documento do tenant "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" em "documentId"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Marcos" enviou um comentário com a chave "K7" e recebeu 201
    When a mesma requisição for reenviada com a chave "K7"
    Then a API deve responder 201 com o mesmo comentário e "Idempotent-Replayed: true"
    And deve existir apenas um comentário, uma entrada de timeline e um evento "CommentCreated"

  Scenario: [Concorrência] Edição do autor concorrente com moderação
    Given que "Marcos" e "Patrícia" carregaram o comentário na versão 1
    When "Patrícia" remover o comentário por moderação
    And "Marcos" enviar a edição com "If-Match" igual a "1"
    Then a API deve responder 412 com código "VERSION_CONFLICT" para "Marcos"
    And o comentário deve permanecer removido

  Scenario: [Falha de banco] Banco indisponível ao comentar
    Given que o banco de dados fica indisponível durante a transação
    When "Marcos" publicar um comentário
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And nenhum comentário, timeline, auditoria ou evento deve ser persistido
    And o texto deve permanecer no compositor com a mensagem e o correlationId

  Scenario: [Falha de integração] Fila de notificações indisponível
    Given que o relay do outbox e a fila "notifications" estão indisponíveis
    When "Marcos" responder a um comentário de "Cláudia"
    Then a resposta deve ser criada e a API deve responder 201
    And o evento "CommentCreated" deve permanecer "PENDING" no outbox
    And quando a fila voltar "Cláudia" deve receber uma única notificação "COMMENT_REPLY"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise o comentário." | Mantém texto; destaca o compositor |
| Formatação/link não permitidos | 422 | `RICH_TEXT_INVALID` | "O comentário contém formatação não permitida." | Mantém texto; sugere remover a formatação |
| Seção inexistente | 422 | `SECTION_NOT_IN_TEMPLATE` | "Seção inexistente neste documento." | Recarrega as seções do editor |
| Processo encerrado | 409 | `INVALID_PROCESS_STATUS` | "Este processo está encerrado; os comentários estão disponíveis apenas para leitura." | Troca compositor por aviso |
| Prazo de edição vencido | 409 | `COMMENT_EDIT_WINDOW_EXPIRED` | "O prazo de 15 minutos para editar terminou." | Fecha edição; texto copiável |
| Alvo cancelado ou comentário excluído | 409 | `INVALID_STATE` | "Não é possível comentar um documento cancelado." | Fecha edição |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não pode comentar neste processo." | Modo leitura |
| Processo/comentário inexistente ou não visível | 404 | `PROCESS_NOT_FOUND` / `COMMENT_NOT_FOUND` | "Comentário não encontrado." | Remove o item e recarrega a lista |
| Versão divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O comentário foi alterado por outra pessoa." | Recarrega a thread |
| Chave reutilizada / em processamento | 422 / 409 | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | "Este comentário já foi enviado." | Nova chave / aguarda 2 s |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Dependência indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível publicar agora. Tente novamente." | Mantém texto; exibe correlationId |

## Dependências
- **Stories:** US-001 (processo), US-059 (projeção na timeline). Indiretas: US-065 (documentos e status), US-108 (seções do template), US-097 (autorização e participação), US-012 (participantes), US-013 (sigilo), US-073 (auditoria), US-082 (outbox), US-111 (entrega de `COMMENT_REPLY`), US-060 (exibição da timeline), US-072 (menções).
- **Decisões/ADRs:** DEC-010, DEC-023, DEC-024, DEC-025, DEC-030, DEC-034, DEC-036, DEC-056, DEC-104, DEC-105, DEC-161, DEC-183; PEND-11.
- **Configurações:** nenhuma específica (prazo de edição fixo em 15 min).
- **Lacunas nas fontes canônicas:**
  1. ~~Código para prazo de edição vencido~~ — resolvida: `COMMENT_EDIT_WINDOW_EXPIRED` (409) já consta em api.md §2.2.
  2. events.md §5 define `COMMENT_ADDED` sempre `STANDARD`; esta story exige `BUDGET_RESTRICTED` quando o documento-alvo for `RESTRICTED` (DEC-030). Atualizar events.md §5.
  3. `ProcessTimelineEntry` é imutável: o `excerpt` de comentário excluído pelo autor continuaria visível. Proposta: o apresentador de PRC-12 (US-060) suprime `excerpt` quando o comentário estiver excluído ("Comentário excluído").
  4. Schema restrito de comentário em `packages/editor` (`commentContentSchema`) é proposta de nome; registrar junto a DEC-056.
  5. Decisão de somente leitura em status final deve ser registrada em decisions.md (aditivo a DEC-013).

## Impacto técnico
- Primeira gravação de conteúdo rico de usuário fora de documentos: o validador estrito do schema de comentário é ponto de segurança (XSS — RS-03) e deve ter testes de fuzzing.
- Leitura de alvo documento e de visibilidade via `ProcessAccessPort` e fachada de `document` (architecture.md §3.3), sem importar módulos de nível superior.
- Listagem com threads: duas consultas (raízes paginadas + respostas das raízes da página) evitam N+1; índices dedicados.
- Mascaramento do `body` para documentos `RESTRICTED` no serializador central (`ConfidentialFieldsInterceptor`), não na tela.

## Backend
- **Módulo(s):** `collaboration` (dono); usa `ProcessAccessPort` (visibilidade, status, POL-09), fachada de `document` (`getCommentTarget`: processo, status, `confidentiality`, chaves de seção), `access` (`AuthorizationService`), `timeline` (projetor síncrono), `audit` (`AuditService`), `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateCommentCommand`, `UpdateCommentCommand`, `DeleteCommentCommand` (autor ou moderação), `ListCommentsQuery`.
- **Domínio:** `Comment.create/edit/deleteByAuthor/moderate` (RN-CMT-01..12); value object `CommentContent` (valida schema, deriva `bodyText`, extrai links e menções); política `CommentPolicy` (autor, janela de 15 min, status do processo).
- **Transação:** inserção/alteração do comentário + timeline + auditoria + outbox em uma transação; `SELECT … FOR SHARE` no processo para ler o status de forma consistente.
- **Serialização:** `CommentPresenter` com `canEdit`, `editableUntil`, `canDelete`, `canModerate`, `bodyMasked`, `isDeleted`, `deletedByModerator`.

## Frontend
- **Tela(s):** SCR-006 aba Comentários (`/processos/[id]?aba=comentarios`); painel lateral nos editores SCR-007, SCR-008, SCR-009, SCR-011, SCR-012 e SCR-105.
- **Componentes:** `CommentsPanel`, `CommentThread`, `CommentItem` (menu "Mais": Editar, Excluir, Remover por moderação), `CommentComposer` (TipTap com extensões restritas de `packages/editor`), `ModerationDialog`, `SectionCommentBadge` (contagem por seção), `ConfidentialBudgetHint`.
- **Dados:** TanStack Query `['t', tenantId, 'process', id, 'comments', filtros]` com `useInfiniteQuery`; refetch ao focar a janela e a cada 60 s com a aba visível; `Idempotency-Key` por envio; invalida `['t', tenantId, 'process', id, 'timeline']` após mutações.
- **Estados:** skeleton; vazio ("Ainda não há comentários. Use este espaço para discutir a instrução do processo."); erro com "Tentar novamente"; envio com botão em carregamento.
- **Acessibilidade e responsividade:** cada comentário é um `article` com rótulo "Comentário de {autor}, {data}"; barra de formatação operável por teclado; `Ctrl+Enter` envia, `Esc` cancela edição; confirmação de exclusão com foco gerenciado; em < 768 px o painel do editor vira folha inferior e a aba ocupa a largura total.

## Banco de dados
- **Tabelas:** `comments` (escrita), `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** `comments` conforme entities.md §4.9 (Padrão + SD), RLS `ENABLE`/`FORCE`, FKs compostas para `processes`, `documents` e `comments` (pai); checks `target_type <> 'DOCUMENT' OR document_id IS NOT NULL`, `target_type <> 'PROCESS' OR (document_id IS NULL AND section_key IS NULL)` e `parent_id IS DISTINCT FROM id`.
- **Índices:** `(tenant_id, process_id, created_at DESC)`; `(tenant_id, document_id, section_key)`; `(tenant_id, parent_id)`; parcial `(tenant_id, process_id, created_at DESC, id DESC) WHERE parent_id IS NULL` para paginação de raízes.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| CMT-01 | GET | `/api/v1/processes/{id}/comments` | `?cursor&limit&targetType&documentId&sectionKey&parentId` | `200 { data: [Comment + replies[] + replyCount], meta: { nextCursor, hasMore } }` | 200, 404, 422 |
| CMT-02 | POST | `/api/v1/processes/{id}/comments` | `{ body, targetType, documentId?, sectionKey?, parentId? }` + `Idempotency-Key` | `201 { data: Comment }` + `Location`, `ETag` | 201, 403, 404, 409, 422, 429, 503 |
| CMT-03 | PATCH | `/api/v1/comments/{id}` | `{ body }` + `If-Match` | `200 { data: Comment }` + `ETag` | 200, 403, 404, 409, 412, 422, 428 |
| CMT-04 | DELETE | `/api/v1/comments/{id}` | `{ reason? }` (obrigatório na moderação) + `If-Match` | `204` | 204, 403, 404, 409, 412, 422, 428 |

`Comment`: `{ id, processId, targetType, document: { id, code, title } | null, sectionKey, parentId, author: { id, name, departmentName }, body | null, bodyMasked, createdAt, editedAt, isDeleted, deletedByModerator, deletionReason (só autor/moderador), canEdit, editableUntil, canDelete, canModerate, version }`.

## Logs
- `info` `comment.created` / `comment.updated` / `comment.deleted` — `commentId`, `processId`, `targetType`, `isReply`, `byModerator`, `bodyLength`, `durationMs`, `correlationId`.
- `warn` `comment.rich_text_rejected` — nó/marca/protocolo rejeitado (somente o nome do nó, nunca o conteúdo).
- `warn` `idempotency.store_unavailable` — Redis indisponível.
- `error` `comment.command_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** texto do comentário, `bodyText`, URLs dos links, motivo da moderação.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `comment.create` | `DATA_CHANGE` | Criação/resposta | `changes`: `body` como `{ sha256, length }`; `metadata`: `processCode`, `targetType`, `documentCode?`, `sectionKey?`, `parentId?`, `idempotencyKey` |
| `comment.update` | `DATA_CHANGE` | Edição | `changes`: `body` antes/depois como `{ sha256, length }` |
| `comment.delete` | `DATA_CHANGE` | Exclusão pelo autor | `metadata`: `processCode`, `hadReplies` |
| `comment.moderate` | `DATA_CHANGE` | Remoção por moderação | `metadata`: `processCode`, `authorId`, `reason` |
| `access.denied` | `ACCESS` | Sem permissão | `reasonCode` = `COMMENT_CREATE` / `COMMENT_MODERATE` |

## Testes necessários
- **Unitários:** `CommentContent` (schema, protocolos, limites, derivação de `bodyText`); `CommentPolicy` (janela de 15 min nas bordas 14:59/15:01, status do processo, autor × moderador); herança de alvo nas respostas.
- **Integração (Testcontainers):** transação única (falha induzida após a timeline → nada persiste); RLS e FKs compostas (documento/pai de outro tenant); mascaramento `RESTRICTED`; paginação de threads sem N+1.
- **Segurança:** fuzzing do validador com payloads XSS conhecidos (OWASP) e JSON profundo/grande; render em modo leitura sem HTML cru.
- **API/contrato:** CMT-01..04 conforme api.md; cabeçalhos `ETag`, `Location`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** matriz de perfis (com e sem `COMMENT_CREATE`), participação `OBSERVER`/`CONSULTANT` expirada, moderação com escopo que não cobre o processo; IDs de outro tenant → 404/422.
- **Concorrência:** edição × moderação (412); duas criações com a mesma chave (replay ou `IDEMPOTENCY_IN_PROGRESS`).
- **E2E (Playwright):** comentar, responder, editar, excluir e moderar; comentário ancorado em seção do ETP; processo encerrado em modo leitura; uso em 360 px.
- **Acessibilidade/performance:** axe sem violações sérias; criação p95 < 300 ms; listagem de 20 threads p95 < 400 ms com 5.000 comentários no processo.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Permissões, participação e POL-09 aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria `comment.*`, eventos e entradas de timeline verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de CMT-01..04 compatível com api.md
- [ ] Logs sem conteúdo de comentários; métricas `cf_comments_created_total` e latência
- [ ] Acessibilidade (axe) e responsividade (360 px) verificadas
- [ ] Revisão de código e de segurança (validador de rich text) aprovadas
- [ ] Lacunas registradas levadas a events.md, api.md e decisions.md

## Estimativa
**M** — CRUD com threads de um nível sobre padrões já estabelecidos (transação, auditoria, outbox, timeline), mas com validador de rich text estrito, mascaramento por sigilo, regras de janela de edição e moderação, e painel reutilizado em seis editores.

## Prioridade
**P0** — a discussão da instrução dentro do processo é parte do núcleo do MVP 1 (substitui e-mail e mensageiros) e é pré-requisito das menções (US-072).
