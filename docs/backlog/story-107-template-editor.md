---
id: US-107
title: "Criar e editar template de documento"
epic: EP-018
feature: FT-058
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-061]
modules: [document]
screens: [SCR-033, SCR-114]
endpoints: [TPL-01, TPL-02, TPL-03, TPL-04, TPL-07, TPL-08]
permissions: [TEMPLATE_VIEW, TEMPLATE_MANAGE]
events: []
---

# US-107 — Criar e editar template de documento

## Título
Criar e editar template de documento

## Descrição
**Como** administrador de configurações documentais do órgão, **quero** criar modelos de documento por tipo (DFD, ETP, TR, mapa de riscos, pesquisa de preço, despacho, ofício, nota técnica, autorização, declaração) e editar suas seções, orientações e mapeamentos de campos, **para** padronizar a redação dos documentos do processo de contratação com o texto institucional e a base legal do órgão, sem depender de desenvolvimento.

A edição ocorre sempre sobre a **versão de trabalho** (rascunho) do template, em um editor dedicado (SCR-114, aba "Conteúdo"). O administrador organiza seções (`SectionDefinition`), define obrigatoriedade, textos de apoio, base legal e, para tipos estruturados, ajusta rótulos e padrões dos campos tipados (`fieldConfig`) e, no caso do TR, o mapeamento de importação a partir do ETP (`importMappings`). A publicação do rascunho é tratada na US-108; o layout de impressão (cabeçalho, rodapé, timbre), na US-109.

## Contexto
- Hoje os documentos da fase preparatória são redigidos em editores de texto soltos; cada servidor reaproveita um modelo antigo recebido por e-mail. Não há controle de qual versão de texto e de base legal está em uso, nem padronização entre secretarias — risco de não conformidade com a Lei 14.133/2021 (ex.: elementos obrigatórios do ETP, art. 18).
- DEC-017 (modelo documental híbrido) define que tipos `STRUCTURED` (DFD, ETP, TR, mapa de riscos, pesquisa de preço) têm cabeçalho tipado + seções narrativas vindas do template; tipos `FREE_TEXT` (despacho, ofício, nota técnica, autorização, declaração) são inteiramente guiados pelo template. Em ambos, `DocumentTemplateVersion.sections` (`SectionDefinition[]`, entities.md §5.1) define a estrutura que o redator preenche ao elaborar o documento.
- DEC-056 trata o conteúdo rico (TipTap/ProseMirror JSON) e exige validação de schema e sanitização no servidor — aplicável a `helpText`, `defaultContent` e, na US-109, a `header`/`footer`.
- Este template é a base consumida por US-108 (publicação e padrão do tipo), US-109 (layout de impressão) e pela biblioteca semeada da US-110.

## Objetivo
Permitir que um administrador configure a estrutura completa de um template (seções, obrigatoriedade, textos de apoio, variáveis, campos tipados e, quando TR, mapeamento de importação) com validação imediata de inconsistências (`TEMPLATE_INVALID`), deixando o rascunho pronto para publicação (US-108) sem retrabalho.

## Persona
- **Principal:** Administrador de configurações documentais do órgão (detentor de `TEMPLATE_MANAGE`).
- **Secundárias:** Qualquer usuário com `TEMPLATE_VIEW` (consulta template e versão publicada, sem editar).

## Pré-condições
- Tenant `ACTIVE`; usuário autenticado com vínculo ativo.
- Usuário possui `TEMPLATE_MANAGE` (para criar/editar) ou `TEMPLATE_VIEW` (para consultar).
- Existe ao menos um `DocumentType` ativo (US-061) ao qual associar o template.

## Fluxo principal
1. O usuário acessa SCR-033 (`/admin/templates`) e clica em **"Novo template"**.
2. Informa **Nome**, **Tipo de documento** (`documentTypeId`) e, opcionalmente, **Descrição**. O front valida com Zod e verifica localmente possíveis duplicidades já carregadas na lista.
3. Ao confirmar, o front envia `POST /api/v1/templates` (TPL-02) com `Idempotency-Key`. A API, em uma transação, cria `DocumentTemplate` e, atomicamente, `DocumentTemplateVersion` nº 1 (`status = DRAFT`, `sections = []`, `layout` com os valores padrão do sistema — RN-TPL-02 —, `fieldConfig = {}`, `importMappings` preenchido com o mapeamento padrão semeado quando o tipo for TR). Responde **201** com `Location` e `ETag: "1"`.
4. O usuário é levado a SCR-114 (editor, aba **"Conteúdo"**), que carrega a versão via `GET /template-versions/{versionId}` (TPL-07).
5. O usuário adiciona seções informando `key`, `title`, `order`, `requirement`, `helpText`, `legalBasis`, `render`, `defaultContent`, `minChars`/`maxChars` e `allowNarrative`. Cada alteração relevante (ao sair do campo ou periodicamente) dispara `PATCH /template-versions/{versionId}` (TPL-08) com `If-Match: "<revisão atual>"`.
6. A API valida o conteúdo (chaves únicas, variáveis conhecidas, compatibilidade de `render` com o `systemModule` do tipo — RN-TPL-04/05/06) e, se inválido, responde **422** `TEMPLATE_INVALID` com `violations[]` apontando a seção e o problema; se válido, grava e responde **200** com novo `ETag`.
7. Para tipos `STRUCTURED`, o usuário ajusta `fieldConfig` (rótulo, obrigatoriedade e valor padrão dos campos do cabeçalho tipado do módulo). Para o tipo TR, ajusta `importMappings` (seções/campos/itens herdados do ETP).
8. O usuário pode sair e retomar a edição a qualquer momento (TPL-03/TPL-07 recarregam o estado atual do rascunho).

## Fluxos alternativos
- **FA-01 — Reordenar seções:** arrastar uma seção recalcula `order` de todas as seções afetadas em uma única chamada TPL-08.
- **FA-02 — Duplicar seção:** cria uma cópia com `key` sugerida (`_COPIA`) que o usuário deve ajustar antes de salvar (chave deve ser única).
- **FA-03 — Editar metadados do template:** nome, descrição e `isActive` são editados via `PATCH /templates/{id}` (TPL-04), independente do estado da versão.
- **FA-04 — Consultar template sem editar:** usuário com apenas `TEMPLATE_VIEW` abre SCR-114 em modo leitura; campos desabilitados; vê a versão publicada corrente quando não há rascunho visível a ele.
- **FA-05 — Tentar editar versão não rascunho:** ao abrir uma versão `PUBLISHED`/`RETIRED` diretamente (ex.: link antigo), o editor abre em modo leitura com aviso "Esta versão está publicada. Para alterar, inicie uma nova versão." (ação de nova versão pertence à US-108).
- **FA-06 — Descartar alterações locais:** recarregar a página busca o estado persistido mais recente (não há buffer local entre chamadas de autosave).

## Regras de negócio
- **RN-TPL-01** — `DocumentTemplate` exige `name` (3–150 caracteres) e `documentTypeId`; `name` é único por tenant dentro do mesmo `documentTypeId` (case-insensitive). `documentTypeId` é imutável após a criação.
- **RN-TPL-02** — Ao criar o template, a versão 1 nasce em `DRAFT` com `sections = []`, `fieldConfig = {}`, `importMappings` = mapeamento padrão semeado (§5.8) quando `documentType.systemModule = TERM_OF_REFERENCE`, senão nulo, e `layout` com valores fixos do sistema (A4, retrato, margens 20/20/20/20 mm, fonte Inter 11 pt, entrelinha 1,15, numeração de página visível, hash no rodapé visível, marca d'água de rascunho visível) — sem chave de configuração dedicada no MVP 1; refinável na US-109.
- **RN-TPL-03** — Somente a versão em `DRAFT` é editável por TPL-08. PATCH em versão `PUBLISHED`/`RETIRED` → `TEMPLATE_VERSION_NOT_DRAFT` (409).
- **RN-TPL-04** — Em `sections[]`: `key` em `SCREAMING_SNAKE_CASE`, único dentro da versão; `order` sequencial a partir de 1; `requirement` ∈ `SectionRequirement`; `maxChars` padrão 50.000 quando omitido; `minChars` ≤ `maxChars`.
- **RN-TPL-05** — `render` (padrão `TEXT`) deve ser compatível com `documentType.systemModule`: `ITEMS_TABLE`/`ALTERNATIVES_TABLE` somente em DFD/ETP/TR; `RISK_MATRIX`/`RISK_LIST` somente em mapa de riscos; `PRICE_SUMMARY`/`ESTIMATED_VALUE` somente em pesquisa de preço ou nos demais módulos estruturados, conforme a seção representar valor estimado (implementado: pesquisa de preço, DFD, ETP e TR — o mapa de riscos não tem valor estimado); tipos `FREE_TEXT`/`UPLOADED` só aceitam `TEXT`. Incompatibilidade → `TEMPLATE_INVALID`. Quando `render ≠ TEXT`, `allowNarrative` (padrão `true`) habilita texto complementar.
- **RN-TPL-06** — `defaultContent` (e `helpText`) aceitam o catálogo de variáveis de §5.2 **exceto** `document.version`, `document.hash`, `page` e `pages` (só existem no momento da renderização em PDF, tratada na US-109); variável fora dessa lista → `TEMPLATE_INVALID`. As variáveis permanecem como texto `{{...}}` no rascunho e só são resolvidas pelo servidor na criação de um documento a partir do template.
- **RN-TPL-07** — `fieldConfig` só é editável para `documentType.kind = STRUCTURED`; as chaves correspondem aos campos do cabeçalho tipado do módulo (definidos nas stories do próprio módulo — DFD/ETP/TR/mapa de riscos/pesquisa de preço). Para `FREE_TEXT`/`UPLOADED`, `fieldConfig` permanece `{}` e a UI não exibe a aba correspondente.
- **RN-TPL-08** — `importMappings` só é editável quando `documentType.systemModule = TERM_OF_REFERENCE`. Cada `sections[].target` deve existir na própria versão; cada `sections[].sources[]` deve existir nas seções da versão publicada corrente do template ETP padrão do tenant. Referência inexistente → `TEMPLATE_INVALID`. Enquanto o tenant não tiver template ETP padrão publicado (US-108/US-110), as fontes válidas são as seções de referência do ETP (entities.md §4.8).
- **RN-TPL-09** — A validação de conteúdo (`TEMPLATE_INVALID`, 422) roda a cada TPL-08 e consolida achados em `violations[]` (api.md §2.1.2): chaves duplicadas, variáveis desconhecidas, `render` incompatível, `importMappings` com referência inexistente — cada item com `sectionKey` preenchido quando aplicável. A mesma validação é reaplicada integralmente na publicação (US-108); no rascunho, ela confere as partes enviadas no corpo do TPL-08 sobre o conteúdo resultante (códigos das violações em api/04-templates.md, TPL-08).
- **RN-TPL-10** — Existe no máximo um rascunho por template (`UNIQUE (tenant_id, template_id) WHERE status = 'DRAFT'`). Iniciar uma nova versão a partir de uma versão publicada é uma ação de gestão de ciclo de vida tratada na US-108; quando disparada concorrentemente por duas sessões, a segunda recebe `TEMPLATE_DRAFT_EXISTS` (409) e deve carregar o rascunho já criado pela primeira.
- **RN-TPL-11** — `isActive = false` no template o remove das opções para novos documentos (sem afetar documentos já criados) e não impede continuar editando o rascunho corrente.
- **RN-TPL-12** — `changeNotes` (texto livre, até 1.000 caracteres) é opcional durante a edição do rascunho e é preservado na publicação (US-108) como registro do que mudou.

## Campos
**Template**
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `name` | texto curto | Sim | 3–150 caracteres; único por tipo (RN-TPL-01) | — |
| Tipo de documento | `documentTypeId` | seleção (`DocumentType`) | Sim | ativo; imutável após criar | — |
| Descrição | `description` | texto longo | Não | até 2.000 caracteres | — |
| Ativo | `isActive` | interruptor | Não | — | `true` |

**Seção (`sections[]`, `SectionDefinition` — entities.md §5.1)**
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Chave | `key` | texto técnico | Sim | `SCREAMING_SNAKE_CASE`; único na versão | — |
| Título | `title` | texto curto | Sim | 1–150 caracteres | — |
| Ordem | `order` | número | Sim | sequencial ≥ 1 | próximo disponível |
| Obrigatoriedade | `requirement` | seleção (`SectionRequirement`) | Sim | enum | `REQUIRED` |
| Texto de ajuda | `helpText` | markdown | Não | até 2.000 caracteres | — |
| Base legal | `legalBasis` | texto curto | Não | até 300 caracteres | — |
| Conteúdo padrão | `defaultContent` | rich text (TipTap) | Não | ≤ 1 MB; variáveis RN-TPL-06 | vazio |
| Mín./Máx. caracteres | `minChars`/`maxChars` | número | Não | `minChars ≤ maxChars` | `maxChars = 50000` |
| Tipo de bloco | `render` | seleção | Não | RN-TPL-05 | `TEXT` |
| Permite texto complementar | `allowNarrative` | interruptor | Não | só relevante se `render ≠ TEXT` | `true` |

`fieldConfig` e `importMappings` são editados em formulários dedicados (não em tabela), persistidos como `Record<fieldKey, { label?, required?, defaultValue? }>` e `ImportMappings` (§5.8) respectivamente.

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios do template ausentes | Front + API | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | Nome duplicado no mesmo tipo de documento | API | "Já existe um template chamado \"{nome}\" para este tipo de documento." | `TEMPLATE_NAME_TAKEN` |
| V-03 | `documentTypeId` inexistente, inativo ou de outro tenant | API | "Selecione um tipo de documento válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | Chave de seção duplicada ou fora do padrão | Front + API | "A chave \"{key}\" já existe nesta versão." | `TEMPLATE_INVALID` |
| V-05 | Variável desconhecida em `defaultContent`/`helpText` | Front + API | "A variável {{...}} não é reconhecida." | `TEMPLATE_INVALID` |
| V-06 | `render` incompatível com o tipo de documento | API | "Este tipo de bloco não é permitido para este tipo de documento." | `TEMPLATE_INVALID` |
| V-07 | `importMappings` referenciando seção inexistente | API | "O mapeamento referencia uma seção que não existe." | `TEMPLATE_INVALID` |
| V-08 | PATCH em versão não `DRAFT` | API | "Esta versão está publicada e não pode ser alterada." | `TEMPLATE_VERSION_NOT_DRAFT` |
| V-09 | `If-Match` divergente (edição concorrente) | API | "Este template foi alterado por outra pessoa. Recarregue para continuar." | `VERSION_CONFLICT` |
| V-10 | `minChars` maior que `maxChars` | Front + API | "O mínimo não pode ser maior que o máximo." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `TEMPLATE_MANAGE` para criar/editar; `TEMPLATE_VIEW` para consultar. Ambas são permissões de configuração do tenant, sem dimensão de escopo (organização/unidade).
- **Políticas:** nenhuma política contextual adicional (recurso não pertence a um processo).
- **MFA:** não exigido por padrão (`TEMPLATE_MANAGE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** botão "Novo template" e ações de edição ocultos/desabilitados em SCR-033/SCR-114; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
Nenhum evento de domínio nesta story — criação e edição de rascunho geram apenas auditoria (ver seção Auditoria). Os eventos `TemplateVersionPublished`/`TemplateVersionRetired` pertencem ao ciclo de publicação (US-108).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: edição de rascunho é atividade de configuração, sem destinatários além do próprio autor. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar e editar template de documento

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o tipo de documento "DESPACHO" (FREE_TEXT) ativo
    And existe o tipo de documento "TR" (STRUCTURED/TERM_OF_REFERENCE) ativo
    And a usuária "Carla" tem vínculo ativo e o perfil com "TEMPLATE_MANAGE"

  Scenario: [Sucesso] Criar template e primeira versão rascunho
    When "Carla" criar o template "Despacho padrão" para o tipo "DESPACHO"
    Then o template deve ser criado com "isActive" verdadeiro
    And deve existir a versão 1 com status "DRAFT", "sections" vazio e "layout" com os valores padrão do sistema
    And a API deve responder 201 com "Location" e "ETag" igual a "1"
    And deve gerar registro de auditoria "template.create"

  Scenario: [Sucesso] Adicionar seções ao rascunho
    Given que "Carla" tem o template "Despacho padrão" com a versão 1 em "DRAFT"
    When "Carla" adicionar a seção "OBJETO" (obrigatória) e a seção "FUNDAMENTACAO" (obrigatória com justificativa)
    Then a versão deve conter as duas seções na ordem informada
    And a API deve responder 200 com novo "ETag"
    And deve gerar registro de auditoria "template.update"

  Scenario: [Validação] Seção com variável desconhecida
    When "Carla" salvar uma seção cujo "defaultContent" contém "{{document.assinante}}"
    Then a API deve responder 422 com código "TEMPLATE_INVALID"
    And a violação deve indicar a seção e a mensagem "A variável {{document.assinante}} não é reconhecida."
    And a seção não deve ser salva

  Scenario: [Validação] Chave de seção duplicada
    Given que a versão já tem a seção de chave "OBJETO"
    When "Carla" tentar adicionar outra seção com chave "OBJETO"
    Then a API deve responder 422 com código "TEMPLATE_INVALID" referenciando a seção "OBJETO"

  Scenario: [Permissão] Usuário somente com TEMPLATE_VIEW tenta editar
    Given que o usuário "Bruno" possui apenas "TEMPLATE_VIEW"
    When "Bruno" acessar o editor do template "Despacho padrão"
    Then os campos devem ser exibidos somente leitura
    When "Bruno" enviar PATCH para a versão com um corpo válido
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "TEMPLATE_MANAGE"

  Scenario: [Tenant incorreto] Tipo de documento de outro tenant
    Given que existe o tipo de documento "OFICIO" no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar POST com "documentTypeId" do tipo "OFICIO" da "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "documentTypeId"
    And a resposta não deve revelar que o tipo existe em outro tenant

  Scenario: [Duplicidade] Nome de template já usado no mesmo tipo
    Given que já existe o template "Despacho padrão" para o tipo "DESPACHO"
    When "Carla" tentar criar outro template "despacho padrão" (mesma grafia, caixa diferente) para "DESPACHO"
    Then a API deve responder 409 com código "TEMPLATE_NAME_TAKEN"
    And nenhum template novo deve ser criado

  Scenario: [Concorrência] Edições simultâneas do mesmo rascunho
    Given que "Carla" e "Diego" abriram o editor do mesmo rascunho com "ETag" igual a "3"
    When "Carla" salvar primeiro e a versão passar a "ETag" igual a "4"
    And "Diego" enviar PATCH com "If-Match" igual a "3"
    Then a API deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" igual a 4
    And as alterações de "Diego" não devem ser salvas

  Scenario: [Falha de banco] Banco indisponível ao salvar o rascunho
    Given que o banco de dados fica indisponível durante o PATCH
    When "Carla" salvar uma seção
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a versão do template não deve ser alterada

  Scenario: [Falha de integração] Redis indisponível ao criar o template
    Given que o Redis está indisponível
    When "Carla" criar um template válido com chave de idempotência
    Then o template deve ser criado normalmente
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (schema) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]` |
| Nome duplicado no tipo | 409 | `TEMPLATE_NAME_TAKEN` | "Já existe um template com este nome para o tipo selecionado." | Foca o campo nome |
| Referência inexistente/inativa/outro tenant | 422 | `VALIDATION_ERROR` | "Selecione um tipo de documento válido." | Recarrega opções |
| Conteúdo inválido (chave, variável, render, mapeamento) | 422 | `TEMPLATE_INVALID` | Mensagem específica por violação | Destaca a seção afetada |
| PATCH em versão publicada/aposentada | 409 | `TEMPLATE_VERSION_NOT_DRAFT` | "Esta versão está publicada e não pode ser alterada." | Abre em modo leitura |
| Edição concorrente | 412 | `VERSION_CONFLICT` | "Este template foi alterado por outra pessoa. Recarregue para continuar." | Oferece recarregar |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega estado |
| Nova versão solicitada com rascunho já existente (ação da US-108) | 409 | `TEMPLATE_DRAFT_EXISTS` | "Já existe um rascunho em edição para este template." | Abre o rascunho existente |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar templates." | Oculta ações de edição |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente." | Preserva rascunho local do formulário |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

## Dependências
- **Stories:** US-061 (tipos de documento — origem de `documentTypeId`, `kind`, `systemModule`). Indiretas: US-073 (auditoria), US-082 (outbox/transação), US-087 (autenticação), US-097 (autorização e escopos).
- **Decisões/ADRs:** DEC-001, DEC-017, DEC-056, DEC-082, DEC-103, DEC-104, DEC-105.
- **Configurações:** nenhuma chave dedicada nesta story (valores padrão de layout são constantes da aplicação — RN-TPL-02).
- **Lacunas nas fontes canônicas:** nenhuma (`TEMPLATE_NAME_TAKEN` em api.md §2.2; tipo de `fieldConfig` em entities.md).

## Impacto técnico
- A validação de conteúdo (RN-TPL-04..09) deve ser implementada como serviço único (`TemplateContentValidator`) reutilizado sem alteração na publicação (US-108), para evitar divergência entre "o que o editor aceita" e "o que a publicação aceita".
- `sections`, `fieldConfig` e `importMappings` são `jsonb`; validação de schema ocorre na aplicação (Zod), não no banco — manter os schemas (`sectionDefinitionSchema` etc.) como fonte única também usada pelo front.
- Autosave de seções de documento (DEC-056) usa revisão própria (`"s<revision>"`); o rascunho de template usa o `version`/`ETag` padrão do recurso (mais simples, pois não há colaboração linha a linha prevista no MVP 1).

## Backend
- **Módulo(s):** `document` (dono); usa `access` (`AuthorizationService.assertCan('TEMPLATE_MANAGE'|'TEMPLATE_VIEW')`), `audit` (`AuditService`), `platform` (`IdempotencyService`).
- **Casos de uso:** `CreateTemplateCommand` → `CreateTemplateHandler`; `UpdateTemplateCommand` (metadados) → `UpdateTemplateHandler`; `UpdateTemplateVersionContentCommand` (sections/fieldConfig/importMappings) → `UpdateTemplateVersionContentHandler`.
- **Domínio:** `DocumentTemplate` (fábrica aplica RN-TPL-01); `DocumentTemplateVersion.updateContent(...)` (aplica RN-TPL-03..09, só permitido em `DRAFT`); value objects `SectionDefinition`, `FieldConfig`, `ImportMappings`; `TemplateContentValidator` (RN-TPL-04..09).
- **Integrações internas:** `document` → `DocumentTypeFacade.get(documentTypeId)` (kind/systemModule/ativo).
- **Transação:** criação (TPL-02) grava `DocumentTemplate` + `DocumentTemplateVersion` nº 1 na mesma transação; edição de conteúdo (TPL-08) é um `UPDATE` único com checagem de `version` (concorrência otimista).

## Frontend
- **Tela(s):** SCR-033 (`/admin/templates`), SCR-114 (`/admin/templates/[id]/versoes/[versionId]`, aba "Conteúdo").
- **Componentes:** `TemplateList`, `TemplateFormDialog` (criar/editar metadados), `SectionList` (drag-and-drop, reordenar), `SectionEditorPanel` (campos de `SectionDefinition`, editor rich text para `defaultContent`/`helpText` com paleta de variáveis), `FieldConfigPanel` (tipos `STRUCTURED`), `ImportMappingsPanel` (só TR), `ReadOnlyBanner` (versão não `DRAFT`).
- **Estados:** skeleton ao carregar a versão; vazio ("Nenhuma seção. Adicione a primeira."); erro de validação inline por seção (`TEMPLATE_INVALID`); banner de somente leitura quando a versão não é `DRAFT`.
- **Acessibilidade e responsividade:** reordenação por teclado (alternativa ao drag-and-drop); foco mantido na seção editada após salvar; painel de seções em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `document_templates`, `document_template_versions`.
- **Migrações:** criação das duas tabelas conforme entities.md (colunas padrão + campos específicos); nenhuma migração nova além do já previsto no módulo `document`.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_type_id, lower(name))` em `document_templates`; `UNIQUE (tenant_id, template_id, version_number)` e `UNIQUE (tenant_id, template_id) WHERE status = 'DRAFT'` em `document_template_versions`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TPL-01 | GET | `/templates` | `?documentTypeId=&q=&page=` | `200 { data: [Template], meta }` | 200 |
| TPL-02 | POST | `/templates` | `{ name, documentTypeId, description? }` + `Idempotency-Key` | `201 { data: Template }` (inclui versão 1) | 201, 403, 409, 422 |
| TPL-03 | GET | `/templates/{id}` | — | `200 { data: Template }` | 200, 404 |
| TPL-04 | PATCH | `/templates/{id}` | `{ name?, description?, isActive? }` + `If-Match` | `200 { data: Template }` | 200, 403, 404, 409, 412, 422 |
| TPL-07 | GET | `/template-versions/{versionId}` | — | `200 { data: TemplateVersion }` | 200, 404 |
| TPL-08 | PATCH | `/template-versions/{versionId}` | `{ sections?, fieldConfig?, importMappings?, changeNotes? }` + `If-Match` | `200 { data: TemplateVersion }` | 200, 403, 404, 409, 412, 422, 428 |

## Logs
- `info` `template.created` — `templateId`, `documentTypeId`, `durationMs`, `tenantId`, `userId`, `correlationId`.
- `info` `template_version.content_updated` — `templateVersionId`, `sectionCount`, `fieldsChanged`.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar.
- `error` `template_version.update_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** conteúdo de `defaultContent`/`helpText`, `legalBasis` por extenso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `template.create` | `CONFIGURATION` | Commit da criação | `changes`: `name`, `documentTypeId`. `metadata`: `templateId`, `idempotencyKey` |
| `template.update` | `CONFIGURATION` | Metadados ou conteúdo do rascunho alterados | `changes`: campos alterados (metadados) ou resumo (`sectionsChanged[]`, `fieldConfigChanged`, `importMappingsChanged` para conteúdo) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = TEMPLATE_MANAGE` |

## Testes necessários
- **Unitários:** `TemplateContentValidator` (RN-TPL-04..09, inclusive combinações de `render`×`systemModule`); fábrica `DocumentTemplate.create`; serialização de `fieldConfig`/`importMappings`.
- **Integração (Testcontainers PostgreSQL):** unicidade de nome por tipo; unicidade de rascunho por template; RLS isola por tenant; transação de criação (template + versão 1) atômica.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `ETag`/`If-Match`/`Idempotency-Key`.
- **RBAC e multi-tenant:** `TEMPLATE_VIEW` vs `TEMPLATE_MANAGE`; referência de `documentTypeId` de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas edições com `If-Match` desatualizado → uma 200, outra 412.
- **E2E (Playwright):** criar template, adicionar seções, salvar, recarregar e confirmar persistência; mensagens de `TEMPLATE_INVALID` visíveis na seção certa.
- **Acessibilidade/performance:** axe sem violações sérias no editor; reordenação de 30 seções sem perda de ordem.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `TemplateContentValidator` cobre RN-TPL-04..09 com testes unitários
- [ ] `TEMPLATE_MANAGE`/`TEMPLATE_VIEW` aplicados na API; UI oculta/desabilita conforme permissão
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de TPL-01/02/03/04/07/08 compatível com api.md
- [ ] Logs sem conteúdo de seção; métricas de criação/atualização de template
- [ ] Editor acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Lacunas da seção Dependências levadas ao backlog de decisões (TEMPLATE_NAME_TAKEN)

## Estimativa
**L** — introduz o editor completo de `SectionDefinition` com validação de conteúdo reutilizável por US-108, dois formulários especializados (`fieldConfig`, `importMappings`) e as telas SCR-033/SCR-114 do zero.

## Prioridade
**P0** — sem o editor não há como criar os templates que US-108 publica, US-109 ajusta e US-110 semeia; bloqueia toda a FT-058.
