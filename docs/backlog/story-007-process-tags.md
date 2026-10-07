---
id: US-007
title: "Gerenciar etiquetas do processo"
epic: EP-001
feature: FT-004
mvp: 1
priority: P2
estimate: S
status: Especificada
depends_on: [US-005]
modules: [process, timeline, audit, platform]
screens: [SCR-006, SCR-004, SCR-109]
endpoints: [TAG-01, TAG-02, TAG-03, PRC-18]
permissions: [TAG_MANAGE, PROCESS_UPDATE, PROCESS_VIEW]
events: [ProcessUpdated]
---

# US-007 — Gerenciar etiquetas do processo

## Título
Gerenciar etiquetas e classificar processos

## Descrição
**Como** gestor de contratações (cadastro) e servidor que está com o processo (aplicação), **quero** manter um conjunto de etiquetas do órgão e aplicá-las aos processos, **para** classificar processos por temas que não existem nos catálogos (ex.: "Obras emergenciais", "Recurso federal", "Prioridade do gabinete") e encontrá-los rapidamente na lista.

O cadastro de etiquetas (nome e cor acessível) fica na administração; a aplicação acontece no cabeçalho do detalhe do processo (SCR-006) por um seletor com busca, limitado a 10 etiquetas por processo. A lista de processos (US-002) exibe as etiquetas e permite filtrar por elas.

## Contexto
- Gestores mantêm hoje marcadores paralelos em planilhas ("processo com recurso de convênio", "pedido do gabinete").
- `Tag`/`ProcessTag` pertencem ao módulo `process` (DEC-040); máximo de 10 etiquetas por processo (entities.md §4.4); aplicar etiquetas é edição do processo — `PROCESS_UPDATE` + custódia (permissions.md §2.1, POL-01) — e gera `ProcessUpdated` (events.md §4.1).
- `RuleContext.process.tags` expõe as etiquetas às regras de workflow (DEC-016).

## Objetivo
Permitir cadastrar uma etiqueta em menos de 30 s e aplicá-la a um processo em 2 cliques, com 100% das alterações auditadas e refletidas na timeline, e filtro por etiqueta disponível na lista.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`) — cadastra etiquetas (`TAG_MANAGE`) e classifica processos sob sua custódia.
- **Secundárias:** Administrador do órgão (`ADMIN_ORGAO`) — cadastro; Requisitante, Planejamento e Compras — aplicam etiquetas quando estão com o processo; todos os usuários — filtram por etiqueta.

## Pré-condições
- Para cadastrar: `TAG_MANAGE`. Para aplicar: `PROCESS_UPDATE` no escopo + custódia, processo em `DRAFT`, `IN_PROGRESS` ou `RETURNED` (US-005).

## Fluxo principal
1. O gestor abre **Administração › Catálogos › Etiquetas** (aba em SCR-109) e clica em **"Nova etiqueta"**; informa nome e escolhe a cor na paleta acessível.
2. O front envia `POST /api/v1/tags` (TAG-02) com `Idempotency-Key`; a API valida (RN-PROC-85), grava a etiqueta e a auditoria `tag.create`, e responde **201**.
3. No detalhe de um processo sob sua custódia, o usuário clica em **"Etiquetas"** no cabeçalho; o seletor lista as etiquetas ativas (`GET /api/v1/tags` — TAG-01) com busca.
4. O usuário marca/desmarca etiquetas e confirma. O front envia `PUT /api/v1/processes/{id}/tags` (PRC-18) com o conjunto completo `tagIds` e `If-Match` da versão do processo.
5. A API, em uma transação com bloqueio do processo: valida o conjunto (RN-PROC-88), autoriza `PROCESS_UPDATE` + POL-01 (RN-PROC-87), calcula a diferença; havendo mudança, grava `ProcessTag`, incrementa a versão do processo e grava `ProcessUpdated` (`changedFields = ["tags"]`), timeline `PROCESS_UPDATED` e auditoria `process.tags_update` (RN-PROC-89).
6. A API responde **200** com as etiquetas do processo e o novo `ETag`; o cabeçalho e a lista passam a exibi-las.

## Fluxos alternativos
- **FA-01 — Criar etiqueta no seletor:** quem tem `TAG_MANAGE` vê, ao buscar um nome inexistente, a opção "Criar etiqueta "{nome}"" (TAG-02 com a cor padrão `#64748B`), já marcada em seguida.
- **FA-02 — Renomear, recolorir ou desativar:** em SCR-109, o gestor altera nome/cor ou desativa (TAG-03 com `If-Match`); a mudança aparece em todos os processos (RN-PROC-90). Ao renomear, a UI avisa: "Regras de workflow que usam o nome antigo deixarão de reconhecer esta etiqueta."
- **FA-03 — Etiqueta inativa aplicada:** continua exibida esmaecida com o rótulo "(inativa)" e pode ser removida; não aparece para novas aplicações (RN-PROC-88).
- **FA-04 — Sem custódia:** o botão "Etiquetas" fica desabilitado com "Somente quem está com o processo pode alterar as etiquetas." (ação `MANAGE_TAGS` em PRC-08).
- **FA-05 — Filtro na lista:** em SCR-004, o filtro "Etiquetas" usa `tagId` (US-002); etiquetas inativas aparecem no filtro em grupo separado.

## Regras de negócio
- **RN-PROC-85** — `Tag.name` tem de 2 a 40 caracteres após trim e é único no tenant sem diferenciar maiúsculas (`lower(name)`) → 409 `CONFLICT`; `color` no formato `#RRGGBB` e pertencente à paleta acessível do design system (contraste AA com o texto do chip), padrão `#64748B`.
- **RN-PROC-86** — Cadastro e manutenção (TAG-02, TAG-03) exigem `TAG_MANAGE`. Etiquetas nunca são excluídas: a desativação (`isActive = false`) retira a etiqueta das seleções novas, mas mantém as associações existentes, visíveis e filtráveis.
- **RN-PROC-87** — Aplicar etiquetas (PRC-18) substitui o conjunto inteiro do processo e exige `PROCESS_UPDATE` com escopo que cubra o processo, custódia e status editável (POL-01), além de `If-Match` com a versão do processo.
- **RN-PROC-88** — Conjunto de `tagIds`: no máximo 10 (`OUT_OF_RANGE`); sem repetição (`DUPLICATE_IN_LIST`); ids inexistentes ou de outro tenant → `REFERENCE_NOT_FOUND`; etiqueta inativa só é aceita se já estava aplicada ao processo (`REFERENCE_INACTIVE` para novas).
- **RN-PROC-89** — PUT sem diferença responde 200 sem nova versão e sem efeitos. Com diferença, na mesma transação: versão do processo incrementada; `ProcessUpdated` com `changedFields = ["tags"]`; timeline `PROCESS_UPDATED` (`params.fields = ["tags"]`); auditoria `process.tags_update` com os nomes adicionados e removidos.
- **RN-PROC-90** — Renomear, recolorir ou desativar uma etiqueta (TAG-03) reflete em todos os processos (associação por id), sem alterar a versão dos processos nem gerar evento de processo; registra `tag.update` ou `tag.deactivate`.
- **RN-PROC-91** — TAG-01 (`PROCESS_VIEW`) lista as etiquetas ativas; `includeInactive=true` só é atendido para quem tem `TAG_MANAGE` (para os demais, o parâmetro é ignorado).
- **RN-PROC-92** — `RuleContext.process.tags` contém os **nomes** das etiquetas ativas e inativas aplicadas ao processo, avaliados no momento da regra (DEC-016).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `Tag.name` | texto curto | Sim | 2–40; único (RN-PROC-85) | — |
| Cor | `Tag.color` | cor da paleta | Sim | `#RRGGBB` da paleta | `#64748B` |
| Ativa | `Tag.isActive` | interruptor | — | RN-PROC-86 | `true` |
| Etiquetas do processo | `tagIds` (PRC-18) | lista de uuid | Sim (pode ser vazia) | RN-PROC-88 | conjunto atual |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Nome ausente, curto ou longo | Front + API | "O nome deve ter entre 2 e 40 caracteres." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Cor fora do formato ou da paleta | Front + API | "Escolha uma das cores disponíveis." | `VALIDATION_ERROR` (`INVALID_FORMAT`/`INVALID_ENUM`) |
| V-03 | Nome repetido | API (+ índice único) | "Já existe uma etiqueta com este nome." | `CONFLICT` |
| V-04 | Mais de 10 etiquetas | Front + API | "Use no máximo 10 etiquetas por processo." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-05 | Etiqueta repetida, inexistente ou inativa nova | API | "Selecione etiquetas válidas." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`/`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |

## Permissões
- **Permissão:** `TAG_MANAGE` (sem escopo) para TAG-02/TAG-03; `PROCESS_UPDATE` com escopo + POL-01 para PRC-18; `PROCESS_VIEW` para TAG-01.
- **Políticas:** POL-01 na aplicação de etiquetas.
- **MFA:** não exigido (`TAG_MANAGE` é `L`; `PROCESS_UPDATE` é `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** aba "Etiquetas" da administração e criação rápida ocultas sem `TAG_MANAGE`; seletor desabilitado com motivo sem custódia; a API responde 403 (`PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN`) e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessUpdated` | `process.updated` | PRC-18 com diferença efetiva | `changedFields = ["tags"]`, `version` |

Cadastro de etiquetas não gera evento de domínio (somente auditoria de configuração).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Etiquetas do processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Patrícia" possui o perfil "GESTOR_CONTRATACOES" (com "TAG_MANAGE")
    And o processo "0012/2026" está "IN_PROGRESS" na versão 9 com "Ana" como responsável

  Scenario: [Sucesso] Cadastrar etiqueta e aplicá-la ao processo
    When "Patrícia" cadastrar a etiqueta "Obras emergenciais" com a cor "#B45309"
    Then a API deve responder 201 e gerar registro de auditoria "tag.create"
    When "Ana" aplicar as etiquetas "Obras emergenciais" e "Recurso federal" ao processo com "If-Match" igual a "9"
    Then a API deve responder 200 com "ETag" igual a "10"
    And deve gerar o evento "ProcessUpdated" com "changedFields" igual a ["tags"]
    And deve existir a entrada "PROCESS_UPDATED" na timeline e o registro de auditoria "process.tags_update" com as duas etiquetas adicionadas
    And o filtro "Etiquetas = Obras emergenciais" da lista deve retornar o processo "0012/2026"

  Scenario: [Validação] Limite de etiquetas e cor fora da paleta
    When "Ana" enviar 11 etiquetas para o processo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" no campo "tagIds"
    When "Patrícia" cadastrar uma etiqueta com a cor "#FFFF00"
    Then a API deve responder 422 com erro "INVALID_ENUM" no campo "color"

  Scenario: [Permissão] Cadastro sem TAG_MANAGE e aplicação sem custódia
    When "Ana" enviar POST para "/api/v1/tags"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que "Juliana" possui o perfil "COMPRAS" e não está com o processo
    When "Juliana" enviar PUT de etiquetas para o processo "0012/2026"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN" e registrar "access.denied"

  Scenario: [Tenant incorreto] Etiqueta de outro tenant
    Given que existe a etiqueta "T-B" no tenant "Prefeitura B"
    When "Ana" aplicar a etiqueta "T-B" ao processo "0012/2026"
    Then a API deve responder 422 com erro "REFERENCE_NOT_FOUND" no campo "tagIds"
    When "Patrícia" enviar PATCH para a etiqueta "T-B"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Nome repetido e conjunto idêntico
    When "Patrícia" cadastrar a etiqueta "obras EMERGENCIAIS"
    Then a API deve responder 409 com código "CONFLICT"
    When "Ana" reenviar o mesmo conjunto de etiquetas já aplicado
    Then a API deve responder 200 sem nova versão, sem evento e sem auditoria

  Scenario: [Concorrência] Etiquetas aplicadas sobre versão desatualizada
    Given que "Ana" abriu o seletor com o processo na versão 10 e um item foi incluído em seguida (versão 11)
    When "Ana" confirmar as etiquetas com "If-Match" igual a "10"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And o seletor deve recarregar mantendo as etiquetas marcadas por "Ana" para nova confirmação

  Scenario: [Falha de banco] Banco indisponível ao aplicar etiquetas
    Given que o banco de dados fica indisponível durante a transação
    When "Ana" confirmar as etiquetas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e nada deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Ana" aplicar uma etiqueta
    Then a API deve responder 200 e o evento "ProcessUpdated" deve permanecer "PENDING" até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Dados inválidos / limite / referência | 422 | `VALIDATION_ERROR` | "Revise as etiquetas selecionadas." | Destaca o problema no seletor |
| Nome repetido | 409 | `CONFLICT` | "Já existe uma etiqueta com este nome." | Erro no campo |
| Status não editável | 409 | `INVALID_PROCESS_STATUS` | "Etiquetas não podem ser alteradas com o processo {status}." | Seletor desabilitado |
| Sem permissão / custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não pode alterar as etiquetas deste processo." | Seletor desabilitado com motivo |
| Etiqueta ou processo de outro tenant / inexistente | 404 | `NOT_FOUND` / `PROCESS_NOT_FOUND` | "Não encontrado." | Recarrega |
| Versão divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O processo foi alterado por outra pessoa." | Recarrega mantendo a seleção |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar as etiquetas agora." | "Tentar novamente" |

## Dependências
- **Stories:** US-005 (edição do processo, versão do agregado, custódia). Relacionadas: US-002 (filtro `tagId` e exibição), US-004 (cabeçalho e ação `MANAGE_TAGS`), US-104 (tela SCR-109), US-041/US-044 (`RuleContext.process.tags`).
- **Decisões/ADRs:** DEC-016, DEC-023, DEC-040, DEC-055, DEC-104, DEC-105, DEC-183.
- **Configurações:** nenhuma.
- **Lacunas nas fontes canônicas:**
  1. **Tela de cadastro de etiquetas:** o inventário (features.md, Apêndice A) não tem tela para `Tag`; adotada uma aba "Etiquetas" em SCR-109 (Catálogos), protegida por `TAG_MANAGE`. Proposta: registrar a aba (ou um SCR-1xx próprio).
  2. **Regras por etiqueta frágeis a renomeação:** `RuleContext.process.tags` usa nomes (`string[]`) e `Tag` não tem código estável. Proposta: incluir `Tag.code` imutável (ou expor ids) no `RuleContext` v2.
  3. **Índice `(tenant_id, tag_id, process_id)`** em `process_tags` (já registrado em US-002).

## Impacto técnico
- PRC-18 calcula a diferença entre conjuntos e grava apenas inserções/remoções em `process_tags` (PK `(tenant_id, process_id, tag_id)`), com bloqueio do processo.
- A paleta acessível é uma constante compartilhada (`packages/ui` + `packages/validation`), garantindo a mesma validação no front e na API.
- TAG-01 é chamada com frequência (lista e seletor): cache no cliente (`staleTime` 10 min) e invalidação após TAG-02/TAG-03.

## Backend
- **Módulo(s):** `process` (dono de `Tag` e `ProcessTag`); `timeline`, `audit`, `platform`.
- **Casos de uso:** `ListTagsQuery`, `CreateTagCommand`, `UpdateTagCommand`, `SetProcessTagsCommand`.
- **Domínio:** `Tag` (nome único, paleta, ativa); `Process.setTags(tagIds)` (RN-PROC-87 a RN-PROC-89).
- **Integrações internas:** `AuthorizationService` + `CustodyPolicy`, `TimelineProjector`, `AuditService`, `OutboxWriter`.
- **Transação:** PRC-18 em uma transação com bloqueio do processo; TAG-02/TAG-03 em transação própria com auditoria de configuração.

## Frontend
- **Tela(s):** SCR-006 (seletor no cabeçalho), SCR-004 (chips e filtro), SCR-109 (aba "Etiquetas").
- **Componentes:** `TagPicker` (combobox multisseleção com busca, contador "3/10", criação rápida para `TAG_MANAGE`), `TagChip` (cor + nome, estado inativo), `TagAdminTable` e `TagForm` (nome, `ColorPaletteSelect`).
- **Estados:** skeleton no seletor; empty state "Nenhuma etiqueta cadastrada. Peça ao gestor para criar etiquetas." (ou botão de criação, com `TAG_MANAGE`).
- **Acessibilidade:** combobox ARIA com anúncio da quantidade selecionada; cor nunca é a única informação (nome sempre visível); contraste AA garantido pela paleta.
- **Responsivo:** seletor em painel inferior abaixo de 768 px.

## Banco de dados
- **Tabelas:** `tags`, `process_tags` (escrita); `processes` (versão); `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** criação de `tags` (colunas padrão, `UNIQUE (tenant_id, lower(name))`, RLS) e `process_tags` (PK `(tenant_id, process_id, tag_id)`, FK `process_id` com `CASCADE`, RLS); índice proposto na lacuna 3.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TAG-01 | GET | `/api/v1/tags?includeInactive=` | — | `200 { data: [{ id, name, color, isActive, version }] }` | 200, 403 |
| TAG-02 | POST | `/api/v1/tags` | `{ name, color? }` + `Idempotency-Key` | `201 { data: Tag }` + `ETag` | 201, 403, 409, 422 |
| TAG-03 | PATCH | `/api/v1/tags/{id}` | `{ name?, color?, isActive? }` + `If-Match` | `200 { data: Tag }` | 200, 403, 404, 409, 412, 422, 428 |
| PRC-18 | PUT | `/api/v1/processes/{id}/tags` | `{ tagIds: uuid[] }` + `If-Match` (processo) | `200 { data: { tags: Tag[] } }` + `ETag` | 200, 403, 404, 409, 412, 422, 428 |

## Logs
- `info` `tag.created` / `tag.updated` — `tagId`, `isActive`.
- `info` `process.tags_changed` — `processId`, quantidades adicionadas/removidas.
- `error` `process.tags_change_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** dados do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tag.create` / `tag.update` / `tag.deactivate` | `CONFIGURATION` | TAG-02 / TAG-03 | `changes` de `name`, `color`, `isActive` |
| `process.tags_update` | `DATA_CHANGE` | PRC-18 com diferença | `changes`: `[{ path: "tags", old: [nomes], new: [nomes] }]`; `metadata.processCode` |
| `access.denied` | `ACCESS` | 403 | `reasonCode = TAG_MANAGE`, `PROCESS_UPDATE` ou `NOT_PROCESS_CUSTODIAN` |

## Testes necessários
- **Unitários:** unicidade sem diferenciar maiúsculas; paleta; diferença de conjuntos; limite de 10; inativa já aplicada × nova.
- **Integração (Testcontainers):** PRC-18 com evento, timeline e auditoria na mesma transação; renomeação reflete nos processos sem alterar versões.
- **API/contrato e RBAC/multi-tenant:** TAG-01..03 e PRC-18 conforme api.md; etiqueta de outro tenant → 422/404 (suíte "tenant leak"); permissões e custódia.
- **Concorrência:** PRC-18 com `If-Match` desatualizado → 412.
- **E2E (Playwright):** cadastrar, aplicar, filtrar na lista, desativar e ver a etiqueta esmaecida.
- **Acessibilidade:** axe no seletor e na administração; navegação por teclado.

## Definition of Done
- [ ] Cenários Gherkin automatizados e passando no CI
- [ ] Permissões `TAG_MANAGE` e POL-01 aplicadas na API; UI oculta/desabilita conforme regras
- [ ] Evento, timeline e auditoria verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de TAG-01..03 e PRC-18 compatível com api.md
- [ ] Seletor acessível e utilizável em 360 px
- [ ] Revisão de código aprovada

## Estimativa
**S** — duas entidades simples, quatro endpoints e um seletor; reaproveita os padrões de comando, custódia e versão do agregado de US-005.

## Prioridade
**P2** — melhora a organização e a busca, mas o MVP é utilizável sem etiquetas (catálogos e filtros de US-002 cobrem a classificação essencial).
