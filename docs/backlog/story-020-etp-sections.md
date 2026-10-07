---
id: US-020
title: "Editar seções do ETP com autosave e \"não se aplica\" justificado"
epic: EP-003
feature: FT-011
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-015, US-019]
modules: [etp, document, process, access, audit, platform]
screens: [SCR-008]
endpoints: [ETP-03, DOC-05, DOC-08]
permissions: [ETP_UPDATE]
events: []
---

# US-020 — Editar seções do ETP com autosave e "não se aplica" justificado

## Título
Editar seções do ETP com autosave e "não se aplica" justificado

## Descrição
**Como** integrante da equipe de planejamento, **quero** editar o ETP seção por seção, com salvamento automático e a opção de marcar uma seção como "não se aplica" com justificativa, **para** redigir o estudo de forma incremental, sem perder conteúdo e sem preencher elementos que não fazem sentido para a contratação, registrando o motivo.

A tela do ETP (SCR-008) mostra uma navegação lateral com as 16 seções do template e um indicador de completude por seção (vazia, preenchida, não se aplica). Ao editar o texto de uma seção, o conteúdo é salvo automaticamente após uma pausa na digitação ou perda de foco (debounce de 1,5 s), sem criar uma nova versão do documento. Seções com `render` diferente de `TEXT` (como a tabela de alternativas, a tabela de itens e a lista de riscos) exibem o conteúdo estruturado correspondente, somente leitura nesta tela, além do texto complementar opcional. O usuário só pode editar enquanto o ETP estiver em `DRAFT` ou `RETURNED`.

## Contexto
- A exigência de cada seção (`REQUIRED`, `REQUIRED_OR_JUSTIFY`, `OPTIONAL`) foi definida na criação do ETP (US-019), a partir da configuração semeada do art. 18 (DEC-016). Seções `REQUIRED_OR_JUSTIFY` podem ficar como "não se aplica" desde que justificadas — ex.: o levantamento de mercado pode não existir quando há solução única no mercado, mas isso precisa estar registrado.
- Autosave por seção (DEC-182) e modelo documental híbrido (DEC-017/ADR-006): o texto de cada seção é TipTap JSON em `Document.draftContent.sections[sectionKey]`; o autosave atualiza o rascunho e a `revision` da seção, mas não gera `DocumentVersion` — versões só nascem em salvamento manual, submissão, finalização, importação, upload ou reabertura.
- Esta story não decide a completude de finalização do ETP (isso é da US-023); ela apenas informa visualmente o estado de cada seção, inclusive consultando a mesma leitura de validação usada pela US-065 (`DOC-08`) para destacar pendências sem bloquear a edição.
- Comentários ancorados por seção (US-071) são exibidos na barra lateral da seção ativa; esta story cobre apenas a navegação/edição, não a criação de comentários.

## Objetivo
Permitir que o usuário edite qualquer seção do ETP sem perda de dados (autosave concluído em menos de 2 s após parar de digitar, com indicador de status visível) e marque seções não aplicáveis com justificativa auditável, mantendo a navegação lateral sempre consistente com o estado real de cada seção.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`); colaboradores convidados ao processo (`COLLABORATOR`) quando autorizados a editar.

## Pré-condições
- Usuário autenticado, com `ETP_UPDATE` em escopo que cubra a unidade atual do processo, custódia do processo ou participação `COLLABORATOR`/`CONSULTANT` (POL-02).
- ETP existe, pertence a um processo visível ao usuário (DEC-024) e está em status `DRAFT` ou `RETURNED`.
- Tipo `ETP` permitido na etapa atual do processo.
- ETP foi criado (US-019), com as 16 seções do template já atribuídas.

## Fluxo principal
1. O usuário abre o ETP (SCR-008, `ETP-03`) e vê a navegação lateral com as 16 seções, cada uma com um ícone de estado (vazia, preenchida, não se aplica) calculado a partir de `DraftContent` e, complementarmente, das pendências retornadas por `DOC-08` (sem bloquear nada nesta tela).
2. O usuário seleciona uma seção de texto (ex.: `NEED_DESCRIPTION`) e edita o conteúdo no editor rich text.
3. Após 1,5 s sem digitar ou ao perder o foco, o front envia `PUT /api/v1/documents/{id}/sections/{sectionKey}` (`DOC-05`) com o conteúdo TipTap e `If-Match: "s<revision>"`; o indicador muda para "Salvando…" e depois "Salvo às HH:mm".
4. A API, com `app.tenant_id` definido: autoriza `ETP_UPDATE` + POL-02 (custódia/participação, status `DRAFT`/`RETURNED`, etapa); valida que `sectionKey` existe no template da versão vigente; valida o conteúdo TipTap contra o schema permitido e o limite de 1 MB; atualiza `draftContent.sections[sectionKey]` (conteúdo, `state = FILLED`, `revision += 1`, `updatedAt`, `updatedById`) e `draftRevision` do documento; grava auditoria coalescida `document.draft_update` (1 registro por documento/seção/usuário a cada 10 min).
5. A API responde **200** com a seção atualizada e o novo `ETag` de seção (`"s<revision>"`); a navegação lateral atualiza o ícone da seção para "preenchida".
6. Para marcar "Não se aplica", o usuário aciona o controle na própria seção, informa a justificativa (mínimo 20 caracteres) e confirma; o front envia o mesmo `PUT` com `state = NOT_APPLICABLE` e `justification`; a seção some do corpo principal e passa a exibir só a justificativa, com o ícone correspondente na navegação lateral.
7. Para seções com `render` estruturado (`ITEMS_TABLE`, `ALTERNATIVES_TABLE`, `RISK_LIST`), a tela carrega os dados pelas leituras do módulo correspondente (itens: `DOC-06`; alternativas: `ETP-05`) e exibe o quadro somente leitura, com link para a tela de gestão do respectivo conteúdo; o texto complementar (`allowNarrative`), se houver, segue o mesmo fluxo de autosave das seções `TEXT`.

## Fluxos alternativos
- **FA-01 — Conflito de edição concorrente:** se o `If-Match` da seção não corresponder à revisão atual (outro usuário salvou antes), a API responde `SECTION_REVISION_CONFLICT`; o front mostra o diálogo "Ver diferenças", "Manter a minha versão" (reenvia sobrescrevendo com nova revisão) ou "Descartar a minha e recarregar" (DEC-182).
- **FA-02 — Reverter "não se aplica" para preenchida:** ao voltar para `FILLED`, a `justification` anterior é descartada; o usuário deve informar o conteúdo da seção.
- **FA-03 — Seção abaixo do tamanho mínimo:** se o texto ficar abaixo do `minChars` da definição (quando houver), a seção permanece contabilizada como pendente na completude (via `DOC-08`, código `SECTION_TOO_SHORT`), mas o autosave não é bloqueado.
- **FA-04 — Falha de rede durante a digitação:** o rascunho é mantido em IndexedDB local; o indicador mostra "Erro ao salvar — tentando novamente"; ao reconectar, o front reenvia o autosave pendente.
- **FA-05 — ETP não editável:** se o ETP estiver `IN_REVIEW`, `FINALIZED`, `APPROVED`, `REJECTED` ou `CANCELED`, as seções abrem em modo somente leitura; o `PUT` de seção responde `DOCUMENT_NOT_EDITABLE`.
- **FA-06 — Conteúdo rich text fora do schema:** conteúdo colado com nós/marks não suportados é higienizado no front antes de enviar; se ainda assim passar algo inválido, a API responde `RICH_TEXT_INVALID` e o front mantém o rascunho local sem perder o texto digitado.

## Regras de negócio
- **RN-ETP-10** — Edição de seção é sempre por autosave (DEC-182): debounce de 1,5 s após digitação e ao perder foco; concorrência controlada pela `revision` da própria seção (`If-Match: "s<revision>"`); divergência → `SECTION_REVISION_CONFLICT` (412).
- **RN-ETP-11** — Marcar `NOT_APPLICABLE` exige `justification` com no mínimo 20 caracteres, independentemente da exigência (`requirement`) da seção; voltar para `FILLED` descarta a `justification` anterior. Para seções `REQUIRED`, a validação de completude (US-023) não aceita `NOT_APPLICABLE` como resolução — a seção segue pendente até ser preenchida; apenas `REQUIRED_OR_JUSTIFY` e `OPTIONAL` são encerradas por essa via.
- **RN-ETP-12** — Seções com `render` estruturado (`ALTERNATIVES_TABLE` → `ALTERNATIVES`; `ITEMS_TABLE` → `ESTIMATES`; `RISK_LIST` → `RISKS`) exibem o conteúdo tipado somente leitura nesta tela; a edição desse conteúdo ocorre nas telas/stories donas (alternativas: US-021; itens/estimativas: US-022; riscos: outra story do produto). O texto narrativo complementar dessas seções (`allowNarrative`, padrão `true`) segue as mesmas regras de autosave das seções `TEXT`.
- **RN-ETP-13** — A navegação lateral calcula a completude a partir do `state` de cada seção em `DraftContent` (`EMPTY`, `FILLED`, `NOT_APPLICABLE`) e, complementarmente, das pendências não bloqueantes de `DOC-08` (ex.: `SECTION_TOO_SHORT`); essa leitura nunca impede a edição — apenas informa.
- **RN-ETP-14** — Edição só permitida com o ETP em `DRAFT`/`RETURNED` (POL-02); `sectionKey` inexistente no template da versão vigente do documento → `SECTION_NOT_IN_TEMPLATE` (422).
- **RN-ETP-15** — Conteúdo rich text é validado contra o schema de nós/marks permitido (`packages/editor`) e limitado a 1 MB por seção (DEC-056); nó desconhecido ou acima do limite → `RICH_TEXT_INVALID` / `PAYLOAD_TOO_LARGE`.
- **RN-ETP-16** — Comentários ancorados por seção (US-071) são exibidos na barra lateral da seção ativa; não alteram `state` nem bloqueiam o autosave.
- **RN-ETP-17** — Toda alteração de seção é registrada em auditoria coalescida `document.draft_update` (1 registro por documento/seção/usuário a cada 10 minutos, com intervalo de revisões e variação de tamanho) — não em um registro por tecla/autosave.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Conteúdo da seção | `content` | rich text (TipTap JSON) | Condicional (RN-ETP-11) | ≤ `maxChars` (padrão 50.000); schema permitido; ≤ 1 MB | — |
| Estado da seção | `state` | enum (`SectionState`) | Sim | `EMPTY`\|`FILLED`\|`NOT_APPLICABLE` | `EMPTY` |
| Justificativa de "não se aplica" | `justification` | texto longo | Condicional (`state = NOT_APPLICABLE`) | ≥ 20 caracteres | — |
| *(sistema)* Revisão da seção | `revision` | int | — | incrementada a cada salvamento | `0` na criação |
| *(sistema)* Atualização | `updatedAt`, `updatedById` | — | — | — | gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `sectionKey` fora do template da versão | API | "Esta seção não existe neste modelo de ETP." | `SECTION_NOT_IN_TEMPLATE` |
| V-02 | ETP não está em `DRAFT`/`RETURNED` | API | "Este ETP não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-03 | `If-Match` de seção divergente | API | "Alguém salvou esta seção enquanto você editava." | `SECTION_REVISION_CONFLICT` |
| V-04 | `NOT_APPLICABLE` sem justificativa ou com menos de 20 caracteres | Front + API | "Explique por que esta seção não se aplica (mín. 20 caracteres)." | `VALIDATION_ERROR` (`TOO_SHORT`/`CONDITIONAL_REQUIRED`) |
| V-05 | Conteúdo acima de `maxChars` ou 1 MB | Front + API | "O texto desta seção excede o tamanho máximo permitido." | `VALIDATION_ERROR` (`TOO_LONG`) / `PAYLOAD_TOO_LARGE` |
| V-06 | Nó/mark não suportado no rich text | API | "Este conteúdo contém formatação não suportada. Remova-a e tente novamente." | `RICH_TEXT_INVALID` |
| V-07 | Sem permissão/escopo para editar | API | "Você não pode editar este ETP." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `ETP_UPDATE` com escopo que cubra a unidade atual do processo.
- **Políticas:** POL-02 (custódia/participação + status do documento + tipo permitido na etapa).
- **MFA:** não exigido (`ETP_UPDATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** seções abrem em modo somente leitura; `PUT` de seção responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio é publicado pelo autosave (DEC-017): atualização de rascunho não cria `DocumentVersion`. A auditoria coalescida `document.draft_update` é o único rastro. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: autosave é uma operação de rascunho, sem impacto em outros usuários além da indicação de conflito (FA-01). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Editar seções do ETP com autosave e "não se aplica" justificado

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o ETP "0003/2026" do processo "0012/2026", em status "DRAFT", sob custódia de "Carla"
    And "Carla" possui "ETP_UPDATE" sobre o processo

  Scenario: [Sucesso] Autosave da seção de texto
    Given que a seção "NEED_DESCRIPTION" está "EMPTY" com revisão 0
    When "Carla" digitar o texto da necessidade e parar de digitar por 1,5 segundo
    Then o front deve enviar "PUT /api/v1/documents/{id}/sections/NEED_DESCRIPTION" com "If-Match" igual a "s0"
    And a seção deve passar para o estado "FILLED" com revisão 1
    And o indicador deve exibir "Salvo às HH:mm"
    And deve gerar auditoria coalescida "document.draft_update"

  Scenario: [Sucesso] Marcar seção como "não se aplica" com justificativa
    When "Carla" marcar a seção "MARKET_SURVEY" como "não se aplica" e informar justificativa com 30 caracteres
    Then a seção deve passar para o estado "NOT_APPLICABLE"
    And a navegação lateral deve exibir o ícone de "não se aplica" para "MARKET_SURVEY"

  Scenario: [Validação] Justificativa muito curta
    When "Carla" marcar a seção "MARKET_SURVEY" como "não se aplica" com justificativa de 10 caracteres
    Then o sistema deve exibir "Explique por que esta seção não se aplica (mín. 20 caracteres)."
    And a seção deve permanecer no estado anterior

  Scenario: [Permissão] Usuário sem ETP_UPDATE
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" abrir o ETP "0003/2026"
    Then todas as seções devem abrir em modo somente leitura
    When "Bruno" enviar "PUT /api/v1/documents/{id}/sections/NEED_DESCRIPTION"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Documento de outro tenant
    Given que o ETP "0009/2026" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar "PUT" para a seção desse ETP
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Reenvio do mesmo autosave após falha de confirmação
    Given que "Carla" salvou a seção "OBJECTIVE" e recebeu a revisão 2
    When o front reenviar automaticamente o mesmo conteúdo com "If-Match" igual a "s2" após não confirmar a resposta anterior por falha de rede
    Then a API deve responder 200 sem gerar conteúdo duplicado
    And deve existir apenas uma seção "OBJECTIVE" com o conteúdo final esperado

  Scenario: [Concorrência] Duas edições simultâneas na mesma seção
    Given que a seção "OBJECTIVE" está na revisão 2
    When "Carla" e outro usuário enviarem "PUT" para "OBJECTIVE" simultaneamente com "If-Match" igual a "s2"
    Then exatamente uma requisição deve responder 200 com revisão 3
    And a outra deve responder 412 com código "SECTION_REVISION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível durante o autosave
    Given que o banco de dados fica indisponível
    When "Carla" estiver editando uma seção e o autosave disparar
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o indicador deve exibir "Erro ao salvar" mantendo o texto digitado
    And o conteúdo deve permanecer disponível no rascunho local (IndexedDB)

  Scenario: [Falha de integração] Conexão perdida durante a digitação
    Given que a conexão com o servidor é perdida
    When "Carla" continuar digitando na seção "RECOMMENDED_SOLUTION"
    Then o conteúdo deve ser mantido no rascunho local (IndexedDB)
    And ao reconectar o front deve reenviar o autosave pendente automaticamente
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Seção fora do template | 422 | `SECTION_NOT_IN_TEMPLATE` | "Esta seção não existe neste modelo de ETP." | Recarrega a navegação lateral |
| ETP não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este ETP não pode ser editado no status atual." | Abre em modo leitura |
| Conflito de revisão da seção | 412 | `SECTION_REVISION_CONFLICT` | "Alguém salvou esta seção enquanto você editava." | Diálogo "Ver diferenças"/"Manter a minha"/"Descartar" |
| Justificativa ausente/curta | 422 | `VALIDATION_ERROR` | "Explique por que esta seção não se aplica (mín. 20 caracteres)." | Foca o campo de justificativa |
| Conteúdo acima do limite | 413/422 | `PAYLOAD_TOO_LARGE` / `VALIDATION_ERROR` | "O texto desta seção excede o tamanho máximo permitido." | Impede novo autosave até reduzir o texto |
| Rich text inválido | 422 | `RICH_TEXT_INVALID` | "Este conteúdo contém formatação não suportada." | Mantém rascunho local; remove formatação ao reenviar |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não pode editar este ETP." | Modo somente leitura |
| Recurso de outro tenant/não visível | 404 | `NOT_FOUND` | "Documento não encontrado." | Redireciona à lista |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tentando novamente…" | Retentativa automática; mantém rascunho local |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém rascunho local; botão copiar código |

## Dependências
- **Stories:** US-015 (padrão de edição por seções com autosave, estabelecido para o DFD e reaproveitado aqui), US-019 (criação do ETP e das seções). Relacionadas: US-021 (alternativas), US-022 (estimativas/itens), US-023 (validação de completude que interpreta os mesmos estados de seção), US-071 (comentários ancorados).
- **Decisões/ADRs:** DEC-016, DEC-017, DEC-018, DEC-056, DEC-182; ADR-006.
- **Configurações:** `SectionDefinition.minChars`/`maxChars`/`requirement` por seção (semeados — DEC-016).
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita integralmente o padrão de autosave por seção (DEC-182) e o contrato `DOC-05`/`DOC-08` já estabelecidos para documentos estruturados (US-015); nenhum novo padrão transversal é introduzido.
- A auditoria coalescida (`document.draft_update`) evita explosão de registros por tecla digitada; a implementação deve agrupar por `(documentId, sectionKey, userId)` dentro da janela de 10 minutos.
- Seções com `render` estruturado não duplicam dados: leem diretamente de `EtpAlternative`/`DocumentItem`/riscos pelas fachadas dos módulos donos, evitando desnormalização desnecessária na tela do ETP.
- `packages/editor` (schema de nós/marks) é dependência compartilhada com todos os documentos estruturados; qualquer ajuste de schema deve ser compatível com conteúdo já salvo (migração de conteúdo fora do escopo desta story).

## Backend
- **Módulo(s):** `document` (dono do `draftContent`, autosave e validação de template); `etp` (expõe `ETP-03` e agrega leituras tipadas); usa `access` (POL-02), `audit`, `platform`.
- **Casos de uso:** `SaveDocumentSectionCommand` → `SaveDocumentSectionHandler`; `GetDocumentValidationQuery` (reaproveitada de US-065) para o indicador de completude.
- **Domínio:** `Document.saveSectionDraft(sectionKey, content, expectedRevision)` (aplica RN-ETP-10/11/14/15); `DraftContent` value object.
- **Integrações internas:** `document.TemplateFacade.getSectionDefinition(templateVersionId, sectionKey)`; `etp.AlternativesFacade.listSummary(etpId)`; leitura de itens via `document.ItemsFacade`.
- **Transação:** cada `PUT` de seção é uma transação curta e isolada por seção (não bloqueia outras seções do mesmo documento).

## Frontend
- **Tela(s):** SCR-008 (`/processos/[id]/etp/[etpId]`).
- **Componentes:** `SectionSidebarNav` (ícones de completude), `RichTextEditor` (TipTap) com autosave (`useAutosave`, debounce 1.500 ms), `NotApplicableToggle` (com campo de justificativa), `ItemsTableReadonly`, `AlternativesTableReadonly`, `RiskListReadonly`, `SectionCommentsPanel` (US-071), `ConflictDialog`.
- **Estados:** salvando/salvo/erro por seção; vazio (seção `EMPTY`); somente leitura (status não editável ou sem permissão); recuperado (rascunho local aplicado após reconexão).
- **Acessibilidade e responsividade:** status de salvamento anunciado via `aria-live="polite"`; navegação lateral operável por teclado; em telas < 768 px a navegação lateral recolhe para um menu "Seções".

## Banco de dados
- **Tabelas:** `documents` (colunas `draft_content`, `draft_revision`).
- **Migrações:** nenhuma nova.
- **Índices/constraints relevantes:** nenhum índice adicional; validação de `sectionKey` e de `state`/`justification` ocorre na camada de aplicação sobre o JSONB (`draftContentSchema`).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ETP-03 | GET | `/api/v1/etps/{id}` | — | `200 { data: Etp }` com cabeçalho e metadados do documento | 200, 403, 404 |
| DOC-05 | PUT | `/api/v1/documents/{id}/sections/{sectionKey}` | `{ content, state, justification? }` + `If-Match: "s<revision>"` | `200 { data: Section }` com nova `revision` | 200, 403, 404, 409, 412, 413, 422 |
| DOC-08 | GET | `/api/v1/documents/{id}/validation` | — | `200 { data: { violations: [] } }` (indicador não bloqueante) | 200, 403, 404 |

## Logs
- `info` `document.section_saved` — `documentId`, `sectionKey`, `newRevision`, `durationMs`, `tenantId`, `userId`.
- `warn` `document.section_conflict` — `documentId`, `sectionKey`, `expectedRevision`, `actualRevision`.
- `error` `document.section_save_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** o conteúdo da seção (texto do estudo) nem a justificativa de "não se aplica".

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.draft_update` | `DATA_CHANGE` | Autosave de seção (coalescida, 1/10 min por documento/seção/usuário) | `changes`: hash + tamanho do conteúdo, `state`. `metadata`: `sectionKey`, intervalo de revisões cobertas |
| `access.denied` | `ACCESS` | Tentativa de editar sem permissão | `reasonCode = ETP_UPDATE` |

## Testes necessários
- **Unitários:** `Document.saveSectionDraft` (RN-ETP-10/11/14/15); cálculo de completude a partir de `DraftContent`; coalescimento da auditoria.
- **Integração (Testcontainers):** persistência de `draftContent` por seção; RLS impede leitura/escrita de seção de outro tenant; schema rich text rejeita nós desconhecidos.
- **API/contrato:** respostas e erros de `DOC-05`/`DOC-08` conforme api.md; cabeçalhos `If-Match`/`ETag` de seção.
- **RBAC e multi-tenant:** `ETP_UPDATE` com e sem custódia/participação; documento de outro tenant → 404.
- **Concorrência:** dois `PUT` simultâneos na mesma seção com a mesma revisão → um 200, outro 412.
- **E2E (Playwright):** digitar e observar autosave; marcar/desmarcar "não se aplica"; simular perda de rede e retomada via IndexedDB.
- **Acessibilidade/performance:** axe sem violações sérias no editor; autosave não deve degradar a digitação mesmo em seções de 50.000 caracteres.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `ETP_UPDATE` + POL-02 aplicados na API; seções somente leitura sem permissão ou fora de `DRAFT`/`RETURNED`
- [ ] Autosave e conflito de revisão cobertos por teste de concorrência
- [ ] Auditoria coalescida `document.draft_update` verificada em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de ETP-03, DOC-05, DOC-08 compatível com api.md
- [ ] Logs sem dados sensíveis (conteúdo/justificativa nunca logados)
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — editor rich text com autosave, controle de concorrência por seção, três tipos de seção estruturada somente leitura (alternativas, itens, riscos), estado "não se aplica" com justificativa e contingência offline local tornam esta story mais extensa que uma edição de formulário simples.

## Prioridade
**P0** — sem a edição das seções, o ETP criado pela US-019 não pode ser redigido; é o meio pelo qual o art. 18 é efetivamente cumprido.
