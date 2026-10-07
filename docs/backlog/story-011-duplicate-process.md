---
id: US-011
title: "Duplicar processo"
epic: EP-001
feature: FT-006
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-001, US-065]
modules: [process, workflow, catalog, access, timeline, audit, platform]
screens: [SCR-006, SCR-113]
endpoints: [PRC-27]
permissions: [PROCESS_DUPLICATE, PROCESS_CREATE]
events: [ProcessCreated, ProcessDuplicated, DocumentCreated]
---

# US-011 — Duplicar processo

## Título
Duplicar processo

## Descrição
**Como** gestor de contratações, **quero** duplicar um processo existente para abrir um novo processo com os mesmos metadados, itens e etiquetas — e, opcionalmente, cópia dos documentos estruturados como novos rascunhos e dos anexos —, **para** reaproveitar contratações recorrentes sem recomeçar a digitação do zero.

O diálogo SCR-113 oferece as opções `copyDocuments`/`copyAttachments`. Ao confirmar, o sistema cria um processo novo com as mesmas regras de criação da US-001 (número próprio, workflow re-resolvido, etapa inicial, custódia de quem duplicou) e `duplicatedFromId` apontando para a origem. Nunca copia: número, aprovações, tramitações, timeline, comentários, auditoria e participantes (DEC-033).

## Contexto
- Órgãos repetem contratações ano a ano (ex.: merenda escolar, combustível) e hoje recomeçam a digitação do zero ou copiam arquivos manualmente, arrastando dados desatualizados.
- DEC-033 define o que a duplicação copia (metadados, itens, etiquetas e, opcionalmente, documentos estruturados como novos rascunhos e anexos por cópia lógica) e o que nunca copia (número, aprovações, tramitações, timeline, comentários, auditoria, participantes).
- O novo processo segue as mesmas regras de criação da US-001 (numeração, resolução de workflow, concessões de acesso, auditoria, outbox); esta story cobre apenas as diferenças: origem dos dados copiados e o vínculo `duplicatedFromId`.
- Pesquisa de preços, quando copiada, traz itens e fontes, mas nunca cotações — dados de mercado perdem validade rapidamente.

## Objetivo
Permitir abrir um novo processo a partir de um existente em menos de 1 minuto, com 100% das duplicações gerando um processo íntegro (numerado e com workflow resolvido para os próprios dados) e nenhum vazamento dos itens vedados pela DEC-033.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`).
- **Secundária:** Planejamento (`PLANEJAMENTO`), ao reabrir contratação recorrente prevista no PCA.

## Pré-condições
- Processo de origem existe, está visível ao usuário (DEC-024) e o usuário tem `PROCESS_VIEW` sobre ele.
- Usuário tem `PROCESS_DUPLICATE` cobrindo o processo de origem **e** `PROCESS_CREATE` cobrindo a unidade solicitante do novo processo.
- Catálogos/unidades referenciados pelo processo de origem continuam ativos (senão, o diálogo pede ajuste antes de confirmar).

## Fluxo principal
1. No painel do processo de origem (SCR-006), menu "Mais" → "Duplicar processo".
2. Diálogo SCR-113 mostra Título/Objeto pré-preenchidos (editáveis), Secretaria/Setor solicitantes (editáveis, padrão = os da origem) e os interruptores **Copiar documentos estruturados (como rascunho)** e **Copiar anexos** (desligados por padrão).
3. Usuário ajusta e confirma; o front envia `POST /processes/{id}/duplicate` com `Idempotency-Key`.
4. A API, em transação (reaproveitando o `CreateProcessHandler` da US-001): valida `PROCESS_DUPLICATE` na origem e `PROCESS_CREATE` na unidade solicitante do novo; copia os dados (ajustados ou não); resolve o workflow aplicável aos dados do **novo** processo (pode diferir do original) e sua etapa inicial; atribui novo número/código, independente da numeração da origem; copia `ProcessItem` (nova sequência própria) e `ProcessTag`; se `copyDocuments`, cria um novo `Document` em `DRAFT` por documento estruturado elegível da origem, com o conteúdo mais recente copiado (pesquisa de preços copia itens e fontes, nunca cotações), gerando `DocumentCreated` por documento; se `copyAttachments`, cria novos `Attachment` com cópia lógica (mesmo objeto de armazenamento); cria `ProcessStage`, `ProcessAssignment`, `ProcessMovement` (`CREATE`) e os `ProcessAccess` iniciais do novo processo; grava `duplicatedFromId`; registra auditoria `process.duplicate` (na origem) e `process.create` (no novo); publica `ProcessCreated` e `ProcessDuplicated`; grava timeline na origem **e** no novo.
5. API responde 201 com o novo processo, `Location` e `ETag: "1"`.
6. Front navega para o painel do novo processo com o toast "Processo 0045/2026 criado a partir de 0012/2026".

## Fluxos alternativos
- **FA-01 — Referência inativa na origem:** catálogo/unidade copiado está inativo; o diálogo pede um substituto antes de confirmar (mesma validação da US-001).
- **FA-02 — Nenhum workflow aplicável aos novos dados:** `NO_APPLICABLE_WORKFLOW`, mesmo comportamento da FA-06 da US-001.
- **FA-03 — Nenhum documento elegível para copiar:** o interruptor "Copiar documentos" fica desabilitado com a dica "Nenhum documento estruturado para copiar".
- **FA-04 — Pesquisa de preços copiada:** apenas itens e fontes (`PriceSource`) são copiados; cotações (`Quotation`) nunca são copiadas — a pesquisa nasce a refazer no novo documento.
- **FA-05 — Ajuste de unidade solicitante no diálogo:** só aparecem no seletor as unidades cobertas pelo escopo de `PROCESS_CREATE` do usuário (mesma regra da FA-08 da US-001).

## Regras de negócio
- **RN-PROC-118** — Sempre copiados (ou os valores ajustados no diálogo): `title`, `object`, `description`, `contractingTypeId`, `modalityId`, `isPriceRegistration`, `priority`, `originId`, dados de PCA, `notes`, itens (`ProcessItem`) e etiquetas (`ProcessTag`) (DEC-033).
- **RN-PROC-119** — Nunca copiados: `number`, `code`, `internalCode`, aprovações, tramitações (`ProcessMovement`/`ProcessStage`/`ProcessAssignment` da origem), timeline, comentários, auditoria, participantes e `estimatedValue`/`estimatedValueSource` (recalculados do zero no novo processo) (DEC-033).
- **RN-PROC-120** — Com `copyDocuments = true`, documentos estruturados (`DocumentKind = STRUCTURED`) elegíveis da origem são copiados como novos `Document` em `DRAFT`, usando o conteúdo mais recente disponível (versão aprovada/finalizada ou rascunho atual); pesquisa de preços copia `PriceItem`/`PriceSource`, nunca `Quotation`.
- **RN-PROC-121** — Com `copyAttachments = true`, cada anexo elegível gera um novo `Attachment` com cópia lógica (mesmo objeto de armazenamento, novo registro vinculado ao novo processo/documento).
- **RN-PROC-122** — O novo processo segue as mesmas regras de numeração, resolução de workflow e concessões de acesso da US-001 (RN-PROC-04/05/06/07/14), de forma independente da origem.
- **RN-PROC-123** — `duplicatedFromId` é gravado no novo processo e é imutável; o processo de origem não mantém lista de duplicados (consulta reversa por `duplicatedFromId`, quando necessária).
- **RN-PROC-124** — Exige `PROCESS_DUPLICATE` cobrindo o processo de origem **e** `PROCESS_CREATE` cobrindo a unidade solicitante final do novo processo (RN-PROC-03).
- **RN-PROC-125** — A duplicação em si não altera o processo de origem, exceto pelo registro de auditoria `process.duplicate`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Título | `title` | texto curto | Sim | 5–200 caracteres | título da origem |
| Objeto | `object` | texto longo | Sim | 10–2.000 caracteres | objeto da origem |
| Secretaria solicitante | `requestingSecretariatId` | seleção | Sim | RN-PROC-02 | secretaria da origem |
| Setor solicitante | `requestingDepartmentId` | seleção em árvore | Sim | RN-PROC-02/03 | setor da origem |
| Copiar documentos estruturados | `copyDocuments` | interruptor | Não | — | `false` |
| Copiar anexos | `copyAttachments` | interruptor | Não | — | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios/limites de tamanho | Front + API | "Informe o {campo}." / "O {campo} deve ter entre X e Y caracteres." | `VALIDATION_ERROR` |
| V-02 | Referência inativa copiada da origem | API | "Selecione um {campo} válido." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-03 | Setor fora da secretaria após ajuste | API | "O setor deve pertencer à secretaria selecionada." | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) |
| V-04 | Sem `PROCESS_DUPLICATE` na origem | API | "Você não tem permissão para duplicar este processo." | `PERMISSION_DENIED` |
| V-05 | Sem `PROCESS_CREATE` na unidade do novo processo | API | "Você não pode abrir processos para este setor." | `PERMISSION_DENIED` |
| V-06 | Sem workflow aplicável aos novos dados | API | "Não há fluxo configurado para estes dados." | `NO_APPLICABLE_WORKFLOW` |

## Permissões
- **Permissão:** `PROCESS_DUPLICATE` cobrindo o processo de origem **e** `PROCESS_CREATE` cobrindo a unidade solicitante final do novo processo.
- **Políticas:** RN-PROC-03 aplicada ao novo processo (mesma regra de escopo da criação); duplicar não exige custódia (POL-01) sobre a origem.
- **MFA:** `PROCESS_DUPLICATE` tem riscoL; `PROCESS_CREATE` é M; nenhuma exigida por padrão, salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Duplicar processo" não aparece no menu "Mais"; a API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessCreated` | `process.created` | Commit da duplicação, no novo processo | `duplicatedFromId` preenchido |
| `ProcessDuplicated` | `process.duplicated` | Commit da duplicação | `sourceProcessId`, `newProcessId`, `options { copyDocuments, copyAttachments }` |
| `DocumentCreated` | `document.created.<type>` (DEC-162) | Por documento copiado, quando `copyDocuments = true` | — |

Projeções síncronas: timeline no processo de origem e no novo; `ProcessAccess` iniciais do novo processo (como na US-001).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: `ProcessCreated` e `ProcessDuplicated` não notificam (mesma regra da criação — o processo nasce sob custódia de quem duplicou) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Duplicar processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo de origem "0012/2026" pertence à "Secretaria de Obras" e ao "Setor de Manutenção"
    And a usuária "Carla" possui "PROCESS_DUPLICATE" e "PROCESS_CREATE" cobrindo essas unidades

  Scenario: [Sucesso] Duplicar processo copiando itens e etiquetas
    Given que o processo "0012/2026" tem 3 itens e as etiquetas "Obras" e "Urgente"
    When "Carla" duplicar o processo sem marcar "Copiar documentos" nem "Copiar anexos"
    Then deve ser criado um novo processo com número próprio e "duplicatedFromId" igual a "0012/2026"
    And o novo processo deve ter os mesmos 3 itens e as mesmas etiquetas, sem aprovações, tramitações ou participantes
    And deve gerar os eventos "ProcessCreated" e "ProcessDuplicated"
    And deve gerar registro de auditoria "process.duplicate"

  Scenario: [Sucesso] Duplicar copiando documentos estruturados como rascunho
    Given que o processo "0012/2026" tem um "DFD" aprovado
    When "Carla" duplicar marcando "Copiar documentos estruturados"
    Then o novo processo deve ter um "DFD" em status "DRAFT" com o conteúdo copiado
    And deve gerar o evento "DocumentCreated" para o novo documento
    And nenhuma aprovação do "DFD" original deve ser copiada

  Scenario: [Validação] Referência inativa copiada da origem
    Given que a modalidade do processo "0012/2026" foi inativada após a criação
    When "Carla" duplicar o processo sem ajustar a modalidade
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_INACTIVE" no campo "modalityId"
    And nenhum processo novo deve ser criado

  Scenario: [Permissão] Usuária sem PROCESS_DUPLICATE no processo de origem
    Given que "Diego" possui "PROCESS_CREATE" mas não "PROCESS_DUPLICATE" para a "Secretaria de Obras"
    When "Diego" enviar POST para duplicar o processo "0012/2026"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_DUPLICATE"

  Scenario: [Tenant incorreto] Duplicar processo de outro tenant
    Given que o processo "0099/2026" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar POST para duplicar "0099/2026"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Carla" duplicou "0012/2026" com a chave "K9" e recebeu 201 para "0045/2026"
    When a mesma requisição for reenviada com a chave "K9"
    Then a API deve responder 201 com o mesmo processo "0045/2026" e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas um processo novo criado

  Scenario: [Concorrência] Duas duplicações simultâneas da mesma origem
    When dois usuários duplicarem o processo "0012/2026" ao mesmo tempo, com chaves de idempotência distintas
    Then devem ser criados dois processos novos com números distintos e sem lacunas
    And cada novo processo deve ter "duplicatedFromId" igual a "0012/2026"

  Scenario: [Falha de banco] Banco indisponível durante a duplicação
    Given que o banco de dados fica indisponível durante a transação de duplicação
    When "Carla" duplicar o processo "0012/2026"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum processo, item, etiqueta, documento ou anexo copiado deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível ao duplicar
    Given que o relay do outbox está indisponível
    When "Carla" duplicar o processo "0012/2026" com sucesso
    Then a API deve responder 201 e o novo processo deve existir
    And os eventos "ProcessCreated" e "ProcessDuplicated" devem permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Referência inativa copiada da origem | 422 | `VALIDATION_ERROR` | "Selecione um {campo} válido." | Pede ajuste antes de confirmar |
| Setor fora da secretaria (após ajuste) | 422 | `VALIDATION_ERROR` | "O setor deve pertencer à secretaria selecionada." | Erro no campo |
| Sem `PROCESS_DUPLICATE` na origem | 403 | `PERMISSION_DENIED` | "Você não tem permissão para duplicar este processo." | Oculta a ação |
| Sem `PROCESS_CREATE` na unidade do novo | 403 | `PERMISSION_DENIED` | "Você não pode abrir processos para este setor." | Sugere outro setor |
| Sem workflow aplicável | 422 | `NO_APPLICABLE_WORKFLOW` | "Não há fluxo configurado para estes dados." | Desabilita "Duplicar" |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Origem de outro tenant/inexistente | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Redireciona à lista |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível duplicar o processo agora." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-001 (mesmas regras de criação, numeração e resolução de workflow para o novo processo), US-065 (pré-requisito funcional indicado no backlog do épico).
- **Decisões/ADRs:** DEC-017, DEC-028, DEC-032, DEC-033, DEC-034, DEC-055, DEC-105.
- **Configurações:** `numbering.process.mask`, `numbering.process.scope`, `numbering.process.assignOn` (reaproveitadas da US-001 para o novo processo).
- **Lacunas nas fontes canônicas:** nenhuma (routing key `document.created.<type>` — events.md, DEC-162).

## Impacto técnico
- Reaproveita o `TransactionalCommandHandler`/fluxo da US-001 para a criação do novo processo; a diferença está na origem dos dados (cópia em vez de formulário) e no `duplicatedFromId`.
- Copiar documentos estruturados pode ser custoso em processos com muitos itens/documentos — considerar processamento assíncrono se o volume exceder um limiar (P2; o MVP 1 assume volumes pequenos por tenant).
- Copiar anexos é lógico (mesmo objeto de armazenamento) — não duplica bytes no storage, só o registro `Attachment` e sua referência.

## Backend
- **Módulo(s):** `process` (dono); `document` (cópia de documentos estruturados), `catalog` (`NumberingFacade`, `assertActive`), `workflow` (`resolveApplicable` para os novos dados), `access`, `audit`, `platform`.
- **Casos de uso:** `DuplicateProcessCommand` → `DuplicateProcessHandler` (compõe `CreateProcessHandler` + cópia de itens/etiquetas + cópia de documentos + cópia de anexos).
- **Domínio:** `Process.create(props)` (reutilizado), `Process.markDuplicatedFrom(sourceId)`; `Document.copyAsDraft(sourceDocument)` (RN-PROC-120).
- **Transação:** todos os passos do fluxo principal em uma única transação; falha em qualquer etapa desfaz tudo, inclusive a numeração do novo processo.

## Frontend
- **Tela(s):** SCR-113 (diálogo "Duplicar processo"), redirecionamento para SCR-006 do novo processo.
- **Componentes:** formulário reaproveitando os campos de identificação da US-001 (pré-preenchidos), dois `Switch` (`copyDocuments`, `copyAttachments`) com texto de ajuda sobre o que é/não é copiado.
- **Estados:** loading ao confirmar; lista de documentos elegíveis exibida quando `copyDocuments` é ativado; erro de referência inativa com link para corrigir.
- **Acessibilidade e responsividade:** foco inicial no título; textos de ajuda associados via `aria-describedby`; utilizável em 360 px.

## Banco de dados
- **Tabelas escritas:** `processes`, `process_items`, `process_tags`, `process_stages`, `process_assignments`, `process_movements`, `process_access`, `documents`, `document_versions` (se `copyDocuments`), `attachments` (se `copyAttachments`), `number_sequences`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova (usa `processes.duplicated_from_id`, já previsto em entities.md §4.4).
- **Índices/constraints relevantes:** mesmos da US-001 (numeração, `code` único) aplicados ao novo processo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-27 | POST | `/api/v1/processes/{id}/duplicate` | `{ title?, object?, requestingSecretariatId?, requestingDepartmentId?, copyDocuments?, copyAttachments? }` + `Idempotency-Key` | `201 { data: Process }` com `duplicatedFromId` | 201, 403, 404, 422, 429, 500, 503 |

## Logs
- `info` `process.duplicated` — `sourceProcessId`, `newProcessId`, `copyDocuments`, `copyAttachments`, `documentsCopied`, `durationMs`, `correlationId`.
- `warn` `process.duplicate_partial_copy` — quando algum documento/anexo elegível não pôde ser copiado; o processo ainda é criado.
- `error` `process.duplicate_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** título/objeto do processo, conteúdo de documentos copiados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.duplicate` | `DATA_CHANGE` | Commit da duplicação, no processo de origem | `changes`: `newProcessId`; `metadata`: `copyDocuments`, `copyAttachments` |
| `process.create` | `DATA_CHANGE` | Commit da duplicação, no novo processo | `metadata`: `duplicatedFromId` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = PROCESS_DUPLICATE` ou `PROCESS_CREATE` |

## Testes necessários
- **Unitários:** regras RN-PROC-118..125 (o que copia/não copia); formatação do novo código independente da origem.
- **Integração (Testcontainers):** duplicação com `copyDocuments = true` copia conteúdo mas não aprovações/versões como pendentes; pesquisa de preços copiada sem cotações.
- **Concorrência:** duas duplicações simultâneas da mesma origem → dois processos com números distintos sem lacunas.
- **API/contrato:** snapshot 201 com `duplicatedFromId`; cabeçalhos `Location`/`ETag`/`Idempotent-Replayed`.
- **RBAC e multi-tenant:** matriz `PROCESS_DUPLICATE` × `PROCESS_CREATE`; origem de outro tenant → 404.
- **E2E (Playwright):** duplicar com e sem cópia de documentos; ajustar setor solicitante no diálogo.
- **Acessibilidade/performance:** axe no diálogo; p95 < 700 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] `PROCESS_DUPLICATE` + `PROCESS_CREATE` aplicados na API; ação oculta sem permissão
- [ ] Itens vedados pela DEC-033 comprovadamente não copiados (teste dedicado)
- [ ] Transação única comprovada por teste de falha induzida (inclui numeração do novo processo)
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-27 compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita quase todo o fluxo transacional da US-001; o esforço adicional é a cópia controlada de itens/etiquetas/documentos/anexos conforme a DEC-033, sem wizard novo (diálogo único).

## Prioridade
**P1** — acelera contratações recorrentes, mas não bloqueia a jornada essencial do MVP 1 (criar, tramitar, concluir), por isso não é P0.
