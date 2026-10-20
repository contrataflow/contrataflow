---
id: US-108
title: "Publicar versão de template e definir padrão do tipo"
epic: EP-018
feature: FT-058
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-107]
modules: [document]
screens: [SCR-033]
endpoints: [TPL-05, TPL-06, TPL-10, TPL-11, DTY-04]
permissions: [TEMPLATE_VIEW, TEMPLATE_MANAGE, TEMPLATE_PUBLISH]
events: [TemplateVersionPublished, TemplateVersionRetired, DocumentTypeChanged]
---

# US-108 — Publicar versão de template e definir padrão do tipo

## Título
Publicar versão de template e definir padrão do tipo

## Descrição
**Como** administrador de configurações documentais do órgão, **quero** publicar a versão de trabalho de um template, iniciar uma nova versão quando precisar alterar um template já publicado, aposentar versões obsoletas e escolher qual template é o padrão de cada tipo de documento, **para** que os documentos novos passem a usar um conteúdo revisado e estável, sem afetar os documentos já criados a partir de versões anteriores.

Publicar torna a versão **imutável** (com `contentHash`) e a define como corrente do template. Aposentar impede que uma versão volte a ser usada em novos documentos, sem remover o histórico. Nenhuma dessas ações tem efeito retroativo sobre documentos existentes.

## Contexto
- US-107 entrega o editor da versão de trabalho (rascunho); esta story fecha o ciclo de vida: `DRAFT → PUBLISHED → RETIRED` (`TemplateVersionStatus`), simétrico ao ciclo de workflows (DEC-015) e consistente com o modelo de versionamento imutável de `DocumentVersion` (DEC-017: hash SHA-256 do JSON canonicalizado).
- Sem uma versão publicada, nenhum tipo de documento pode ter um template como padrão (`DocumentType.defaultTemplateId`) e, portanto, nenhum documento `STRUCTURED`/`FREE_TEXT` desse tipo pode ser criado com seções — este é o passo que efetivamente "liga" os templates da US-107 ao restante do produto.
- "Sem efeito retroativo" é um requisito direto do domínio: um despacho já emitido não pode ter seu texto alterado porque o template mudou depois.

## Objetivo
Permitir publicar uma versão válida em um único passo, com validação completa antes da publicação, e permitir eleger/substituir o template padrão de cada tipo de documento sem necessidade de suporte técnico — mantendo histórico íntegro e imutável de cada versão publicada.

## Persona
- **Principal:** Administrador de configurações documentais do órgão (detentor de `TEMPLATE_PUBLISH`).
- **Secundárias:** Detentores de `TEMPLATE_MANAGE` (podem iniciar nova versão, mas não publicar/aposentar/definir padrão); `TEMPLATE_VIEW` (consulta o histórico de versões).

## Pré-condições
- Tenant `ACTIVE`; usuário com vínculo ativo e `TEMPLATE_PUBLISH` (publicar/aposentar/definir padrão) ou `TEMPLATE_MANAGE`/`TEMPLATE_VIEW` conforme a ação.
- Existe o template com uma versão em `DRAFT` (para publicar) ou `PUBLISHED` (para aposentar ou nova versão) — US-107.

## Fluxo principal
1. Na aba "Versões" de SCR-033 (`/admin/templates/{id}`), o usuário vê o histórico (`GET /templates/{id}/versions`, TPL-05): número, status, `publishedAt`, `retiredAt`, `contentHash` (resumido).
2. Para publicar o rascunho atual, clica em **"Publicar versão"**. O front roda a mesma validação de conteúdo da US-107 (feedback antecipado) e envia `POST /template-versions/{versionId}/publish` (TPL-10) com `If-Match` e `Idempotency-Key`.
3. A API reexecuta a validação completa (`TemplateContentValidator`); se houver violação bloqueante, responde **422** `TEMPLATE_INVALID` e nada muda. Caso contrário, em uma transação: define `status = PUBLISHED`, `publishedAt`/`publishedById`, calcula `contentHash` (SHA-256 do JSON canonicalizado — RFC 8785 — de `sections`+`layout`+`fieldConfig`+`importMappings`), atualiza `DocumentTemplate.currentPublishedVersionId`, grava auditoria `template.version_publish` e o evento `TemplateVersionPublished` no outbox.
4. A API responde **200** com a versão publicada e novo `ETag`. A tela exibe "Versão 2 publicada" com o `contentHash` resumido.
5. Para continuar editando depois de publicado, o usuário clica em **"Iniciar nova versão"**: `POST /templates/{id}/versions` (TPL-06) clona o conteúdo da versão mais recente (publicada ou aposentada) em uma nova versão `DRAFT`, que passa a ser editável na SCR-114 da US-107.
6. Para aposentar uma versão publicada que não deve mais ser usada em novos documentos, o usuário clica em **"Aposentar"**: `POST /template-versions/{versionId}/retire` (TPL-11) com `If-Match`; define `status = RETIRED`, `retiredAt`/`retiredById`; grava auditoria `template.version_retire` e o evento `TemplateVersionRetired`.
7. Na tela de tipos de documento (US-061), o usuário escolhe, para um tipo, qual template é o padrão: `PUT /document-types/{id}/default-template` (DTY-04) com `{ templateId }` e `If-Match`; a API valida (RN-TPL-19) e atualiza `DocumentType.defaultTemplateId`, gravando auditoria `document_type.update` e o evento `DocumentTypeChanged`.

## Fluxos alternativos
- **FA-01 — Publicar a primeira versão de um template novo:** idêntico ao passo 2, apenas sem versão anterior publicada (`currentPublishedVersionId` estava nulo).
- **FA-02 — Nova versão a partir de uma versão aposentada:** quando o template não tem versão `PUBLISHED` (todas aposentadas) e nenhum `DRAFT`, TPL-06 clona a aposentada mais recente.
- **FA-03 — Aposentar sem substituta:** se a versão aposentada for a `currentPublishedVersionId` e não houver outra `PUBLISHED`, a UI impede a ação e sugere publicar uma nova versão antes (RN-TPL-18).
- **FA-04 — Trocar o padrão do tipo:** ao escolher um novo `defaultTemplateId`, o anterior permanece listado e pode voltar a ser escolhido depois (RN-TPL-20).
- **FA-05 — Consultar sem publicar:** usuário com apenas `TEMPLATE_VIEW` navega pelo histórico de versões em modo leitura, sem os botões de ação.

## Regras de negócio
- **RN-TPL-13** — Nova versão (TPL-06) só é criada quando não há rascunho corrente para o template (`UNIQUE (tenant_id, template_id) WHERE status = 'DRAFT'`); clona `sections`/`layout`/`fieldConfig`/`importMappings` da versão de maior `versionNumber` (publicada ou aposentada); `versionNumber = max(existente) + 1`; status inicial `DRAFT`. Duas solicitações concorrentes para o mesmo template → a segunda recebe `TEMPLATE_DRAFT_EXISTS` (409) e a UI deve carregar o rascunho criado pela primeira.
- **RN-TPL-14** — Publicar (TPL-10) exige versão em `DRAFT` e `template.isActive = true` (template inativo → `INVALID_STATE`, 409); a validação completa (RN-TPL-04 a RN-TPL-09 da US-107) é reexecutada por inteiro — qualquer violação bloqueante → `TEMPLATE_INVALID` (422) e nenhuma alteração é persistida.
- **RN-TPL-15** — Ao publicar: `status = PUBLISHED`; `publishedAt`/`publishedById` preenchidos; `contentHash` = SHA-256 do JSON canonicalizado (RFC 8785) de `{ sections, layout, fieldConfig, importMappings }`; `DocumentTemplate.currentPublishedVersionId` passa a apontar para esta versão. A partir daqui, `sections`/`layout`/`fieldConfig`/`importMappings`/`versionNumber` são imutáveis (qualquer PATCH → `TEMPLATE_VERSION_NOT_DRAFT`, RN-TPL-03).
- **RN-TPL-16** — Sem efeito retroativo: publicar uma nova versão não altera documentos já criados a partir de versões anteriores (cada documento referencia a versão vigente no momento de sua criação); apenas documentos criados depois usam a versão recém-publicada.
- **RN-TPL-17** — Aposentar (TPL-11) exige `status = PUBLISHED`; define `RETIRED`, `retiredAt`/`retiredById`. Versão aposentada não pode ser escolhida como padrão do tipo (DTY-04) nem usada para iniciar novos documentos; documentos existentes continuam a referenciá-la normalmente (consulta, impressão, histórico).
- **RN-TPL-18** — Aposentar a versão que é a `currentPublishedVersionId` do template só é permitido se o template não for `defaultTemplateId` de nenhum `DocumentType` ativo, ou se existir outra versão `PUBLISHED` do mesmo template para assumir imediatamente essa posição; caso contrário, a ação é bloqueada (ver lacuna TEMPLATE_IN_USE em Dependências).
- **RN-TPL-19** — Definir padrão do tipo (DTY-04): o template escolhido deve ter `documentTypeId` igual ao tipo informado, `isActive = true` e `currentPublishedVersionId` preenchido (ao menos uma versão publicada); caso contrário, `BUSINESS_RULE_VIOLATION` com `violations[].code = "TEMPLATE_NOT_PUBLISHED"`.
- **RN-TPL-20** — Cada `DocumentType` tem no máximo um `defaultTemplateId` por vez; definir um novo padrão substitui o anterior sem desativá-lo ou excluí-lo — ele permanece disponível na lista de templates do tipo e pode voltar a ser escolhido depois.

## Campos
Esta story não introduz campos de formulário novos: reaproveita `changeNotes` (editado na US-107, visível no histórico de versões) e a seleção de `templateId` como padrão do tipo (lista já carregada por TPL-01 filtrada por `documentTypeId`). Ações de publicar/aposentar são confirmações, sem campos adicionais — não há coluna para justificativa de aposentadoria em `DocumentTemplateVersion` (entities.md conferido).

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Publicar com violações bloqueantes | API | "O template tem pendências que impedem a publicação." | `TEMPLATE_INVALID` |
| V-02 | Publicar/editar versão que não está `DRAFT` | API | "Esta versão já foi publicada ou aposentada." | `TEMPLATE_VERSION_NOT_DRAFT` |
| V-03 | Aposentar versão que não está `PUBLISHED` | API | "Só é possível aposentar uma versão publicada." | `INVALID_STATE` |
| V-04 | Aposentar a versão corrente sem substituta, sendo padrão de algum tipo | API | "Publique outra versão antes de aposentar esta, pois ela é a padrão de \"{tipo}\"." | `TEMPLATE_IN_USE` |
| V-05 | Definir como padrão um template sem versão publicada | API | "Este template ainda não tem uma versão publicada." | `BUSINESS_RULE_VIOLATION` (TEMPLATE_NOT_PUBLISHED) |
| V-06 | Definir como padrão um template de outro tipo de documento | API | "Este template não pertence ao tipo selecionado." | `VALIDATION_ERROR` (`templateId`, `NOT_ALLOWED`) |
| V-07 | Nova versão solicitada com rascunho já existente | API | "Já existe um rascunho em edição para este template." | `TEMPLATE_DRAFT_EXISTS` |
| V-08 | `If-Match` divergente em publicar/aposentar/definir padrão | API | "O recurso foi alterado por outra pessoa. Recarregue e tente novamente." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `TEMPLATE_PUBLISH` para publicar, aposentar e definir padrão do tipo (DTY-04); `TEMPLATE_MANAGE` para iniciar nova versão (TPL-06); `TEMPLATE_VIEW` para consultar o histórico (TPL-05). Permissões de configuração do tenant, sem dimensão de escopo.
- **Políticas:** `POL-14` (ação de risco `H` exige MFA) aplica-se a `TEMPLATE_PUBLISH` e a `DOCUMENT_TYPE_MANAGE`.
- **MFA:** exigido em publicar/aposentar/definir padrão (`TEMPLATE_PUBLISH`, risco `H`), salvo isenção de `security.mfaPolicy`; não exigido para iniciar nova versão (`TEMPLATE_MANAGE`, risco `M`).
- **Sem permissão:** botões "Publicar", "Aposentar" e "Definir como padrão" ocultos para quem só tem `TEMPLATE_MANAGE`/`TEMPLATE_VIEW`; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TemplateVersionPublished` | `template.version_published` | Commit da publicação | Payload: `templateId`, `templateVersionId`, `versionNumber`, `documentTypeCode`, `contentHash` |
| `TemplateVersionRetired` | `template.version_retired` | Commit da aposentadoria | Payload: `templateId`, `templateVersionId` |
| `DocumentTypeChanged` | `document_type.changed` | Commit da troca de padrão | Payload: `documentTypeId`, `code`, `changedFields: ["defaultTemplateId"]` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: publicação/aposentadoria de template é atividade de configuração, sem destinatários além do próprio autor. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Publicar versão de template e definir padrão do tipo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o template "Ofício padrão" (tipo "OFICIO") tem a versão 1 publicada e a versão 2 em "DRAFT", válida
    And o usuário "Diego" tem vínculo ativo e o perfil com "TEMPLATE_PUBLISH"

  Scenario: [Sucesso] Publicar a versão em rascunho
    When "Diego" publicar a versão 2 do template "Ofício padrão"
    Then a versão 2 deve passar a "PUBLISHED" com "publishedAt" e "contentHash" preenchidos
    And "DocumentTemplate.currentPublishedVersionId" deve apontar para a versão 2
    And a API deve responder 200 com novo "ETag"
    And deve gerar registro de auditoria "template.version_publish"
    And deve gerar o evento "TemplateVersionPublished"

  Scenario: [Sucesso] Definir o template como padrão do tipo
    When "Diego" definir "Ofício padrão" como padrão do tipo "OFICIO"
    Then "DocumentType.defaultTemplateId" do tipo "OFICIO" deve ser o template "Ofício padrão"
    And deve gerar registro de auditoria "document_type.update"
    And deve gerar o evento "DocumentTypeChanged" com "changedFields" contendo "defaultTemplateId"

  Scenario: [Validação] Publicar versão com violação bloqueante
    Given que a versão 2 tem uma seção com variável desconhecida
    When "Diego" tentar publicar a versão 2
    Then a API deve responder 422 com código "TEMPLATE_INVALID"
    And a versão deve permanecer em "DRAFT"

  Scenario: [Permissão] Usuário só com TEMPLATE_MANAGE tenta publicar
    Given que "Carla" possui apenas "TEMPLATE_MANAGE"
    When "Carla" enviar POST para publicar a versão 2
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "TEMPLATE_PUBLISH"

  Scenario: [Tenant incorreto] templateVersionId de outro tenant
    Given que existe uma versão de template no tenant "Prefeitura B"
    When "Diego", no tenant "Prefeitura de São José", enviar POST para publicar essa versão
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Reenvio da publicação com a mesma chave de idempotência
    Given que "Diego" publicou a versão 2 com a chave de idempotência "K9" e recebeu 200
    When a mesma requisição for reenviada com a chave "K9"
    Then a API deve responder 200 com o mesmo "contentHash" e o cabeçalho "Idempotent-Replayed: true"
    And nenhuma segunda publicação deve ocorrer

  Scenario: [Concorrência] Duas solicitações simultâneas de nova versão
    Given que o template "Ofício padrão" não tem rascunho corrente
    When duas requisições simultâneas chamarem "Iniciar nova versão"
    Then uma deve responder 201 criando a versão 3 em "DRAFT"
    And a outra deve responder 409 com código "TEMPLATE_DRAFT_EXISTS"
    And deve existir apenas uma versão em "DRAFT" para o template

  Scenario: [Falha de banco] Banco indisponível ao publicar
    Given que o banco de dados fica indisponível durante a publicação
    When "Diego" publicar a versão 2
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a versão deve permanecer em "DRAFT"

  Scenario: [Falha de integração] Relay do outbox indisponível ao publicar
    Given que o relay do outbox está indisponível
    When "Diego" publicar a versão 2
    Then a versão deve passar a "PUBLISHED" e a API deve responder 200
    And o evento "TemplateVersionPublished" deve permanecer "PENDING" no outbox
    And quando o relay voltar o evento deve ser publicado uma única vez
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Violação bloqueante ao publicar | 422 | `TEMPLATE_INVALID` | "O template tem pendências que impedem a publicação." | Lista as violações por seção |
| Versão não `DRAFT` (publicar) / não `PUBLISHED` (aposentar) | 409 | `TEMPLATE_VERSION_NOT_DRAFT` / `INVALID_STATE` | "Esta ação não é permitida no estado atual da versão." | Atualiza a tela com o estado corrente |
| Aposentar versão corrente sem substituta em uso | 409 | `TEMPLATE_IN_USE` | "Publique outra versão antes de aposentar esta." | Sugere "Iniciar nova versão" |
| Template sem versão publicada ao definir padrão | 422 | `BUSINESS_RULE_VIOLATION` (TEMPLATE_NOT_PUBLISHED) | "Este template ainda não tem uma versão publicada." | Desabilita a opção na lista |
| Rascunho já existente | 409 | `TEMPLATE_DRAFT_EXISTS` | "Já existe um rascunho em edição para este template." | Abre o rascunho existente |
| Edição concorrente (`If-Match`) | 412 | `VERSION_CONFLICT` | "O recurso foi alterado por outra pessoa. Recarregue." | Recarrega o histórico |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para publicar templates." | Oculta ações de publicação |
| Recurso de outro tenant/inexistente | 404 | `NOT_FOUND` | "Template ou versão não encontrados." | Redireciona à lista |
| Banco/outbox indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém estado; botão "Tentar novamente" |

## Dependências
- **Stories:** US-107 (editor e validação de conteúdo reutilizada na publicação). Indiretas: US-061 (tipos de documento — `defaultTemplateId`), US-073 (auditoria), US-082 (outbox), US-097 (autorização e escopos).
- **Decisões/ADRs:** DEC-001, DEC-015 (simetria com ciclo de vida de workflow), DEC-017, DEC-082, DEC-103, DEC-104, DEC-105.
- **Configurações:** nenhuma chave específica.
- **Lacunas nas fontes canônicas:**
  1. ~~Bloqueio de aposentadoria~~ — resolvida: `TEMPLATE_IN_USE` (409) em api.md §2.2.
  2. `violations[].code = "TEMPLATE_NOT_PUBLISHED"` (DTY-04) não está pré-catalogado em api.md, mas é permitido por extensão (api.md §2.1.2: "códigos com prefixo do módulo... definidos na tabela de validações da story dona") — registrado aqui, sem gap real.

## Impacto técnico
- `contentHash` deve ser calculado com a mesma rotina de canonicalização (RFC 8785) já usada para `DocumentVersion` (DEC-017) — reutilizar `ContentHasher` em vez de duplicar.
- A reexecução integral da validação na publicação (RN-TPL-14) deve usar exatamente o `TemplateContentValidator` da US-107 — qualquer divergência vira bug de "publicou algo que o editor rejeitaria".
- `currentPublishedVersionId` e `defaultTemplateId` são FKs para uma tabela que também referencia o template/tipo — atenção à ordem de atualização dentro da transação para não violar a constraint antes do commit.

## Backend
- **Módulo(s):** `document` (dono, para TPL-05/06/10/11); integra `DocumentTypeFacade` (para DTY-04, cujo recurso é `DocumentType` — dono `US-061`); usa `access`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateTemplateVersionCommand` (TPL-06) → `CreateTemplateVersionHandler`; `PublishTemplateVersionCommand` (TPL-10) → `PublishTemplateVersionHandler`; `RetireTemplateVersionCommand` (TPL-11) → `RetireTemplateVersionHandler`; `SetDefaultTemplateCommand` (DTY-04) → `SetDefaultTemplateHandler`.
- **Domínio:** `DocumentTemplateVersion.publish()` (RN-TPL-14/15, emite `TemplateVersionPublished`); `DocumentTemplateVersion.retire()` (RN-TPL-17/18, emite `TemplateVersionRetired`); `DocumentTemplate.setCurrentPublishedVersion(...)`; `DocumentType.setDefaultTemplate(...)` (RN-TPL-19/20, emite `DocumentTypeChanged`); `ContentHasher.hashCanonical(json)`.
- **Transação:** publicar e aposentar são `UPDATE` único com checagem de `version`; publicar também atualiza `DocumentTemplate` na mesma transação; DTY-04 atualiza `DocumentType` isoladamente (não toca a versão).

## Frontend
- **Tela(s):** SCR-033 (`/admin/templates/{id}`, aba "Versões"); ação "Definir padrão" na tela de tipos de documento (US-061).
- **Componentes:** `VersionHistoryTable` (status, datas, hash resumido, ações por linha), `PublishConfirmDialog` (mostra violações se houver), `RetireConfirmDialog` (bloqueia com explicação se `TEMPLATE_IN_USE`), `DefaultTemplateSelect` (lista templates `isActive` com versão publicada do tipo).
- **Estados:** desabilita "Publicar" quando a validação antecipada encontra pendências; desabilita "Aposentar" quando é a única versão publicada e padrão de um tipo; sucesso com toast e atualização imediata da tabela.
- **Acessibilidade e responsividade:** diálogos de confirmação com foco inicial no botão de ação primária e `aria-describedby` para a lista de violações; tabela de histórico com rolagem horizontal em telas estreitas.

## Banco de dados
- **Tabelas:** `document_template_versions` (status, `published_at`/`by`, `retired_at`/`by`, `content_hash`), `document_templates` (`current_published_version_id`), `document_types` (`default_template_id`).
- **Migrações:** nenhuma nova além da já prevista em entities.md para essas tabelas.
- **Índices/constraints relevantes:** reutiliza `UNIQUE (tenant_id, template_id) WHERE status = 'DRAFT'` (impede duas versões rascunho) e `UNIQUE (tenant_id, template_id, version_number)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TPL-05 | GET | `/templates/{id}/versions` | `?status=` | `200 { data: [TemplateVersion], meta }` | 200, 404 |
| TPL-06 | POST | `/templates/{id}/versions` | — (clona a versão mais recente) + `Idempotency-Key` | `201 { data: TemplateVersion }` | 201, 403, 404, 409 |
| TPL-10 | POST | `/template-versions/{versionId}/publish` | `If-Match` + `Idempotency-Key` | `200 { data: TemplateVersion }` | 200, 403, 404, 409, 412, 422 |
| TPL-11 | POST | `/template-versions/{versionId}/retire` | `If-Match` | `200 { data: TemplateVersion }` | 200, 403, 404, 409, 412 |
| DTY-04 | PUT | `/document-types/{id}/default-template` | `{ templateId }` + `If-Match` | `200 { data: DocumentType }` | 200, 403, 404, 412, 422 |

## Logs
- `info` `template_version.published` — `templateId`, `templateVersionId`, `versionNumber`, `contentHash`, `durationMs`.
- `info` `template_version.retired` — `templateId`, `templateVersionId`.
- `info` `document_type.default_template_changed` — `documentTypeId`, `templateId` anterior e novo.
- `error` `template_version.publish_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** conteúdo das seções (apenas IDs e contagens).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `template.version_publish` | `CONFIGURATION` | Commit da publicação | `metadata`: `templateVersionId`, `versionNumber`, `contentHash`, `idempotencyKey` |
| `template.version_retire` | `CONFIGURATION` | Commit da aposentadoria | `metadata`: `templateVersionId` |
| `document_type.update` | `CONFIGURATION` | Troca de padrão (DTY-04) | `changes`: `defaultTemplateId` (anterior → novo) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = TEMPLATE_PUBLISH` |

## Testes necessários
- **Unitários:** transições de `TemplateVersionStatus` (RN-TPL-13..18); cálculo de `contentHash` (determinístico para o mesmo conteúdo); regra RN-TPL-19/20.
- **Integração (Testcontainers PostgreSQL):** publicação atualiza `currentPublishedVersionId` na mesma transação; aposentadoria bloqueada quando é a única publicada e padrão (`TEMPLATE_IN_USE`); constraint de rascunho único.
- **API/contrato:** respostas e erros conforme api.md; `Idempotent-Replayed`, `ETag`, `If-Match`.
- **RBAC e multi-tenant:** matriz `TEMPLATE_VIEW`/`TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH`; recurso de outro tenant → 404.
- **Concorrência:** duas chamadas simultâneas de nova versão → uma 201, outra 409 `TEMPLATE_DRAFT_EXISTS`.
- **E2E (Playwright):** publicar, verificar histórico atualizado, aposentar, definir novo padrão e confirmar que documentos antigos (criados antes) não mudam.
- **Acessibilidade/performance:** axe nos diálogos de confirmação.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `TEMPLATE_PUBLISH`/`TEMPLATE_MANAGE`/`TEMPLATE_VIEW` aplicados corretamente por ação
- [ ] `contentHash` verificado em teste de determinismo e imutabilidade pós-publicação
- [ ] Auditoria e os três eventos verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de TPL-05/06/10/11 e DTY-04 compatível com api.md
- [ ] Logs sem conteúdo de seção; métricas de publicação/aposentadoria
- [ ] Revisão de código e de segurança aprovadas
- [ ] Bloqueio `TEMPLATE_IN_USE` coberto por teste de integração

## Estimativa
**M** — ciclo de vida de versão bem delimitado (publicar/aposentar/nova versão/padrão do tipo), sem UI nova complexa; reaproveita validação e hashing já definidos para outras entidades.

## Prioridade
**P0** — sem publicação não há template utilizável por nenhum documento; bloqueia US-110 (biblioteca padrão) e toda criação de documento com seções.
