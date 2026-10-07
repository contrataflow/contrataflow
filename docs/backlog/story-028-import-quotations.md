---
id: US-028
title: "Importar cotações por planilha"
epic: EP-004
feature: FT-017
mvp: 1
priority: P2
estimate: M
status: Especificada
depends_on: [US-026, US-068]
modules: [price-research, supplier, catalog, attachment, access, audit, platform]
screens: [SCR-009]
endpoints: [PRS-18, PRS-19, PRS-24]
permissions: [PRICE_RESEARCH_UPDATE]
events: [PriceResearchRecalculated]
---

# US-028 — Importar cotações por planilha

## Título
Importar cotações por planilha

## Descrição
**Como** responsável pela pesquisa de preços, **quero** preencher os preços de várias fontes e itens em uma planilha e importá-la de uma vez, **para** lançar pesquisas grandes (muitos itens × muitas fontes) sem digitar célula a célula na grade (US-026).

O usuário baixa um modelo pré-preenchido com os itens e as fontes já cadastradas, completa os preços offline, envia o arquivo e revê uma prévia com erro por linha/célula antes de confirmar a aplicação.

## Contexto
- Pesquisas com muitos itens e fontes (ex.: compras centralizadas) tornam o lançamento célula a célula (US-026) lento; a importação por planilha é o caminho alternativo para esse volume, mantendo as mesmas regras de validação da grade.
- A importação **não cria fontes nem fornecedores** — pressupõe que as fontes já existam (US-026) — apenas aplica preços de cotações sobre itens × fontes existentes, replicando a mesma matriz do mapa comparativo (US-031).
- Por ser uma funcionalidade de conveniência para volumes grandes, está priorizada como P2 (pode chegar depois do núcleo da pesquisa de preços).

## Objetivo
Permitir que o responsável importe uma planilha com até 500 linhas (itens) × 50 colunas (fontes) em menos de 1 minuto, com 100% dos erros de linha/célula reportados antes de qualquer gravação.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`).
- **Secundárias:** Setor de Compras (`COMPRAS`).

## Pré-condições
- Existe a `PriceResearch` com itens (US-024) e ao menos uma `PriceSource` cadastrada (US-026).
- Usuário possui `PRICE_RESEARCH_UPDATE` em escopo que cubra o processo; documento em `DRAFT`/`RETURNED` (POL-02).

## Fluxo principal
1. Na aba "Fontes" (SCR-009), o usuário clica em **"Importar planilha"**.
2. O sistema oferece **"Baixar modelo"**: a API gera o XLSX (`PRS-24`, mesmo gerador de planilhas do mapa comparativo — `PRS-22`) — colunas fixas (sequência e descrição do item) seguidas de uma coluna por fonte já cadastrada (cabeçalho = descrição da fonte), com os preços já lançados pré-preenchidos e as células sem cotação em branco.
3. O usuário preenche/ajusta os preços offline e volta à tela, selecionando o arquivo em **"Enviar planilha"**.
4. O front envia `POST /api/v1/price-research/{id}/import-preview` (`PRS-18`) com o arquivo. A API valida o tipo/tamanho do arquivo, lê cada linha e cada coluna de fonte, verifica correspondência de item e de fonte e a validade do preço, e devolve um token de prévia (válido por 15 minutos) com o resumo por linha/célula (válidas, com erro, vazias).
5. O sistema exibe a prévia: total de células a aplicar, lista de erros por linha/coluna (ex.: "Linha 5, fonte 'Painel de Preços': preço inválido").
6. Se houver ao menos uma célula válida, o usuário clica em **"Aplicar importação"**. O front envia `POST /api/v1/price-research/{id}/import` (`PRS-19`) com o token da prévia e `Idempotency-Key`.
7. A API, em uma transação: revalida o token (ainda dentro de 15 minutos), aplica cada célula válida (cria/atualiza a `Quotation` correspondente), ignora células vazias e cotações `EXCLUDED`, recalcula a pesquisa, grava auditoria `price_research.import` com o resumo e publica `PriceResearchRecalculated`.
8. A API responde **200** com o resumo da aplicação (linhas aplicadas/ignoradas); o front atualiza a grade e mostra o toast "Importação concluída: N preços atualizados".

## Fluxos alternativos
- **FA-01 — Planilha com formato inválido:** arquivo que não é `.xlsx`, corrompido ou maior que `uploads.maxFileSizeMb` é rejeitado antes de processar linhas (`FILE_TYPE_NOT_ALLOWED`/`FILE_TOO_LARGE`), sem gerar token de prévia.
- **FA-02 — Estrutura da planilha alterada:** colunas renomeadas/reordenadas pelo usuário são identificadas pelo cabeçalho (descrição da fonte) e pela coluna de item (sequência); colunas desconhecidas são ignoradas e reportadas como aviso na prévia, não como erro bloqueante.
- **FA-03 — Token de prévia expirado:** aplicar após 15 minutos retorna `IMPORT_PREVIEW_EXPIRED`; o usuário deve enviar a planilha novamente.
- **FA-04 — Todas as linhas com erro:** se nenhuma célula for válida, o botão "Aplicar importação" fica desabilitado e a prévia orienta a corrigir o arquivo.
- **FA-05 — Reenvio da aplicação com a mesma chave de idempotência:** reenvio com a mesma `Idempotency-Key` devolve a resposta original (`Idempotent-Replayed: true`), sem aplicar a importação duas vezes.
- **FA-06 — Pesquisa não editável:** com o documento fora de `DRAFT`/`RETURNED`, "Importar planilha" fica oculto; a API responde `DOCUMENT_NOT_EDITABLE`.

## Regras de negócio
- **RN-PRICE-35** — O modelo de importação é a mesma matriz itens (linhas, por `sequence` do `ProcessItem`) × fontes já cadastradas (colunas, por `PriceSource.description`) do mapa comparativo (US-031), gerada pela API em `PRS-24` com os preços atuais pré-preenchidos.
- **RN-PRICE-36** — Só são aceitos arquivos `.xlsx` até `uploads.maxFileSizeMb`; a planilha deve manter a coluna de item e ao menos uma coluna correspondente a uma fonte existente da pesquisa, identificadas por cabeçalho.
- **RN-PRICE-37** — A prévia (`PRS-18`) processa todas as linhas e colunas reconhecidas, reporta erro por linha/célula (item ou fonte não encontrados, preço inválido ou fora da faixa, usando os códigos de `errors[].code` de api.md §2.1.1) sem gravar nada, e emite um token válido por 15 minutos.
- **RN-PRICE-38** — A aplicação (`PRS-19`) exige o token da prévia ainda válido (`IMPORT_PREVIEW_EXPIRED` após 15 minutos) e importa somente as células marcadas como válidas na prévia correspondente; células vazias não alteram cotações existentes.
- **RN-PRICE-39** — Importar uma célula preenchida cria a `Quotation` (se não existir para aquele item/fonte) ou atualiza o preço (se existir e estiver `VALID`); células referentes a cotações `EXCLUDED` são ignoradas e reportadas como aviso (restaurar antes, via US-027).
- **RN-PRICE-40** — A importação é atômica (tudo ou nada entre as células válidas) e dispara um único recálculo geral da pesquisa (`PriceResearchRecalculated`) ao final; é registrada em auditoria (`price_research.import`) com o resumo de linhas aplicadas/ignoradas.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Arquivo | `file` | upload (.xlsx) | Sim | RN-PRICE-36 | — |
| Token da prévia | `previewToken` | texto (interno) | Sim (na aplicação) | válido por 15 min | gerado por `PRS-18` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Extensão/MIME fora da allowlist | Front + API | "Envie um arquivo .xlsx." | `FILE_TYPE_NOT_ALLOWED` |
| V-02 | Arquivo acima do limite | Front + API | "O arquivo excede o tamanho máximo permitido." | `FILE_TOO_LARGE` |
| V-03 | Linha com item não encontrado na pesquisa | API | "Linha {n}: item não encontrado nesta pesquisa." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-04 | Coluna com fonte não encontrada | API | "Coluna '{fonte}': fonte não encontrada nesta pesquisa." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Preço inválido, zero/negativo ou fora das casas permitidas | API | "Linha {n}, fonte '{fonte}': preço inválido." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-06 | Token de prévia expirado | API | "A prévia expirou. Envie a planilha novamente." | `IMPORT_PREVIEW_EXPIRED` |
| V-07 | Pesquisa não editável | API | "Esta pesquisa de preços não pode mais ser editada." | `DOCUMENT_NOT_EDITABLE` |

## Permissões
- **Permissão:** `PRICE_RESEARCH_UPDATE` com escopo que cubra o processo.
- **Políticas:** POL-02 (documento em `DRAFT`/`RETURNED`) e POL-09 (mascaramento do orçamento sigiloso na prévia e no resumo da aplicação).
- **MFA:** não exigido (risco M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Importar planilha" fica oculto; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PriceResearchRecalculated` | `price_research.recalculated` | Commit da aplicação da importação | `priceResearchId`, `itemsCount`, `itemsWithAlertsCount` |

A prévia (`PRS-18`) não grava nada e não gera evento.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: ação pontual de edição da pesquisa. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Importar cotações por planilha

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe a pesquisa de preços do processo "0012/2026" com 3 itens e 2 fontes cadastradas
    And o usuário "Diego" tem "PRICE_RESEARCH_UPDATE" sobre o processo

  Scenario: [Sucesso] Importar planilha válida
    When "Diego" enviar uma planilha com preços válidos para os 3 itens nas 2 fontes
    Then a prévia deve reportar 6 células válidas e nenhum erro
    When "Diego" aplicar a importação
    Then as 6 cotações devem ser gravadas
    And deve gerar o evento "PriceResearchRecalculated"
    And deve gerar registro de auditoria "price_research.import"

  Scenario: [Sucesso] Importar planilha com algumas células vazias
    When "Diego" enviar uma planilha com preços em apenas 4 das 6 células
    And aplicar a importação
    Then apenas 4 cotações devem ser gravadas ou atualizadas
    And as 2 células vazias não devem alterar cotações existentes

  Scenario: [Validação] Linha com preço inválido
    When "Diego" enviar uma planilha com o valor "-10" em uma célula
    Then a prévia deve reportar erro "VALIDATION_ERROR" com código "INVALID_DECIMAL" naquela linha/coluna
    And aplicar a importação não deve gravar aquela célula

  Scenario: [Permissão] Usuário sem PRICE_RESEARCH_UPDATE
    Given que o usuário "Eva" possui apenas "PROCESS_VIEW"
    When "Eva" enviar uma planilha para "PRS-18"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Token de prévia de outra pesquisa/tenant
    Given que o token "T1" foi emitido para a pesquisa do processo "0012/2026" no tenant "Prefeitura de São José"
    When for usado para aplicar importação na pesquisa de outro processo
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhuma cotação deve ser alterada

  Scenario: [Duplicidade] Aplicar a mesma importação duas vezes com a mesma chave de idempotência
    Given que "Diego" aplicou a importação com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And as cotações não devem ser duplicadas ou somadas novamente

  Scenario: [Concorrência] Importação e edição manual simultâneas do mesmo item
    Given que a prévia "T1" inclui um preço para o item 1 na fonte "Painel de Preços"
    When "Diego" editar manualmente a cotação do item 1 na mesma fonte pela grade (US-026) antes de aplicar "T1"
    And em seguida aplicar a importação "T1"
    Then a cotação deve refletir o último valor aplicado, sem erro, e o recálculo deve ocorrer uma única vez

  Scenario: [Falha de banco] Banco indisponível ao aplicar a importação
    Given que o banco de dados fica indisponível durante a transação de aplicação
    When "Diego" aplicar uma importação válida
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma cotação da planilha deve ser persistida

  Scenario: [Falha de integração] Token de prévia expirado
    Given que a prévia "T1" foi emitida há 20 minutos
    When "Diego" tentar aplicar a importação com o token "T1"
    Then a API deve responder 410 com código "IMPORT_PREVIEW_EXPIRED"
    And nenhuma cotação deve ser alterada
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Arquivo não `.xlsx` | 415 | `FILE_TYPE_NOT_ALLOWED` | "Envie um arquivo .xlsx." | Mantém seletor de arquivo |
| Arquivo acima do limite | 413 | `FILE_TOO_LARGE` | "O arquivo excede o tamanho máximo permitido." | Mantém seletor de arquivo |
| Linha/coluna com referência não encontrada | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Linha {n}/coluna '{fonte}': não encontrada nesta pesquisa." | Lista de erros na prévia |
| Preço inválido | 422 | `VALIDATION_ERROR` (`INVALID_DECIMAL`) | "Linha {n}, fonte '{fonte}': preço inválido." | Lista de erros na prévia |
| Token de prévia expirado | 410 | `IMPORT_PREVIEW_EXPIRED` | "A prévia expirou. Envie a planilha novamente." | Volta ao passo de upload |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Esta pesquisa de preços não pode mais ser editada." | Oculta "Importar planilha" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar esta pesquisa de preços." | Oculta "Importar planilha" |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém prévia; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-026 (fontes/cotações já existentes — pré-requisito), US-068 (upload do arquivo). US-031 (mapa comparativo) fornece o layout reaproveitado pelo modelo; US-029 consome o recálculo.
- **Decisões/ADRs:** DEC-003 (decimais), DEC-030 (sigilo do orçamento na prévia/resumo).
- **Configurações:** `uploads.maxFileSizeMb`.
- **Lacunas nas fontes canônicas:** ~~rota para baixar o modelo~~ — resolvida: `PRS-24` `GET /price-research/{id}/import-template` incluída no catálogo (api.md §3).

## Impacto técnico
- Reaproveita o parser/gerador XLSX do mapa comparativo (US-031, `PRS-22`) tanto para montar o modelo quanto para a futura exportação — mesma camada de (de)serialização de planilha.
- Processamento de até 500 linhas × 50 colunas deve ocorrer de forma síncrona na prévia (mesmo limite de `EXPORT_TOO_LARGE` usado em US-031, por consistência), evitando necessidade de fila para o MVP 1.
- Token de prévia (15 min) deve ser armazenado em Redis com TTL igual, referenciando as células validadas (evita reprocessar o arquivo na aplicação).
- Import é P2: pode ser entregue após o núcleo (US-024/025/026/027/029) sem bloquear o fechamento da pesquisa, já que a grade manual (US-026) cobre o caminho principal.

## Backend
- **Módulo(s):** `price-research` (dono); usa `attachment`/`platform` (upload temporário do arquivo, Redis para o token), `access`, `audit`.
- **Casos de uso:** `PreviewQuotationImportCommand`/`Handler`, `ApplyQuotationImportCommand`/`Handler`.
- **Domínio:** `QuotationImportPreview` (value object: linhas, células, erros, resumo); reaproveita `Quotation.upsertPrice` (US-026) célula a célula na aplicação.
- **Integrações internas:** parser XLSX compartilhado com `PRS-22` (US-031); `PriceResearchFacade.recalculate`.
- **Transação:** prévia é somente leitura (sem transação de escrita); aplicação grava todas as células válidas em uma única transação com `app.tenant_id`.

## Frontend
- **Tela(s):** SCR-009 (`/processos/[id]/pesquisa-precos/[researchId]`), diálogo "Importar planilha".
- **Componentes:** `ImportQuotationsDialog` (upload, geração do modelo client-side via `xlsx`/`exceljs`), `ImportPreviewTable` (lista de erros/avisos por linha).
- **Estados:** carregando durante o parse da prévia; vazio ("Nenhuma célula válida para importar"); erro de upload com "Tentar novamente".
- **Acessibilidade e responsividade:** lista de erros navegável por teclado; resumo anunciado via `aria-live` ao concluir a prévia.

## Banco de dados
- **Tabelas:** `quotations` (sem nova tabela; token de prévia fica em Redis, não em banco relacional).
- **Migrações:** nenhuma adicional a US-026.
- **Índices/constraints relevantes:** reaproveita `UNIQUE (tenant_id, price_item_id, price_source_id)` de `quotations` (US-026).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-18 | POST | `/api/v1/price-research/{id}/import-preview` | multipart `.xlsx` | `200 { data: { previewToken, rows: [...], summary: { total, valid, errors } } }` | 200, 403, 404, 413, 415, 422 |
| PRS-19 | POST | `/api/v1/price-research/{id}/import` | `{ previewToken }` + `Idempotency-Key` | `200 { data: { appliedCount, skippedCount } }` | 200, 403, 404, 409, 410, 422 |
| PRS-24 | GET | `/api/v1/price-research/{id}/import-template` | — | `200` arquivo `.xlsx` (matriz itens × fontes com preços atuais) | 200, 403, 404 |

## Logs
- `info` `price_research.import_previewed` — `priceResearchId`, linhas processadas, quantidade de erros.
- `info` `price_research.import_applied` — `priceResearchId`, `appliedCount`, `skippedCount`.
- `warn` `price_research.import_token_expired`.
- `error` `price_research.import_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** preços e conteúdo do arquivo enviado.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `price_research.import` | `DATA_CHANGE` | Commit da aplicação | `metadata`: `appliedCount`, `skippedCount`, nome do arquivo |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = PRICE_RESEARCH_UPDATE` |

## Testes necessários
- **Unitários:** parser da planilha (mapeamento de colunas por cabeçalho de fonte; linhas por sequência de item); validação de preço por célula.
- **Integração (Testcontainers + Redis):** token de prévia com TTL de 15 min; aplicação atômica; recálculo único ao final.
- **API/contrato:** respostas e erros conforme api.md; `Idempotency-Key` na aplicação.
- **RBAC e multi-tenant:** `PRICE_RESEARCH_UPDATE` por escopo; token de outra pesquisa/tenant → 404.
- **Concorrência:** edição manual (US-026) e importação do mesmo item entre prévia e aplicação.
- **E2E (Playwright):** baixar modelo, preencher, importar, revisar prévia com erro, corrigir e aplicar.
- **Acessibilidade/performance:** planilha de 500×50 processada dentro do tempo de resposta síncrono esperado.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PRICE_RESEARCH_UPDATE` e POL-02 aplicados na API
- [ ] Token de prévia expira corretamente aos 15 minutos (teste dedicado)
- [ ] Auditoria e evento `PriceResearchRecalculated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRS-18/19 compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Acessibilidade (axe) verificada no diálogo de importação
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — reaproveita validações e parser de planilha de outra story (US-031), mas soma upload, prévia com token temporário e aplicação em lote com as mesmas regras de US-026.

## Prioridade
**P2** — conveniência para pesquisas de grande volume; a grade manual (US-026) já cobre o caminho principal, por isso pode ser entregue depois do núcleo do MVP 1.
