---
id: US-061
title: "Gerenciar tipos de documento"
epic: EP-011
feature: FT-038
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-100]
modules: [document, catalog, access, identity, organization, workflow, audit, platform]
screens: [SCR-108]
endpoints: [DTY-01, DTY-02, DTY-03, DTY-04, SET-04, USR-02, DEP-02, ROL-02]
permissions: [DOCUMENT_TYPE_MANAGE]
events: [DocumentTypeChanged]
---

# US-061 — Gerenciar tipos de documento

## Título
Gerenciar tipos de documento

## Descrição
**Como** administrador do órgão, **quero** criar tipos de documento próprios (texto livre ou arquivo externo) e ajustar, dentro de limites seguros, os tipos semeados pela plataforma, **para** que cada órgão produza os atos do seu regulamento (pareceres, memorandos, portarias de designação, certidões) com numeração, confidencialidade e aprovação adequadas, sem depender de desenvolvimento.

A tela SCR-108 lista todos os tipos do tenant agrupados por natureza (Estruturado, Texto livre, Arquivo externo), com situação, numeração, exigência de aprovação avulsa e template padrão. O administrador cria tipos `FREE_TEXT` ou `UPLOADED`, edita os tipos personalizados e, nos tipos de sistema, altera apenas nome, numeração, aprovação avulsa (`requiresApproval` + `approvalPolicy`), confidencialidade padrão e template padrão. Tipos podem ser desativados: deixam de aparecer na criação de documentos, sem afetar documentos existentes. Toda alteração é auditada e publica `DocumentTypeChanged`, que invalida os caches de tipos.

## Contexto
- O modelo documental é híbrido (DEC-017): `DocumentType` com `kind` `STRUCTURED` (módulos tipados DFD, ETP, TR, RISK_MAP, PRICE_RESEARCH), `FREE_TEXT` (template rico) e `UPLOADED` (arquivo externo). Os tipos estruturados dependem de código (módulos `dfd`, `etp`, `term`, `risk`, `price-research`) e por isso não podem ser criados pelo tenant.
- Os tipos semeados no provisionamento (entities.md §7) têm `requiresApproval = false`: a aprovação formal acontece nas etapas APPROVAL do workflow (DEC-015, DEC-018). Órgãos cujo regulamento exige aprovação avulsa de um ato (ex.: nota técnica aprovada pela chefia) ligam `requiresApproval` com uma `approvalPolicy` (§5.7).
- Numeração por tipo (DEC-028): máscara `numberingMask` (nula = `numbering.document.defaultMask`, padrão `{type} {seq:4}/{year}`); número atribuído na criação do documento (US-105, US-065).
- Os códigos de tipo são usados em regras (`REQUIRED_DOCUMENT`), em `WorkflowStage.documentTypeCodes`/`approvalDocumentTypeCodes` e nas routing keys dos eventos (`document.created.<type>`): por isso são **imutáveis** (DEC-027, DEC-162).
- Segundo o plano (delivery-plan.md, nota ¹), o **núcleo técnico** desta story — fachada de tipos, cache e semeadura — é pré-requisito de US-040 e US-065 (P0) e entra cedo; a tela administrativa pode vir depois.

## Objetivo
Permitir que o administrador mantenha o catálogo de tipos de documento do tenant em menos de 2 minutos por tipo, com 100% das alterações validadas (código imutável, máscara válida, política de aprovação resolvível), auditadas e refletidas na criação de documentos em até 10 s (invalidação de cache por evento; no pior caso, TTL de 10 min).

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) e Jurídico (`JURIDICO`) — apenas consultam os tipos (DTY-01) ao criar documentos e revisar templates.

## Pré-condições
- Tenant provisionado com os tipos semeados (US-099): `DFD`, `ETP`, `TR`, `RISK_MAP`, `PRICE_RESEARCH` (STRUCTURED), `DESPACHO`, `OFICIO`, `NOTA_TECNICA`, `AUTORIZACAO`, `DECLARACAO` (FREE_TEXT) e `DOCUMENTO_EXTERNO` (UPLOADED).
- Usuário autenticado, vínculo `ACTIVE`, com `DOCUMENT_TYPE_MANAGE` (risco `H`) e MFA satisfeito conforme `security.mfaPolicy` (POL-14).
- Contexto de tenant e isolamento ativos (US-100).

## Fluxo principal
1. O administrador acessa **Administração › Tipos de documento** (SCR-108, `/admin/tipos-documento`). O front chama `DTY-01` com `includeInactive=true` e exibe skeleton até a resposta.
2. O sistema lista os tipos agrupados por natureza, ordenados por `sortOrder` e nome, com: nome, código, natureza, situação (Ativo/Inativo), numeração (exemplo do próximo número), "Exige aprovação", confidencialidade padrão, template padrão e selo "Do sistema" para `isSystem = true`.
3. O administrador clica em **"Novo tipo"**. O painel lateral abre com os campos: Natureza (Texto livre | Arquivo externo), Nome, Código (sugerido a partir do nome: "Parecer técnico" → `PARECER_TECNICO`, editável até salvar), Descrição, Permite vários por processo, Numeração (ligada/desligada + máscara com prévia via `SET-04`), Confidencialidade padrão, Exige aprovação avulsa e Ordem de exibição.
4. Ao ligar **"Exige aprovação avulsa"**, o painel exibe o bloco "Quem aprova" (`approvalPolicy`): tipo de aprovador (Usuário | Perfil | Titular de unidade), o seletor correspondente (`USR-02`, `ROL-02`, `DEP-02`), a resolução da unidade (Secretaria solicitante | Setor solicitante | Unidade fixa), "Permitir decisão pelo substituto" e prazo (dias úteis ou corridos).
5. O administrador clica em **"Salvar"**. O front valida com `documentTypeCreateSchema` e envia `DTY-02` com `Idempotency-Key`.
6. A API, em uma transação com `app.tenant_id`: valida o schema; autoriza `DOCUMENT_TYPE_MANAGE` (+ MFA); valida a máscara (`NumberingFacade.validateMask`); valida a política (RN-DOC-07); insere `DocumentType` (`isSystem = false`); grava auditoria `document_type.create` e o evento `DocumentTypeChanged` (`changedFields` = campos informados) no outbox; confirma.
7. A API responde **201** com o tipo, `Location` e `ETag: "1"`. O front fecha o painel, mostra o toast "Tipo de documento "Parecer técnico" criado" e invalida `['t', tenantId, 'document-types']`.
8. Para editar, o administrador abre um tipo da lista. Em tipos de sistema, os campos não editáveis aparecem como texto com o ícone de cadeado e a explicação "Definido pela plataforma". O front envia `DTY-03` com `If-Match` e apenas os campos alterados.
9. Após o commit, o relay publica `DocumentTypeChanged`; o handler leve de invalidação de cache (queues.md §4.1) apaga a chave de tipos do tenant em todas as instâncias.

## Fluxos alternativos
- **FA-01 — Desativar tipo:** em "Mais › Desativar", o sistema mostra a prévia de impacto (documentos existentes do tipo, workflows publicados que o referenciam em etapas ou regras). Confirmado, envia `DTY-03 { isActive: false }`. O tipo some do menu "Criar documento" (US-062); documentos existentes continuam acessíveis e editáveis conforme seu ciclo de vida. Bloqueado se houver regra `REQUIRED_DOCUMENT` `BLOCKING` ativa em versão de workflow `PUBLISHED` que exija o tipo (RN-DOC-09).
- **FA-02 — Reativar tipo:** "Mais › Reativar" envia `{ isActive: true }`; o tipo volta a ser oferecido nas etapas que o permitem.
- **FA-03 — Template padrão:** o campo "Template padrão" mostra o template vigente e o link "Alterar template padrão", que abre o seletor de templates publicados do tipo e chama `DTY-04` (US-108; requer `TEMPLATE_PUBLISH`). Sem template publicado, o tipo `FREE_TEXT` fica com o alerta "Sem template publicado — documentos deste tipo não podem ser criados" (US-063).
- **FA-04 — Alterar máscara no meio do exercício:** a prévia mostra "Próximo número: PT 008/2026". A sequência continua (a chave da sequência é por tipo/escopo/ano, não por máscara); números já emitidos não mudam. O painel exibe esse aviso antes de salvar.
- **FA-05 — Ligar aprovação avulsa em tipo com documentos em andamento:** a mudança vale para as próximas ações. Documentos já `FINALIZED` permanecem; documentos em `DRAFT`/`RETURNED` passam a exigir "Submeter" (DOC-09) em vez de "Finalizar" (DOC-10). O aviso informa a quantidade de documentos afetados.
- **FA-06 — Reenvio por falha de rede:** o front reenvia `DTY-02` com a mesma `Idempotency-Key` e recebe a resposta original (`Idempotent-Replayed: true`).

## Regras de negócio
- **RN-DOC-01** — O tenant só cria tipos com `kind` `FREE_TEXT` ou `UPLOADED`. `STRUCTURED` (e `systemModule`) existe apenas nos tipos semeados, com `isSystem = true`.
- **RN-DOC-02** — `code` segue `^[A-Z][A-Z0-9_]{1,39}$`, é único no tenant (`UNIQUE (tenant_id, code)`) e **imutável** após a criação, em qualquer tipo. `kind`, `systemModule` e `isSystem` também são imutáveis.
- **RN-DOC-03** — Em tipos de sistema (`isSystem = true`) só podem ser alterados: `name`, `description`, `numberingEnabled`, `numberingMask`, `requiresApproval`, `approvalPolicy`, `defaultConfidentiality`, `sortOrder` e, para tipos `FREE_TEXT`/`UPLOADED`, `isActive`. O template padrão é alterado por `DTY-04` (US-108). Tentativa de alterar outro campo → `VALIDATION_ERROR` com `NOT_ALLOWED` no campo.
- **RN-DOC-04** — Tipos `STRUCTURED` têm `allowMultiplePerProcess = false` fixo e não podem ser desativados (são a base do workflow padrão e dos módulos tipados). Tipos personalizados escolhem `allowMultiplePerProcess` (padrão `true`); a escolha é imutável depois que existir documento do tipo.
- **RN-DOC-05** — Numeração (DEC-028): `numberingMask` nula usa `numbering.document.defaultMask`; quando informada, tem até 60 caracteres, contém `{seq:N}` (N de 1 a 8) e `{year}` e só aceita os tokens `{seq:N}`, `{year}`, `{org}` e `{type}`. A sequência é por tipo/escopo/ano (US-105) e a troca de máscara não reinicia a contagem.
- **RN-DOC-06** — `requiresApproval = true` exige `approvalPolicy` (check `NOT requires_approval OR approval_policy IS NOT NULL`). Desligar `requiresApproval` mantém a última política gravada apenas para histórico de auditoria; a política deixa de ser usada.
- **RN-DOC-07** — A `approvalPolicy` deve ser **resolvível** no momento da configuração: `USER` → usuário com vínculo `ACTIVE` que possua `APPROVAL_DECIDE` em algum escopo; `ROLE` → perfil ativo que contenha `APPROVAL_DECIDE`; `DEPARTMENT_HEAD` → `approverDepartmentResolution` obrigatório e, se `FIXED`, unidade ativa com titular (`headUserId`). Resoluções `REQUESTING_SECRETARIAT`/`REQUESTING_DEPARTMENT` só são verificadas na solicitação (US-051). `slaDays` entre 1 e 365; `slaType` padrão `BUSINESS`; `allowDeputy` obrigatório.
- **RN-DOC-08** — Alterações de `requiresApproval`, `approvalPolicy`, `defaultConfidentiality` e numeração valem para ações futuras; nunca alteram documentos existentes, versões, números emitidos ou aprovações em curso.
- **RN-DOC-09** — Desativação: bloqueada (409 `CONFLICT`) quando o tipo é exigido por regra `REQUIRED_DOCUMENT` `BLOCKING` ativa de versão de workflow `PUBLISHED`; demais referências (etapas que listam o tipo, regras `WARNING`) geram apenas aviso na prévia de impacto.
- **RN-DOC-10** — Tipo inativo não pode ser usado para criar documentos (`DOC-02` e criações tipadas → `VALIDATION_ERROR`/`REFERENCE_INACTIVE` em `documentTypeId`); documentos existentes do tipo seguem normalmente.
- **RN-DOC-11** — Nenhum tipo é excluído (não há rota de exclusão): o ciclo é criar → editar → desativar/reativar.
- **RN-DOC-12** — `DTY-01` é capacidade implícita e por padrão retorna só tipos ativos; `includeInactive=true` exige `DOCUMENT_TYPE_MANAGE`. A lista é servida de cache por tenant (TTL 10 min) invalidado por `DocumentTypeChanged`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Natureza | `kind` | rádio (`DocumentKind`) | Sim (criação) | `FREE_TEXT` ou `UPLOADED`; imutável (RN-DOC-01) | `FREE_TEXT` |
| Nome | `name` | texto curto | Sim | 3–120 caracteres; trim | — |
| Código | `code` | texto curto | Sim (criação) | RN-DOC-02 | sugerido do nome |
| Descrição | `description` | texto longo | Não | até 2.000 | — |
| Permite vários por processo | `allowMultiplePerProcess` | interruptor | Sim | RN-DOC-04 | `true` |
| Numerar documentos | `numberingEnabled` | interruptor | Sim | — | `true` |
| Máscara de numeração | `numberingMask` | texto curto | Não | RN-DOC-05; prévia via `SET-04` | nula (máscara padrão) |
| Exige aprovação avulsa | `requiresApproval` | interruptor | Sim | RN-DOC-06 | `false` |
| Tipo de aprovador | `approvalPolicy.approverType` | seleção (`ApproverType`) | Condicional | RN-DOC-07 | — |
| Aprovador (usuário) | `approvalPolicy.approverUserId` | seletor (`USR-02`) | Se `USER` | vínculo ativo + `APPROVAL_DECIDE` | — |
| Perfil aprovador | `approvalPolicy.approverRoleId` | seletor (`ROL-02`) | Se `ROLE` | perfil ativo com `APPROVAL_DECIDE` | — |
| Unidade cujo titular aprova | `approvalPolicy.approverDepartmentResolution` / `approverFixedDepartmentId` | seleção / seletor (`DEP-02`) | Se `DEPARTMENT_HEAD` | `FIXED` exige unidade ativa com titular | `REQUESTING_SECRETARIAT` |
| Permitir substituto | `approvalPolicy.allowDeputy` | interruptor | Condicional | — | `true` |
| Prazo da aprovação | `approvalPolicy.slaDays` / `slaType` | número / seleção (`DayCountType`) | Não | 1–365 | — / `BUSINESS` |
| Confidencialidade padrão | `defaultConfidentiality` | seleção (`Confidentiality`) | Sim | — | `INTERNAL` |
| Ordem de exibição | `sortOrder` | número | Não | 0–999 | `0` |
| Situação | `isActive` | ação Desativar/Reativar | — | RN-DOC-04, RN-DOC-09 | `true` |
| *(sistema)* Do sistema / módulo / template padrão | `isSystem`, `systemModule`, `defaultTemplateId` | — | — | somente leitura; template via `DTY-04` | semeados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Obrigatórios e tamanhos (`name`, `code`, `kind`) | Front + API (Zod) | "Informe o nome do tipo (3 a 120 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Formato do código | Front + API | "Use letras maiúsculas, números e _ (ex.: PARECER_TECNICO)." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | `kind = STRUCTURED` na criação | API | "Tipos estruturados são fornecidos pela plataforma." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-04 | Alteração de campo imutável ou restrito em tipo de sistema | API | "Este campo não pode ser alterado." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-05 | Código já usado no tenant | API (+ índice único) | "Já existe um tipo com o código {code}." | `CONFLICT` (409) |
| V-06 | Máscara inválida | Front + API | "A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos." | `NUMBERING_MASK_INVALID` |
| V-07 | `requiresApproval` sem política | Front + API | "Defina quem aprova documentos deste tipo." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-08 | Aprovador/perfil/unidade inexistente ou de outro tenant | API | "Selecione um aprovador válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-09 | Aprovador inativo, perfil sem `APPROVAL_DECIDE` ou unidade inativa | API | "O aprovador selecionado não pode decidir aprovações." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-10 | Unidade fixa sem titular | API | "A unidade selecionada não tem titular cadastrado." | `APPROVER_UNRESOLVED` (422) |
| V-11 | `slaDays` fora de 1–365 | Front + API | "O prazo deve estar entre 1 e 365 dias." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-12 | Desativar tipo `STRUCTURED` | API | "Tipos estruturados não podem ser desativados." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-13 | Desativar tipo exigido por regra bloqueante publicada | API | "Este tipo é exigido pelo fluxo {workflow} (etapa {etapa}). Ajuste o fluxo antes de desativar." | `CONFLICT` (409) |
| V-14 | `allowMultiplePerProcess` alterado com documentos existentes | API | "Não é possível mudar esta opção: já existem documentos deste tipo." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |

## Permissões
- **Permissão:** `DOCUMENT_TYPE_MANAGE` (risco `H`, sem escopo de processo) para `DTY-02`, `DTY-03` e `DTY-01?includeInactive=true`. `DTY-01` padrão é capacidade implícita (vínculo ativo). `DTY-04` exige `TEMPLATE_PUBLISH` (US-108).
- **Políticas:** POL-14 (MFA para permissão `H`); POL-15 impede que vínculos `EXTERNAL` recebam perfis com esta permissão.
- **MFA:** exigido quando `security.mfaPolicy` ∈ {`ADMINS`, `ALL`}; sem MFA → 403 `MFA_REQUIRED` e *step-up* no BFF.
- **Sem permissão:** o item de menu "Tipos de documento" não é exibido (permissions.md §9); acesso direto à rota exibe SCR-111 (403); a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentTypeChanged` | `document_type.changed` | Commit de `DTY-02` e `DTY-03` (inclui ativar/desativar) | Payload `documentTypeId`, `code`, `changedFields[]`; consumidor de invalidação de cache (C) |

Sem projeção na timeline (configuração não pertence a um processo).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. Alterações de configuração ficam na auditoria (`CONFIGURATION`). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar tipos de documento

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com os tipos de documento semeados
    And a usuária "Marta" possui o perfil "ADMIN_ORGAO" com escopo "TENANT" e sessão com MFA
    And a política de MFA do tenant é "ADMINS"

  Scenario: [Sucesso] Criar tipo personalizado de texto livre
    When "Marta" criar o tipo "Parecer técnico" com código "PARECER_TECNICO", natureza "FREE_TEXT" e máscara "PT {seq:3}/{year}"
    Then a API deve responder 201 com "ETag" igual a "1"
    And o tipo deve ser criado com "isSystem" falso e "isActive" verdadeiro
    And a prévia de numeração deve exibir "PT 001/2026"
    And deve gerar registro de auditoria "document_type.create" com categoria "CONFIGURATION"
    And deve gerar o evento "DocumentTypeChanged" com "changedFields" contendo "numberingMask"

  Scenario: [Sucesso] Ligar aprovação avulsa em tipo de sistema
    Given o tipo de sistema "NOTA_TECNICA" com "requiresApproval" falso
    When "Marta" ligar "Exige aprovação avulsa" com aprovador "DEPARTMENT_HEAD" da "secretaria solicitante", substituto permitido e prazo de 3 dias úteis
    Then o tipo deve ficar com "requiresApproval" verdadeiro e a política gravada
    And documentos "NOTA_TECNICA" em rascunho devem passar a oferecer "Submeter" em vez de "Finalizar"
    And documentos "NOTA_TECNICA" já finalizados não devem ser alterados

  Scenario: [Sucesso] Desativar tipo personalizado sem uso em regras
    Given o tipo "PARECER_TECNICO" com 4 documentos existentes e nenhuma regra que o exija
    When "Marta" confirmar a desativação após ver a prévia "4 documentos existentes continuarão acessíveis"
    Then o tipo deve ficar inativo
    And o tipo não deve aparecer no menu "Criar documento" de nenhum processo
    And os 4 documentos existentes devem continuar acessíveis

  Scenario: [Validação] Código imutável e campos restritos de tipo de sistema
    When "Marta" enviar PATCH do tipo "OFICIO" alterando "code" para "OFICIO_EXTERNO"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "code"
    When "Marta" enviar PATCH do tipo "DFD" com "isActive" falso
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "isActive"

  Scenario: [Validação] Política de aprovação não resolvível
    Given a unidade "Gabinete" está ativa e sem titular
    When "Marta" ligar a aprovação avulsa com aprovador "DEPARTMENT_HEAD" de unidade fixa "Gabinete"
    Then a API deve responder 422 com código "APPROVER_UNRESOLVED"
    When "Marta" informar "requiresApproval" verdadeiro sem "approvalPolicy"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" no campo "approvalPolicy"

  Scenario: [Validação] Máscara de numeração inválida
    When "Marta" salvar a máscara "PT {seq:3}" sem o ano
    Then a API deve responder 422 com código "NUMBERING_MASK_INVALID"
    And o painel deve exibir "A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos."

  Scenario: [Validação] Desativação bloqueada por regra publicada
    Given o workflow publicado "Fase preparatória — Lei 14.133/2021" exige "PARECER_TECNICO" por regra "BLOCKING" na etapa "TERMO_REFERENCIA"
    When "Marta" tentar desativar "PARECER_TECNICO"
    Then a API deve responder 409 com código "CONFLICT" citando o workflow e a etapa
    And o tipo deve permanecer ativo

  Scenario: [Permissão] Usuário sem DOCUMENT_TYPE_MANAGE
    Given o usuário "Lúcia" possui apenas o perfil "GESTOR_CONTRATACOES"
    When "Lúcia" acessar o menu de administração
    Then o item "Tipos de documento" não deve ser exibido
    When "Lúcia" enviar POST para "/api/v1/document-types"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "DOCUMENT_TYPE_MANAGE"

  Scenario: [Permissão] Administradora sem MFA na sessão
    Given que a sessão de "Marta" não registra autenticação com MFA
    When "Marta" enviar PATCH para um tipo de documento
    Then a API deve responder 403 com código "MFA_REQUIRED"
    And nenhuma alteração deve ser persistida

  Scenario: [Tenant incorreto] Tipo ou aprovador de outro tenant
    Given que existe o tipo "PORTARIA" no tenant "Câmara de Vila Nova"
    When "Marta" enviar PATCH para o id do tipo "PORTARIA"
    Then a API deve responder 404 com código "NOT_FOUND"
    When "Marta" informar como aprovador um usuário vinculado somente à "Câmara de Vila Nova"
    Then a API deve responder 422 com erro "REFERENCE_NOT_FOUND" no campo "approvalPolicy.approverUserId"

  Scenario: [Duplicidade] Código já existente e reenvio idempotente
    Given que existe o tipo com código "PARECER_TECNICO"
    When "Marta" criar outro tipo com código "PARECER_TECNICO"
    Then a API deve responder 409 com código "CONFLICT" e a mensagem "Já existe um tipo com o código PARECER_TECNICO."
    When a criação original for reenviada com a mesma "Idempotency-Key"
    Then a API deve responder 201 com o mesmo tipo e o cabeçalho "Idempotent-Replayed: true"

  Scenario: [Concorrência] Edições simultâneas do mesmo tipo
    Given que "Marta" e "Otávio" abriram o tipo "OFICIO" na versão 3
    And "Otávio" salvou a alteração do nome, levando o tipo à versão 4
    When "Marta" salvar a alteração da máscara com "If-Match" igual a "3"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And o painel deve oferecer "Recarregar e reaplicar minhas alterações"

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados está indisponível
    When "Marta" salvar um novo tipo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum tipo, auditoria ou evento deve ser persistido
    And o painel deve manter os dados preenchidos

  Scenario: [Falha de integração] Relay do outbox e Redis indisponíveis
    Given que o relay do outbox e o Redis estão indisponíveis
    When "Marta" renomear o tipo "OFICIO" para "Ofício externo"
    Then a alteração deve ser persistida e a API deve responder 200
    And o evento "DocumentTypeChanged" deve permanecer "PENDING" no outbox
    And a lista de tipos deve refletir o novo nome em até 10 minutos (expiração do cache) ou assim que o evento for publicado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Schema inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]` |
| Campo imutável/restrito | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Este campo não pode ser alterado." | Campo exibido como somente leitura |
| Código duplicado | 409 | `CONFLICT` | "Já existe um tipo com o código {code}." | Erro no campo código |
| Máscara inválida | 422 | `NUMBERING_MASK_INVALID` | "A máscara deve conter {seq:N} e {year}…" | Erro no campo; prévia limpa |
| Aprovador não resolvível | 422 | `APPROVER_UNRESOLVED` | "A unidade selecionada não tem titular cadastrado." | Link para a estrutura organizacional |
| Desativação bloqueada | 409 | `CONFLICT` | "Este tipo é exigido pelo fluxo {workflow}…" | Prévia de impacto com links |
| Sem permissão / MFA | 403 | `PERMISSION_DENIED` / `MFA_REQUIRED` | "Você não tem permissão…" / "Confirme sua identidade para continuar." | SCR-111 / *step-up* |
| Tipo inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Tipo de documento não encontrado." | Volta à lista |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Este tipo foi alterado por outra pessoa." | Recarregar e reaplicar |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega o tipo |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; exibe correlationId |

## Dependências
- **Stories:** US-100 (contexto de tenant). Relacionadas: US-099 (semeadura dos tipos), US-105 (máscaras e sequência), US-108 (template padrão — `DTY-04`), US-040/US-044 (workflows e regras referenciam códigos), US-051 (resolução do aprovador na solicitação), US-065 (consome tipos no ciclo de vida), US-073 (auditoria), US-082 (outbox).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-022, DEC-027, DEC-028, DEC-030, DEC-059, DEC-104, DEC-105, DEC-134; ADR-006.
- **Configurações:** `numbering.document.defaultMask`, `numbering.process.scope` (escopo da sequência de documentos — US-105), `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. Não há código de erro específico para código de tipo duplicado; usado `CONFLICT` (409). Proposta: `DOCUMENT_TYPE_CODE_TAKEN` em api.md §2.2.
  2. Os valores de `numberingMask`/`numberingEnabled` dos tipos semeados não estão definidos (com a máscara padrão, `NOTA_TECNICA` geraria "NOTA_TECNICA 0001/2026"). Proposta para entities.md §7: `DESPACHO` → `DESP {seq:4}/{year}`, `OFICIO` → `OF {seq:4}/{year}`, `NOTA_TECNICA` → `NT {seq:4}/{year}`, `AUTORIZACAO` → `AUT {seq:4}/{year}`, `DECLARACAO` → `DECL {seq:4}/{year}`, `DOCUMENTO_EXTERNO` com `numberingEnabled = false`.
  3. `document` e `workflow` estão no mesmo nível em architecture.md §3.3 e `workflow` já consome tipos de `document`; a verificação de uso (RN-DOC-09) usa a porta `DocumentTypeUsageProvider` (proposta), declarada em `document` e implementada por `workflow`.
  4. Contrato detalhado de DTY-01..03 (api.md §4 ainda vazia), incluindo `editableFields` por item, proposto na seção API deste card.

## Impacto técnico
- **Núcleo antecipado:** `DocumentTypeFacade` (`getByCode`, `getById`, `listActive`, `assertCreatable`) com cache por tenant (`cf:{env}:t:{tenantId}:document-types`, TTL 10 min, invalidação por `DocumentTypeChanged`) é usado por US-040 (validação de códigos no workflow) e US-065 (criação e ciclo de vida). Deve ser entregue antes da tela.
- **Imutabilidade do código** sustenta regras, routing keys e numeração; o schema Zod de `DTY-03` não aceita `code`/`kind` (resposta `NOT_ALLOWED` explícita, em vez de ignorar silenciosamente).
- Validação da política reutiliza fachadas de nível inferior (`access`, `identity`, `organization`); a resolução definitiva continua no momento da solicitação (US-051), pois titulares e perfis mudam.
- Sem migração de dados: tabela `document_types` criada no setup do módulo; seeds por US-099.

## Backend
- **Módulo(s):** `document` (dono de `DocumentType`); usa `catalog` (`NumberingFacade.validateMask`, `NumberingFacade.preview`), `access` (`RoleFacade.hasPermission(roleId, 'APPROVAL_DECIDE')`, `AuthorizationService.assertCan('DOCUMENT_TYPE_MANAGE')`), `identity` (`MembershipFacade.assertActiveWithPermission`), `organization` (`DepartmentFacade.getHead`), porta `DocumentTypeUsageProvider` (implementada por `workflow`), `audit` (`AuditService`), `platform` (`OutboxWriter`, `IdempotencyService`, `TenantCache`).
- **Casos de uso:** `ListDocumentTypesQuery`; `CreateDocumentTypeCommand`; `UpdateDocumentTypeCommand` (inclui ativar/desativar); `PreviewDocumentTypeImpactQuery` (documentos existentes e uso em workflows).
- **Domínio:** `DocumentType.createCustom(props)` (RN-DOC-01/02/05/06), `DocumentType.update(patch, { isSystem })` (RN-DOC-03/04), value objects `NumberingMask`, `ApprovalPolicy` (schema `approvalPolicySchema` — entities.md §5.7).
- **Transação:** validação → autorização → (atualização com `version = version + 1` condicionada ao `If-Match`) → auditoria → outbox → commit.

## Frontend
- **Tela(s):** SCR-108 (`/admin/tipos-documento`).
- **Componentes:** `DataTable` agrupada por natureza, `Badge` de situação e "Do sistema", `Sheet` lateral com formulário React Hook Form + `zodResolver`, `NumberingMaskInput` com prévia (debounce 500 ms → `SET-04`), `ApprovalPolicyFieldset` (campos condicionais por tipo de aprovador), `UserLookup`, `RoleSelect`, `DepartmentTreeSelect`, `ImpactPreviewDialog`, `LockedField` (campos restritos com explicação).
- **Dados:** `['t', tenantId, 'document-types', { includeInactive }]` (staleTime 5 min); mutações com `Idempotency-Key` e `If-Match`; invalidação da lista e de `['t', tenantId, 'processes', processId, 'documents']` em sucesso.
- **Estados:** skeleton da tabela; vazio impossível (há seeds) — em erro de carga, "Não foi possível carregar os tipos. Tentar novamente"; botão salvar com "Salvando…"; aviso de impacto antes de mudanças relevantes (FA-04/FA-05).
- **Acessibilidade e responsividade:** painel com foco preso e retorno ao gatilho; campos condicionais anunciados (`aria-live`); cadeado com texto alternativo; tela administrativa *desktop-first*, utilizável em 768 px (tabela vira lista de cartões).

## Banco de dados
- **Tabelas:** `document_types` (leitura/escrita); leitura de `documents` (contagem para prévia e RN-DOC-04); `audit_logs`, `outbox_events`.
- **Migrações:** `document_types` conforme entities.md §4.7 (RLS, `UNIQUE (tenant_id, id)`, FK composta `default_template_id`), checks `(kind = 'STRUCTURED') = (system_module IS NOT NULL)` e `NOT requires_approval OR approval_policy IS NOT NULL`; check adicional `code ~ '^[A-Z][A-Z0-9_]{1,39}$'`; trigger que impede `UPDATE` de `code`, `kind`, `system_module`, `is_system`.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, code)`; índice `(tenant_id, is_active, sort_order)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DTY-01 | GET | `/api/v1/document-types` | `?includeInactive=false&kind=FREE_TEXT,UPLOADED&q=` | `200 { data: [{ id, code, name, description, kind, systemModule, isSystem, isActive, allowMultiplePerProcess, numberingEnabled, numberingMask, nextNumberPreview, requiresApproval, approvalPolicy, defaultConfidentiality, defaultTemplate { id, name, versionNumber }?, sortOrder, editableFields[], version }] }` | 200, 403 (`includeInactive` sem permissão) |
| DTY-02 | POST | `/api/v1/document-types` | `{ kind, code, name, description?, allowMultiplePerProcess, numberingEnabled, numberingMask?, requiresApproval, approvalPolicy?, defaultConfidentiality, sortOrder? }` + `Idempotency-Key` | `201 { data: DocumentType }` + `Location`, `ETag` | 201, 403, 409, 422, 503 |
| DTY-03 | PATCH | `/api/v1/document-types/{id}` | campos editáveis (RN-DOC-03) + `If-Match` | `200 { data: DocumentType }` + `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| DTY-04 | PUT | `/api/v1/document-types/{id}/default-template` | `{ templateId }` + `If-Match` (US-108) | `200 { data: DocumentType }` | 200, 403, 404, 412, 422 |
| SET-04 | POST | `/api/v1/numbering/preview` | `{ mask, documentTypeCode }` (US-105) | `200 { data: { example: "PT 008/2026", nextValue: "8" } }` | 200, 422 |

## Logs
- `info` `document_type.created` / `document_type.updated` — `documentTypeId`, `code`, `changedFields`, `tenantId`, `userId`, `correlationId`.
- `info` `document_type.deactivated` — `documentTypeId`, `existingDocumentsCount`.
- `warn` `document_type.cache_invalidation_failed` — falha de Redis no handler de invalidação (cache expira pelo TTL).
- `error` `document_type.update_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo de `description`, dados pessoais do aprovador (somente ids).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document_type.create` | `CONFIGURATION` | Commit de `DTY-02` | `changes`: valores iniciais; `metadata`: `code`, `kind`, `idempotencyKey` |
| `document_type.update` | `CONFIGURATION` | Commit de `DTY-03` (inclusive ativar/desativar) | `changes`: `[{ path, old, new }]` dos campos alterados (inclui `approvalPolicy` campo a campo); `metadata`: `code`, `isSystem`, `impact { documentsCount, workflowsReferencing }` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/MFA | `reasonCode = DOCUMENT_TYPE_MANAGE` ou `MFA_REQUIRED` |

## Testes necessários
- **Unitários:** `DocumentType.createCustom`/`update` (RN-DOC-01..06); `NumberingMask` (tokens válidos, `{seq:N}` 1–8, tamanho); `ApprovalPolicy` (combinações por `approverType`); matriz de campos editáveis em tipos de sistema.
- **Integração (Testcontainers):** trigger de imutabilidade de `code`/`kind`; checks do banco; RLS; desativação bloqueada por regra publicada (porta implementada por `workflow`); auditoria + outbox na mesma transação.
- **API/contrato:** DTY-01..03 conforme este card e o OpenAPI; `editableFields`; `If-Match`/`ETag`; `Idempotency-Key`.
- **RBAC e multi-tenant:** `ADMIN_ORGAO` × demais perfis; MFA exigido; id de outro tenant → 404; aprovador de outro tenant → 422 `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas edições com o mesmo `If-Match` → uma 200 e outra 412; criação concorrente do mesmo código → uma 201 e outra 409.
- **E2E (Playwright):** criar tipo, ligar aprovação avulsa, desativar com prévia de impacto, conferir menu "Criar documento" no processo.
- **Acessibilidade/performance:** axe sem violações sérias em SCR-108; DTY-01 p95 < 150 ms com cache.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `DOCUMENT_TYPE_MANAGE` + MFA aplicados; menu e rota ocultos sem permissão
- [ ] Imutabilidade de `code`/`kind` garantida por schema **e** trigger
- [ ] Auditoria `document_type.*` e evento `DocumentTypeChanged` verificados; cache invalidado pelo handler
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de DTY-01..03 compatível com api.md e com este card
- [ ] Logs sem dados sensíveis; métricas de cache (hit/miss) presentes
- [ ] Tela acessível (axe) e textos revisados por UX writing
- [ ] Revisão de código e de segurança aprovadas
- [ ] Lacunas registradas levadas a decisions.md/api.md/entities.md

## Estimativa
**M** — CRUD administrativo com regras de imutabilidade, validação de política de aprovação contra três módulos, prévia de impacto com porta para `workflow`, cache com invalidação por evento e formulário condicional.

## Prioridade
**P1** — a tela administrativa é necessária ao release (regulamentos locais exigem tipos próprios e aprovação avulsa), mas seu núcleo (fachada, cache e tipos semeados) é pré-requisito de US-040 e US-065 (P0) e deve ser implementado primeiro (delivery-plan.md, nota ¹).
