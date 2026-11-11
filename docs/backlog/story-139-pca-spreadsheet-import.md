---
id: US-139
title: "Importar itens do PCA por planilha"
epic: EP-023
feature: FT-068
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-068, US-083, US-138]
modules: [pca, files, catalog, organization, notification, audit, platform]
screens: [SCR-018]
endpoints: [PCA-10, PCA-11, PCA-12, PCA-13, PCA-14, ATT-02, ATT-03, ATT-04]
permissions: [PCA_MANAGE]
events: [PcaImported, PcaItemChanged]
---

# US-139 — Importar itens do PCA por planilha

## Título
Importar os itens do PCA a partir de uma planilha CSV ou XLSX, com prévia e validação por linha

## Descrição
**Como** responsável pelo planejamento (`PLANEJAMENTO`), **quero** baixar um modelo de planilha, preenchê-lo com os itens do plano (ou exportar do controle que o órgão já mantém) e importá-lo, vendo antes uma prévia com o resultado da validação linha a linha, **para** levar o plano do exercício à plataforma sem redigitar centenas de itens e corrigir os erros com precisão.

O fluxo é: **baixar o modelo** → **enviar o arquivo** pelo upload seguro (quarentena e antivírus) → **prévia** assíncrona (nada é gravado) com contagem de itens a criar, a atualizar, sem alteração e rejeitados, e a lista de linhas rejeitadas com coluna, motivo e valor → **confirmar** → **aplicação** assíncrona em uma única transação → **resultado** com relatório de rejeições em CSV. A chave de reimportação é o `code` do item: reenviar a mesma planilha atualiza (ou deixa como está), nunca duplica. É a única "integração" do PCA no MVP 2 (roadmap §4.2): arquivo local, sem sistema externo.

## Contexto
- Os órgãos pequenos já mantêm o plano em planilha (EP-023, "Contexto e problema"); a importação com validação por linha evita a redigitação e é o caminho esperado para a primeira carga do exercício. Meta do épico: ≥ 90% das linhas aceitas na primeira importação e 500 linhas com p95 ≤ 30 s.
- O mesmo padrão de prévia e confirmação da importação de cotações do MVP 1 (US-028: modelo baixável, prévia sem gravação, token de 15 minutos, aplicação atômica, `IMPORT_PREVIEW_EXPIRED`) é seguido aqui, com duas diferenças: a prévia e a aplicação são **assíncronas** (fila, padrão B de `queues.md §1.1`) e as linhas válidas entram mesmo quando outras são rejeitadas (RN-PCA-05).
- Arquivos entram pelo fluxo da US-068 (ATT-02, `PUT` pré-assinado, ATT-03, antivírus `file-scan`); o resultado da varredura precisa estar `AVAILABLE` antes de a importação começar. `Attachment.targetType = PCA` já está previsto na DEC-197 (`entities.md §5.11`, "planilha importada"), e `Pca.importAttachmentId` guarda o último arquivo aplicado.
- O leiaute da planilha (colunas, cabeçalhos aceitos, formatos) está pendente nas fontes ("a fixar no card de API", epic §Pontos em aberto); esta story o define em **Campos** e nas RN-PCA-51 a RN-PCA-53.
- Esta story não cria itens fora de `DRAFT` (RN-PCA-12): plano `AWAITING_APPROVAL`, `APPROVED` ou `SUPERSEDED` não importa; na revisão (versão > 1, `DRAFT`, US-141) a importação funciona e casa linhas com os itens copiados pelo `code`.
- A reconciliação textual (US-143) e o vínculo (US-142) só olham planos `APPROVED`; a importação em `DRAFT` não toca em `Process` nem `Dfd`.
- Sigilo: os valores do plano não são mascarados na SCR-018 (RN-PCA-07); mesmo assim nenhuma célula é logada nem vai ao Redis/Bull Board (payload do job só com ids).

## Objetivo
Permitir importar até `pca.import.maxRows` itens (padrão 1.000) por planilha, com 100% dos erros reportados por linha e coluna antes de qualquer gravação, aplicação atômica das linhas válidas, reimportação idempotente por `code` e meta de p95 ≤ 30 s por fase (prévia e aplicação) para 500 linhas.

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`) com `PCA_MANAGE` em escopo `ORGANIZATION` ou `TENANT`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, `PCA_MANAGE`); Administrador do órgão (`ADMIN_ORGAO`, mantém os catálogos usados pelo modelo). Sem acesso: quem tem `PCA_MANAGE` apenas em escopo de secretaria, `PCA_VIEW`, `CONSULTOR_EXTERNO`.

## Pré-condições
- Plano do órgão em `DRAFT` (versão 1 ou revisão), existente no tenant e dentro do escopo de quem importa.
- `PCA_MANAGE` com escopo de órgão/tenant e `ATTACHMENT_UPLOAD` (upload do arquivo).
- `csv` ou `xlsx` na allowlist `uploads.allowedExtensions` do tenant (padrão inclui as duas).
- Catálogo `PCA_CATEGORY` e secretarias ativas cadastrados (as listas do modelo vêm deles).
- Fila `pca-import` e worker ativos (se estiverem fora, a importação fica `QUEUED`; ver FA-09).

## Fluxo principal
1. Na aba **Itens** de `/pca/[pcaId]` (SCR-018), com o plano `DRAFT` e `PCA_MANAGE` em escopo de órgão, o usuário clica em **"Importar planilha"**; abre o diálogo em etapas: Modelo → Arquivo → Prévia → Resultado.
2. **Modelo:** "Baixar modelo (XLSX)" ou "(CSV)" chama PCA-10. O XLSX traz a aba **Itens** (só cabeçalho, com observação nas células de cabeçalho), a aba **Instruções** (colunas, formatos, limites) e a aba **Listas** (secretarias do órgão com sigla e nome, categorias, unidades de medida, tipos de contratação, situações, prioridades e meses ativos hoje). O CSV traz só o cabeçalho (`;`, UTF-8 com BOM).
3. **Arquivo:** o usuário escolhe o arquivo (`.xlsx` ou `.csv`, até 10 MB). O front valida extensão e tamanho e faz o upload seguro: ATT-02 (`targetType = PCA`, `targetId = pcaId`) → `PUT` pré-assinado na quarentena → ATT-03 → acompanhamento por ATT-04 até `AVAILABLE` (ou "Rejeitado", com o motivo).
4. Com o anexo `AVAILABLE`, o front chama **PCA-11** (`{ attachmentId }`, `Idempotency-Key`). A API valida plano `DRAFT`, escopo, anexo e ausência de importação ativa, cria o registro `PcaImport` (`QUEUED`) e responde **202** com `Location` para PCA-12. Depois do commit, enfileira o job `validate`.
5. O worker lê o arquivo do armazenamento, aplica os limites e valida o cabeçalho; percorre as linhas, valida cada uma (RN-PCA-54), calcula para as válidas se serão criadas, atualizadas ou ficarão sem alteração (por `code`) e grava o resultado no `PcaImport` (`rowsRead`, `rowsValid`, `rowsRejected`, resumo, lista completa de rejeições, amostra das 50 primeiras linhas válidas com antes e depois, `planVersionAtPreview`). Estado final: `PREVIEW_READY`. **Nada** é gravado em `pca_items`, no plano, no outbox nem na auditoria de itens.
6. O front consulta **PCA-12** a cada 2 s (com barra de progresso) e exibe a **Prévia**: "Linhas lidas 120 · a criar 112 · a atualizar 4 · sem alteração 0 · rejeitadas 4", avisos (colunas ignoradas), a tabela de rejeições (linha, coluna, motivo, valor informado; paginada) e a amostra de alterações. O botão **"Baixar relatório de rejeições"** usa PCA-14. A prévia vale por 15 minutos.
7. Se houver ao menos uma linha válida, o usuário clica em **"Importar {N} itens"** (e entende que as rejeitadas ficam de fora). O front chama **PCA-13** com `Idempotency-Key`. A API muda o `PcaImport` para `APPLYING`, responde **202** e enfileira o job `apply`.
8. O worker `apply`, em **uma transação** com `app.tenant_id`: trava o plano, confirma `DRAFT` e que `Pca.version` é igual a `planVersionAtPreview`, reprocessa o arquivo com as mesmas regras, cria e atualiza os itens (`importRowNumber` = linha de origem), recalcula os totais **uma vez**, atualiza `Pca.importAttachmentId`, grava auditoria (`pca.import` e `pca.item_create`/`pca.item_update` por item com `metadata.importId`), publica `PcaItemChanged` por item afetado e um `PcaImported` no outbox, marca `COMPLETED`.
9. O front mostra o **Resultado**: "Importação concluída: 112 itens criados, 4 atualizados, 4 linhas rejeitadas", com "Baixar relatório" e "Ver itens"; a lista de itens e os totais são recarregados. O autor recebe a notificação `PCA_IMPORT_FINISHED` (útil se fechou a tela).
10. O usuário corrige a planilha e a reenvia: os 4 itens corrigidos são criados e os demais ficam "sem alteração" (ou atualizados, se mudaram), sem duplicar (RN-PCA-55).

## Fluxos alternativos
- **FA-01 — Arquivo fora do formato ou grande demais:** extensão fora de `csv`/`xlsx` (inclui `.xls`, `.xlsm`, `.ods`) ou acima do limite → o front bloqueia e a API responde 415 `FILE_TYPE_NOT_ALLOWED` / 413 `FILE_TOO_LARGE` (em ATT-02 ou em PCA-11, que reconfere o anexo).
- **FA-02 — Arquivo ilegível:** XLSX corrompido, protegido por senha, com macros/vínculos externos, sem nenhuma planilha, vazio, ou CSV sem delimitador reconhecível → o job termina `FAILED` com `PCA_IMPORT_FILE_INVALID` (`meta.reason`: `UNREADABLE`, `PASSWORD_PROTECTED`, `MACROS`, `EMPTY`, `NO_SHEET`); a tela mostra o motivo e "Enviar outro arquivo".
- **FA-03 — Cabeçalho inválido:** coluna obrigatória ausente ou repetida → `FAILED` com `PCA_IMPORT_HEADER_INVALID` e `meta.missing[]`/`meta.duplicated[]`; nenhuma linha é lida. Colunas desconhecidas só geram aviso (`warnings[]`) e são ignoradas.
- **FA-04 — Linhas demais:** mais de `pca.import.maxRows` linhas de dados → `FAILED` com `PCA_IMPORT_TOO_MANY_ROWS` (`meta.maxRows`, `meta.rowsFound`); a orientação é dividir o arquivo.
- **FA-05 — Nenhuma linha válida:** o botão de confirmar fica desabilitado; a prévia orienta a corrigir o arquivo e oferece o relatório. Confirmar mesmo assim (via API) → 422 `VALIDATION_ERROR` (`NOT_ALLOWED`).
- **FA-06 — Prévia expirada ou plano alterado:** passados 15 minutos, ou com `Pca.version` diferente do da prévia (alguém mexeu em itens, no título, ou outra importação foi aplicada) → PCA-13 responde 410 `IMPORT_PREVIEW_EXPIRED`; a tela volta ao passo "Arquivo" com o arquivo já enviado e "Refazer a prévia".
- **FA-07 — Importação em andamento:** com outra importação `QUEUED`, `VALIDATING` ou `APPLYING` no plano, PCA-11 responde 409 `PCA_IMPORT_IN_PROGRESS` com `meta.importId`; a tela retoma o acompanhamento dela. Uma prévia `PREVIEW_READY` antiga é descartada (`EXPIRED`) quando uma nova começa.
- **FA-08 — Reimportação da mesma planilha:** todas as linhas válidas ficam "sem alteração"; a aplicação conclui com 0 criados e 0 atualizados e `PcaImported` mesmo assim registra a execução.
- **FA-09 — Fila ou worker fora do ar:** PCA-11/PCA-13 respondem 202 normalmente; o `PcaImport` fica `QUEUED`/`APPLYING` (o registro é o estado durável) e o reconciliador reenfileira quando a fila voltar; a tela mostra "Aguardando o processamento…".
- **FA-10 — Falha na aplicação:** erro transitório de banco ou armazenamento → o job tenta de novo (até 3 vezes, transação sempre revertida entre tentativas); esgotadas, `FAILED` com `DEPENDENCY_UNAVAILABLE`, nada gravado, e a tela oferece "Refazer a importação".
- **FA-11 — Plano deixa de ser `DRAFT` durante a aplicação:** o job encontra o plano fora de `DRAFT` (ex.: enviado para aprovação) → `EXPIRED`, nada gravado.
- **FA-12 — Escrever sobre itens existentes:** linha cujo `code` já existe atualiza só as colunas informadas; item do plano ausente da planilha não é tocado nem excluído; linha que repete código já visto no arquivo é rejeitada.

## Regras de negócio
- **RN-PCA-02** — O `code` é a chave de idempotência da importação: normalizado (sem espaços nas pontas, maiúsculas) e único no plano (DEC-197).
- **RN-PCA-03** — Cada linha obedece às regras de item (secretaria, objeto de 10 a 2.000 caracteres, categoria ativa, valor ≥ 0, mês 1 a 12; `catalogCode` exige `catalogSystem`) (DEC-197).
- **RN-PCA-04** — Importar exige `PCA_MANAGE` com escopo `ORGANIZATION` ou `TENANT` (DEC-197; permissions.md §5.1).
- **RN-PCA-05** — A importação valida cada linha de forma independente: linhas válidas entram, as inválidas vão ao relatório com a linha de origem; reimportar o mesmo `code` atualiza o item em vez de duplicar (DEC-197).
- **RN-PCA-06** — Dados isolados por `tenant_id`; toda busca de secretaria, categoria, unidade, tipo e responsável pelas células é feita só no tenant e no órgão do plano (DEC-197).
- **RN-PCA-12** — Importação só em plano `DRAFT` (POL-22); fora disso, 409 `PCA_NOT_EDITABLE`.
- **RN-PCA-50** — Arquivo: extensão `csv` ou `xlsx` presente em `uploads.allowedExtensions`; tamanho ≤ o menor entre `uploads.maxFileSizeMb` e 10 MB; passa pelo fluxo da US-068 com `targetType = PCA` e só é usado com status `AVAILABLE`, enviado por quem importa; o nome é sanitizado e só aparece no relatório e na auditoria.
- **RN-PCA-51** — Leitura: XLSX — primeira planilha visível (preferência pela aba chamada "Itens"); CSV — UTF-8 (com ou sem BOM) ou Windows-1252, delimitador `;`, `,` ou tabulação detectado no cabeçalho; cabeçalho na linha 1; linhas totalmente vazias são ignoradas; fórmulas **não são avaliadas**: vale o valor em cache gravado pelo programa (fórmula sem valor em cache = célula vazia); arquivo com macros (`xlsm`), vínculos externos ou senha é recusado. Limites: no máximo `pca.import.maxRows` linhas de dados (padrão 1.000; faixa 50 a 5.000), 30 colunas, 2.000 caracteres por célula, 50 MB descompactado e 100.000 células lidas.
- **RN-PCA-52** — Colunas (nome sem acento, caixa, espaços ou sublinhado; aliases em **Campos**): obrigatórias `codigo`, `secretaria`, `objeto`, `categoria`, `valor_previsto`, `mes_previsto`; opcionais `responsavel_email`, `situacao`, `motivo_situacao`, `quantidade`, `unidade_medida`, `sistema_catalogo`, `codigo_catalogo`, `tipo_contratacao`, `prioridade`, `observacoes`. Coluna obrigatória ausente ou repetida → `PCA_IMPORT_HEADER_INVALID`; coluna desconhecida → aviso.
- **RN-PCA-53** — Interpretação das células: `codigo` normalizado (RN-PCA-34); `valor_previsto` número ou texto pt-BR (`1.234,56`, `1234,56`, `R$ 1.234,56`; com só ponto e 1 ou 2 casas depois, é decimal; com 3 casas, milhar); `mes_previsto` número 1 a 12 ou nome pt-BR completo ou de 3 letras ("mar", "março"); `secretaria` por sigla, depois `Department.code`, depois nome (sem acento nem caixa), apenas secretarias ativas do órgão do plano — nome que casa com mais de uma → `AMBIGUOUS_REFERENCE`; `categoria`, `unidade_medida` e `tipo_contratacao` por `code` ou rótulo do catálogo; `responsavel_email` por e-mail de usuário com vínculo `ACTIVE` no tenant; `situacao` por rótulo ("Planejado", "Adiado", "Cancelado") ou código (`PLANNED`, `POSTPONED`, `CANCELED`); `prioridade` por rótulo ("Baixa", "Média", "Alta", "Urgente") ou código; `sistema_catalogo` `CATMAT`, `CATSER` ou `OTHER`.
- **RN-PCA-54** — Validação por linha (prévia e aplicação, mesma regra): todos os erros da linha são listados (até 10), cada um com `row`, `column`, `field`, `code` (de `errors[].code`: `REQUIRED`, `TOO_SHORT`, `TOO_LONG`, `INVALID_FORMAT`, `INVALID_ENUM`, `OUT_OF_RANGE`, `INVALID_DECIMAL`, `REFERENCE_NOT_FOUND`, `REFERENCE_INACTIVE`, `AMBIGUOUS_REFERENCE`, `DUPLICATE_IN_LIST`, `CONDITIONAL_REQUIRED`, `NOT_ALLOWED`), mensagem em pt-BR e o valor informado (até 100 caracteres). Linha com erro nunca entra, mesmo que as demais entrem.
- **RN-PCA-55** — Idempotência por `code`: código ainda inexistente no plano (entre os não excluídos) → criação; já existente → atualização (ou "sem alteração" quando nenhum campo informado muda); código repetido no arquivo → só a primeira ocorrência é avaliada e as seguintes são rejeitadas com `DUPLICATE_IN_LIST` (mensagem cita a primeira linha). Reimportar o mesmo arquivo não duplica nem altera nada.
- **RN-PCA-56** — Atualização: só as colunas presentes no cabeçalho são aplicadas; célula **opcional** vazia não altera nem apaga o valor atual (para limpar, edite o item na tela); as seis colunas obrigatórias sempre vêm preenchidas na linha; `code` e `pcaId` não mudam; item do plano ausente da planilha permanece como está; `situacao` segue a RN-PCA-37 (transição inválida → `NOT_ALLOWED`); `quantidade`, `unidade_medida` etc. seguem a RN-PCA-36.
- **RN-PCA-57** — Prévia sem efeito: gera só o `PcaImport` (resultado, rejeições, amostra); não escreve em `pca_items`, `pcas`, auditoria de itens, outbox ou notificações; vale 15 minutos (`previewExpiresAt`) e expira também se `Pca.version` mudar.
- **RN-PCA-58** — Confirmação: só o autor da importação confirma (PCA-13), com `PcaImport` em `PREVIEW_READY`, dentro da validade, `rowsValid > 0` e `Pca.version` igual a `planVersionAtPreview`; de outro modo, `IMPORT_PREVIEW_EXPIRED` (410), `INVALID_STATE` (409) ou `NOT_ALLOWED` (422).
- **RN-PCA-59** — Uma importação ativa por plano (`QUEUED`, `VALIDATING` ou `APPLYING`): outra recebe `PCA_IMPORT_IN_PROGRESS` (409). Iniciar nova importação marca como `EXPIRED` qualquer prévia `PREVIEW_READY` anterior do plano.
- **RN-PCA-60** — Execução assíncrona (padrão B): o `PcaImport` é o registro durável; os jobs `validate` e `apply` da fila `pca-import` são enfileirados **depois** do commit, com `jobId = {importId}:validate` e `{importId}:apply`, 3 tentativas com *backoff* de 5 s, *timeout* de 120 s, payload só com ids (`importId`); o reconciliador reenfileira `QUEUED` e `APPLYING` sem job ativo há mais de 5 minutos e `VALIDATING` há mais de 10. Os handlers são idempotentes por transição condicional de estado.
- **RN-PCA-61** — Aplicação atômica: tudo ou nada entre as linhas válidas, em uma transação, sob a trava da linha do plano; erro transitório desfaz e o job tenta de novo; sem escrita parcial. Os totais do plano são recalculados uma vez ao final (`Pca.version` +1).
- **RN-PCA-62** — Efeitos da aplicação: `PcaItem.importRowNumber` = linha de origem; `Pca.importAttachmentId` = anexo aplicado; `PcaItemChanged` (`CREATED`/`UPDATED`) por item afetado, em lote no outbox; um `PcaImported` com `rowsRead`, `itemsCreated`, `itemsUpdated`, `rowsRejected` (as linhas "sem alteração" = `rowsRead − itemsCreated − itemsUpdated − rowsRejected`); auditoria `pca.import` e por item (antes e depois dos campos importados); notificação `PCA_IMPORT_FINISHED` ao autor.
- **RN-PCA-63** — Relatório de rejeições: PCA-14 gera CSV sob demanda a partir do `PcaImport` (UTF-8 com BOM, delimitador `;`, colunas `linha;coluna;codigo_erro;mensagem;valor_informado`); células que começam com `=`, `+`, `-` ou `@` recebem apóstrofo na frente (injeção de fórmula); disponível enquanto o `PcaImport` existir e a quem tem `PCA_MANAGE` de órgão.
- **RN-PCA-64** — Segurança do arquivo: só entra depois do antivírus (`AVAILABLE`); o parser roda no worker, com limites de memória e tempo e sem executar macros ou fórmulas; conteúdo de células e e-mails não vão a logs, métricas nem à fila.
- **RN-PCA-65** — O modelo (PCA-10) reflete os catálogos e secretarias ativos do órgão do plano **no momento do download**, não contém itens do plano e é gerado sem escrita nem auditoria de dados do PCA.

## Campos
**Diálogo de importação**

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Arquivo | `attachmentId` (após ATT-02/03) | upload `.xlsx`/`.csv` | Sim | RN-PCA-50 | — |
| Formato do modelo | `format` (query de PCA-10) | `XLSX` \| `CSV` | Não | — | `XLSX` |
| *(saída)* Situação da importação | `PcaImport.status` | `PcaImportStatus` | — | Ver lacuna 1 | `QUEUED` |
| *(saída)* Linhas lidas / válidas / rejeitadas | `rowsRead`, `rowsValid`, `rowsRejected` | inteiros | — | RN-PCA-57 | — |
| *(saída)* A criar / atualizar / sem alteração | `summary { toCreate, toUpdate, unchanged }` | inteiros | — | Prévia | — |
| *(saída)* Validade da prévia | `previewExpiresAt` | data/hora | — | 15 minutos | — |

**Colunas da planilha (aba "Itens" / CSV)**

| Coluna | Campo técnico | Tipo | Obrigatória | Regras | Aliases aceitos |
|---|---|---|---|---|---|
| `codigo` | `code` | texto (60) | Sim | RN-PCA-34 | "Código", "Código do item", "Item" |
| `secretaria` | `departmentId` | referência | Sim | Sigla, código ou nome (RN-PCA-53) | "Secretaria demandante", "Unidade" |
| `objeto` | `object` | texto | Sim | 10–2.000 | "Descrição", "Objeto da contratação" |
| `categoria` | `categoryId` | referência | Sim | `PCA_CATEGORY` ativo | "Categoria" |
| `valor_previsto` | `plannedValue` | decimal | Sim | ≥ 0, 2 casas | "Valor previsto (R$)", "Valor estimado" |
| `mes_previsto` | `plannedMonth` | inteiro/nome | Sim | 1–12 ou nome | "Mês", "Mês previsto" |
| `responsavel_email` | `responsibleId` | e-mail | Não | Vínculo `ACTIVE` | "Responsável", "E-mail do responsável" |
| `situacao` | `status` | enum | Não | `PLANNED`, `POSTPONED`, `CANCELED` | "Situação" |
| `motivo_situacao` | `statusReason` | texto | Condicional | Obrigatório com Adiado/Cancelado | "Motivo" |
| `quantidade` | `quantity` | decimal | Não | > 0, 4 casas | "Qtd" |
| `unidade_medida` | `unitOfMeasureId` | referência | Não | `UNIT_OF_MEASURE` ativo | "Unidade de medida" |
| `sistema_catalogo` | `catalogSystem` | enum | Condicional | `CATMAT`, `CATSER`, `OTHER` | "Catálogo" |
| `codigo_catalogo` | `catalogCode` | texto (30) | Não | Exige `sistema_catalogo` | "Código CATMAT/CATSER" |
| `tipo_contratacao` | `contractingTypeId` | referência | Não | `CONTRACTING_TYPE` ativo | "Tipo de contratação" |
| `prioridade` | `priority` | enum | Não | `LOW`…`URGENT` ou rótulo | "Prioridade" |
| `observacoes` | `notes` | texto | Não | até 5.000 | "Observações" |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Extensão fora de `csv`/`xlsx` ou fora da allowlist do tenant | Front + API | "Envie um arquivo .xlsx ou .csv." | `FILE_TYPE_NOT_ALLOWED` |
| V-02 | Arquivo acima do limite (10 MB ou `uploads.maxFileSizeMb`) | Front + API | "O arquivo excede o tamanho máximo de {n} MB." | `FILE_TOO_LARGE` |
| V-03 | Anexo inexistente, de outro tenant, de outro plano ou de outro usuário | API | "Arquivo não encontrado." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-04 | Anexo ainda não `AVAILABLE` (em verificação ou rejeitado) | API | "O arquivo ainda está sendo verificado ou foi rejeitado." | `ATTACHMENT_NOT_AVAILABLE` |
| V-05 | Plano fora de `DRAFT` | API | "Este plano não aceita importação. Para alterar o plano aprovado, crie uma revisão." | `PCA_NOT_EDITABLE` |
| V-06 | Já existe importação ativa no plano | API | "Já há uma importação em andamento neste plano." | `PCA_IMPORT_IN_PROGRESS` |
| V-07 | Arquivo ilegível, vazio, com senha, macros ou sem planilha | Worker | "Não foi possível ler o arquivo: {motivo}. Verifique e envie de novo." | `PCA_IMPORT_FILE_INVALID` |
| V-08 | Coluna obrigatória ausente ou repetida | Worker | "Faltam colunas obrigatórias: {lista}." | `PCA_IMPORT_HEADER_INVALID` |
| V-09 | Mais linhas que `pca.import.maxRows` | Worker | "O arquivo tem {n} linhas; o máximo é {max}. Divida a planilha." | `PCA_IMPORT_TOO_MANY_ROWS` |
| V-10 | Célula obrigatória vazia | Worker (por linha) | "Linha {n}, coluna '{coluna}': preenchimento obrigatório." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-11 | `codigo` com formato inválido ou acima de 60 caracteres | Worker (por linha) | "Linha {n}: código inválido." | `VALIDATION_ERROR` (`INVALID_FORMAT`/`TOO_LONG`) |
| V-12 | `codigo` repetido no arquivo | Worker (por linha) | "Linha {n}: o código {código} já apareceu na linha {m}." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-13 | `objeto` fora de 10–2.000 caracteres | Worker (por linha) | "Linha {n}: descreva o objeto com 10 a 2.000 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-14 | Secretaria, categoria, unidade, tipo ou responsável não encontrado no órgão/tenant | Worker (por linha) | "Linha {n}, coluna '{coluna}': '{valor}' não encontrado." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-15 | Referência inativa | Worker (por linha) | "Linha {n}, coluna '{coluna}': '{valor}' está inativo." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-16 | Nome de secretaria casa com mais de uma unidade | Worker (por linha) | "Linha {n}: '{valor}' corresponde a mais de uma unidade; use a sigla." | `VALIDATION_ERROR` (`AMBIGUOUS_REFERENCE`) |
| V-17 | Valor previsto inválido, negativo ou fora de faixa | Worker (por linha) | "Linha {n}: valor previsto inválido." | `VALIDATION_ERROR` (`INVALID_DECIMAL`/`OUT_OF_RANGE`) |
| V-18 | Mês fora de 1–12 ou nome desconhecido | Worker (por linha) | "Linha {n}: mês previsto inválido." | `VALIDATION_ERROR` (`OUT_OF_RANGE`/`INVALID_FORMAT`) |
| V-19 | Situação fora de Planejado/Adiado/Cancelado ou transição inválida | Worker (por linha) | "Linha {n}: situação não permitida." | `VALIDATION_ERROR` (`INVALID_ENUM`/`NOT_ALLOWED`) |
| V-20 | Adiado/Cancelado sem motivo; `codigo_catalogo` sem `sistema_catalogo` | Worker (por linha) | "Linha {n}: informe {campo}." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-21 | Quantidade ≤ 0 ou com mais de 4 casas; prioridade/sistema de catálogo inválido | Worker (por linha) | "Linha {n}, coluna '{coluna}': valor inválido." | `VALIDATION_ERROR` (`INVALID_DECIMAL`/`INVALID_ENUM`) |
| V-22 | Prévia expirada ou plano alterado desde a prévia | API | "A prévia expirou ou o plano mudou. Refaça a prévia." | `IMPORT_PREVIEW_EXPIRED` |
| V-23 | Confirmar importação fora de `PREVIEW_READY`, ou já confirmada | API | "Esta importação não pode ser confirmada." | `INVALID_STATE` |
| V-24 | Confirmar sem nenhuma linha válida | API | "Não há linhas válidas para importar." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-25 | Confirmar importação de outra pessoa | API | "Só quem iniciou a importação pode confirmá-la." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `PCA_MANAGE` com escopo `ORGANIZATION` ou `TENANT` cobrindo o plano para PCA-10 a PCA-14; `ATTACHMENT_UPLOAD` para ATT-02/ATT-03. PCA-12 e PCA-14 aceitam qualquer pessoa com `PCA_MANAGE` de órgão; PCA-13 só o autor da importação.
- **Políticas:** POL-22 (elaboração só em `DRAFT`, escopo de órgão); autorização do anexo `PCA` pelo resolvedor do módulo `pca` (ver lacuna 6); POL-09 não se aplica (valores do plano não são mascarados na SCR-018).
- **MFA:** não exigido (`PCA_MANAGE` risco M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Importar planilha" fica oculto sem `PCA_MANAGE` de órgão; a API responde 403 `PERMISSION_DENIED` (e `access.denied`); plano, importação ou anexo de outro tenant ou invisível → 404 `NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PcaImported` | `pca.imported` | Commit da aplicação (`COMPLETED`) | `pcaId`, `attachmentId`, `rowsRead`, `itemsCreated`, `itemsUpdated`, `rowsRejected`; consumidor N (`PCA_IMPORT_FINISHED`) |
| `PcaItemChanged` | `pca.item_changed` | Mesma transação, um por item criado (`CREATED`) ou alterado (`UPDATED`/`STATUS_CHANGED`) | `changedFields[]` sem valores; consumidor R |

PCA-10, PCA-11, PCA-12, a prévia e as falhas (`FAILED`, `EXPIRED`) **não** geram evento de domínio (ver lacuna 7).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PCA_IMPORT_FINISHED` | Quem importou (exceção à regra do ator: trabalho assíncrono do próprio usuário) | in-app; e-mail desligado por padrão | `PcaImported`: "Importação do PCA {ano} concluída: {criados} criados, {atualizados} atualizados, {rejeitadas} rejeitadas" |

## Critérios de aceite em Gherkin
```gherkin
Feature: Importar itens do PCA por planilha

  Background:
    Given que o tenant "Prefeitura A" está ativo e o plano "PCA 2027" está em "DRAFT" com 0 itens
    And as secretarias "Saúde" (sigla "SMS") e "Educação" (sigla "SME") e as categorias "MATERIAL", "SERVICO" e "OBRA" estão ativas
    And "Helena" tem "PCA_MANAGE" com escopo "ORGANIZATION" e "ATTACHMENT_UPLOAD"
    And "pca.import.maxRows" é 1000

  Scenario: [Sucesso] Prévia, confirmação e relatório de uma planilha com linhas rejeitadas
    Given que "Helena" enviou o arquivo "pca-2027.xlsx" com 120 linhas, 4 delas inválidas, e o anexo está "AVAILABLE"
    When "Helena" iniciar a importação do anexo
    Then a API deve responder 202 com a importação "QUEUED"
    And a importação deve chegar a "PREVIEW_READY" com "rowsRead" 120, "rowsValid" 116, "rowsRejected" 4 e "toCreate" 116
    And nenhum item deve existir no plano, nenhum evento "PcaItemChanged" deve ser gerado e a auditoria de itens deve estar vazia
    And a prévia deve listar as 4 rejeições com linha, coluna, motivo e valor informado
    When "Helena" confirmar a importação
    Then a importação deve chegar a "COMPLETED"
    And o plano deve ter 116 itens, "totalPlannedValue" igual à soma dos valores e "importAttachmentId" do arquivo
    And cada item deve ter "importRowNumber" igual à linha de origem
    And deve gerar registro de auditoria "pca.import" e "pca.item_create" por item com o mesmo "importId"
    And deve gerar o evento "PcaImported" com "rowsRead" 120, "itemsCreated" 116, "itemsUpdated" 0 e "rowsRejected" 4
    And "Helena" deve receber a notificação "PCA_IMPORT_FINISHED"
    And o relatório "GET .../report" deve trazer 4 linhas em CSV com delimitador ";"

  Scenario: [Sucesso] Reimportar a planilha corrigida atualiza sem duplicar
    Given que o plano tem os 116 itens da primeira importação
    When "Helena" importar a planilha corrigida com as 4 linhas antes inválidas, 2 linhas com valor alterado e 114 idênticas
    Then a prévia deve mostrar "toCreate" 4, "toUpdate" 2 e "unchanged" 114
    And após confirmar, o plano deve ter 120 itens e nenhum código duplicado
    And o evento "PcaImported" deve trazer "itemsCreated" 4 e "itemsUpdated" 2
    And a auditoria dos 2 itens atualizados deve registrar o valor antes e depois

  Scenario: [Sucesso] CSV em Windows-1252 com valores no formato brasileiro
    Given que o arquivo "pca.csv" usa ";" , codificação Windows-1252, "R$ 1.234,56" e mês "mar"
    When "Helena" importar e confirmar
    Then o item deve ter "plannedValue" "1234.56" e "plannedMonth" 3
    And acentos do objeto devem estar preservados

  Scenario: [Validação] Cabeçalho, limite de linhas e erros por linha
    Given que a planilha não tem a coluna "valor_previsto"
    When a prévia for processada
    Then a importação deve ficar "FAILED" com código "PCA_IMPORT_HEADER_INVALID" e "meta.missing" ["valor_previsto"]
    Given que a planilha tem 1.001 linhas de dados
    Then a importação deve ficar "FAILED" com código "PCA_IMPORT_TOO_MANY_ROWS" e "meta.maxRows" 1000
    Given que a linha 7 tem objeto "curto", valor "abc", mês "13", secretaria inexistente e categoria inativa
    Then a prévia deve listar para a linha 7 os erros "TOO_SHORT", "INVALID_DECIMAL", "OUT_OF_RANGE", "REFERENCE_NOT_FOUND" e "REFERENCE_INACTIVE"
    And a linha 7 não deve ser importada e as demais linhas válidas devem continuar na prévia

  Scenario: [Validação] Plano fora de rascunho e confirmação sem linhas válidas
    Given que o plano "PCA 2027" está "AWAITING_APPROVAL"
    When "Helena" iniciar uma importação
    Then a API deve responder 409 com código "PCA_NOT_EDITABLE"
    Given que a prévia tem 0 linhas válidas
    When "Helena" confirmar a importação
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"

  Scenario: [Permissão] Sem PCA_MANAGE de órgão e confirmação por outra pessoa
    Given que "Rui" tem "PCA_MANAGE" apenas com escopo "DEPARTMENT" na "Saúde"
    When "Rui" chamar "GET /pcas/{id}/import-template" ou iniciar uma importação
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Helena" tem uma prévia "PREVIEW_READY" e "Paulo" também tem "PCA_MANAGE" de órgão
    When "Paulo" confirmar a importação de "Helena"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que "Caio" é "CONSULTOR_EXTERNO"
    When "Caio" chamar qualquer rota de importação
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Anexo, importação e referências de outro tenant
    Given que existem um anexo e uma importação no tenant "Prefeitura B"
    When "Helena", no tenant "Prefeitura A", iniciar uma importação com o "attachmentId" do tenant "Prefeitura B"
    Then a API deve responder 422 com "REFERENCE_NOT_FOUND" no campo "attachmentId"
    When "Helena" consultar "GET /pcas/{id}/imports/{importId}" com a importação do tenant "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    Given que o tenant "Prefeitura B" tem a secretaria "Obras Especiais" e a categoria "CONCESSAO"
    When a planilha da "Prefeitura A" citar "Obras Especiais" e "CONCESSAO"
    Then a prévia deve rejeitar a linha com "REFERENCE_NOT_FOUND" sem revelar que existem em outro tenant

  Scenario: [Duplicidade] Código repetido no arquivo, reimportação e reenvio idempotente
    Given que as linhas 3 e 9 da planilha têm o código "0010"
    When a prévia for processada
    Then a linha 3 deve ser aceita e a linha 9 rejeitada com "DUPLICATE_IN_LIST" citando a linha 3
    Given que "Helena" já importou a planilha completa e confirmou
    When "Helena" importar exatamente o mesmo arquivo de novo e confirmar
    Then a importação deve concluir com "itemsCreated" 0 e "itemsUpdated" 0 e o plano deve manter o mesmo número de itens
    Given que "Helena" iniciou a importação com a chave "k-139" e recebeu 202
    When a mesma requisição for reenviada com a chave "k-139"
    Then a API deve responder 202 com o cabeçalho "Idempotent-Replayed" verdadeiro e o mesmo "importId"
    And deve existir uma única importação e um único job "validate"

  Scenario: [Concorrência] Plano alterado entre a prévia e a confirmação, e confirmações simultâneas
    Given que a prévia "I1" está "PREVIEW_READY" com "planVersionAtPreview" 7
    When "Marina" criar um item manualmente e o plano passar à versão 8
    And "Helena" confirmar "I1"
    Then a API deve responder 410 com código "IMPORT_PREVIEW_EXPIRED"
    And nenhum item da planilha deve ser criado
    Given que "Helena" tem uma prévia válida "I2"
    When "Helena" confirmar "I2" duas vezes ao mesmo tempo com chaves diferentes
    Then uma requisição deve responder 202 e a outra 409 com código "INVALID_STATE"
    And os itens devem ser criados uma única vez
    Given que a importação "I3" está "APPLYING"
    When "Helena" iniciar outra importação no mesmo plano
    Then a API deve responder 409 com código "PCA_IMPORT_IN_PROGRESS" e "meta.importId" "I3"

  Scenario: [Falha de banco] Banco falha durante a aplicação
    Given que a prévia "I4" está "PREVIEW_READY" com 116 linhas válidas
    And o banco de dados falha ao inserir a linha 60 na transação de aplicação
    When "Helena" confirmar "I4" e o job tentar 3 vezes
    Then a importação deve ficar "FAILED" com código "DEPENDENCY_UNAVAILABLE"
    And o plano não deve ter itens novos, totais alterados, auditoria "pca.import" nem evento "PcaImported"
    And a tela deve oferecer "Refazer a importação"
    Given que o banco falha apenas na primeira tentativa
    Then a segunda tentativa deve concluir a importação com os 116 itens criados uma única vez

  Scenario: [Falha de integração] Arquivo corrompido, armazenamento e fila indisponíveis
    Given que o anexo é um XLSX corrompido
    When a prévia for processada
    Then a importação deve ficar "FAILED" com código "PCA_IMPORT_FILE_INVALID" e "meta.reason" "UNREADABLE"
    And nenhum item deve ser criado
    Given que o armazenamento de arquivos está indisponível durante a leitura do job "validate"
    When o worker tentar 3 vezes
    Then a importação deve ficar "FAILED" com código "DEPENDENCY_UNAVAILABLE" e um log "error" "pca.import_failed"
    Given que o Redis das filas está indisponível
    When "Helena" iniciar a importação
    Then a API deve responder 202 com a importação "QUEUED" e a tela deve exibir "Aguardando o processamento"
    And quando a fila voltar, o reconciliador deve enfileirar o job e a prévia deve ser gerada sem duplicidade
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Arquivo não `.xlsx`/`.csv` | 415 | `FILE_TYPE_NOT_ALLOWED` | "Envie um arquivo .xlsx ou .csv." | Mantém o seletor de arquivo |
| Arquivo acima do limite | 413 | `FILE_TOO_LARGE` | "O arquivo excede o tamanho máximo de {n} MB." | Mantém o seletor |
| Anexo inexistente ou de outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Arquivo não encontrado." | Volta ao passo Arquivo |
| Anexo não disponível | 409 | `ATTACHMENT_NOT_AVAILABLE` | "O arquivo ainda está sendo verificado ou foi rejeitado." | Aguarda a verificação ou pede novo arquivo |
| Plano fora de `DRAFT` | 409 | `PCA_NOT_EDITABLE` | "Este plano não aceita importação." | Oculta a ação e recarrega |
| Importação ativa no plano | 409 | `PCA_IMPORT_IN_PROGRESS` | "Já há uma importação em andamento neste plano." | Retoma o acompanhamento dela |
| Arquivo ilegível (estado `FAILED`) | 200 (corpo da importação) | `PCA_IMPORT_FILE_INVALID` | "Não foi possível ler o arquivo: {motivo}." | Mostra o motivo e "Enviar outro arquivo" |
| Cabeçalho inválido (estado `FAILED`) | 200 (corpo da importação) | `PCA_IMPORT_HEADER_INVALID` | "Faltam colunas obrigatórias: {lista}." | Lista as colunas e oferece o modelo |
| Linhas demais (estado `FAILED`) | 200 (corpo da importação) | `PCA_IMPORT_TOO_MANY_ROWS` | "O arquivo tem {n} linhas; o máximo é {max}." | Orienta a dividir o arquivo |
| Prévia expirada ou plano alterado | 410 | `IMPORT_PREVIEW_EXPIRED` | "A prévia expirou ou o plano mudou. Refaça a prévia." | Volta ao passo Arquivo |
| Importação não confirmável | 409 | `INVALID_STATE` | "Esta importação não pode ser confirmada." | Recarrega o estado |
| Confirmar sem linhas válidas | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Não há linhas válidas para importar." | Botão desabilitado |
| Sem permissão ou confirmação de outra pessoa | 403 | `PERMISSION_DENIED` | "Você não tem permissão para importar neste plano." | Oculta a ação |
| Plano, importação ou anexo de outro tenant | 404 | `NOT_FOUND` | "Importação não encontrada." | Volta ao plano |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Gera nova chave |
| Banco ou armazenamento indisponível | 503 / `FAILED` | `DEPENDENCY_UNAVAILABLE` | "Não foi possível processar o arquivo agora. Tente novamente em instantes." | Botão "Refazer a importação" |

## Dependências
- **Stories:** US-068 (upload seguro, quarentena e antivírus), US-083 (fila, retries, *dead letter* e reconciliador), US-138 (plano e itens: regras, escopo, totais e trava). Indiretas: US-028 (padrão de prévia e confirmação), US-031 (parser/gerador de planilhas compartilhado), US-104 (catálogos), US-102 (secretarias). Habilita US-141 (revisão por planilha) e a carga inicial que alimenta US-142/US-143.
- **Decisões/ADRs:** DEC-197, DEC-003 (decimais), DEC-105 (idempotência), DEC-163/DEC-164 (política e contrato de jobs), DEC-030 (sigilo, sem mascaramento na SCR-018).
- **Configurações:** `uploads.maxFileSizeMb`, `uploads.allowedExtensions`; `pca.import.maxRows` (nova, ver lacuna 3).
- **Lacunas nas fontes canônicas:**
  1. **Entidade da importação:** o estado, o progresso, as rejeições e o resultado da importação precisam de registro durável (feature FT-068 cita `GET /pca/{id}/imports/{importId}`, e `queues.md §1.1` exige a linha de estado), mas `entities.md` só tem `Pca.importAttachmentId` e `PcaItem.importRowNumber`. Proposta: entidade `PcaImport` (`pca_imports`, módulo `pca`, migração junto de M2-11) e enum `PcaImportStatus` (`QUEUED`, `VALIDATING`, `PREVIEW_READY`, `APPLYING`, `COMPLETED`, `FAILED`, `EXPIRED`). Campos: `pcaId`, `attachmentId`, `requestedById`, `status`, `fileFormat` (`XLSX`/`CSV`), `headerColumns` (jsonb), `warnings` (jsonb), `rowsRead`, `rowsValid`, `rowsRejected`, `toCreate`, `toUpdate`, `unchanged`, `itemsCreated`, `itemsUpdated`, `rowsProcessed`, `rejections` (jsonb, até `pca.import.maxRows`), `sample` (jsonb, 50 linhas), `planVersionAtPreview`, `previewReadyAt`, `previewExpiresAt`, `confirmedAt`, `startedAt`, `finishedAt`, `errorCode`, `errorReason`, `version`. Unique parcial `(tenant_id, pca_id) WHERE status IN ('QUEUED','VALIDATING','APPLYING')`.
  2. **Fila `pca-import`** (jobs `validate` e `apply`, padrão B) não consta em `queues.md §4`; o reconciliador (`maintenance-reconcile`, proposta de `queues.md §4.8`) precisa cobrir `PcaImport`. A métrica "fila de importação" do épico é `cf_pca_import_duration_seconds`.
  3. **Chave de configuração `pca.import.maxRows`** (int, padrão 1.000, faixa 50 a 5.000) inexistente em `entities.md §8`; o limite de 10 MB é constante técnica (menor entre ele e `uploads.maxFileSizeMb`).
  4. **Rotas e IDs:** a feature lista `GET /pca/import-template`, `POST /pca/{id}/import` e `GET /pca/{id}/imports/{importId}`; adotados `PCA-10` `GET /pcas/{pcaId}/import-template`, `PCA-11` `POST /pcas/{pcaId}/imports`, `PCA-12` `GET /pcas/{pcaId}/imports/{importId}`, `PCA-13` `POST /pcas/{pcaId}/imports/{importId}/confirm` e `PCA-14` `GET /pcas/{pcaId}/imports/{importId}/report` (a consolidar em `api.md`). O modelo leva o `pcaId` para listar as secretarias do órgão certo.
  5. **Códigos de erro novos:** `PCA_IMPORT_FILE_INVALID`, `PCA_IMPORT_HEADER_INVALID`, `PCA_IMPORT_TOO_MANY_ROWS`, `PCA_IMPORT_IN_PROGRESS`; `errors[].code` novo `AMBIGUOUS_REFERENCE` (em `api.md §2.1.1`). Reusados: `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE`, `ATTACHMENT_NOT_AVAILABLE`, `IMPORT_PREVIEW_EXPIRED`, `INVALID_STATE`, `PCA_NOT_EDITABLE`.
  6. **Anexo `PCA`:** o MVP 1 autoriza ATT-02..ATT-05 por `PROCESS_VIEW` e exige `attachments.process_id` fora de `TENANT_ASSET`/`TEMPLATE_VERSION` (`entities.md` do MVP 1, check de `Attachment`); para `targetType = PCA` o `AttachmentTargetResolver` do módulo `pca` deve autorizar por `PCA_MANAGE`/`PCA_VIEW` e o check precisa admitir `PCA` sem `process_id`. Propõe-se ainda o alvo editável de ATT-02 = plano `DRAFT` com `PCA_MANAGE` de órgão.
  7. **Falha de importação não notifica:** `PCA_IMPORT_FINISHED` nasce de `PcaImported`, que só existe na conclusão; o autor vê a falha na tela. **Dúvida de produto:** notificar também `FAILED`/`EXPIRED`? (exigiria evento novo).
  8. **Semântica de "atualizado":** a feature (critério de aceite) fala em "116 já existentes atualizados"; aqui `itemsUpdated` conta só linhas que mudam algum campo, e as idênticas são "sem alteração". **Dúvida de produto.**
  9. **Fórmulas e aliases de colunas:** leitura por valor em cache e a lista de aliases são decisões desta story (sem fonte); validar com o piloto usando planilhas reais dos órgãos.

## Impacto técnico
- **Parser compartilhado:** reaproveita a camada de leitura/geração de planilhas do mapa comparativo (US-031, PRS-22) e acrescenta o CSV; o parser roda no worker, em fluxo contínuo (*streaming*), com teto de memória, de células lidas (100.000) e de tamanho descompactado (50 MB) para evitar *zip bomb* e planilhas gigantes.
- **Fila e estado:** o padrão B garante que nenhum pedido se perde com o Redis fora; o reconciliador reenfileira por estado e o `jobId` deduplica. O payload do job leva só `importId` e `meta`; nada da planilha passa pela fila nem aparece no Bull Board.
- **Transação de aplicação:** até `maxRows` itens em uma transação sob a trava do plano (≈ 1.000 inserts em lote, auditoria e outbox em lote); o plano fica bloqueado para escrita de itens por alguns segundos, o que é aceitável na elaboração. Meta: prévia e aplicação com p95 ≤ 30 s para 500 linhas, medidas na suíte de performance no endurecimento.
- **Resolução de referências:** secretarias, catálogos e e-mails de responsáveis são carregados uma vez em mapas (por tenant e órgão) antes de ler as linhas, evitando consulta por linha; o resultado é determinístico para o mesmo arquivo e o mesmo estado, o que permite reprocessar o arquivo na aplicação.
- **Armazenamento de resultados:** rejeições e amostra ficam no próprio `PcaImport` (jsonb, ≤ ~500 KB com 1.000 linhas); sem purga no MVP 2 (segue a retenção do tenant).
- **Segurança:** antivírus antes de ler; sem macros nem avaliação de fórmulas; relatório CSV neutraliza injeção de fórmula; mensagens de erro não revelam recursos de outro tenant; nenhum dado de célula em logs.
- **Compatibilidade:** `Attachment.targetType = PCA` e o resolvedor entram junto com a US-138/US-139; planos existentes não são afetados; a importação não toca em `Process` nem `Dfd`.

## Backend
- **Módulo(s):** `pca` (dono de `PcaImport`, parser de domínio, handlers e reconciliação do estado); `files` (anexo, quarentena, `file-scan`; `AttachmentTargetResolver` implementado por `pca`), `catalog`, `organization`, `identity`/`access` (e-mail → usuário), `notification`, `audit`, `platform` (fila, outbox, idempotência).
- **Casos de uso:** `GetPcaImportTemplateQuery` (PCA-10), `StartPcaImportCommand` (PCA-11), `GetPcaImportQuery` (PCA-12), `ConfirmPcaImportCommand` (PCA-13), `GetPcaImportReportQuery` (PCA-14), `ValidatePcaImportHandler` e `ApplyPcaImportHandler` (jobs), `PcaImportReconciler`.
- **Domínio:** `PcaImport` (máquina de estados e validade da prévia), `PcaSpreadsheetReader` (porta; adaptadores XLSX e CSV), `PcaImportHeaderMapper`, `PcaImportRowParser` (normalização — RN-PCA-53), `PcaImportRowValidator` (reusa `PcaItem` e `PcaCode` da US-138), `PcaImportPlanner` (criar/atualizar/sem alteração por `code`), `PcaImportReport` (CSV neutralizado).
- **Integrações internas:** `FilesFacade` (leitura do objeto `AVAILABLE`), `OrganizationFacade`, `CatalogFacade`, `IdentityFacade`, `JobProducer.enqueue('pca-import', …)` (após o commit), `OutboxWriter`, `AuditService`, `NotificationDispatcher` (consome `PcaImported`).
- **Transação:** PCA-11 e PCA-13 gravam apenas o `PcaImport` (estado) e enfileiram depois do commit. O job `validate` grava o resultado da prévia em uma transação curta. O job `apply` roda em uma transação: trava do plano → conferência de `DRAFT` e `version` → reprocesso → itens → totais → `Pca.importAttachmentId` → auditoria em lote → outbox em lote → `COMPLETED`.

## Frontend
- **Tela(s):** SCR-018 (`/pca/[pcaId]`, aba Itens), diálogo "Importar planilha" em quatro etapas.
- **Componentes:** `PcaImportDialog` (*stepper* Modelo → Arquivo → Prévia → Resultado), `TemplateDownloadButtons`, `PcaFileUploader` (reaproveita o upload seguro da US-068, com progresso e estado da verificação), `PcaImportProgress`, `PcaImportSummary` (cartões: lidas, a criar, a atualizar, sem alteração, rejeitadas), `PcaImportRejectionsTable` (linha, coluna, motivo, valor; paginada), `PcaImportSampleTable` (antes e depois dos campos), `DownloadReportButton`.
- **Estados:** loading (barra de progresso com linhas processadas; *polling* de 2 s, recuando a 5 s), vazio (nenhuma rejeição: "Todas as linhas são válidas"), erro por tipo (arquivo ilegível, cabeçalho, linhas demais, prévia expirada) com ação de recuperação, sucesso (resumo e "Ver itens"), aguardando fila.
- **Acessibilidade e responsividade:** progresso como `role="progressbar"` com `aria-valuenow`; resumo da prévia anunciado por `aria-live="polite"`; tabela de rejeições navegável por teclado e com cabeçalhos associados; estado das etapas por texto e ícone; diálogo com foco preso e tela cheia abaixo de 768 px; botão de confirmar descreve o efeito ("Importar 116 itens; 4 linhas ficam de fora").

## Banco de dados
- **Tabelas:** `pca_imports` (nova, ver lacuna 1), `pca_items` (`import_row_number`), `pcas` (`import_attachment_id`, `version`, totais), `attachments` (`target_type = PCA`), `outbox_events`, `audit_logs`.
- **Migrações:** `pca_imports` junto da M2-11 (`expand`, reversível); check de `attachments` admite `PCA` sem `process_id` (lacuna 6); chave `pca.import.maxRows` e allowlist padrão nas sementes M2-21.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, pca_id) WHERE status IN ('QUEUED','VALIDATING','APPLYING')`; `(tenant_id, pca_id, created_at DESC)`; `(tenant_id, status, updated_at) WHERE status IN ('QUEUED','VALIDATING','APPLYING')` para o reconciliador; FK composta `(tenant_id, attachment_id)`; RLS por `tenant_id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-10` | GET | `/api/v1/pcas/{pcaId}/import-template` | query `format` (`XLSX`\|`CSV`, padrão `XLSX`) | `200` arquivo (`Content-Disposition: attachment`; abas Itens, Instruções e Listas no XLSX) | 200, 403, 404, 422 |
| `PCA-11` | POST | `/api/v1/pcas/{pcaId}/imports` | `{ attachmentId }` + `Idempotency-Key` | `202 { data: PcaImport }` + `Location` (PCA-12) | 202, 403, 404, 409, 413, 415, 422, 503 |
| `PCA-12` | GET | `/api/v1/pcas/{pcaId}/imports/{importId}` | query `rejectionsPage`, `rejectionsPageSize` (≤ 100) | `200 { data: PcaImport, meta: { rejectionsTotal } }` · `ETag` · `Cache-Control: no-store` | 200, 403, 404 |
| `PCA-13` | POST | `/api/v1/pcas/{pcaId}/imports/{importId}/confirm` | `{}` + `Idempotency-Key` + `If-Match` (versão da importação) | `202 { data: PcaImport }` (`APPLYING`) | 202, 403, 404, 409, 410, 412, 422, 428 |
| `PCA-14` | GET | `/api/v1/pcas/{pcaId}/imports/{importId}/report` | — | `200` `text/csv` (`;`, UTF-8 com BOM, `Content-Disposition: attachment`) | 200, 403, 404, 409 |
| `ATT-02` | POST | `/api/v1/attachments` | `targetType = PCA`, `targetId = pcaId` (existente) | `201` com URL de upload | 201, 403, 404, 413, 415, 422 |
| `ATT-03` | POST | `/api/v1/attachments/{id}/confirm` | (existente) | `202` | 202, 403, 404, 409 |
| `ATT-04` | GET | `/api/v1/attachments/{id}` | (existente) | `200` com status | 200, 403, 404 |

- **`PcaImport` (resposta):** `id`, `pcaId`, `attachment { id, fileName, sizeBytes }`, `status`, `fileFormat`, `requestedBy { id, name }`, `createdAt`, `startedAt`, `finishedAt`, `previewReadyAt`, `previewExpiresAt`, `planVersionAtPreview`, `progress { rowsProcessed, rowsTotal }`, `rowsRead`, `rowsValid`, `rowsRejected`, `summary { toCreate, toUpdate, unchanged }`, `result { itemsCreated, itemsUpdated, unchanged }` (após `COMPLETED`), `headerColumns { recognized[], ignored[] }`, `warnings[]`, `rejections[]` (`row`, `column`, `field`, `code`, `message`, `value`), `sample[]` (`row`, `action`, `code`, `changes[] { field, before, after }`), `errorCode`, `errorReason`, `version`, `allowedActions[]` (`CONFIRM`, `DOWNLOAD_REPORT`, `RESTART`).
- **PCA-13:** divergência de `If-Match` com a importação ainda confirmável → 412 `VERSION_CONFLICT`; versão do plano diferente da prévia ou validade vencida → 410 `IMPORT_PREVIEW_EXPIRED`, verificado antes do `If-Match`.

## Logs
- `info` `pca.import_queued` — `importId`, `pcaId`, `fileFormat`, `sizeBytes`.
- `info` `pca.import_validated` — `importId`, `rowsRead`, `rowsValid`, `rowsRejected`, `durationMs`.
- `info` `pca.import_applied` — `importId`, `itemsCreated`, `itemsUpdated`, `durationMs`.
- `warn` `pca.import_preview_expired` — `importId`, `reason` (`TTL`, `PLAN_CHANGED`, `PLAN_NOT_DRAFT`).
- `warn` `pca.import_enqueue_deferred` — fila indisponível; reconciliador assume.
- `error` `pca.import_failed` — `importId`, `errorCode`, `attempt`, `correlationId`.
- Métricas: `cf_pca_import_duration_seconds{phase}`, `cf_pca_import_rows_total{outcome}` (`created`, `updated`, `unchanged`, `rejected`), `cf_pca_import_jobs_total{status}`.
- **Nunca logar:** conteúdo de células, objetos, valores, e-mails de responsáveis, nome do arquivo (apenas `attachmentId`).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `pca.import` | `DATA_CHANGE` | Commit da aplicação | `metadata`: `importId`, `attachmentId`, `rowsRead`, `itemsCreated`, `itemsUpdated`, `rowsRejected`, `durationMs`; nome do arquivo sanitizado |
| `pca.item_create` | `DATA_CHANGE` | Cada item criado pela importação | `changes`: campos importados; `metadata`: `importId`, `pcaItemId`, `code`, `importRowNumber`, `via = IMPORT` |
| `pca.item_update` | `DATA_CHANGE` | Cada item alterado pela importação | `changes`: antes/depois dos campos alterados; `metadata` igual |
| `pca.item_status_change` | `DATA_CHANGE` | Item cuja situação mudou pela importação | `changes.status` antes/depois; `metadata.hasReason` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = PCA_MANAGE`, `pcaId`, `importId?` |

A prévia, o download do modelo e o do relatório não geram auditoria de dados; o upload tem a sua (`attachment.upload_intent`, `attachment.confirm`).

## Testes necessários
- **Unitários:** leitor XLSX e CSV (codificações, delimitadores, BOM, células mescladas, fórmulas com e sem valor em cache); `PcaImportHeaderMapper` (aliases, acentos, repetidas, ausentes); normalização de valor (`1.234,56`, `1234,56`, `R$ 1.234,56`, `1234.5`, `1.234`), mês por nome, secretaria por sigla/código/nome e ambiguidade; `PcaImportPlanner` (criar, atualizar, sem alteração, duplicado no arquivo); neutralização de injeção de fórmula no relatório; máquina de estados e expiração.
- **Integração (Testcontainers PostgreSQL + Redis + armazenamento S3 de teste):** fluxo completo com anexo `AVAILABLE`; prévia sem escrita (contagens de tabelas iguais antes e depois); aplicação atômica com 500 linhas; reimportação idempotente; `Pca.version` divergente → 410; reconciliador reenfileirando `QUEUED`/`APPLYING`; falha injetada de banco no meio da aplicação (rollback, nova tentativa, `FAILED`); falha do armazenamento; XLSX corrompido, com senha, `xlsm`, *zip bomb*.
- **API/contrato:** PCA-10 a PCA-14 (formatos, `ETag`, `Idempotent-Replayed`, `no-store`, `Content-Disposition`); catálogo de erros e `errors[].code` por linha; PCA-12 com paginação de rejeições.
- **RBAC e multi-tenant:** `PCA_MANAGE` de órgão × de secretaria × `PCA_VIEW` × `CONSULTOR_EXTERNO`; confirmação só pelo autor; anexo/importação de outro tenant (404/422); nomes de outro tenant na planilha → `REFERENCE_NOT_FOUND` (suíte `test/tenant-leak`).
- **Concorrência:** edição manual entre prévia e confirmação; confirmações simultâneas; duas importações no mesmo plano; importação durante envio para aprovação (`EXPIRED`).
- **E2E (Playwright):** baixar o modelo, preencher com erros, enviar, ver a prévia e as rejeições, baixar o relatório, corrigir, reenviar, confirmar e ver os itens e totais; arquivo inválido; prévia expirada.
- **Acessibilidade/performance:** axe no diálogo e nas tabelas; leitor de tela no progresso; 500 linhas com p95 ≤ 30 s por fase e 1.000 linhas dentro do *timeout* (medido no endurecimento).

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
- [ ] Prévia sem nenhum efeito colateral comprovado por teste (tabelas, outbox, auditoria)
- [ ] Reimportação idempotente e aplicação atômica verificadas com falha injetada
- [ ] Modelo de planilha testado com Excel e LibreOffice e validado com ao menos uma planilha real do piloto

## Estimativa
**M** — reaproveita o padrão de prévia e o parser de planilhas do MVP 1 e as regras de item da US-138, mas soma CSV/XLSX com validação por linha, estado durável de importação, fila com reconciliador, aplicação atômica em lote, relatório e um diálogo em quatro etapas.

## Prioridade
**P1** — a carga por planilha é o caminho esperado para a primeira elaboração do PCA nos órgãos pequenos e sustenta a meta de plano elaborado em até 2 dias; não bloqueia a US-140 (o plano pode ser digitado), por isso não é P0.
