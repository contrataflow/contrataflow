---
id: US-064
title: "Incluir documento externo (upload) com versões"
epic: EP-011
feature: FT-039
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-065, US-068]
modules: [document, files, workflow, access]
screens: [SCR-105]
endpoints: [DOC-02, DOC-19]
permissions: [DOCUMENT_CREATE, DOCUMENT_UPDATE, ATTACHMENT_UPLOAD]
events: [DocumentCreated, DocumentVersionCreated]
---

# US-064 — Incluir documento externo (upload) com versões

## Título
Incluir documento externo por upload, com histórico de versões

## Descrição
**Como** redator do processo, **quero** anexar um arquivo já produzido fora do sistema (ex.: parecer em PDF, planilha) como um documento do processo, e enviar uma nova versão quando o arquivo for revisado, **para** manter o artefato original, com prévia e histórico, sem precisar recriá-lo no editor.

Ao escolher um tipo `UPLOADED` no painel de documentos (US-062), o sistema cria o documento (sem conteúdo) e guia o envio do arquivo pelo fluxo de upload seguro (DEC-136): intenção, confirmação e varredura antes de o arquivo ficar disponível. Cada envio de arquivo (o primeiro ou uma substituição) cria uma nova `DocumentVersion` imutável. Arquivos diretamente visualizáveis (PDF, imagem) têm prévia inline; os demais formatos oferecem apenas download nesta story.

## Contexto
- Nem todo documento do processo nasce no editor: pareceres jurídicos, laudos técnicos e planilhas frequentemente já existem como arquivo. DEC-017 trata esse caso como `Document` com `kind = UPLOADED`, sem `templateVersionId` e sem seções.
- O upload reaproveita o fluxo seguro de anexos (DEC-136, US-068): quarentena, varredura por *magic bytes* e ClamAV, e só então disponibilização — um arquivo nunca fica acessível sem ter passado pelo scan.
- Cada versão é um snapshot imutável (DEC-084): `DocumentVersion.content` fica nulo e `attachmentId` aponta para o arquivo daquela versão, com `contentHash` igual ao SHA-256 do arquivo.
- A conversão de DOCX para PDF via Gotenberg (para dar prévia a formatos de escritório) é **P2**, fora do MVP 1; aqui a prévia inline cobre apenas os formatos nativamente exibíveis no navegador.

## Objetivo
Permitir anexar um arquivo externo como documento do processo e substituí-lo por uma nova versão em poucos passos, com o arquivo sempre varrido por antivírus antes de ficar disponível e sem nunca perder as versões anteriores.

## Persona
- **Principal:** redator/custodiante do processo (`REQUISITANTE`, `GESTOR_CONTRATACOES`) com `DOCUMENT_CREATE` e `ATTACHMENT_UPLOAD`.
- **Secundárias:** participante do processo com papel `COLLABORATOR`/`CONSULTANT` (via POL-02); `GESTOR_CONTRATO`.

## Pré-condições
- Processo em `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Existe ao menos um `DocumentType` ativo com `kind = UPLOADED`, permitido na etapa atual.
- Usuário com `DOCUMENT_CREATE`/`ATTACHMENT_UPLOAD` no escopo do processo e custódia atual **ou** participação `COLLABORATOR`/`CONSULTANT` (POL-02).
- Arquivo dentro dos limites do tenant (`uploads.maxFileSizeMb`, `uploads.allowedExtensions`).

## Fluxo principal
1. No painel de documentos (US-062), o usuário escolhe um tipo `UPLOADED` no menu "Criar documento".
2. O sistema abre um diálogo pedindo **Título** (obrigatório); ao confirmar, envia `POST /api/v1/processes/{id}/documents` com `Idempotency-Key`, criando o `Document` em `DRAFT`, sem versão (`currentVersionId = null`).
3. O front navega para SCR-105 em modo "Enviar arquivo".
4. O usuário seleciona o arquivo; o front solicita a intenção de upload (`ATT-02`, `targetType = DOCUMENT`, `targetId = documentId`) e recebe uma URL pré-assinada `PUT` para o bucket de quarentena (válida por 5 minutos).
5. O front envia o arquivo à URL e confirma (`ATT-03`); o job `file-scan` verifica *magic bytes* × allowlist, roda o ClamAV e calcula o SHA-256; em sucesso, o anexo passa a `AVAILABLE`.
6. Quando `AVAILABLE`, o front chama `POST /api/v1/documents/{id}/upload-version` (`DOC-19`) com `{ attachmentId }`; a API cria uma `DocumentVersion` (`reason = UPLOAD`) e atualiza `Document.currentVersionId`.
7. A tela mostra a prévia inline (PDF/imagem, via URL pré-assinada de download) ou, para outros formatos, "Sem prévia disponível — baixe o arquivo".
8. O documento permanece `DRAFT`, podendo receber uma nova versão, até ser submetido ou finalizado (US-065).

## Fluxos alternativos
- **FA-01 — Arquivo rejeitado pela varredura:** o anexo fica `INFECTED`/`REJECTED`; a tela exibe "Não foi possível usar este arquivo. Verifique e tente novamente." e permite selecionar outro arquivo; nenhuma versão é criada.
- **FA-02 — Arquivo sem prévia nativa (DOCX, XLSX, ODT…):** exibe "Sem prévia disponível para este tipo de arquivo" com o botão "Baixar arquivo"; conversão DOCX → PDF via Gotenberg fica para P2 (reaproveitando o worker `document-render` da US-067).
- **FA-03 — Enviar nova versão substituindo a atual:** com o documento em `DRAFT`/`RETURNED`, o usuário repete os passos 4–6; a versão anterior permanece íntegra no histórico (consulta completa é da US-066, fora desta story).
- **FA-04 — Abandonar sem enviar arquivo:** o `Document` (casca) permanece em `DRAFT` sem versão; aparece no painel como "Rascunho sem arquivo" e não pode ser submetido/finalizado até receber uma versão (US-065).
- **FA-05 — Reenvio da confirmação por falha de rede:** a confirmação (`ATT-03`) e o `upload-version` (`DOC-19`) são idempotentes por `Idempotency-Key`; o reenvio não duplica anexo nem versão.

## Regras de negócio
- **RN-DOC-31** — A criação (`DOC-02`) exige `documentTypeId` de um `DocumentType` ativo do tenant com `kind = UPLOADED`; `templateVersionId` permanece nulo (DEC-017); `title` obrigatório (5 a 250 caracteres).
- **RN-DOC-32** — O documento `UPLOADED` nasce em `DRAFT` sem versão (`currentVersionId = null`); permanece editável (enviar/substituir arquivo) até a primeira versão ser confirmada e também depois, enquanto estiver em `DRAFT`/`RETURNED`.
- **RN-DOC-33** — O envio do arquivo usa o fluxo de upload seguro (DEC-136, US-068): intenção (`ATT-02`, `targetType = DOCUMENT`, `targetId = documentId`) → confirmação (`ATT-03`) → job `file-scan` → `AVAILABLE`; um anexo `INFECTED`/`REJECTED` nunca pode ser usado em `DOC-19`.
- **RN-DOC-34** — `DOC-19` cria uma `DocumentVersion` com `reason = UPLOAD`, `content = null`, `attachmentId` do anexo `AVAILABLE`, `contentHash` igual ao `sha256` do anexo e `statusAtCreation` igual ao status atual do documento; atualiza `Document.currentVersionId`. Não altera o `status` do documento.
- **RN-DOC-35** — Extensão e MIME detectado do arquivo devem estar em `uploads.allowedExtensions`; tamanho deve ser ≤ `uploads.maxFileSizeMb`; violação → `FILE_TYPE_NOT_ALLOWED` (415) ou `FILE_TOO_LARGE` (413) na intenção/confirmação de upload.
- **RN-DOC-36** — A prévia inline está disponível para MIME diretamente renderizável no navegador (PDF, PNG, JPEG), usando o mesmo mecanismo de URL pré-assinada de download do anexo da versão atual (equivalente a `ATT-05`, US-069); demais formatos exibem "Sem prévia disponível — baixe o arquivo" nesta story.
- **RN-DOC-37** — A conversão DOCX → PDF para habilitar prévia desses formatos é **P2** (fora do MVP 1 desta story); quando implementada, reaproveitará o worker `document-render` (US-067).
- **RN-DOC-38** — Uma nova versão só pode ser enviada enquanto o documento está em `DRAFT`/`RETURNED` (POL-02); do contrário, `DOCUMENT_NOT_EDITABLE` (409).
- **RN-DOC-39** — O upload de nova versão exige que o tipo esteja permitido na etapa atual do processo (`WorkflowStage.documentTypeCodes`), igual à regra de criação (RN-DOC-30/POL-02); violação → `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422).
- **RN-DOC-40** — A validação de completude antes de submeter/finalizar um documento `UPLOADED` (US-065, `DOC-08`) exige ao menos uma versão (`currentVersionId` preenchido); documento sem nenhuma versão enviada não pode avançar (`violations[]` com `code = "FIELD_REQUIRED"`, `field = "currentVersionId"`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo de documento | `documentTypeId` | seleção | Sim | `UPLOADED` ativo, permitido na etapa | — |
| Título | `title` | texto curto | Sim | 5–250 caracteres | — |
| Arquivo | `attachmentId` (via intenção + `PUT`) | arquivo | Sim (para a 1ª versão) | extensão/tamanho (`uploads.*`) | — |
| Resumo da alteração | `changeSummary` | texto curto | Não | até 500 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Título ausente ou fora do limite | Front + API | "Informe um título entre 5 e 250 caracteres." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Tipo inexistente, inativo, de outro `kind` ou outro tenant | API | "Selecione um tipo de documento válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-03 | Tipo não permitido na etapa atual | API | "Este tipo de documento não é permitido na etapa atual." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-04 | Extensão/MIME fora da allowlist | API | "Este tipo de arquivo não é permitido." | `FILE_TYPE_NOT_ALLOWED` |
| V-05 | Arquivo maior que o limite do tenant | API | "O arquivo excede o tamanho máximo permitido ({limite} MB)." | `FILE_TOO_LARGE` |
| V-06 | Confirmação sem objeto na quarentena | API | "Não encontramos o arquivo enviado. Tente novamente." | `UPLOAD_NOT_RECEIVED` |
| V-07 | `attachmentId` não `AVAILABLE` (ainda em varredura, infectado ou rejeitado) | API | "Este arquivo ainda não pode ser usado." | `ATTACHMENT_NOT_AVAILABLE` |
| V-08 | Documento não editável (status fora de `DRAFT`/`RETURNED`) | API | "Este documento não pode receber uma nova versão agora." | `DOCUMENT_NOT_EDITABLE` |

## Permissões
- **Permissão:** `DOCUMENT_CREATE` para criar o documento (`DOC-02`); `ATTACHMENT_UPLOAD` para enviar o arquivo (`ATT-02`/`ATT-03`); `DOCUMENT_UPDATE` para registrar uma nova versão (`DOC-19`).
- **Políticas:** POL-02 — permissão aplicável + (custódia do processo **ou** participação `COLLABORATOR`/`CONSULTANT`) + documento em `DRAFT`/`RETURNED` + tipo permitido na etapa atual + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`. Aplica-se a `DOC-02` e `DOC-19`.
- **MFA:** não exigido (permissões de risco médio), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** tipo não aparece no menu "Criar documento" (US-062); botão "Enviar arquivo"/"Enviar nova versão" oculto sem `ATTACHMENT_UPLOAD`; chamadas diretas respondem 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` | `document.created.<type>` | Commit da criação do documento (casca) | Payload: `documentId`, `documentTypeCode`, `kind = UPLOADED`, `title` |
| `DocumentVersionCreated` | `document.version_created.<type>` | Commit de `DOC-19` | Payload: `documentId`, `documentVersionId`, `versionNumber`, `reason = UPLOAD`, `contentHash` |

Projeções síncronas: entradas `DOCUMENT_CREATED` e `DOCUMENT_VERSION_CREATED` na timeline do processo. O ciclo de upload do arquivo em si gera `AttachmentUploaded`/`AttachmentRejected` (worker `file-scan`, US-068), consumidos aqui apenas como pré-condição de `DOC-19`.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. Não há `NotificationType` para criação de documento ou nova versão (apenas timeline); o autor já está ciente da própria ação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Incluir documento externo (upload) com versões

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está em "IN_PROGRESS" na etapa "Estudos preliminares"
    And a etapa atual permite o tipo "PARECER_EXTERNO" (`kind = UPLOADED`)
    And "Ana" tem `DOCUMENT_CREATE` e `ATTACHMENT_UPLOAD`, e é a custodiante atual do processo

  Scenario: [Sucesso] Criar documento externo e enviar o arquivo
    When "Ana" criar um documento do tipo "PARECER_EXTERNO" com título "Parecer jurídico sobre a minuta"
    Then o documento deve ser criado com status "DRAFT" e sem versão
    When "Ana" enviar o arquivo "parecer.pdf" (2 MB, dentro do limite)
    Then o anexo deve ficar "AVAILABLE" após o `file-scan`
    And deve ser criada uma "DocumentVersion" com `reason = "UPLOAD"` e `versionNumber = 1`
    And deve ser gerado o evento "DocumentVersionCreated"
    And a prévia inline do PDF deve ficar disponível

  Scenario: [Validação] Extensão de arquivo não permitida
    When "Ana" tentar enviar o arquivo "script.exe"
    Then a API deve responder 415 com código "FILE_TYPE_NOT_ALLOWED"
    And nenhuma "DocumentVersion" deve ser criada

  Scenario: [Permissão] Usuário sem ATTACHMENT_UPLOAD
    Given que "Bruno" tem `DOCUMENT_CREATE` mas não `ATTACHMENT_UPLOAD`
    When "Bruno" criar o documento "PARECER_EXTERNO" e tentar enviar um arquivo
    Then o botão "Enviar arquivo" não deve estar disponível
    And "POST /api/v1/attachments" deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] attachmentId de outro tenant em upload-version
    Given que existe um anexo "AVAILABLE" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", chamar "DOC-19" com esse `attachmentId`
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "attachmentId"

  Scenario: [Duplicidade] Reenvio da confirmação de upload com a mesma chave de idempotência
    Given que "Ana" confirmou o upload com a chave "K1" e recebeu a versão 1
    When a mesma confirmação for reenviada com a chave "K1"
    Then a API deve responder com o mesmo resultado e "Idempotent-Replayed: true"
    And deve existir apenas uma "DocumentVersion" criada

  Scenario: [Concorrência] Duas versões enviadas quase ao mesmo tempo
    Given que o documento está na versão 1
    When "Ana" e "Carla" chamarem "DOC-19" com arquivos diferentes, quase simultaneamente
    Then as versões criadas devem ser numeradas sequencialmente (2 e 3), sem colisão
    And `Document.currentVersionId` deve apontar para a versão mais recente confirmada

  Scenario: [Falha de banco] Banco indisponível ao confirmar a versão
    Given que o banco de dados está indisponível
    When "Ana" chamar "DOC-19" após o arquivo ficar "AVAILABLE"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma "DocumentVersion" deve ser criada

  Scenario: [Falha de integração] Fila de varredura (file-scan) ou ClamAV indisponível
    Given que a fila "file-scan" ou o ClamAV estão indisponíveis
    When "Ana" enviar um arquivo válido
    Then o anexo deve permanecer em "SCANNING"
    And "DOC-19" deve responder 409 com código "ATTACHMENT_NOT_AVAILABLE" enquanto o anexo não ficar "AVAILABLE"
    And o arquivo nunca deve ficar acessível sem ter passado pela varredura
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Título inválido | 422 | `VALIDATION_ERROR` | "Informe um título entre 5 e 250 caracteres." | Marca o campo |
| Tipo inválido/não permitido na etapa | 422 | `VALIDATION_ERROR`/`DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "Selecione um tipo de documento válido." / "Tipo não permitido na etapa atual." | Oculta opção/recarrega |
| Extensão não permitida | 415 | `FILE_TYPE_NOT_ALLOWED` | "Este tipo de arquivo não é permitido." | Mantém seletor de arquivo aberto |
| Arquivo muito grande | 413 | `FILE_TOO_LARGE` | "O arquivo excede o tamanho máximo permitido." | Sugere compactar/reduzir |
| Upload não recebido | 409 | `UPLOAD_NOT_RECEIVED` | "Não encontramos o arquivo enviado. Tente novamente." | Reinicia o fluxo de envio |
| Arquivo infectado/rejeitado | 409 | `ATTACHMENT_NOT_AVAILABLE` | "Não foi possível usar este arquivo." | Permite selecionar outro arquivo |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este documento não pode receber uma nova versão agora." | Desabilita o envio |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta botão/ação |
| Banco/fila indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir o envio agora. Tente novamente em instantes." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-065 (status, transições e validação de completude); US-068 (fluxo seguro de upload reaproveitado: `ATT-02`/`ATT-03`, job `file-scan`). Relacionadas, não bloqueantes: US-062 (ponto de entrada), US-066 (histórico completo de versões e comparação), US-069 (padrão de download/prévia por URL pré-assinada), US-067 (conversão DOCX → PDF, P2).
- **Decisões/ADRs:** DEC-017, DEC-084, DEC-136; ADR-006.
- **Configurações:** `uploads.maxFileSizeMb`, `uploads.allowedExtensions`.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita integralmente o fluxo de upload seguro da US-068 (intenção/confirmação/varredura); esta story só adiciona o vínculo entre o anexo `AVAILABLE` e uma nova `DocumentVersion`.
- A prévia inline usa o mesmo mecanismo de URL pré-assinada de download de anexos (US-069); não introduz um novo mecanismo de armazenamento ou de acesso a arquivos.
- `DocumentVersion.content = null` para `UPLOADED` significa que comparação de versões (US-066) não pode usar diff textual — fica registrado para aquela story (fora desta).

## Backend
- **Módulo(s):** `document` (dono da versão) e `files` (dono do anexo e da varredura); usa `workflow` (etapa atual) e `access` (POL-02).
- **Casos de uso:** `CreateUploadedDocumentCommand` → `CreateDocumentHandler` (reaproveita a fábrica `Document.create` da US-065 com `kind = UPLOADED`); `UploadDocumentVersionCommand` → `UploadDocumentVersionHandler` (`DOC-19`).
- **Domínio:** `Document.create(props)` (RN-DOC-31/32); `DocumentVersion.fromUpload(attachment)` (RN-DOC-34).
- **Integrações internas:** `files.assertAttachmentAvailable(attachmentId, { targetType: 'DOCUMENT', targetId: documentId })`.
- **Transação:** `DOC-19` em uma transação curta (verificação do anexo → inserção da versão → atualização de `currentVersionId` → auditoria → outbox → commit).

## Frontend
- **Tela(s):** SCR-105 (`/processos/[id]/documentos/[docId]`), modo "arquivo externo".
- **Componentes:** `CreateDocumentDialog`, `FileUploadDropzone`, `UploadProgress`, `InlinePreview` (PDF/imagem), `UnsupportedPreviewPlaceholder`, `VersionBadge` ("v{N} · enviado por {user} em {data}"), link "Ver todas as versões" (US-066).
- **Estados:** seleção de arquivo vazia; progresso de envio; varredura em andamento ("Verificando o arquivo…"); sucesso com prévia; erro com nova tentativa.
- **Acessibilidade e responsividade:** dropzone acessível por teclado e leitor de tela; prévia com alternativa de download sempre visível; em telas < 768 px a prévia ocupa a largura total.

## Banco de dados
- **Tabelas:** escrita em `documents` (criação), `attachments` (via US-068), `document_versions`, `audit_logs`, `outbox_events`, `process_timeline_entries`.
- **Migrações:** nenhuma (reaproveita o esquema de `documents`/`document_versions`/`attachments`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id, version_number)` em `document_versions`; `(tenant_id, target_type, target_id)` em `attachments`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-02 | POST | `/api/v1/processes/{id}/documents` | `{ documentTypeId, title }` + `Idempotency-Key` | `201 { data: Document }` sem versão | 201, 403, 404, 409, 422, 429, 503 |
| DOC-19 | POST | `/api/v1/documents/{id}/upload-version` | `{ attachmentId, changeSummary? }` + `If-Match` + `Idempotency-Key` | `201 { data: DocumentVersion }` | 201, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `document.created` — `documentId`, `documentTypeCode`.
- `info` `document.version_create` — `documentId`, `documentVersionId`, `versionNumber`, `reason = UPLOAD`.
- `warn` `document.upload_version_not_available` — tentativa de `DOC-19` com anexo não `AVAILABLE`.
- `error` `document.upload_version_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** nome original do arquivo em nível `info` acima do necessário para auditoria; conteúdo do arquivo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Commit da criação | `metadata`: `documentTypeCode`, `code?` |
| `document.version_create` | `DATA_CHANGE` | Commit de `DOC-19` | `metadata`: `versionNumber`, `reason = UPLOAD`, `attachmentId`, `sha256` |

## Testes necessários
- **Unitários:** fábrica `Document.create` com `kind = UPLOADED`; `DocumentVersion.fromUpload` (RN-DOC-34); validação de extensão/tamanho.
- **Integração (Testcontainers PostgreSQL + Redis + S3 fake):** fluxo completo intenção → confirmação → scan → `upload-version`; anexo `INFECTED` nunca vira versão.
- **API/contrato:** respostas e erros conforme api.md; `Idempotency-Key`/`If-Match` em `DOC-19`.
- **RBAC e multi-tenant:** `ATTACHMENT_UPLOAD`/`DOCUMENT_UPDATE` com e sem custódia/participação; anexo de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** dois uploads de versão simultâneos → `versionNumber` sequencial sem colisão.
- **E2E (Playwright):** criar documento externo, enviar PDF, ver prévia, enviar nova versão, tentar arquivo não permitido.
- **Acessibilidade/performance:** axe na dropzone e na prévia; upload de 50 MB concluído dentro do tempo esperado.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `DOCUMENT_CREATE`/`ATTACHMENT_UPLOAD`/`DOCUMENT_UPDATE` e POL-02 aplicados na API
- [ ] Nenhum arquivo acessível antes de `AVAILABLE` (verificado em teste)
- [ ] Auditoria `document.version_create` e evento `DocumentVersionCreated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `DOC-02`/`DOC-19` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de upload e de varredura
- [ ] Prévia e dropzone acessíveis (axe) e responsivas (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — o fluxo de upload seguro é inteiramente reaproveitado da US-068; o esforço está na integração com o ciclo de vida do documento (casca + versão) e na prévia inline.

## Prioridade
**P1** — necessária para anexar pareceres e arquivos externos ao processo, mas não bloqueia a jornada crítica de DFD/ETP/TR do MVP 1.
