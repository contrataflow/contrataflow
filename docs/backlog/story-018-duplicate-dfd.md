---
id: US-018
title: "Duplicar DFD"
epic: EP-002
feature: FT-010
mvp: 1
priority: P2
estimate: S
status: Especificada
depends_on: [US-014, US-011]
modules: [dfd, document, process, access, timeline, audit, platform]
screens: [SCR-007, SCR-113, SCR-006]
endpoints: [DFD-05, DFD-03, PRC-14]
permissions: [DFD_CREATE, PROCESS_CREATE]
events: [DocumentCreated, ProcessCreated, ProcessItemsChanged]
---

# US-018 — Duplicar DFD

## Título
Duplicar DFD

## Descrição
**Como** servidora da área requisitante, **quero** duplicar um DFD já elaborado para iniciar um novo processo semelhante ou para adiantar o DFD de um processo existente, **para** não reescrever do zero justificativas, itens e dados recorrentes. A duplicação (DFD-05) cria um novo `Document`/`Dfd` em `DRAFT` a partir do DFD de origem, copiando cabeçalho, seções e itens, com `sourceDocumentId` apontando para o original; o destino pode ser um **novo processo** (via US-011) ou um **processo existente** sem DFD, em etapa que permita o tipo.

## Contexto
- Órgãos repetem contratações semelhantes todo ano (ex.: merenda escolar, combustível); hoje cada DFD é redigitado. DEC-017 define `sourceDocumentId` em `Document` para marcar a origem de duplicação/importação.
- SCR-113 ("Duplicar processo", de US-011) é reaproveitada, com a opção adicional de duplicar só o DFD para um processo existente.

## Objetivo
Permitir duplicar um DFD em menos de 1 minuto, com 100% dos campos e itens elegíveis copiados corretamente para o destino escolhido.

## Persona
- **Principal:** Área requisitante (`REQUISITANTE`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`).

## Pré-condições
- Existe um DFD de origem visível ao usuário (`PROCESS_VIEW` no processo de origem) e `DFD_CREATE` no escopo do destino; para novo processo, também `PROCESS_CREATE` (US-011).
- Para processo existente: status editável (`DRAFT`/`IN_PROGRESS`/`RETURNED`), etapa cujo `documentTypeCodes` permite `DFD`, e sem DFD ativo.

## Fluxo principal
1. Na tela do DFD (SCR-007) ou na lista de documentos, a usuária aciona **"Duplicar DFD"**, abrindo o diálogo SCR-113.
2. Escolhe o destino: **"Novo processo"** ou **"Processo existente"** (busca por código/título, já filtrada pelas pré-condições).
3. Confirma; o front envia `POST /api/v1/dfds/{id}/duplicate` com `Idempotency-Key` e o destino escolhido.
4. Em uma única transação: cria o processo (US-011, se "novo processo") ou os `ProcessItem` equivalentes no destino (RN-DFD-75, se "processo existente"); em seguida cria o novo `Document`/`Dfd` em `DRAFT`, copiando cabeçalho, seções (`JUSTIFICATION`, `EXPECTED_RESULTS`, `NOTES`) e `DocumentItem` (remapeados), com `sourceDocumentId` = documento de origem e `wizardStep = IDENTIFICATION`.
5. A API responde 201; o front navega para o wizard do novo DFD (SCR-007) no processo destino.

## Fluxos alternativos
- **FA-01 — Processo existente sem itens:** quando o destino não tem itens próprios ainda, todos os itens do DFD de origem são clonados (caso comum, já que itens costumam nascer durante o DFD — RN-DFD-15 de US-014).
- **FA-02 — Anexos não copiados:** anexos do DFD de origem não são duplicados (ficam só como referência no documento original); a usuária os reenvia se necessário.

## Regras de negócio
- **RN-DFD-72** — "Duplicar DFD" exige `DFD_CREATE` no escopo do processo destino; para "novo processo", exige também `PROCESS_CREATE` (US-011).
- **RN-DFD-73** — Destino "processo existente": o processo deve estar em status editável, ter etapa atual cujo `documentTypeCodes` permita `DFD` e não ter DFD ativo (índice `singletonKey`); violações retornam `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` ou `DOCUMENT_ALREADY_EXISTS`.
- **RN-DFD-74** — Destino "novo processo": o novo processo é criado pela mecânica de US-011 (inclui a duplicação dos `ProcessItem` do processo de origem); o novo DFD é então criado nesse processo com os itens remapeados por `sequence`.
- **RN-DFD-75** — Destino "processo existente": para cada `DocumentItem` do DFD de origem, o sistema cria um `ProcessItem` no processo destino (natureza, descrição, unidade, código de catálogo clonados; `sequence` a partir do próximo disponível) e o `DocumentItem` correspondente no novo DFD.
- **RN-DFD-76** — Campos copiados do cabeçalho: `objectSummary`, `priority`, `expectedDate`, `estimatedValue`, `pcaStatus`, `pcaYear`, `pcaItemCode`, `pcaJustification`; `requestingDepartmentId`/`responsibleId` assumem os padrões do processo destino (RN-DFD-05 de US-014), não os do DFD de origem; `requestDate` = hoje.
- **RN-DFD-76a** — Refinamentos da cópia do cabeçalho (implementação): a `expectedDate` anterior a hoje não é copiada (CHECK `dfds_expected_date_after_request`: previsão ≥ data do DFD, que é hoje) e o `estimatedValue` não é copiado quando o orçamento do processo de origem é sigiloso (POL-09 — DEC-030: o valor não migra para outro processo/público).
- **RN-DFD-77** — O novo documento nasce `DRAFT`, `wizardStep = IDENTIFICATION`, `completedSteps = []`, numerado como qualquer DFD novo (RN-DFD-04); `sourceDocumentId` = `documentId` do DFD de origem.
- **RN-DFD-78** — Conteúdo das seções é copiado como texto (TipTap JSON), sem recalcular `defaultContent`; a usuária deve revisar antes de reenviar para aprovação (US-016).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Destino | `targetType` | enum (`NEW_PROCESS`\|`EXISTING_PROCESS`) | Sim | RN-DFD-72/73 | — |
| Processo existente | `targetProcessId` | seleção | Condicional (`EXISTING_PROCESS`) | RN-DFD-73 | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Processo destino já tem DFD ativo | API | "Este processo já possui um DFD." | `DOCUMENT_ALREADY_EXISTS` |
| V-02 | Etapa do destino não permite DFD | API | "Este processo não aceita DFD na etapa atual." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-03 | Processo destino de outro tenant/inexistente | API | "Selecione um processo válido." | `REFERENCE_NOT_FOUND` |

## Permissões
- **Permissão:** `DFD_CREATE` no escopo do destino; `PROCESS_CREATE` quando o destino for um novo processo. **Políticas:** POL-02 (tipo permitido na etapa do destino). **MFA:** não exigido.
- **Sem permissão:** botão "Duplicar DFD" oculto; API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessCreated` | `process.created` | Destino "novo processo" | Via US-011 |
| `DocumentCreated` (`DFDCreated`) | `document.created.dfd` | Sempre | Novo DFD criado |
| `ProcessItemsChanged` | `process.items_changed` | Quando itens são clonados | RN-DFD-75 |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (mesma regra de criação de DFD — RN-DFD-22, nasce sob custódia de quem duplicou) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Duplicar DFD

  Background:
    Given que existe o DFD "DFD 0003/2025" aprovado no processo "0002/2025"
    And a usuária "Ana" tem "DFD_CREATE" e "PROCESS_CREATE"
  Scenario: [Sucesso] Duplicar para novo processo
    When "Ana" duplicar o DFD escolhendo "Novo processo"
    Then um novo processo e um novo DFD "DRAFT" devem existir, com itens clonados e "sourceDocumentId" do DFD de origem
    And a API deve responder 201 levando "Ana" ao wizard do novo DFD
  Scenario: [Validação] Processo destino já possui DFD ativo
    Given que o processo "0010/2026" já tem um DFD "DRAFT"
    When "Ana" tentar duplicar para o processo "0010/2026"
    Then a API deve responder 409 "DOCUMENT_ALREADY_EXISTS" e nenhum documento deve ser criado
  Scenario: [Permissão] Sem PROCESS_CREATE para duplicar em novo processo
    Given que "Bruno" tem "DFD_CREATE" mas não "PROCESS_CREATE"
    When "Bruno" tentar duplicar o DFD escolhendo "Novo processo"
    Then a API deve responder 403 "PERMISSION_DENIED" e nada deve ser criado
  Scenario: [Tenant incorreto] Processo destino de outro tenant
    When "Ana" enviar "targetProcessId" de um processo do tenant "Prefeitura B"
    Then a API deve responder 422 "REFERENCE_NOT_FOUND" sem ler ou alterar dados de "Prefeitura B"
  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que a duplicação foi concluída com a chave "K1"
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo DFD e "Idempotent-Replayed: true", sem criar um segundo DFD
  Scenario: [Concorrência] Duas duplicações simultâneas para o mesmo processo existente
    Given que o processo "0011/2026" não tem DFD
    When duas duplicações para "0011/2026" forem enviadas ao mesmo tempo
    Then apenas uma deve criar o DFD; a outra deve receber 409 "DOCUMENT_ALREADY_EXISTS"
  Scenario: [Falha de banco] Falha após criar o processo e antes de concluir o DFD
    Given que o banco falha ao criar o "Dfd" após criar o processo
    When a transação for revertida
    Then nada deve ficar órfão e a API deve responder 503 "DEPENDENCY_UNAVAILABLE"
  Scenario: [Falha de integração] Outbox indisponível ao publicar os eventos
    Given que o relay do outbox está indisponível
    When "Ana" duplicar o DFD com sucesso
    Then o processo e o DFD devem ser criados normalmente, com os eventos "PENDING" até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| DFD ativo já existe no destino | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já possui um DFD." | Sugere abrir o DFD existente |
| Etapa do destino não permite DFD | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "Este processo não aceita DFD na etapa atual." | Oculta o processo da busca |
| Referência de outro tenant | 422 | `REFERENCE_NOT_FOUND` | "Selecione um processo válido." | Recarrega a busca |
| Banco/infra indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível duplicar agora. Tente novamente." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-014 (estrutura do DFD), US-011 (duplicar processo, inclui itens), US-006 (`ProcessItem`), US-105 (numeração), US-097 (autorização), US-082 (outbox). Indiretas: US-065.
- **Decisões/ADRs:** DEC-017 (`sourceDocumentId`), DEC-019, DEC-028.
- **Configurações:** `numbering.document.defaultMask`.
- **Lacunas nas fontes canônicas:** (1) o pacote não detalha itens entre processos distintos; assumimos (RN-DFD-75) que o DFD-05 cria `ProcessItem` equivalentes no destino, já que `ProcessItem` é exclusivo de um processo (DEC-019); (2) não há confirmação de que US-011 duplica os `ProcessItem` de origem — assumimos que sim (RN-DFD-74), a confirmar ao especificar US-011.

## Impacto técnico
- Reaproveita DFD-02 (criação) e a mecânica de US-011; nenhuma migração nova (usa `sourceDocumentId` já existente).
- Risco: duplicar itens em lote para processo existente pode gerar muitas linhas em `process_items`/`document_items` numa única transação — aceitável no volume do MVP 1 (dezenas de itens).

## Backend
- **Módulo(s):** `dfd` (dono); usa `process` (criação de `ProcessItem`), integra com `process` (US-011) para "novo processo".
- **Casos de uso:** `DuplicateDfdCommand` → `DuplicateDfdHandler`.
- **Domínio:** `Dfd.duplicateFrom(sourceDfd, target)`; reaproveita `ProcessItem.cloneInto(targetProcessId)`. Tudo em uma única transação (processo, se aplicável, + itens + novo documento/DFD).

## Frontend
- **Tela(s):** SCR-113 (diálogo, reaproveitado de US-011) com a opção "Duplicar apenas o DFD"; SCR-007 (destino após criação).
- **Componentes:** `DuplicateTargetPicker` (novo processo \| processo existente), `ProcessSearchSelect` (filtra pelas pré-condições).
- **Estados:** carregando a busca de processos elegíveis; vazio ("Nenhum processo elegível encontrado"); erro; botão com estado de carregamento.
- **Acessibilidade e responsividade:** mesmo padrão de SCR-005/US-001 (foco, `aria-live`, layout em coluna única < 768 px).

## Banco de dados
- **Tabelas:** `documents`, `dfds`, `document_items`, `process_items`, `processes` (via US-011). Sem migrações novas.
- **Índices/constraints relevantes:** reaproveita `UNIQUE (tenant_id, process_id, singleton_key) WHERE …` e `UNIQUE (tenant_id, process_id, sequence)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DFD-05 | POST | `/dfds/{id}/duplicate` | `{ targetType, targetProcessId? }` + `Idempotency-Key` | `201 { data: Dfd }` | 201, 403, 409, 422, 503 |
| DFD-03 | GET | `/dfds/{id}` | — | Estado do novo DFD | 200, 403, 404 |

`PRC-14` é usado internamente (por item clonado), sem chamada direta do front.

## Logs
- `info` `dfd.duplicated` — `sourceDocumentId`, `newDocumentId`, `targetType`, `itemsCloned`, `durationMs`.
- `error` `dfd.duplicate_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo das seções, valor estimado, justificativas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.duplicate` | `DATA_CHANGE` | Commit da duplicação | `metadata.sourceDocumentId`, `targetProcessId`, `targetType` |

## Testes necessários
- **Unitários:** cópia de cabeçalho/seções/itens; remapeamento de `sequence`.
- **Integração/contrato (Testcontainers):** transação única (processo + itens + DFD); unicidade do DFD ativo no destino; DFD-05 conforme api.md e cabeçalhos de idempotência.
- **Concorrência:** duas duplicações simultâneas para o mesmo processo existente.
- **E2E (Playwright):** duplicar para novo processo e para processo existente, ponta a ponta.

## Definition of Done
- [ ] Cenários Gherkin automatizados e passando no CI
- [ ] `DFD_CREATE`/`PROCESS_CREATE` aplicados na API; UI oculta sem permissão
- [ ] Unicidade do DFD ativo no destino garantida por teste (índice + concorrência)
- [ ] Auditoria `document.duplicate` e eventos verificados em teste; teste de isolamento na suíte "tenant leak"
- [ ] OpenAPI de DFD-05 compatível com api.md
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**S** — reaproveita DFD-02, US-011 e `sourceDocumentId` existentes; o único ponto novo é o remapeamento de itens para processo existente.

## Prioridade
**P2** — conveniência de reaproveitamento, não bloqueia a jornada principal da fase preparatória.
