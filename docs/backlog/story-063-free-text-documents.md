---
id: US-063
title: "Criar documento livre a partir de template"
epic: EP-011
feature: FT-039
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-015, US-065]
modules: [document, workflow, access]
screens: [SCR-105]
endpoints: [DOC-02, DOC-05]
permissions: [DOCUMENT_CREATE, DOCUMENT_UPDATE]
events: [DocumentCreated]
---

# US-063 — Criar documento livre a partir de template

## Título
Criar documento livre a partir do modelo do tipo, com numeração e salvamento automático

## Descrição
**Como** redator do processo, **quero** criar um documento livre (despacho, ofício, nota técnica…) a partir do modelo configurado para o tipo e editar suas seções com salvamento automático, **para** produzir o expediente formal do processo sem perder trabalho e com numeração própria.

Ao escolher um tipo `FREE_TEXT` no painel de documentos (US-062), o sistema cria o documento a partir do modelo padrão publicado do tipo, atribui numeração (quando habilitada) e abre o editor de seções (SCR-105). Cada seção é salva automaticamente conforme o usuário digita, sem criar uma nova versão — a versão só nasce quando o documento é finalizado ou submetido (US-065).

## Contexto
- Hoje despachos, ofícios e notas técnicas são produzidos fora do sistema (editor de texto, e-mail), sem numeração única nem rastreabilidade.
- DEC-017 trata esses artefatos como `Document` com `kind = FREE_TEXT`: as seções vêm do `DocumentTemplateVersion` publicado do tipo (`DocumentType.defaultTemplateId` → `DocumentTemplate.currentPublishedVersionId`) e o conteúdo é rich text (TipTap/ProseMirror JSON, DEC-056).
- O salvamento automático por seção (`DOC-05`) reaproveita o mecanismo e os contratos (revisão por seção, `SECTION_REVISION_CONFLICT`) já estabelecidos pela US-015, evitando duplicar essa lógica de borda para cada tipo de documento que precise de autosave.
- Depende de US-065 para a validação de completude e as transições de status (finalizar/submeter) que vêm depois da criação.

## Objetivo
Permitir criar e começar a redigir um documento livre em menos de um minuto, com numeração atribuída de forma consistente e sem perda de dados por falha de rede durante a edição (autosave confiável).

## Persona
- **Principal:** redator do processo (`REQUISITANTE`, `GESTOR_CONTRATACOES`) com `DOCUMENT_CREATE` no escopo do processo.
- **Secundárias:** participante do processo com papel `COLLABORATOR`/`CONSULTANT` (via POL-02); `GESTOR_CONTRATO`.

## Pré-condições
- Processo em `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Existe ao menos um `DocumentType` ativo com `kind = FREE_TEXT`, permitido na etapa atual, com modelo padrão publicado.
- Usuário com `DOCUMENT_CREATE` no escopo do processo e custódia atual **ou** participação `COLLABORATOR`/`CONSULTANT` (POL-02).

## Fluxo principal
1. No painel de documentos (US-062), o usuário escolhe um tipo `FREE_TEXT` no menu "Criar documento".
2. O sistema abre um diálogo pedindo **Título** (obrigatório) e, opcionalmente, **Responsável** (padrão: o próprio usuário).
3. O usuário confirma; o front envia `POST /api/v1/processes/{id}/documents` com `Idempotency-Key`.
4. A API, em uma transação: valida que o tipo está ativo, é `FREE_TEXT` e permitido na etapa atual; autoriza `DOCUMENT_CREATE` + POL-02; resolve o modelo padrão publicado do tipo; atribui numeração (se `numberingEnabled`); monta `draftContent.sections` a partir de `DocumentTemplateVersion.sections` (com variáveis resolvidas no servidor); insere o `Document` (`status = DRAFT`); grava auditoria `document.create`; publica `DocumentCreated` no outbox e a entrada `DOCUMENT_CREATED` na timeline; confirma.
5. A API responde **201**; o front navega para SCR-105 (`/processos/[id]/documentos/[docId]`).
6. O editor mostra as seções na ordem do modelo (`SectionDefinition.order`), com texto de ajuda (`helpText`), base legal (`legalBasis`) quando houver, e o estado de cada seção (vazia, preenchida ou não se aplica).
7. Ao digitar, o front aguarda um intervalo curto (debounce) e chama `PUT /api/v1/documents/{id}/sections/{sectionKey}` com `If-Match: "s{revision}"`; ao ter sucesso, mostra "Salvo às HH:mm".
8. Em seções com `requirement = REQUIRED_OR_JUSTIFY`, o usuário pode marcar "Não se aplica" e informar uma justificativa (mínimo 20 caracteres).
9. O usuário pode continuar editando depois; o documento permanece em `DRAFT` até ser finalizado ou submetido (US-065).

## Fluxos alternativos
- **FA-01 — Falha de rede durante o autosave:** o front mantém as alterações localmente, mostra "Salvando…"/"Não foi possível salvar" e tenta novamente; nada é perdido enquanto a aba permanecer aberta.
- **FA-02 — Conflito de revisão da seção:** outro usuário salvou a mesma seção primeiro; a API responde 412 `SECTION_REVISION_CONFLICT`; o front oferece "Ver versão atual" ou "Sobrescrever com minhas alterações".
- **FA-03 — Seção excede o tamanho máximo:** o front avisa antes de enviar quando o texto passa de `maxChars` (padrão 50.000) ou se aproxima do limite de 1 MB por seção.
- **FA-04 — Reenvio da criação por instabilidade de rede:** o front reenvia com a mesma `Idempotency-Key`; a API devolve a mesma resposta (`Idempotent-Replayed: true`), sem duplicar o documento.
- **FA-05 — Tipo sem modelo publicado:** a opção não deveria aparecer no menu (US-062), mas se chamada diretamente a criação é bloqueada (ver Regras de negócio).

## Regras de negócio
- **RN-DOC-21** — A criação (`DOC-02`) exige `documentTypeId` de um `DocumentType` ativo do tenant com `kind = FREE_TEXT`; tipo inativo ou de outro `kind` → `VALIDATION_ERROR` com `REFERENCE_INACTIVE`/`REFERENCE_NOT_FOUND` no campo `documentTypeId`.
- **RN-DOC-22** — O documento nasce a partir do `DocumentTemplate` indicado por `DocumentType.defaultTemplateId` e de sua `currentPublishedVersionId`; sem modelo padrão com versão `PUBLISHED`, a criação é bloqueada com `VALIDATION_ERROR`/`REFERENCE_INACTIVE` no campo `documentTypeId` ("Este tipo de documento não tem um modelo publicado. Fale com o administrador.").
- **RN-DOC-23** — `draftContent.sections` é inicializado com uma entrada por `SectionDefinition.key` do modelo: `state = FILLED` quando houver `defaultContent` (variáveis resolvidas no servidor, entities.md §5.2) ou `EMPTY` caso contrário; `revision = 1` em todas.
- **RN-DOC-24** — Quando `DocumentType.numberingEnabled`, a numeração segue `numberingMask` do tipo (ou `numbering.document.defaultMask`), com sequência por `(tenant, documentTypeId, ano)`, atribuída na criação, de forma análoga à numeração de processos (RN-PROC-04) e de tipos (RN-DOC-05 em US-061).
- **RN-DOC-25** — `title` é obrigatório e de texto livre (5 a 250 caracteres); `code` é gerado pelo sistema (ex.: "Despacho 0007/2026") e nunca é editável pelo usuário.
- **RN-DOC-26** — `responsibleId` tem como padrão o usuário criador; pode ser atribuído a outro usuário com acesso ao processo no momento da criação (reatribuição posterior é feita por `DOC-04`, fora desta story).
- **RN-DOC-27** — O autosave de seção (`DOC-05`, mecanismo da US-015) nunca cria `DocumentVersion` nem avança o `status` do documento (DEC-017); apenas atualiza `draftContent.sections[key]`, incrementando a `revision` da seção e o `draftRevision` do documento.
- **RN-DOC-28** — Seção com `requirement = REQUIRED` só é satisfeita com `state = FILLED`; `REQUIRED_OR_JUSTIFY` aceita `FILLED` ou `NOT_APPLICABLE` com `justification` (mínimo 20 caracteres); `OPTIONAL` aceita qualquer estado, inclusive `EMPTY`.
- **RN-DOC-29** — O conteúdo da seção é TipTap/ProseMirror JSON (DEC-056): nós/marks fora do schema permitido de `packages/editor` são rejeitados (`RICH_TEXT_INVALID`); limite de 1 MB por seção e de `maxChars` da `SectionDefinition` (padrão 50.000).
- **RN-DOC-30** — Criar ou editar exige que o tipo esteja permitido na etapa atual do processo (`WorkflowStage.documentTypeCodes` vazio ou contendo o `code` do tipo) e que o processo esteja em `DRAFT`/`IN_PROGRESS`/`RETURNED` (POL-02); do contrário, `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422) ou `DOCUMENT_NOT_EDITABLE` (409).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo de documento | `documentTypeId` | seleção | Sim | `FREE_TEXT` ativo, permitido na etapa | — |
| Título | `title` | texto curto | Sim | 5–250 caracteres | — |
| Responsável | `responsibleId` | seleção | Não | usuário com acesso ao processo | criador |
| Conteúdo da seção | `sections[key].content` | rich text (TipTap) | Conforme `requirement` | RN-DOC-28/29 | vazio ou `defaultContent` |
| Não se aplica | `sections[key].state = NOT_APPLICABLE` | interruptor | Não | só em `REQUIRED_OR_JUSTIFY`/`OPTIONAL` | `false` |
| Justificativa | `sections[key].justification` | texto longo | Condicional (`NOT_APPLICABLE`) | mínimo 20 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Título ausente ou fora do limite | Front + API | "Informe um título entre 5 e 250 caracteres." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Tipo inexistente, inativo, de outro `kind` ou outro tenant | API | "Selecione um tipo de documento válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-03 | Tipo sem modelo publicado | API | "Este tipo de documento não tem um modelo publicado. Fale com o administrador." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-04 | Tipo não permitido na etapa atual | API | "Este tipo de documento não é permitido na etapa atual." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-05 | Conteúdo de seção fora do schema TipTap permitido | API | "Este conteúdo contém formatação não suportada." | `RICH_TEXT_INVALID` |
| V-06 | Seção acima de 1 MB ou `maxChars` | Front + API | "O texto desta seção excede o limite permitido." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-07 | "Não se aplica" sem justificativa suficiente | Front + API | "Justifique por que esta seção não se aplica (mín. 20 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-08 | `If-Match` de seção divergente | API | "Esta seção foi alterada por outra pessoa." | `SECTION_REVISION_CONFLICT` |
| V-09 | Documento não editável (status fora de `DRAFT`/`RETURNED`) | API | "Este documento não pode ser editado no momento." | `DOCUMENT_NOT_EDITABLE` |

## Permissões
- **Permissão:** `DOCUMENT_CREATE` para criar (`DOC-02`); `DOCUMENT_UPDATE` para editar seções (`DOC-05`).
- **Políticas:** POL-02 — permissão do tipo + (custódia do processo **ou** participação `COLLABORATOR`/`CONSULTANT`) + documento em `DRAFT`/`RETURNED` + tipo permitido na etapa atual + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`. Aplica-se tanto à criação quanto à edição de seções.
- **MFA:** não exigido (`DOCUMENT_CREATE`/`DOCUMENT_UPDATE` são risco médio), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** tipo não aparece no menu "Criar documento" (US-062); chamada direta a `DOC-02`/`DOC-05` responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` | `document.created.<type>` | Commit da criação | Payload: `documentId`, `documentTypeCode`, `kind = FREE_TEXT`, `code?`, `title`, `templateVersionId` (events.md §4) |

Projeção síncrona na mesma transação: entrada `DOCUMENT_CREATED` na timeline do processo. O autosave de seção (`DOC-05`) não gera evento de domínio, apenas auditoria coalescida (`document.draft_update`, ver RN-DOC-54 em US-065).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. Não há `NotificationType` para criação ou edição de documento (apenas timeline); o autor já está ciente da própria ação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar documento livre a partir de template

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está em "IN_PROGRESS" na etapa "Estudos preliminares"
    And a etapa atual permite o tipo "DESPACHO"
    And existe o tipo de documento "DESPACHO" (`kind = FREE_TEXT`) com modelo padrão publicado
    And "Ana" tem `DOCUMENT_CREATE` e `DOCUMENT_UPDATE`, e é a custodiante atual do processo

  Scenario: [Sucesso] Criar um despacho e salvar automaticamente a primeira seção
    When "Ana" criar um documento do tipo "DESPACHO" com título "Encaminhamento à Secretaria de Obras"
    Then o documento deve ser criado com status "DRAFT" e código "Despacho 0001/2026"
    And deve ser gerado o evento "DocumentCreated"
    And deve existir uma entrada "DOCUMENT_CREATED" na timeline
    When "Ana" digitar o texto da seção "Assunto" e aguardar o salvamento automático
    Then a seção deve ficar com `state = "FILLED"` e `revision = 2`
    And nenhuma "DocumentVersion" deve ser criada pelo autosave

  Scenario: [Validação] Seção excede o limite de caracteres
    When "Ana" digitar um texto com mais de 50.000 caracteres na seção "Assunto"
    Then o sistema deve exibir "O texto desta seção excede o limite permitido."
    And "PUT /api/v1/documents/{id}/sections/assunto" deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_LONG"

  Scenario: [Permissão] Usuário sem DOCUMENT_CREATE
    Given que "Bruno" não tem `DOCUMENT_CREATE`
    When o menu "Criar documento" for aberto por "Bruno"
    Then a opção "DESPACHO" não deve aparecer
    When "Bruno" chamar "POST /api/v1/processes/{id}/documents" com o tipo "DESPACHO"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Tipo de documento de outro tenant
    Given que existe um tipo com código "DESPACHO" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", enviar `documentTypeId` desse tipo de outro tenant
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "documentTypeId"

  Scenario: [Duplicidade] Reenvio da criação com a mesma chave de idempotência
    Given que "Ana" criou o despacho "Despacho 0001/2026" com a chave "K1"
    When a mesma requisição de criação for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo documento e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas um documento criado

  Scenario: [Concorrência] Duas edições simultâneas da mesma seção
    Given que a seção "Assunto" está na revisão 3
    When "Ana" e "Carla" salvarem a seção simultaneamente, ambas a partir da revisão 3
    Then uma requisição deve ser aceita e avançar para a revisão 4
    And a outra deve receber 412 com código "SECTION_REVISION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao criar o documento
    Given que o banco de dados está indisponível
    When "Ana" tentar criar um documento do tipo "DESPACHO"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum documento, numeração, auditoria ou evento deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível durante a criação
    Given que o relay do outbox está indisponível
    When "Ana" criar um documento válido do tipo "DESPACHO"
    Then o documento deve ser criado e a API deve responder 201
    And o evento "DocumentCreated" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Título inválido | 422 | `VALIDATION_ERROR` | "Informe um título entre 5 e 250 caracteres." | Marca o campo |
| Tipo inválido/inativo/outro tenant | 422 | `VALIDATION_ERROR` | "Selecione um tipo de documento válido." | Recarrega opções |
| Tipo sem modelo publicado | 422 | `VALIDATION_ERROR` | "Este tipo de documento não tem um modelo publicado." | Oculta a opção; orienta contato com admin |
| Tipo não permitido na etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "Este tipo de documento não é permitido na etapa atual." | Oculta a opção no menu |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este documento não pode ser editado no momento." | Desabilita o editor |
| Conflito de revisão de seção | 412 | `SECTION_REVISION_CONFLICT` | "Esta seção foi alterada por outra pessoa." | Oferece ver/sobrescrever |
| Conteúdo rich text inválido | 422 | `RICH_TEXT_INVALID` | "Este conteúdo contém formatação não suportada." | Reverte para o último conteúdo salvo |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta opção/ação |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém conteúdo local; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém conteúdo local |

## Dependências
- **Stories:** US-015 (mecanismo de autosave de seção reaproveitado por `DOC-05`); US-065 (validação de completude e transições após a criação); US-062 (ponto de entrada da criação); US-061/US-108 (tipo e modelo publicado, indiretas).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-028, DEC-056; ADR-006.
- **Configurações:** `numbering.document.defaultMask`.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita integralmente o endpoint e o contrato de autosave estabelecidos pela US-015 (`DOC-05`); nenhuma rota nova de edição é criada aqui.
- Numeração de documento usa o mesmo padrão de contenção por `UPDATE … RETURNING` já estabelecido para processos (US-001) e tipos (US-061), agora com chave `(tenant, documentTypeId, ano)`.
- Sanitização e validação de rich text ocorrem sempre no servidor (DEC-056); o editor no cliente é apenas a superfície de edição.

## Backend
- **Módulo(s):** `document` (dono); usa `workflow` (etapa atual), `access` (POL-02), `platform` (`NumberingFacade`, `OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateFreeTextDocumentCommand` → `CreateDocumentHandler` (reaproveita a fábrica `Document.create` da US-065 com `kind = FREE_TEXT`); `UpdateDocumentSectionCommand` (inalterado, da US-015).
- **Domínio:** `Document.create(props)` (RN-DOC-21..26); value object `DraftContent` inicializado a partir de `DocumentTemplateVersion.sections`.
- **Transação:** criação em uma transação (validação → autorização → numeração → inserção → auditoria → outbox → timeline → commit); autosave de seção permanece na transação curta já definida pela US-015.

## Frontend
- **Tela(s):** SCR-105 (`/processos/[id]/documentos/[docId]`).
- **Componentes:** `CreateDocumentDialog`, `SectionEditor` (TipTap), `SectionStatusIndicator`, `NotApplicableToggle` + `JustificationField`, `AutosaveIndicator`.
- **Estados:** diálogo de criação com carregamento; editor com skeleton nas seções; indicador "Salvando…"/"Salvo às HH:mm"/"Não foi possível salvar".
- **Acessibilidade e responsividade:** navegação entre seções por teclado; `aria-live` para o status do autosave; editor em coluna única em telas < 768 px.

## Banco de dados
- **Tabelas:** escrita em `documents`, `number_sequences`, `audit_logs`, `outbox_events`, `process_timeline_entries` (na criação); `documents` (em cada autosave, sem nova linha).
- **Migrações:** nenhuma (reaproveita o esquema de `documents`/`document_templates` de US-061/US-065).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, code) WHERE code IS NOT NULL` (já existente em `documents`).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-02 | POST | `/api/v1/processes/{id}/documents` | `{ documentTypeId, title, responsibleId? }` + `Idempotency-Key` | `201 { data: Document }` com `code`, `status`, `draftContent`, `version` | 201, 403, 404, 409, 422, 429, 503 |
| DOC-05 | PUT | `/api/v1/documents/{id}/sections/{sectionKey}` | `{ content, state, justification? }` + `If-Match: "s{revision}"` | `200 { data: { state, revision, updatedAt } }` | 200, 403, 409, 412, 422, 428, 503 |

## Logs
- `info` `document.created` — `documentId`, `documentTypeCode`, `code`, `durationMs`.
- `warn` `document.section_save_conflict` — `documentId`, `sectionKey`.
- `error` `document.create_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo das seções (rich text) nem justificativas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Commit da criação | `metadata`: `documentTypeCode`, `templateVersionId`, `code` |
| `document.draft_update` | `DATA_CHANGE` | Autosave (coalescida — ver RN-DOC-54, US-065) | `metadata`: `sectionKey`, intervalo de revisões, variação de tamanho |

## Testes necessários
- **Unitários:** fábrica `Document.create` com `kind = FREE_TEXT` (RN-DOC-21..26); inicialização de `draftContent` a partir do modelo; validação de seção (`requirement` × `state`).
- **Integração (Testcontainers PostgreSQL + Redis):** numeração concorrente por tipo; RLS multi-tenant; autosave com conflito de revisão.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `Idempotency-Key`/`If-Match`.
- **RBAC e multi-tenant:** `DOCUMENT_CREATE`/`DOCUMENT_UPDATE` com e sem custódia/participação; tipo de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas criações simultâneas com a mesma `Idempotency-Key`; duas edições simultâneas da mesma seção.
- **E2E (Playwright):** criar documento pelo painel, editar seções, marcar "não se aplica", recarregar e confirmar persistência.
- **Acessibilidade/performance:** axe no editor rich text; autosave com p95 < 300 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `DOCUMENT_CREATE`/`DOCUMENT_UPDATE` e POL-02 aplicados na API; UI oculta o que não é permitido
- [ ] Numeração e `draftContent` inicial verificados em teste de integração
- [ ] Auditoria `document.create` e evento `DocumentCreated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `DOC-02` compatível com api.md (DOC-05 inalterado, já coberto pela US-015)
- [ ] Logs sem dados sensíveis; métricas de criação e de autosave
- [ ] Editor acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita os padrões de numeração (US-061) e de autosave de seção (US-015) já estabelecidos; o esforço concentra-se no fluxo específico de criação `FREE_TEXT` e nas regras de seção/justificativa.

## Prioridade
**P1** — necessária para o expediente formal do processo (despachos, ofícios), mas não bloqueia a jornada crítica de DFD/ETP/TR do MVP 1.
