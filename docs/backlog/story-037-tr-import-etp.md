---
id: US-037
title: "Importar dados do ETP para o TR"
epic: EP-006
feature: FT-025
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-020, US-036]
modules: [term, document, etp, catalog, access, timeline, audit, platform]
screens: [SCR-012]
endpoints: [TRM-05, TRM-06, TRM-03, ETP-03]
permissions: [TERM_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [TermImportedFromEtp, DocumentVersionCreated]
---

# US-037 — Importar dados do ETP para o TR

## Título
Importar dados do ETP para o TR

## Descrição
**Como** analista de planejamento responsável pelo TR, **quero** importar para o TR os dados já elaborados no ETP do processo, **para** reaproveitar objeto, justificativa, especificações, valor estimado e quantidades sem redigitar e sem divergir do estudo técnico preliminar.

A importação acontece em dois passos: uma prévia somente leitura (`TRM-05`) que mostra, seção a seção e campo a campo, o que seria alterado a partir do ETP vigente do processo — conforme o mapeamento semeado no template (`importMappings`, §5.8: `OBJECT ← RECOMMENDED_SOLUTION`, `JUSTIFICATION ← NEED_DESCRIPTION + PROBLEM + OBJECTIVE`, `SPECIFICATIONS ← REQUIREMENTS`, `ESTIMATED_VALUE ← ESTIMATES`, além dos campos `estimatedTotalValue`/`priceResearchId` e das quantidades dos itens) — e a aplicação (`TRM-06`), seletiva, rastreável e idempotente, que grava as mudanças escolhidas em uma nova versão do documento. O TR permanece livremente editável depois; se o ETP mudar após a importação, o editor exibe um aviso para reimportar.

## Contexto
- O TR decorre do ETP (Lei 14.133/2021, art. 6º, XXIII, c/c art. 18): objeto, justificativa, especificações e valor estimado devem ser coerentes entre os dois documentos. Sem importação, o redator copia manualmente trechos do ETP, gerando divergências que só aparecem na licitação.
- DEC-019 define `DocumentItem` como a linha de item em cada documento (DFD/ETP/TR) a partir do mesmo `ProcessItem`, permitindo copiar quantidades do ETP para o TR sem duplicar o conceito de item; a validação cruzada de divergências remanescentes é tratada em US-039.
- Modelo documental híbrido (DEC-017): seções narrativas em `draftContent` (TipTap), cabeçalho tipado em `TermOfReference`/`Etp`, coleções em `DocumentItem` — a importação escreve nos três.
- Depende do editor de seções e ciclo de vida do TR (US-036) e das seções do ETP (US-020, US-019).

## Objetivo
Reduzir a redigitação na elaboração do TR: todo TR de processo com ETP consegue importar objeto, justificativa, especificações, valor estimado e quantidades em uma ação revisável, mantendo rastreabilidade (`importedFromEtpId`/`importedFromEtpVersionId`) e sem perda de dado não confirmada.

## Persona
- **Principal:** Planejamento (perfil `PLANEJAMENTO`), redator do TR.
- **Secundárias:** Compras (`COMPRAS`), Gestor de contratações (`GESTOR_CONTRATACOES`), Área requisitante (`REQUISITANTE`) quando custodia o TR; Consultoria externa (`CONSULTOR_EXTERNO`) como participante `COLLABORATOR`/`CONSULTANT`.

## Pré-condições
- TR criado (US-036), em `DRAFT`/`RETURNED`, sob custódia ou participação do usuário (POL-02).
- Processo possui um documento ETP não cancelado (RN-TR-16).
- Usuário com `TERM_UPDATE` cobrindo o processo.
- Template do TR com `importMappings` configurado na versão fixada do documento (padrão semeado — US-110).

## Fluxo principal
1. No editor do TR (SCR-012), o usuário aciona **"Importar do ETP"**.
2. O front chama `TRM-05`; o sistema localiza o ETP do processo, aplica o `importMappings` da versão do template e devolve a prévia: por seção (conteúdo resultante e modo `REPLACE`/`APPEND`), por campo (valor de origem) e por item (quantidade do ETP), além de `importToken` (validade 15 min).
3. O painel mostra o "antes/depois" por seção, a lista de campos e a tabela de itens, todos pré-marcados para importar.
4. O usuário desmarca o que não deseja importar e, se o TR já tiver `estimatedValueSource = PRICE_RESEARCH`, confirma a substituição da origem do valor.
5. O usuário clica em **"Aplicar importação"**; o front envia `POST` para `TRM-06` com o `importToken`, a seleção e `If-Match` da versão atual do TR.
6. A API, em uma transação, revalida o token (ETP e TR inalterados desde a prévia), aplica as seções (REPLACE/APPEND) e campos selecionados, faz upsert dos itens selecionados, grava `DocumentVersion` (`reason = IMPORT`), audita `term.import_etp` e publica `TermImportedFromEtp` no outbox.
7. A API responde 200 com o TR atualizado e o resumo (`sectionsImported[]`, `itemsImported`).
8. O front atualiza o editor, mostra o toast "Importação aplicada: 4 seções e 8 itens atualizados" e projeta a entrada `TERM_IMPORTED_FROM_ETP` na timeline.
9. Se, depois disso, o ETP for finalizada uma nova versão, o editor passa a exibir o aviso "O ETP foi atualizado desde a última importação" com atalho para repetir o processo.

## Fluxos alternativos
- **FA-01 — Nenhuma seleção:** o usuário desmarca tudo; "Aplicar importação" fica desabilitado ("Selecione ao menos uma seção, campo ou os itens").
- **FA-02 — ETP ainda em elaboração:** o ETP está em `DRAFT`/`IN_REVIEW` (não cancelado); a prévia é exibida normalmente com o aviso "O ETP ainda não foi concluído; os dados podem mudar".
- **FA-03 — Prévia expirada ou origem alterada:** ao aplicar, o token passou de 15 min ou o ETP/TR mudou desde a prévia; `410 IMPORT_PREVIEW_EXPIRED`; o painel recarrega a prévia automaticamente.
- **FA-04 — Itens já especificados no TR:** itens com `specification`/`acceptanceCriteria` já preenchidos não são sobrescritos salvo `overwriteExisting: true`, confirmado item a item ou em lote.
- **FA-05 — Orçamento sigiloso sem permissão:** sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia, o campo `estimatedTotalValue` não aparece na prévia (mascarado) e não é importado mesmo que selecionado.
- **FA-06 — Reimportação parcial:** o usuário repete a importação depois de editar manualmente algumas seções; apenas as seções marcadas desta vez são tocadas, preservando as demais.

## Regras de negócio
- **RN-TR-16** — A origem é o documento ETP não cancelado do processo (um por processo — DEC-019/DEC-017); sem ETP → 422 `ETP_REQUIRED_FOR_IMPORT`.
- **RN-TR-17** — O mapeamento vem de `DocumentTemplateVersion.importMappings` (§5.8) da versão do template fixada no TR: `sections[].mode = REPLACE` substitui o conteúdo da seção destino, `APPEND` acrescenta ao final com referência à origem ("Importado do ETP v{n} em {data}"); `fields[]` mapeia campos do cabeçalho; `items.copyQuantities`/`copyCalculationMemoToNotes` regem a cópia de itens.
- **RN-TR-18** — A prévia (`TRM-05`) é somente leitura e não grava nada; emite `importToken` assinado (contém `etpVersionId`, versão atual do TR e a seleção padrão), válido por 15 min.
- **RN-TR-19** — Na aplicação (`TRM-06`), qualquer mudança no ETP (nova versão) ou no TR (nova revisão de seção ou versão) desde a prévia invalida o `importToken` com o mesmo efeito do vencimento: 410 `IMPORT_PREVIEW_EXPIRED`, exigindo nova prévia.
- **RN-TR-20** — A aplicação é seletiva por `importToken`: só as seções, campos e itens marcados pelo usuário são alterados; os demais permanecem como estavam.
- **RN-TR-21** — Itens: por `processItemId` comum ao ETP e ao TR, cria ou atualiza o `DocumentItem` do TR com a quantidade do ETP (se `copyQuantities`); item do TR com `specification`/`acceptanceCriteria` já preenchidos só é sobrescrito com `overwriteExisting: true` explícito.
- **RN-TR-22** — Importar `estimatedTotalValue` define `estimatedValueSource = ETP` e grava `importedFromEtpId`/`importedFromEtpVersionId`; se o TR já tinha `estimatedValueSource = PRICE_RESEARCH` (RN-TR-07), a substituição exige `confirmReplaceValueSource: true` — sem ele, 422 `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) no campo.
- **RN-TR-23** — Sigilo do orçamento (POL-09/DEC-030): sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem custódia, a prévia não mostra nem importa o valor estimado (mascarado).
- **RN-TR-24** — Pré-requisito e efeitos: exige `TERM_UPDATE` + POL-02 (TR em `DRAFT`/`RETURNED`, tipo permitido na etapa, processo editável); a aplicação cria `DocumentVersion` (`reason = IMPORT`), gera `TermImportedFromEtp` (`sectionsImported[]`, `itemsImported`) e auditoria `term.import_etp`; não há notificação, apenas a entrada `TERM_IMPORTED_FROM_ETP` na timeline. `TRM-03` passa a devolver `etpChangedSinceImport = true` quando a versão atual do ETP é posterior a `importedFromEtpVersionId` (apenas informativo).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Seções a importar | `sections[].selected` | lista de checkboxes | Não (mín. 1 entre seções/campos/itens) | chave deve existir no mapeamento do template | todas marcadas na prévia |
| Campos a importar | `fields[].selected` | lista de checkboxes | Não | idem | todos marcados |
| Copiar itens | `copyItems` | interruptor | Não | — | `true` |
| Sobrescrever itens já especificados | `overwriteExisting` | interruptor | Não | só tem efeito se `copyItems` | `false` |
| Confirmo substituir a origem do valor | `confirmReplaceValueSource` | booleano (técnico) | Condicional (RN-TR-22) | só enviado após aviso | `false` |
| *(sistema)* Token da prévia | `importToken` | string opaca assinada | Sim (na aplicação) | emitido por `TRM-05`; 15 min | gerado |
| *(sistema)* Defasagem do ETP | `etpChangedSinceImport` | booleano (calculado) | — | comparação de versão (RN-TR-24) | calculado em `TRM-03` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Nenhuma seleção enviada | Front + API (Zod) | "Selecione ao menos uma seção, campo ou os itens." | `VALIDATION_ERROR` |
| V-02 | Processo sem ETP não cancelado | API | "Este processo não tem um ETP para importar." | `ETP_REQUIRED_FOR_IMPORT` |
| V-03 | `importToken` ausente, inválido ou de outro TR | API | "Gere a prévia novamente." | `VALIDATION_ERROR` |
| V-04 | Token expirado ou ETP/TR mudaram desde a prévia | API | "O ETP ou o TR foram alterados. Atualizando a prévia…" | `IMPORT_PREVIEW_EXPIRED` |
| V-05 | Substituir origem do valor sem confirmação | Front + API | "Confirme a substituição do valor vinculado à pesquisa de preços." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-06 | TR não está em `DRAFT`/`RETURNED` | API | "O TR não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-07 | Tipo TR não permitido na etapa atual | API | "O TR não pode ser editado nesta etapa do processo." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-08 | `If-Match` ausente no `TRM-06` | API | "Atualize a página e tente novamente." | `PRECONDITION_REQUIRED` |
| V-09 | `If-Match` divergente (TR mudou) | API | "O TR foi alterado por outra pessoa. Recarregue para continuar." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `TERM_UPDATE` com escopo que cubra o processo (permissions.md §2.3).
- **Políticas:** POL-02 (custódia **ou** participação `COLLABORATOR`/`CONSULTANT` + TR `DRAFT`/`RETURNED` + tipo permitido na etapa + processo editável); POL-09 (valor estimado mascarado sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia).
- **MFA:** não exigido (`TERM_UPDATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Importar do ETP" não é exibido; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TermImportedFromEtp` | `term.imported_from_etp` | Commit da aplicação (`TRM-06`) | `termId`, `etpId`, `etpVersionId`, `sectionsImported[]`, `itemsImported`; projeta `TERM_IMPORTED_FROM_ETP` na timeline |
| `DocumentVersionCreated` | `document.version_created.tr` | Mesmo commit | `reason = IMPORT` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: apenas a entrada `TERM_IMPORTED_FROM_ETP` na timeline (RN-TR-24). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Importar dados do ETP para o TR

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" tem um ETP finalizado com 8 itens e valor estimado "125000.00"
    And o processo tem um TR em "DRAFT" criado a partir do template padrão
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO" e custódia do TR

  Scenario: [Sucesso] Pré-visualizar e aplicar a importação completa
    When "Carla" solicitar a prévia de importação do ETP
    Then o sistema deve apresentar o conteúdo proposto para "OBJECT", "JUSTIFICATION", "SPECIFICATIONS" e "ESTIMATED_VALUE", os campos "estimatedTotalValue" e "priceResearchId" e 8 itens com as quantidades do ETP
    When "Carla" confirmar a importação de todas as seções, campos e itens com o token da prévia
    Then o TR deve ter "estimatedTotalValue" igual a "125000.00" e "estimatedValueSource" igual a "ETP"
    And deve existir uma nova versão do documento com "reason" igual a "IMPORT"
    And deve gerar o evento "TermImportedFromEtp" com "itemsImported" igual a 8
    And deve gerar registro de auditoria "term.import_etp"

  Scenario: [Validação] Processo sem ETP
    Given que o processo não possui ETP
    When "Carla" solicitar a prévia de importação
    Then a API deve responder 422 com código "ETP_REQUIRED_FOR_IMPORT"

  Scenario: [Validação] Substituir a origem do valor sem confirmação
    Given que o TR já tem "estimatedValueSource" igual a "PRICE_RESEARCH"
    When "Carla" aplicar a importação do campo "estimatedTotalValue" sem marcar "confirmReplaceValueSource"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "confirmReplaceValueSource"
    And o valor estimado do TR não deve ser alterado

  Scenario: [Permissão] Usuário sem TERM_UPDATE
    Given que "Bruno" não possui "TERM_UPDATE" para o processo
    When "Bruno" enviar POST para a aplicação da importação
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] TR de outro tenant
    Given que existe um TR no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", solicitar a prévia desse TR
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio da aplicação com a mesma chave de idempotência
    Given que "Carla" aplicou a importação com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And nenhum item deve ser duplicado no TR

  Scenario: [Concorrência] ETP muda entre a prévia e a aplicação
    Given que "Carla" gerou uma prévia de importação
    When outro usuário finalizar uma nova versão do ETP antes de "Carla" aplicar
    Then a aplicação deve responder 410 com código "IMPORT_PREVIEW_EXPIRED"

  Scenario: [Concorrência] Edição concorrente do TR invalida o If-Match
    Given que "Carla" gerou a prévia com a versão 3 do TR
    When outro usuário editar uma seção do TR, criando a versão 4
    And "Carla" aplicar a importação informando "If-Match: \"3\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco de dados fica indisponível durante a transação de aplicação
    When "Carla" confirmar a importação
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma seção, campo ou item do TR deve ser alterado

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" aplicar a importação com sucesso
    Then o TR deve ser atualizado e a API deve responder 200
    And o evento "TermImportedFromEtp" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem ETP no processo | 422 | `ETP_REQUIRED_FOR_IMPORT` | "Este processo não tem um ETP para importar." | Oculta a ação; exibe link para criar o ETP |
| Token expirado/origem alterada | 410 | `IMPORT_PREVIEW_EXPIRED` | "O ETP ou o TR foram alterados. Atualizando a prévia…" | Recarrega a prévia automaticamente |
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise a seleção." | Marca o campo correspondente |
| TR não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "O TR não pode ser editado no status atual." | Oculta a ação |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O TR não pode ser editado nesta etapa." | Oculta a ação |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar este TR." | Botão oculto; API bloqueia |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente novamente." | Recarrega o documento |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "O TR foi alterado por outra pessoa. Recarregue para continuar." | Oferece "Ver versão atual" |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Requisição em processamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Estamos concluindo a importação. Aguarde." | Repete consulta após 2 s |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível importar agora. Tente novamente em instantes." | Mantém seleção; botão "Tentar novamente" |

## Dependências
- **Stories:** US-020 (seções do ETP, fonte dos dados), US-036 (cria o TR e o editor de seções), US-110 (mapeamento padrão semeado do template). Indiretas: US-019, US-006 (itens do processo). Habilita: US-039.
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-019, DEC-030, DEC-032, DEC-056, DEC-104, DEC-105, DEC-161; ADR-006.
- **Configurações:** `DocumentTemplateVersion.importMappings` (por versão do template do TR).
- **Lacunas nas fontes canônicas:**
  1. `IMPORT_PREVIEW_EXPIRED` (api.md §2.2) está documentado só como "token de prévia expirado (15 min)"; esta story reaproveita o mesmo código quando o ETP ou o TR mudam entre a prévia e a aplicação, pois o efeito prático é idêntico (recalcular a prévia) — propor ampliar a descrição em api.md.
  2. O campo calculado `etpChangedSinceImport` (resposta de `TRM-03`) não consta de entities.md; segue o mesmo padrão dos campos derivados `...Masked` (DEC-030) — propor registrar em entities.md §4.8/api.md.
  3. O formato do `importToken` (assinado, com TTL, sem estado em Redis) não está especificado em nenhuma fonte canônica — propor nota em api.md §1.3 ou um ADR curto.

## Impacto técnico
- `importToken` é autocontido e assinado (HMAC), sem estado em Redis: embute `etpVersionId`, versão do TR e a seleção padrão; evita infraestrutura nova e simplifica a invalidação (basta recalcular e comparar).
- Reaproveita o mecanismo de `DocumentVersion`/`contentHash` (RFC 8785) de DEC-017 — nenhuma migração nova.
- Concorrência: a aplicação compete com o autosave de seções (US-036); por isso a invalidação do token cobre tanto a versão do ETP quanto a revisão de seções do TR, não só o `version` do documento.
- Upsert de itens usa a unicidade existente `(tenant_id, document_id, process_item_id)` de `document_items` — sem novo índice.

## Backend
- **Módulo(s):** `term` (dono); usa `document` (`DocumentVersionFactory`, `DraftContentService`), `etp` (leitura), `catalog`, `access`, `timeline` (projetor síncrono), `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `PreviewImportEtpToTermQuery` → `PreviewImportEtpToTermHandler`; `ApplyImportEtpToTermCommand` → `ApplyImportEtpToTermHandler`.
- **Domínio:** `TermOfReference.applyEtpImport(mapping, selection)`; `ImportToken` (value object, assina/verifica, TTL 15 min); `DocumentItem.upsertFromImport(...)`.
- **Integrações internas:** `EtpReadFacade.getActiveForProcess(processId)`; `DocumentFacade.createVersion(reason: 'IMPORT')`; `AuthorizationService.assertCan('TERM_UPDATE', { processId })`.
- **Transação:** passos 6.1–6.6 do fluxo principal em uma transação interativa Prisma com `app.tenant_id`: revalidação do token → aplicação seletiva (seções/campos/itens) → nova `DocumentVersion` → auditoria → outbox → commit.

## Frontend
- **Tela(s):** SCR-012 (`/processos/[id]/tr/[termId]`), painel "Importar do ETP".
- **Componentes:** `ImportEtpPreviewPanel` (diff "antes/depois" por seção), `FieldImportList`, `ItemsImportTable`, `ReplaceValueSourceDialog`, `StaleEtpBanner` (`etpChangedSinceImport`).
- **Estados:** carregando a prévia (skeleton); vazio (sem ETP, com link para criá-lo); erro (prévia expirada, recarrega automaticamente); sucesso (resumo "X seções e Y itens importados").
- **Acessibilidade:** foco movido ao painel ao abrir; diffs anunciados via `aria-live`; checkboxes navegáveis por teclado.
- **Responsivo:** em telas < 768 px o diff "antes/depois" vira abas "Antes" / "Depois".

## Banco de dados
- **Tabelas:** `terms_of_reference` (update dos campos importados), `documents` (`draftContent`, `draftRevision++`), `document_items` (upsert), `document_versions` (insert), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma — reaproveita entidades existentes.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id, process_item_id)` em `document_items` garante o upsert; `UNIQUE (tenant_id, document_id)` em `terms_of_reference`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TRM-05` | POST | `/terms/{id}/import-etp/preview` | `{}` (calcula a partir do estado atual) | `200 { data: { importToken, expiresAt, etp: { id, versionNumber }, sections: [{ target, sources, mode, preview }], fields: [{ target, source, value, valueMasked }], items: { count, copyQuantities, copyCalculationMemoToNotes, preview: [{ processItemId, sequence, description, etpQuantity, trCurrentQuantity }] } } }` | 200, 401, 403, 404, 422 (`ETP_REQUIRED_FOR_IMPORT`) |
| `TRM-06` | POST | `/terms/{id}/import-etp` | `{ importToken, sections: string[], fields: string[], copyItems: boolean, overwriteExisting?: boolean, confirmReplaceValueSource?: boolean }` + `If-Match` + `Idempotency-Key` | `200 { data: { term: TermOfReference, sectionsImported: string[], itemsImported: number } }` | 200, 401, 403, 404, 409, 410 (`IMPORT_PREVIEW_EXPIRED`), 412, 422, 428, 503 |
| `TRM-03` | GET | `/terms/{id}` | — | `200 { data: TermOfReference & { etpChangedSinceImport: boolean } }` | 200, 403, 404 |
| `ETP-03` | GET | `/etps/{id}` | — | `200 { data: Etp }` (link "ver ETP" a partir do painel de importação) | 200, 403, 404 |

## Logs
- `info` `term.import_etp_applied` — `termId`, `etpId`, `etpVersionId`, `sectionsCount`, `itemsCount`, `durationMs`.
- `warn` `term.import_preview_stale` — prévia recusada por expiração/mudança.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar.
- `error` `term.import_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** conteúdo das seções, valor estimado, especificações/critérios de aceitação dos itens.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `term.import_etp` | `DATA_CHANGE` | Commit da aplicação | `changes`: chaves de seções/campos/itens alterados (sem conteúdo); `metadata`: `etpId`, `etpVersionId`, `itemsImported`, `idempotencyKey` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = TERM_UPDATE` |

## Testes necessários
- **Unitários:** aplicação de `importMappings` (`REPLACE` vs `APPEND`); assinatura/verificação do `importToken`; regra de não sobrescrever itens especificados; precedência de origem do valor estimado.
- **Integração (Testcontainers PostgreSQL + Redis):** upsert de itens por `processItemId`; criação de `DocumentVersion` com `reason = IMPORT`; RLS entre tenants; outbox e timeline na mesma transação.
- **API/contrato:** respostas e erros de `TRM-05`/`TRM-06` conforme api.md; cabeçalhos `If-Match`, `Idempotency-Key`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** `TERM_UPDATE` por perfil e escopo; sigilo do orçamento (POL-09); TR de outro tenant → 404.
- **Concorrência:** prévia seguida de mudança no ETP ou no TR → `IMPORT_PREVIEW_EXPIRED`; duas aplicações simultâneas com o mesmo token → uma sucesso, outra reaproveita o resultado.
- **E2E (Playwright):** prévia → seleção parcial → aplicação → verificação do editor e da timeline; reimportação após o ETP mudar.
- **Acessibilidade/performance:** axe sem violações sérias no painel; prévia com p95 < 800 ms para ETP com até 50 itens.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `TERM_UPDATE` e POL-02/POL-09 aplicados na API; ação oculta sem permissão
- [ ] Transação única comprovada por teste de falha induzida
- [ ] Auditoria `term.import_etp` e evento `TermImportedFromEtp` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `TRM-05`/`TRM-06` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace da importação
- [ ] Painel acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e entities.md/api.md quanto às lacunas) atualizada

## Estimativa
**M** — reaproveita o editor e o ciclo de vida de US-036 e o modelo de itens de DEC-019; a complexidade está na prévia seletiva com token e na aplicação idempotente, sem novas entidades nem migrações.

## Prioridade
**P0** — sem importação, o TR nasce desalinhado do ETP, contrariando o art. 6º, XXIII c/c art. 18 da Lei 14.133/2021 e aumentando o risco de divergência na fase externa.
