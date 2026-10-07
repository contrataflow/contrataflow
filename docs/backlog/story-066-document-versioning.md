---
id: US-066
title: "Versionamento imutável e comparação de versões"
epic: EP-011
feature: FT-040
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-065]
modules: [document]
screens: [SCR-106]
endpoints: [DOC-15, DOC-16, DOC-17, DOC-18]
permissions: [DOCUMENT_UPDATE]
events: [DocumentVersionCreated]
---

# US-066 — Versionamento imutável e comparação de versões

## Título
Versionamento imutável e comparação de versões

## Descrição
**Como** redator ou aprovador de um documento do processo, **quero** salvar versões imutáveis do seu conteúdo e comparar duas versões quaisquer, **para** ter um histórico confiável de "quem mudou o quê" e poder auditar/justificar alterações entre a elaboração e a aprovação.

Toda transição de status que a DEC-018 associa à criação de versão (US-065) usa o mecanismo descrito aqui. Além disso, o usuário pode salvar uma versão manualmente em qualquer momento em que o documento esteja editável ("Salvar versão"), sem mudar o status. Toda versão é um retrato permanente (cabeçalho + seções + coleções) com hash SHA-256 sobre o JSON canonicalizado por RFC 8785; nada nela é editável ou excluível depois de gravado. A SCR-106 lista as versões e permite comparar quaisquer duas, destacando o que mudou em campos de cabeçalho, seções narrativas e linhas de coleção.

## Contexto
- Base legal: a Lei 14.133/2021 exige integridade e rastreabilidade dos documentos do processo; provar exatamente o que um DFD/ETP/TR dizia no momento da aprovação, frente ao rascunho atual, é necessário em auditorias (TCU/TCE) e em revisões internas após uma devolução.
- DEC-017 estabelece o modelo híbrido (cabeçalho tipado + seções narrativas do template + coleções) e DEC-084 padroniza snapshots com hash RFC 8785/SHA-256 em todo o produto (versões de documento, workflow publicado, template publicado) — esta story implementa a parte de `DocumentVersion`.
- US-065 já decide **quando** uma versão é criada (submissão, finalização, importação, upload, reabertura não cria) e qual `reason` ela recebe; esta story cobre o **mecanismo** de criação/leitura/comparação e o salvamento manual (`reason = MANUAL`), que US-065 não cobre.
- O ADR-006 (modelo documental) justifica por que a versão é um retrato completo e não um diff incremental: snapshots completos simplificam a renderização de PDF (US-067) e a comparação, ao custo de armazenamento (aceitável — o JSON de um documento administrativo é pequeno).

## Objetivo
Garantir que 100% das versões de documento sejam imutáveis, com hash verificável, e que qualquer par de versões do mesmo documento possa ser comparado em até 3 segundos (p95), apontando com precisão os campos, seções e itens que mudaram.

## Persona
- **Principal:** Redator/custodiante do documento (perfis com `DOCUMENT_UPDATE` ou a permissão de edição do tipo tipado) — salva versões manuais.
- **Secundárias:** Aprovador, gestor de contratações, auditor interno/externo — consultam o histórico e comparam versões (somente leitura, `PROCESS_VIEW`).

## Pré-condições
- Documento existente, visível ao usuário (DEC-024) e, para salvar versão, em `DRAFT`/`RETURNED` (POL-02).
- Ao menos uma versão existe para comparar (a primeira nasce na primeira submissão/finalização — US-065; documentos sem nenhuma versão exibem a aba "Versões" vazia).

## Fluxo principal
1. Na tela do documento (SCR-105), com o documento em `DRAFT`/`RETURNED`, o usuário aciona **"Salvar versão"** no menu de ações.
2. O front abre um diálogo pedindo um resumo opcional da alteração (`changeSummary`, até 500 caracteres) e confirma.
3. O front envia `POST /api/v1/documents/{id}/versions` (`DOC-16`) com `Idempotency-Key`.
4. A API, em uma transação: valida que o documento está editável (POL-02); monta o `DocumentSnapshot` atual (cabeçalho + seções + coleções, entities.md §5.3.2); canonicaliza (RFC 8785) e calcula `contentHash` (SHA-256); insere `DocumentVersion` com `versionNumber` = próximo da sequência do documento, `reason = MANUAL`, `statusAtCreation` = status atual; atualiza `Document.currentVersionId`; grava auditoria `document.version_create` e o evento `DocumentVersionCreated`; confirma.
5. A API responde **201** com a versão criada (`versionNumber`, `contentHash`, `createdAt`).
6. O usuário acessa **SCR-106** (`/processos/{id}/documentos/{docId}/versoes`), que lista `GET /documents/{id}/versions` (`DOC-15`) em ordem decrescente por `versionNumber`, com `reason`, autor, data e os primeiros caracteres do hash.
7. O usuário seleciona duas versões e aciona **"Comparar"**; o front chama `GET /documents/{id}/versions/compare?from=&to=` (`DOC-18`).
8. A API carrega os dois snapshots (equivalente a `GET /document-versions/{id}` — `DOC-17` — para cada lado), aplica o mascaramento de sigilo (POL-09) e devolve as diferenças agrupadas por cabeçalho, seções e coleções, cada campo/linha marcado `ADDED`/`REMOVED`/`CHANGED`/`UNCHANGED`.
9. O front renderiza a comparação lado a lado (cabeçalho em tabela de campos; seções com indicador de alteração e link para abrir o texto completo de cada lado; coleções como tabela com linhas destacadas).

## Fluxos alternativos
- **FA-01 — Comparar com a versão anterior direto da lista:** cada linha da lista (exceto a primeira) tem o atalho "Comparar com a anterior", que preenche `from`/`to` automaticamente.
- **FA-02 — Documento `UPLOADED`:** o botão "Salvar versão" não aparece (a versão desse tipo nasce do upload de um novo arquivo — `DOC-19`, US-064); a lista e a comparação funcionam igual, mas a comparação mostra apenas metadados do arquivo (nome, tamanho, `sha256`) por versão, sem diff de conteúdo (`content` é nulo nesse `kind`).
- **FA-03 — Uma das versões tem campo sigiloso mascarado:** quando o usuário não atende POL-09, os campos monetários aparecem como `"—"` com a marca "Valor sigiloso" nas duas colunas, e o indicador de mudança daquele campo vira `MASKED` (nunca `CHANGED`/`UNCHANGED`, para não vazar que houve alteração por inferência).
- **FA-04 — `changeSummary` vazio:** permitido; a listagem mostra "Sem resumo informado".

## Regras de negócio
- **RN-DOC-56** — **Salvar versão manual** (`DOC-16`) só é aceito com o documento em `DRAFT`/`RETURNED` (POL-02) e `DocumentType.kind ∈ {STRUCTURED, FREE_TEXT}`; para `UPLOADED` a API responde 422 `VALIDATION_ERROR` (`errors[].code = NOT_ALLOWED` no campo `kind`) — a versão desse tipo é criada por `DOC-19` (US-064).
- **RN-DOC-57** — `contentHash` é o SHA-256 do `DocumentSnapshot` (entities.md §5.3.2) canonicalizado por RFC 8785/JCS (DEC-084, ADR-006); para `UPLOADED`, `content` é nulo e `contentHash` é o `sha256` do `Attachment` da versão (calculado no scan — US-068), nunca recalculado aqui.
- **RN-DOC-58** — `DocumentVersion` é imutável: sem `updatedAt`/`updatedById`/`version`; trigger de banco bloqueia `UPDATE`/`DELETE`; `versionNumber` é sequencial 1..n sem lacunas por `(tenant_id, document_id)`, garantido por índice único e por inserção na mesma transação que lê o máximo atual com lock de linha do `Document`.
- **RN-DOC-59** — **Listagem** (`DOC-15`): ordenada por `versionNumber` desc; cada item traz `reason`, `statusAtCreation`, autor, data, `changeSummary`, prefixo do `contentHash` e, para `UPLOADED`, o anexo associado.
- **RN-DOC-60** — **Comparação** (`DOC-18`): `from` e `to` devem ser versões do mesmo `documentId` (senão `VALIDATION_ERROR` no campo `to`); o resultado traz três blocos — `header` (por campo), `sections` (por `sectionKey`, com `state` e indicador de mudança sobre o texto extraído do TipTap) e `collections` (por chave natural: `processItemId` em itens, chave equivalente nas demais) — cada entrada marcada `ADDED`, `REMOVED`, `CHANGED` ou `UNCHANGED`.
- **RN-DOC-61** — **Sigilo** (POL-09): campos monetários dos snapshots comparados são mascarados (`null` + `masked: true`) para quem não atende a política, nas duas versões e também no indicador de mudança (que vira `MASKED`).
- **RN-DOC-62** — `changeSummary` é opcional, até 500 caracteres, armazenado como texto simples (sem sanitização de rich text).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Resumo da alteração | `changeSummary` | texto curto | Não | até 500 caracteres | — |
| Versão de origem | `from` (query) | referência a `DocumentVersion` | Sim (na comparação) | mesma `documentId` | — |
| Versão de destino | `to` (query) | referência a `DocumentVersion` | Sim (na comparação) | mesma `documentId`; ≠ `from` | — |
| *(sistema)* Número da versão | `versionNumber` | int | — | RN-DOC-58 | gerado |
| *(sistema)* Hash do conteúdo | `contentHash` | varchar(64) | — | RN-DOC-57 | gerado |
| *(sistema)* Motivo | `reason` | `VersionReason` | — | US-065 define o valor nas transições; `MANUAL` aqui | gerado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Documento não editável (status fora de `DRAFT`/`RETURNED`) | API | "Esta versão só pode ser salva enquanto o documento está em edição." | `DOCUMENT_NOT_EDITABLE` |
| V-02 | Tipo `UPLOADED` tentando salvar versão manual | API | "Para este tipo de documento, envie um novo arquivo para criar uma versão." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-03 | `changeSummary` acima de 500 caracteres | Front + API | "O resumo deve ter no máximo 500 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-04 | `from`/`to` de outro documento ou inexistentes | API | "Selecione duas versões deste mesmo documento." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | `from` igual a `to` | Front + API | "Escolha duas versões diferentes para comparar." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** salvar versão exige a permissão de edição do tipo (`DOCUMENT_UPDATE` para `FREE_TEXT`; permissão do módulo tipado para `STRUCTURED`, fora deste épico) + POL-02; listar/ver/comparar exige apenas `PROCESS_VIEW` (+ POL-09 para campos sigilosos).
- **Políticas:** POL-02 (edição — ver story-065); POL-09 (mascaramento na comparação — RN-DOC-61).
- **MFA:** não exigido (ações de risco médio).
- **Sem permissão:** botão "Salvar versão" oculto fora de POL-02; API responde 403 `PERMISSION_DENIED`/409 `DOCUMENT_NOT_EDITABLE` conforme o caso; leitura de versão/comparação sem `PROCESS_VIEW` → 404 (DEC-024).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentVersionCreated` | `document.version_created.<type>` | Commit de `DOC-16` | `documentId`, `documentVersionId`, `versionNumber`, `reason = MANUAL`, `contentHash` (events.md) |

Não há evento para leitura/comparação (operações `GET`).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: salvar versão manual não notifica ninguém (ação do próprio custodiante). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Versionamento imutável e comparação de versões

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura A"
    And possui vínculo ativo
    And existe o documento "ETP 0003/2026" do tipo "ETP" em status "DRAFT" sob sua custódia

  Scenario: [Sucesso] Salvar uma versão manual
    Given que o documento está em "DRAFT"
    When o usuário informar o resumo "Ajuste na justificativa" e confirmar "Salvar versão"
    Then a API deve criar uma "DocumentVersion" com "versionNumber" 1 e "reason" "MANUAL"
    And o "contentHash" deve ser o SHA-256 do snapshot canonicalizado
    And deve gerar o evento "DocumentVersionCreated"
    And deve gerar registro de auditoria "document.version_create"
    And a API deve responder 201

  Scenario: [Validação] Resumo da alteração acima do limite
    When o usuário informar um resumo com 600 caracteres
    Then o sistema deve exibir "O resumo deve ter no máximo 500 caracteres."
    And a API, se chamada diretamente, deve responder 422 com código "VALIDATION_ERROR"

  Scenario: [Permissão] Usuário sem permissão de edição do tipo
    Given que o usuário "Carlos" não tem a permissão de edição do tipo "ETP"
    When "Carlos" enviar "POST /api/v1/documents/{id}/versions"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And nenhuma versão deve ser criada

  Scenario: [Tenant incorreto] Comparar versões de documento de outro tenant
    Given que a versão "V2" pertence a um documento do tenant "Prefeitura B"
    When um usuário da "Prefeitura A" chamar "GET /documents/{id}/versions/compare" referenciando "V2"
    Then a API deve responder 404
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que o usuário salvou uma versão com a chave "K1" e recebeu 201 para a versão 2
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com a mesma versão 2 e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas uma nova versão criada

  Scenario: [Concorrência] Dois "Salvar versão" simultâneos
    Given que o documento está na versão 3
    When dois pedidos de "Salvar versão" chegarem ao mesmo tempo sem chaves de idempotência iguais
    Then exatamente um deve criar a versão 4 e o outro a versão 5
    And nenhum "versionNumber" deve se repetir ou ficar faltando

  Scenario: [Falha de banco] Banco indisponível ao salvar versão
    Given que o banco de dados fica indisponível durante a transação
    When o usuário confirmar "Salvar versão"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma "DocumentVersion" deve ser persistida

  Scenario: [Falha de integração] Relay do outbox indisponível ao salvar versão
    Given que o relay do outbox está indisponível
    When o usuário salvar uma versão válida
    Then a versão deve ser criada e a API deve responder 201
    And o evento "DocumentVersionCreated" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Esta versão só pode ser salva enquanto o documento está em edição." | Oculta/desabilita "Salvar versão" |
| Tipo `UPLOADED` | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Para este tipo de documento, envie um novo arquivo para criar uma versão." | Mostra "Enviar novo arquivo" |
| Resumo muito longo | 422 | `VALIDATION_ERROR` | "O resumo deve ter no máximo 500 caracteres." | Marca o campo |
| Versões de documentos diferentes | 422 | `VALIDATION_ERROR` | "Selecione duas versões deste mesmo documento." | Limpa a seleção |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para salvar uma versão deste documento." | Mantém o rascunho |
| Não encontrado/outro tenant | 404 | `NOT_FOUND` | "Documento ou versão não encontrados." | Redireciona à lista |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar a versão agora. Tente novamente em instantes." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-065 (ciclo de vida — define quando as transições criam versão e o `reason`); consumida por US-063/US-064 (documentos livres/externos exibem a aba de versões) e US-067 (renderiza PDF a partir da `DocumentVersion`).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-024, DEC-030, DEC-084, DEC-105; ADR-006.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** o formato de resposta de `GET /documents/{id}/versions/compare` (`DOC-18`) não está definido em `api.md`/`entities.md`; foi adotado o conceito mais próximo já existente (`DocumentSnapshot`, entities.md §5.3.2), devolvendo diffs por `header`/`sections`/`collections` com marcadores `ADDED`/`REMOVED`/`CHANGED`/`UNCHANGED`/`MASKED`. Proposta: registrar esse contrato em `api.md` §3 quando a story entrar em desenvolvimento.

## Impacto técnico
- Reaproveita o padrão de comando transacional (US-001/US-065); a criação de versão nunca deve ser feita fora do `DocumentLifecycleService`/caso de uso dedicado, para não duplicar a lógica de canonicalização de hash.
- A comparação é calculada sob demanda a cada chamada (sem cache nesta story); se a telemetria mostrar latência acima do SLO (p95 < 3 s), considerar cache por par `(from,to)` — fora de escopo no MVP 1.
- `DOC-16` não exige `If-Match` no catálogo (apenas `Idempotency-Key`): a proteção de concorrência vem do lock de linha do `Document` dentro da transação e da constraint única de `versionNumber`, não do `ETag` do cliente.
- Canonicalização RFC 8785 deve usar a mesma biblioteca já adotada para workflow/template publicados (DEC-084), para não haver duas implementações divergentes de JCS no monorepo.

## Backend
- **Módulo(s):** `document` (dono).
- **Casos de uso:** `SaveDocumentVersionCommand` → `SaveDocumentVersionHandler`; `ListDocumentVersionsQuery`; `GetDocumentVersionQuery`; `CompareDocumentVersionsQuery` → `CompareDocumentVersionsHandler`.
- **Domínio:** `DocumentVersion.createSnapshot(document)` (fábrica que monta o `DocumentSnapshot`, canonicaliza e assina o hash); `DocumentVersionComparator.diff(from, to)` (produz os três blocos de diferenças).
- **Integrações internas:** `access.assertCan` (POL-02/POL-09); `audit.record`; `platform.OutboxWriter`.
- **Transação:** passo 4 do fluxo principal, interativa, isolamento `READ COMMITTED`.

## Frontend
- **Tela(s):** SCR-106 (`/processos/[id]/documentos/[docId]/versoes`); diálogo "Salvar versão" sobre SCR-105.
- **Componentes:** `SaveVersionDialog`, `VersionList` (com atalho "Comparar com a anterior"), `VersionComparePicker`, `VersionDiffView` (três blocos: cabeçalho, seções, coleções, cada linha com indicador de status).
- **Estados:** carregando lista/comparação (skeleton); lista vazia ("Nenhuma versão salva ainda"); erro ao comparar (recarregar); sucesso ao salvar (toast "Versão {n} salva").
- **Acessibilidade e responsividade:** indicadores de alteração com texto além de cor (`aria-label="Alterado"`); em telas estreitas a comparação empilha os dois lados em vez de lado a lado.

## Banco de dados
- **Tabelas:** `document_versions` (leitura/escrita), `documents` (atualiza `current_version_id`).
- **Migrações:** nenhuma nova (reaproveita entities.md §4 — `document_versions` já definida por US-065/ADR-006).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id, version_number)`; índice `(tenant_id, content_hash)`; trigger de imutabilidade bloqueando `UPDATE`/`DELETE`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-16 | POST | `/api/v1/documents/{id}/versions` | `{ changeSummary? }` + `Idempotency-Key` | `201 { data: DocumentVersion }` | 201, 403, 404, 409, 422, 429, 503 |
| DOC-15 | GET | `/api/v1/documents/{id}/versions` | `?page&pageSize` | `200 { data: DocumentVersion[], meta }` | 200, 403, 404 |
| DOC-17 | GET | `/api/v1/document-versions/{versionId}` | — | `200 { data: DocumentVersion }` (com `content` conforme POL-09) | 200, 403, 404 |
| DOC-18 | GET | `/api/v1/documents/{id}/versions/compare` | `?from=&to=` | `200 { data: { from, to, header[], sections[], collections[] } }` | 200, 403, 404, 422 |

## Logs
- `info` `document.version_saved` — `documentId`, `documentVersionId`, `versionNumber`, `reason`, `durationMs`.
- `info` `document.versions_compared` — `documentId`, `fromVersion`, `toVersion`, `durationMs`.
- `error` `document.version_save_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo de seções, valores monetários, `changeSummary`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.version_create` | `DATA_CHANGE` | Commit de `DOC-16` | `metadata`: `versionNumber`, `reason = MANUAL`, `contentHash` |

Leitura e comparação não geram auditoria (não são exportação nem mudança de dado).

## Testes necessários
- **Unitários:** canonicalização RFC 8785 e hash (vetores de teste com chaves fora de ordem produzindo o mesmo hash); `DocumentVersionComparator` (campos iguais/diferentes/ausentes; seção `NOT_APPLICABLE`→`FILLED`; item removido/adicionado).
- **Integração (Testcontainers):** trigger de imutabilidade rejeita `UPDATE`/`DELETE` em `document_versions`; `versionNumber` sequencial sob concorrência.
- **API/contrato:** respostas conforme a tabela de API acima; mascaramento POL-09 na comparação.
- **RBAC e multi-tenant:** `DOC-16` sem permissão de edição do tipo → 403; `DOC-17`/`DOC-18` de outro tenant → 404.
- **Concorrência:** duas chamadas simultâneas a `DOC-16` sem idempotência → duas versões consecutivas sem lacunas/repetição.
- **E2E (Playwright):** salvar versão → listar → comparar com a anterior → ver diffs.
- **Acessibilidade/performance:** axe na tela de comparação; comparação de snapshots grandes (pesquisa de preço com 200 itens) abaixo de 3 s (p95).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — o mecanismo de hash/imutabilidade já é definido por DEC-084/ADR-006 (reaproveitado), e a criação de versão herda a transação de US-065; o esforço concentra-se no comparador de snapshots e na tela de diff.

## Prioridade
**P0** — sem versão imutável não há histórico confiável nem base para gerar PDF (US-067) ou para auditoria externa, ambos requisitos da Lei 14.133/2021.
