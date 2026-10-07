---
id: US-003
title: "Visões salvas e exportação CSV da lista de processos"
epic: EP-001
feature: FT-002
mvp: 1
priority: P2
estimate: M
status: Especificada
depends_on: [US-002]
modules: [process, access, audit, platform]
screens: [SCR-004]
endpoints: [PRC-34, PRC-35, PRC-36, PRC-37, PRC-38, PRC-01]
permissions: [PROCESS_VIEW, INBOX_VIEW, PROCESS_EXPORT, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-003 — Visões salvas e exportação CSV da lista de processos

## Título
Salvar visões da lista de processos e exportá-la em CSV

## Descrição
**Como** gestor de contratações (ou controlador interno), **quero** salvar combinações de filtros, ordenação e colunas da lista de processos e exportar o resultado em CSV, **para** retomar minhas consultas recorrentes com um clique, compartilhá-las com a equipe e levar os dados para relatórios e prestações de contas sem redigitar nada.

A lista (US-002) ganha o seletor **Visões** (minhas e compartilhadas), o diálogo **Salvar visão** (nome, padrão, compartilhar) e o botão **Exportar CSV**. A exportação usa exatamente os mesmos filtros, ordenação e colunas da tela, é gerada em streaming até 10 mil linhas, aplica o mascaramento do orçamento sigiloso (POL-09), neutraliza conteúdo que planilhas interpretariam como fórmula (CSV injection) e é registrada na auditoria (`process.export`).

## Contexto
- O gestor repete diariamente as mesmas consultas ("atrasados da minha diretoria", "aguardando aprovação por prioridade") e mantém relatórios manuais para a gestão (persona P02); Controle Interno e Auditoria precisam extrair evidências com filtros combináveis e exportação registrada (P09, P13).
- `SavedView` pertence ao módulo `process` (DEC-040; entities.md §4.4, P2). Exportação é ação sensível auditada (DEC-025, categoria `EXPORT`); valores sigilosos seguem DEC-030/POL-09 também em exportações.
- O contrato de filtros é o de PRC-01 (US-002); as visões com `scope = INBOX` usam a mesma API e serão consumidas pela caixa de tarefas (US-056).

## Objetivo
Permitir que um usuário salve e reaplique uma visão em até 2 cliques e exporte até 10 mil processos em menos de 15 s (p95), com 100% das exportações auditadas, nenhum valor sigiloso exposto a quem não atende POL-09 e nenhuma célula capaz de executar fórmula ao abrir o arquivo.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`).
- **Secundárias:** Controle Interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — exportação de evidências; qualquer usuário com `PROCESS_VIEW` — visões pessoais (ex.: Planejamento, Compras, Requisitante).

## Pré-condições
- Lista de processos disponível (US-002) e usuário com acesso a ela (`PROCESS_VIEW` ou concessões `USER`).
- Para exportar: `PROCESS_EXPORT` com escopo que cubra ao menos parte dos processos visíveis.
- Para visões da caixa (`scope = INBOX`): `INBOX_VIEW`.

## Fluxo principal
**Salvar e aplicar visão**
1. Na lista (SCR-004), o usuário ajusta filtros, ordenação e colunas e clica em **"Salvar visão"**.
2. O diálogo pede **Nome** (obrigatório), **"Usar como visão padrão"** e **"Compartilhar com a equipe"** (desmarcados) e mostra o resumo dos critérios em texto ("Status: Em andamento · Atrasados · Ordenação: Prioridade").
3. O front envia `POST /api/v1/saved-views` (PRC-36) com `Idempotency-Key`, `scope = PROCESS_LIST`, `filters` (estado atual sem paginação), `sort` e `columns`.
4. A API valida (Zod `savedViewSchema`), verifica unicidade do nome e o limite por dono (RN-PROC-34, RN-PROC-38), desmarca a padrão anterior se `isDefault = true` (RN-PROC-36) e responde **201** com a visão e `ETag`.
5. O seletor **Visões** passa a listar a nova visão em "Minhas visões"; ao escolhê-la, o front aplica `filters`, `sort` e `columns` à URL e consulta PRC-01.

**Exportar**
6. O usuário clica em **"Exportar CSV"** (visível só com `PROCESS_EXPORT`). O diálogo mostra o total da consulta atual (de `meta.totalItems`), as colunas que serão exportadas e, se o total passar de 10 mil, o aviso para refinar os filtros (botão desabilitado).
7. Ao confirmar, o front chama `GET /api/v1/processes/export` (PRC-34) com os mesmos parâmetros de PRC-01 + `columns`.
8. A API autoriza, conta as linhas (RN-PROC-40, RN-PROC-41), abre um cursor somente leitura com `app.tenant_id` e transmite o CSV em lotes de 500 linhas (RN-PROC-45), aplicando mascaramento (RN-PROC-42), neutralização (RN-PROC-43) e formatação (RN-PROC-44).
9. Ao final do envio a API grava `process.export` (`SUCCESS`) com filtros, colunas e contagens.
10. O front salva o arquivo `processos-20261005-1432.csv` e exibe o toast "Exportação concluída: 137 processos."

## Fluxos alternativos
- **FA-01 — Visão padrão:** ao abrir SCR-004 sem parâmetros na URL, aplica-se a visão marcada como padrão do usuário; o chip "Visão: {nome}" indica a origem e "Limpar" volta ao padrão da tela (RN-PROC-30).
- **FA-02 — Atualizar visão:** com uma visão aplicada e critérios alterados, o seletor mostra "Alterações não salvas" e oferece "Atualizar visão" (PRC-37 com `If-Match`) ou "Salvar como nova".
- **FA-03 — Renomear, excluir e trocar a padrão:** em "Gerenciar visões" o dono renomeia (PRC-37), exclui (PRC-38, com confirmação) ou troca a visão padrão.
- **FA-04 — Visão compartilhada:** aparece para os demais em "Compartilhadas", com o nome do dono; ao aplicá-la, cada usuário vê somente os processos que pode ver (RN-PROC-37). Quem não é dono pode apenas aplicar ou **"Salvar como minha"** (cópia via PRC-36).
- **FA-05 — Filtros desatualizados:** ao aplicar uma visão cujo filtro referencia unidade, etiqueta ou item de catálogo que não existe mais, o front descarta o valor e exibe "Alguns filtros desta visão não estão mais disponíveis e foram ignorados." (RN-PROC-39). Itens apenas inativos continuam valendo.
- **FA-06 — Exportar uma visão:** no menu da visão, "Exportar CSV" aplica a visão e abre o diálogo de exportação.
- **FA-07 — Acima do limite:** se, entre a abertura do diálogo e o envio, o total ultrapassar 10 mil, a API responde 422 `EXPORT_TOO_LARGE` com o total; o diálogo mostra "A consulta tem 10.240 processos. Refine os filtros para exportar até 10.000."
- **FA-08 — Exportação interrompida:** falha durante o envio aborta a conexão; o front descarta o arquivo parcial e exibe "A exportação foi interrompida. Tente novamente." (RN-PROC-45).
- **FA-09 — Exportação simultânea:** uma segunda exportação do mesmo usuário enquanto a primeira está em andamento recebe 429 com `Retry-After` (RN-PROC-46).

## Regras de negócio
- **RN-PROC-34** — Uma visão pertence ao dono (`ownerId`) e a um escopo (`SavedViewScope`: `PROCESS_LIST` nesta story; `INBOX` para a caixa de tarefas). `name` tem de 1 a 80 caracteres após trim e é único por dono e escopo sem diferenciar maiúsculas (`lower(name)`).
- **RN-PROC-35** — `filters` guarda apenas o contrato de filtros de PRC-01 (US-002, tabela "Campos"), sem `page`/`pageSize`, validado por `savedViewFiltersSchema` com versão (`{ "v": 1, … }`); `sort` usa a sintaxe de RN-PROC-27 (até 120 caracteres); `columns` é a lista ordenada de chaves de coluna válidas, com `code` e `title` sempre presentes.
- **RN-PROC-36** — Visão padrão: no máximo uma por dono e escopo. Marcar uma visão como padrão desmarca a anterior na mesma transação; a padrão é aplicada ao abrir a tela sem parâmetros (FA-01). Visões compartilhadas por outros não podem ser a padrão de quem não é dono (use "Salvar como minha").
- **RN-PROC-37** — Compartilhamento: `isShared = true` torna a visão visível, somente para leitura, a todos os usuários do tenant com acesso ao mesmo escopo (`PROCESS_VIEW`/concessões para `PROCESS_LIST`; `INBOX_VIEW` para `INBOX`). A visão compartilha **critérios, nunca dados**: o resultado sempre respeita o predicado de visibilidade (RN-PROC-19) e o mascaramento (RN-PROC-25) de quem a aplica. Somente o dono altera ou exclui.
- **RN-PROC-38** — Limite de 20 visões por dono e escopo; acima disso a criação retorna 422 `VALIDATION_ERROR` ("Você atingiu o limite de 20 visões. Exclua uma visão para salvar outra.").
- **RN-PROC-39** — Ao aplicar uma visão, valores de filtro que não existem mais no tenant são descartados com aviso (FA-05); valores inativos são mantidos (US-002 permite filtrar por itens inativos). A visão salva não é alterada automaticamente.
- **RN-PROC-40** — Exportação: mesmos filtros e ordenação de PRC-01 (inclusive valores reservados e atalhos); colunas = `columns` informadas (padrão: colunas visíveis do usuário); linhas = processos visíveis (RN-PROC-19) **e** cobertos pelo escopo de `PROCESS_EXPORT` do vínculo (mesmo cálculo de cobertura do §1.1 de permissions.md).
- **RN-PROC-41** — Limite de **10.000 linhas** por arquivo: a API conta as linhas antes de enviar o primeiro byte; acima do limite responde 422 `EXPORT_TOO_LARGE` com `meta.totalItems` e não gera arquivo nem registro de exportação concluída.
- **RN-PROC-42** — Mascaramento (POL-09): para processos sigilosos em que o exportador não atende POL-09, a coluna "Valor estimado" sai como `Sigiloso`; a coluna "Orçamento sigiloso" (`Sim`/`Não`) é incluída sempre que "Valor estimado" for exportado; filtro e ordenação por valor seguem RN-PROC-25. Nenhum valor mascarado é escrito no arquivo, no log ou na auditoria.
- **RN-PROC-43** — Proteção contra CSV injection: toda célula de texto iniciada por `=`, `+`, `-`, `@`, tabulação ou retorno de carro recebe o prefixo `'` (apóstrofo); aspas duplas são duplicadas e campos com separador, aspas ou quebra de linha vão entre aspas (RFC 4180). Valores numéricos e datas gerados pelo sistema não recebem prefixo.
- **RN-PROC-44** — Formato: UTF-8 com BOM, separador `;`, fim de linha CRLF, cabeçalho com rótulos em pt-BR, decimais com vírgula e sem separador de milhar, datas `DD/MM/AAAA` e data-hora `DD/MM/AAAA HH:mm` no fuso do tenant, enums pelos rótulos da terminologia (nunca valores técnicos — DEC-184), etiquetas separadas por " | ". Nome do arquivo: `processos-AAAAMMDD-HHmm.csv` (horário do tenant), entregue com `Content-Disposition: attachment`.
- **RN-PROC-45** — Geração em streaming: cursor no servidor em lotes de 500 linhas, com backpressure, em transação `READ ONLY` com `app.tenant_id` e `statement_timeout` de 60 s. Toda exportação gera `process.export` — `SUCCESS` ao concluir; `FAILURE` (com `reasonCode`) se interrompida após iniciar o envio.
- **RN-PROC-46** — Concorrência e limites: no máximo uma exportação em andamento por usuário e tenant (trava Redis com TTL de 2 min) e o limite de 20 exportações/min de api.md §1.6; excedentes recebem 429 `RATE_LIMITED` com `Retry-After`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome da visão | `name` | texto curto | Sim | 1–80 caracteres; único por dono e escopo | — |
| Escopo | `scope` | `SavedViewScope` | Sim | `PROCESS_LIST` nesta tela | `PROCESS_LIST` |
| Filtros | `filters` | JSON | Sim | `savedViewFiltersSchema` (`v: 1`) | estado atual da lista |
| Ordenação | `sort` | texto | Não | RN-PROC-27; até 120 caracteres | ordenação atual |
| Colunas | `columns` | JSON (lista de chaves) | Sim | chaves válidas; inclui `code` e `title` | colunas visíveis |
| Compartilhar com a equipe | `isShared` | interruptor | Não | RN-PROC-37 | `false` |
| Usar como visão padrão | `isDefault` | interruptor | Não | RN-PROC-36 | `false` |
| *(sistema)* Dono | `ownerId` | uuid | — | usuário autenticado | gerado |
| Colunas da exportação | `columns` (query de PRC-34) | lista de chaves | Não | mesmas chaves da tela | colunas visíveis |

Chaves de coluna: `code`, `title`, `status`, `stage`, `currentDepartment`, `currentResponsible`, `deadline` (exporta "Prazo da etapa" e "Situação do prazo"), `priority`, `requestingSecretariat`, `requestingDepartment`, `organization`, `contractingType`, `modality`, `origin`, `estimatedValue` (exporta também "Orçamento sigiloso"), `targetDate`, `tags`, `internalCode`, `createdAt`, `updatedAt`.

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Nome ausente ou acima de 80 caracteres | Front + API (Zod) | "Informe um nome de até 80 caracteres." | `VALIDATION_ERROR` |
| V-02 | Nome repetido para o mesmo dono e escopo | API (+ índice único) | "Você já tem uma visão com este nome." | `CONFLICT` |
| V-03 | `filters` fora do contrato (filtro desconhecido, enum inválido, versão ausente) | API | "Não foi possível salvar: há filtros inválidos." | `VALIDATION_ERROR` |
| V-04 | `columns` com chave inexistente ou sem `code`/`title` | Front + API | "Selecione colunas válidas." | `VALIDATION_ERROR` |
| V-05 | Limite de 20 visões atingido | API | "Você atingiu o limite de 20 visões. Exclua uma visão para salvar outra." | `VALIDATION_ERROR` |
| V-06 | Visão compartilhada por outro marcada como padrão | API | "Salve uma cópia da visão para usá-la como padrão." | `VALIDATION_ERROR` |
| V-07 | Exportação acima de 10.000 linhas | API | "A consulta tem {total} processos. Refine os filtros para exportar até 10.000." | `EXPORT_TOO_LARGE` |
| V-08 | Parâmetros de filtro inválidos na exportação | API | "Alguns filtros eram inválidos. Revise a consulta." | `VALIDATION_ERROR` |

## Permissões
- **Visões:** `PROCESS_VIEW` (ou concessões `USER`) para `scope = PROCESS_LIST`; `INBOX_VIEW` para `scope = INBOX` (PRC-35/36). Alterar e excluir (PRC-37/38): somente o dono — visão compartilhada de outro → 403 `PERMISSION_DENIED`; visão privada de outro → 404 `NOT_FOUND`.
- **Exportação:** `PROCESS_EXPORT` (risco `M`, com escopo) — perfis padrão `GESTOR_CONTRATACOES`, `CONTROLE_INTERNO`, `AUDITOR`. Linhas limitadas por RN-PROC-40.
- **Políticas:** POL-09 (mascaramento na exportação).
- **MFA:** não exigido para visões; para exportação, somente se `security.mfaPolicy = ALL`. O desmascaramento por `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (`H`) segue a regra de US-002 (sem MFA quando exigido, valores saem mascarados).
- **Sem permissão:** botão "Exportar CSV" oculto; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Visões são preferências do usuário e a exportação é leitura: nenhum evento de domínio. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (o toast de conclusão é feedback de interface). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Visões salvas e exportação CSV da lista de processos

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Patrícia" possui o perfil "GESTOR_CONTRATACOES" com escopo "TENANT"
    And "Tatiane" possui o perfil "SOMENTE_LEITURA" com escopo "ORGANIZATION"
    And existem 137 processos visíveis com status "IN_PROGRESS" ou "RETURNED", sendo o "0031/2026" com orçamento sigiloso de "1200000.00"

  Scenario: [Sucesso] Salvar visão e usá-la como padrão
    Given que "Patrícia" filtrou "Atrasados", ordenou por "-priority" e ocultou a coluna "Prioridade"
    When "Patrícia" salvar a visão "Atrasados por prioridade" marcando "Usar como visão padrão"
    Then a API deve responder 201 com a visão e o cabeçalho "ETag" igual a "1"
    And a visão padrão anterior de "Patrícia" no escopo "PROCESS_LIST" deve ser desmarcada
    When "Patrícia" abrir "/processos" sem parâmetros
    Then a lista deve aplicar os filtros, a ordenação e as colunas da visão "Atrasados por prioridade"

  Scenario: [Sucesso] Visão compartilhada respeita a visibilidade de quem aplica
    Given que "Patrícia" compartilhou a visão "Devolvidos da Saúde"
    And "Ana" vê apenas processos das suas lotações
    When "Ana" aplicar a visão "Devolvidos da Saúde"
    Then "Ana" deve ver somente os processos devolvidos que o seu predicado de visibilidade permite
    And "Ana" não deve conseguir renomear ou excluir a visão

  Scenario: [Sucesso] Exportar CSV com mascaramento e auditoria
    Given que "Luciana" possui o perfil "CONTROLE_INTERNO" com "PROCESS_EXPORT" e "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    And "Rafaela" possui um perfil personalizado com "PROCESS_VIEW" e "PROCESS_EXPORT", sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Rafaela" exportar a lista filtrada com as colunas "code", "title", "status" e "estimatedValue"
    Then o arquivo deve ter 138 linhas (cabeçalho + 137), separador ";", codificação UTF-8 com BOM e nome no padrão "processos-AAAAMMDD-HHmm.csv"
    And a linha do processo "0031/2026" deve trazer "Sigiloso" na coluna "Valor estimado" e "Sim" na coluna "Orçamento sigiloso"
    And deve gerar registro de auditoria "process.export" com resultado "SUCCESS", "rowCount" 137 e "maskedRowCount" 1
    When "Luciana" exportar a mesma consulta
    Then a linha do processo "0031/2026" deve trazer "1200000,00"

  Scenario: [Validação] Conteúdo que planilhas interpretariam como fórmula é neutralizado
    Given que o processo "0050/2026" tem o título "=HYPERLINK(\"http://x.io\";\"Clique\")"
    When "Patrícia" exportar a lista contendo esse processo
    Then a célula do título deve começar com "'=" e nenhuma célula de texto deve começar com "=", "+", "-" ou "@"

  Scenario: [Validação] Nome inválido e exportação acima do limite
    When "Patrícia" tentar salvar uma visão com nome de 81 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro no campo "name"
    Given que a consulta atual retorna 10240 processos
    When "Patrícia" solicitar a exportação
    Then a API deve responder 422 com código "EXPORT_TOO_LARGE" e "meta.totalItems" igual a 10240
    And nenhum arquivo deve ser gerado

  Scenario: [Permissão] Usuário sem PROCESS_EXPORT
    When "Tatiane" abrir a lista de processos
    Then o botão "Exportar CSV" não deve ser exibido
    When "Tatiane" enviar "GET /api/v1/processes/export"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_EXPORT"

  Scenario: [Permissão] Alterar visão de outro usuário
    Given que "Patrícia" possui a visão compartilhada "Devolvidos da Saúde" e a visão privada "Minha fila"
    When "Tatiane" enviar PATCH para a visão "Devolvidos da Saúde"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    When "Tatiane" enviar PATCH para a visão "Minha fila"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Tenant incorreto] Visão de outro tenant
    Given que existe a visão "V1" no tenant "Prefeitura B"
    When "Patrícia", no tenant "Prefeitura de São José", enviar GET, PATCH ou DELETE para a visão "V1"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhuma visão da "Prefeitura B" deve aparecer em "GET /api/v1/saved-views"

  Scenario: [Duplicidade] Nome repetido e reenvio idempotente
    Given que "Patrícia" já possui a visão "Atrasados por prioridade"
    When "Patrícia" salvar outra visão chamada "atrasados por PRIORIDADE"
    Then a API deve responder 409 com código "CONFLICT"
    When "Patrícia" reenviar a criação de uma visão nova com a mesma "Idempotency-Key" após falha de rede
    Then a API deve responder 201 com a mesma visão e o cabeçalho "Idempotent-Replayed: true"

  Scenario: [Concorrência] Mesma visão alterada em duas abas
    Given que "Patrícia" abriu a visão "Atrasados por prioridade" (versão 3) em duas abas
    And alterou e salvou a visão na primeira aba
    When "Patrícia" salvar alterações na segunda aba com "If-Match" igual a "3"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And a tela deve oferecer "Recarregar a visão" ou "Salvar como nova"

  Scenario: [Concorrência] Segunda exportação simultânea do mesmo usuário
    Given que uma exportação de "Patrícia" está em andamento
    When "Patrícia" solicitar outra exportação
    Then a API deve responder 429 com código "RATE_LIMITED" e cabeçalho "Retry-After"

  Scenario: [Falha de banco] Banco cai durante o envio do arquivo
    Given que a exportação de "Patrícia" já enviou 4000 linhas
    When o banco de dados ficar indisponível
    Then a conexão deve ser encerrada sem concluir o arquivo
    And o front deve descartar o arquivo parcial e exibir "A exportação foi interrompida. Tente novamente."
    And deve gerar registro de auditoria "process.export" com resultado "FAILURE"

  Scenario: [Falha de integração] Redis indisponível durante a exportação
    Given que o Redis está indisponível
    When "Patrícia" exportar a lista
    Then a exportação deve ser concluída sem a trava de concorrência
    And deve ser registrado log "warn" "export.lock_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Visão inválida (nome, filtros, colunas, limite) | 422 | `VALIDATION_ERROR` | "Revise os dados da visão." | Destaca o campo; mantém o diálogo aberto |
| Nome repetido | 409 | `CONFLICT` | "Você já tem uma visão com este nome." | Erro no campo "Nome" |
| Visão compartilhada de outro (alterar/excluir) | 403 | `PERMISSION_DENIED` | "Somente quem criou a visão pode alterá-la." | Oferece "Salvar como minha" |
| Visão inexistente, privada de outro ou de outro tenant | 404 | `NOT_FOUND` | "Visão não encontrada." | Remove do seletor e recarrega a lista de visões |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Esta visão foi alterada em outra janela." | "Recarregar a visão" / "Salvar como nova" |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a visão e tente novamente." | Recarrega a visão |
| Sem `PROCESS_EXPORT` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para exportar processos." | Botão oculto |
| Exportação acima do limite | 422 | `EXPORT_TOO_LARGE` | "A consulta tem {total} processos. Refine os filtros para exportar até 10.000." | Mantém o diálogo com o botão desabilitado |
| Exportação simultânea ou limite por minuto | 429 | `RATE_LIMITED` | "Aguarde a exportação em andamento terminar." | Respeita `Retry-After` |
| Banco indisponível antes do envio | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível exportar agora. Tente novamente em instantes." | Botão "Tentar novamente"; correlationId |
| Interrupção durante o envio | — (conexão abortada) | — | "A exportação foi interrompida. Tente novamente." | Descarta arquivo parcial |

## Dependências
- **Stories:** US-002 (contrato de filtros, predicado de visibilidade, colunas e mascaramento). Relacionadas: US-013 (registro de campos sigilosos), US-073 (auditoria), US-056 (consumidora de visões `INBOX`).
- **Decisões/ADRs:** DEC-025, DEC-030, DEC-040, DEC-055, DEC-104, DEC-105, DEC-106, DEC-184; ADR-009.
- **Configurações:** `labels.secretariat`, `labels.department` (rótulos do cabeçalho do CSV); fuso do tenant (`Tenant.timezone`).
- **Lacunas nas fontes canônicas:**
  1. **Visão padrão única:** `SavedView` não tem índice que garanta uma única `isDefault` por dono e escopo. Proposta: `UNIQUE (tenant_id, owner_id, scope) WHERE is_default` em entities.md (a aplicação já garante na transação).
  2. **Listagem de compartilhadas:** sem índice para `is_shared`. Proposta: `(tenant_id, scope) WHERE is_shared`.
  3. **Formato do CSV e limite de 10.000 linhas** não constam das fontes canônicas; adotados como regra desta story (constante `PROCESS_EXPORT_MAX_ROWS` em `packages/types`). Proposta: registrar em api.md §4 (PRC-34).

## Impacto técnico
- Estabelece o **padrão de exportação em streaming** do produto (reutilizável por AUD-03 e PRS-22): cursor (`pg-query-stream`) dentro de transação `READ ONLY` com `app.tenant_id`, transformação linha a linha (`CsvRowSerializer` com neutralização e formatação pt-BR) e backpressure até o BFF; nada é materializado em memória ou em disco.
- O BFF (Next.js) deve repassar o stream sem bufferizar (resposta `ReadableStream`) e respeitar o tempo máximo de 60 s.
- Reutiliza `ProcessListQueryBuilder` (US-002) com um segundo conjunto de escopos (`PROCESS_EXPORT`) — a cobertura de exportação é uma interseção adicional no predicado.
- Visões guardam critérios versionados (`v: 1`); mudanças futuras no contrato de filtros exigem migração de leitura (upcaster) em `savedViewFiltersSchema`.
- A auditoria de exportação é gravada fora da transação de leitura (transação curta própria) para registrar também falhas.

## Backend
- **Módulo(s):** `process` (dono de `SavedView` e da exportação); `audit` e `platform` (trava e rate limit em Redis).
- **Casos de uso:** `ListSavedViewsQuery`, `CreateSavedViewCommand`, `UpdateSavedViewCommand`, `DeleteSavedViewCommand`, `ExportProcessesQuery` (stream).
- **Domínio:** `SavedView` (invariantes de nome, limite, padrão única e posse); `ProcessExportService` (contagem, cursor, serialização, auditoria); `CsvRowSerializer` (RN-PROC-43/44).
- **Integrações internas:** `ProcessVisibilityService` e `ProcessListQueryBuilder` (US-002), `BudgetVisibilityService` (POL-09), `AccessFacade.getEffectiveScopes('PROCESS_EXPORT')`, `AuditService`, `RateLimitService`/`DistributedLock` (Redis).
- **Transação:** criação/alteração de visão em uma transação (inclui desmarcar a padrão anterior); exportação em transação somente leitura + gravação de `process.export` em transação própria ao final ou na falha.

## Frontend
- **Tela(s):** SCR-004 (`/processos`).
- **Componentes:** `SavedViewSelect` (grupos "Minhas visões" e "Compartilhadas", indicador "Alterações não salvas"), `SaveViewDialog` (nome, padrão, compartilhar, resumo textual dos critérios), `ManageViewsDialog` (renomear, excluir, definir padrão), `ExportCsvDialog` (total, colunas, aviso de limite), `useCsvDownload` (fetch em streaming → `Blob` → download; detecta interrupção).
- **Dados:** TanStack Query `['t', tenantId, 'saved-views', scope]`; mutações com `Idempotency-Key` (criação) e `If-Match` (alteração/exclusão); aplicar visão = escrever `filters`/`sort`/`columns` na URL.
- **Estados:** skeleton no seletor; empty state "Você ainda não salvou visões. Ajuste os filtros e clique em Salvar visão."; progresso indeterminado durante a exportação com "Cancelar" (aborta o fetch); toast de conclusão.
- **Acessibilidade:** diálogos com foco preso e retorno ao gatilho; seletor de visões como `listbox` rotulado; anúncio por `aria-live` de "Exportação concluída: 137 processos."
- **Responsivo:** em telas < 768 px o seletor de visões fica no topo da lista de cartões; a exportação permanece disponível (download no dispositivo).

## Banco de dados
- **Tabelas:** `saved_views` (escrita); leitura das tabelas de US-002; `audit_logs` (escrita).
- **Migrações:** criação de `saved_views` conforme entities.md §4.4 (colunas padrão, `owner_id` → `users`, `scope`, `name`, `filters` jsonb, `sort`, `columns` jsonb, `is_shared`, `is_default`), RLS `ENABLE` + `FORCE`, `UNIQUE (tenant_id, owner_id, scope, lower(name))`; índices propostos nas lacunas 1 e 2.
- **Índices/constraints relevantes:** os de `processes`/`process_access` usados pela lista (US-002).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-35 | GET | `/api/v1/saved-views?scope=PROCESS_LIST` | — | `200 { data: [{ id, name, scope, filters, sort, columns, isShared, isDefault, owner { id, name }, isOwner, version }] }` | 200, 403, 422 |
| PRC-36 | POST | `/api/v1/saved-views` | `{ scope, name, filters, sort?, columns, isShared?, isDefault? }` + `Idempotency-Key` | `201 { data: SavedView }` + `Location`, `ETag` | 201, 403, 409, 422 |
| PRC-37 | PATCH | `/api/v1/saved-views/{id}` | `{ name?, filters?, sort?, columns?, isShared?, isDefault? }` + `If-Match` | `200 { data: SavedView }` | 200, 403, 404, 409, 412, 422, 428 |
| PRC-38 | DELETE | `/api/v1/saved-views/{id}` | `If-Match` | `204` | 204, 403, 404, 412, 428 |
| PRC-34 | GET | `/api/v1/processes/export` | Query de PRC-01 + `columns=code,title,status,estimatedValue` | `200 text/csv; charset=utf-8` em streaming, `Content-Disposition: attachment; filename="processos-20261005-1432.csv"` | 200, 403, 422, 429, 503 |

Exemplo de `filters` salvo:
```json
{ "v": 1, "status": ["IN_PROGRESS", "RETURNED"], "overdue": true, "requestingSecretariatId": ["0192…"], "currentResponsibleId": ["none"] }
```
Trecho do CSV gerado:
```text
Código;Título;Situação;Valor estimado;Orçamento sigiloso
0012/2026;Aquisição de cimento para manutenção de vias;Em andamento;85000,00;Não
0031/2026;Contratação de limpeza hospitalar;Devolvido;Sigiloso;Sim
0050/2026;"'=HYPERLINK(""http://x.io"";""Clique"")";Em andamento;;Não
```

## Logs
- `info` `saved_view.created` / `saved_view.updated` / `saved_view.deleted` — `savedViewId`, `scope`, `isShared`, `isDefault` (sem filtros).
- `info` `process.export_completed` — `rowCount`, `maskedRowCount`, `columnsCount`, `durationMs`, `bytes`.
- `warn` `process.export_too_large` — `totalItems`.
- `warn` `export.lock_unavailable` — trava de concorrência sem Redis.
- `error` `process.export_failed` — linha alcançada, `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo das linhas exportadas, texto de `q`, valores estimados, nomes de visões compartilhadas de terceiros.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.export` | `EXPORT` | Conclusão (`SUCCESS`) ou interrupção após iniciar o envio (`FAILURE`) | `metadata`: filtros aplicados (inclusive `q`), `sort`, `columns`, `rowCount`, `maskedRowCount`, `durationMs`, `savedViewId?`; `reasonCode` em falha |
| `access.denied` | `ACCESS` | 403 em PRC-34 ou em visão compartilhada de outro dono | `reasonCode = PROCESS_EXPORT` (exportação) ou `PERMISSION_DENIED` (visão de outro dono), `entityId` da visão |

Visões salvas não geram auditoria (preferência pessoal, sem dados de negócio).

## Testes necessários
- **Unitários:** `CsvRowSerializer` (neutralização dos prefixos `= + - @ \t \r`, aspas, quebras de linha, BOM, CRLF, decimal com vírgula, datas no fuso do tenant, rótulos de enum); invariantes de `SavedView` (nome único sem diferenciar maiúsculas, limite de 20, padrão única); upcaster de `filters`.
- **Integração (Testcontainers):** exportação de 10.000 linhas com memória constante; contagem acima do limite → 422 sem auditoria de sucesso; mascaramento por linha com e sem POL-09; interseção visibilidade × escopo de `PROCESS_EXPORT`; falha induzida no meio do cursor → `FAILURE`.
- **API/contrato:** PRC-34..38 conforme api.md; cabeçalhos `Content-Type`, `Content-Disposition`, `ETag`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** visões de outro tenant → 404; compartilhada de outro dono → 403 ao alterar; exportação sem permissão → 403 + `access.denied`; suíte "tenant leak" para PRC-34..38.
- **Concorrência:** duas abas com `If-Match` (412); duas exportações simultâneas (429); duas visões marcadas como padrão em paralelo → apenas uma permanece.
- **E2E (Playwright):** salvar, aplicar, atualizar e compartilhar visão; exportar e abrir o arquivo (verificação do conteúdo); visão com filtro de unidade removida (aviso).
- **Acessibilidade/performance:** axe nos diálogos; exportação de 10.000 linhas com 20 colunas em p95 < 15 s.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Exportação em streaming com memória constante comprovada em teste
- [ ] Mascaramento POL-09 e neutralização de CSV injection verificados por teste automatizado
- [ ] Auditoria `process.export` registrada em sucesso e em falha
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-34..38 compatível com api.md
- [ ] Logs sem conteúdo exportado; métricas de duração e tamanho das exportações
- [ ] Diálogos acessíveis (axe) e utilizáveis em 360 px
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — CRUD simples de visões com invariantes (unicidade, padrão única, posse, compartilhamento) e uma exportação em streaming que reaproveita o construtor de consultas de US-002, com atenção a mascaramento, neutralização de fórmulas, formato pt-BR, trava de concorrência e auditoria de sucesso/falha.

## Prioridade
**P2** — melhora a produtividade do gestor e do controle, mas o MVP funciona sem ela (filtros e links da lista já resolvem o uso essencial); pode ir para o release seguinte.
