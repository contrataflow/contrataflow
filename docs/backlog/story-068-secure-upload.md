---
id: US-068
title: "Upload seguro de anexos"
epic: EP-011
feature: FT-042
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-083, US-097]
modules: [files]
screens: [SCR-006, SCR-105]
endpoints: [ATT-02, ATT-03, ATT-04, ATT-06]
permissions: [ATTACHMENT_UPLOAD, ATTACHMENT_DELETE]
events: [AttachmentUploaded, AttachmentRejected, AttachmentDeleted]
---

# US-068 — Upload seguro de anexos

## Título
Upload seguro de anexos

## Descrição
**Como** qualquer usuário com acesso de edição a um processo, documento, comentário, tramitação ou pesquisa de preço, **quero** anexar arquivos (comprovantes, propostas, atas, imagens) com segurança, **para** instruir o processo com evidências sem arriscar que um arquivo malicioso ou de tipo não permitido circule pela plataforma.

O upload nunca passa pela API: o navegador envia os bytes direto a um bucket de quarentena por URL pré-assinada; um worker então confere o tipo real do arquivo (*magic bytes*), varre com antivírus (ClamAV) e só então promove o arquivo ao armazenamento definitivo. Nenhum arquivo fica disponível para download antes de passar limpo por essa varredura — se o antivírus estiver fora do ar, o anexo simplesmente aguarda, nunca é liberado sem verificação.

## Contexto
- Hoje anexos de processos administrativos circulam por e-mail e pendrives, sem controle de tipo nem antivírus corporativo — risco de malware e de arquivos fora do padrão (executáveis renomeados, por exemplo).
- A DEC-136 formaliza o fluxo de quatro passos (intenção → upload direto → confirmação → varredura) e o storage.md detalha os princípios de segurança: binário fora do banco, chave nunca vem do cliente, nada é liberado sem varredura limpa, conteúdo não confiável fica isolado em bucket próprio, acesso é sempre efêmero e por URL assinada de um único objeto.
- `Attachment` é genérico: serve a `AttachmentTargetType` `PROCESS`, `DOCUMENT`, `DOCUMENT_VERSION`, `PRICE_SOURCE`, `COMMENT`, `MOVEMENT`, `RISK` (e, sem processo, `TENANT_ASSET`/`TEMPLATE_VERSION`) — esta story implementa o mecanismo único de upload/varredura/exclusão reaproveitado por todos esses contextos; a listagem e o download pertencem a US-069.
- A fila `file-scan` (queues.md §4.5) já define o contrato do job; esta story aplica esse contrato ao caso de negócio (quem pode enviar, para qual alvo, com qual allowlist).

## Objetivo
Garantir que 100% dos anexos enviados sejam verificados (tipo + antivírus) antes de ficarem disponíveis, com tempo de varredura p95 abaixo de 30 s para arquivos de até 50 MB, e que nenhum arquivo infectado ou fora da allowlist chegue a `AVAILABLE`.

## Persona
- **Principal:** Qualquer usuário com permissão de edição sobre o alvo do anexo (ex.: redator do documento, participante `COLLABORATOR` de um comentário).
- **Secundárias:** Administrador do tenant (configura `uploads.allowedExtensions`/`uploads.maxFileSizeMb`, fora desta story); auditor (consulta `attachment.scan_result`).

## Pré-condições
- Alvo do anexo existe, é do mesmo tenant e está em estado editável (regra do próprio alvo: POL-02 para documento, custódia/participação para processo/comentário/tramitação).
- ClamAV (`clamd`) e o bucket de quarentena estão operacionais (US-078 provisiona o ambiente); quando ClamAV está fora, o upload é aceito mas a liberação fica pendente (RN-DOC-75).

## Fluxo principal
1. Na tela do alvo (ex.: SCR-105, documento, ou SCR-006, processo), o usuário aciona **"Anexar arquivo"** e escolhe um arquivo local.
2. O front valida localmente extensão e tamanho (feedback imediato) e chama `POST /api/v1/attachments` (`ATT-02`) com `{ targetType, targetId, fileName, declaredMimeType, sizeBytes, categoryId? }` + `Idempotency-Key`.
3. A API autoriza (`ATTACHMENT_UPLOAD` + alvo editável), valida extensão/MIME/tamanho, grava `Attachment` (`PENDING_UPLOAD`) + auditoria `attachment.upload_intent`, assina uma URL `PUT` para o bucket de quarentena (validade máxima 300 s) e responde **201** com o anexo e `{ url, method, headers, expiresAt }`.
4. O front faz `PUT` direto no S3 com os headers assinados, mostrando progresso; ao concluir, chama `POST /api/v1/attachments/{id}/confirm` (`ATT-03`).
5. A API confere (`HEAD`) o objeto na quarentena: se ausente, erro; se o tamanho não bate com o declarado, marca `REJECTED` sem acionar varredura; caso contrário, marca `UPLOADED` + `uploadedAt`, audita `attachment.confirm`, e, após o commit, enfileira o job `file-scan` (`jobId = attachmentId`). Responde **202** com o status resultante.
6. O worker consome `file-scan`: trava o estado em `SCANNING`; lê o objeto em stream único, dividido entre detecção de tipo (*magic bytes*), cálculo de SHA-256 e verificação `INSTREAM` no ClamAV; se limpo e do tipo correto, copia o objeto para o bucket definitivo, grava `AVAILABLE` + `sha256` + `detectedMimeType` + `scanResult`, audita `attachment.scan_result`, projeta a timeline e publica `AttachmentUploaded`; remove o objeto da quarentena.
7. O front, ao detectar `AVAILABLE` (poll ou notificação), mostra o anexo disponível na lista; se `INFECTED`/`REJECTED`, mostra o motivo resumido e permite enviar novamente.
8. Para excluir um anexo (próprio, enquanto o alvo é editável, ou de terceiro com `ATTACHMENT_DELETE`), o usuário aciona **"Excluir"**, informa o motivo e o front chama `DELETE /api/v1/attachments/{id}` (`ATT-06`); a API faz exclusão lógica (`deletedAt`, `deletionReason`) e publica `AttachmentDeleted`.

## Fluxos alternativos
- **FA-01 — Extensão ou tamanho fora do permitido:** `ATT-02` responde `415 FILE_TYPE_NOT_ALLOWED` ou `413 FILE_TOO_LARGE` antes de qualquer URL ser emitida; o front já bloqueia no seletor de arquivo com a mesma allowlist.
- **FA-02 — Confirmação sem upload realizado:** se o `PUT` falhar ou não acontecer, `ATT-03` encontra a quarentena vazia e responde `409 UPLOAD_NOT_RECEIVED`; o front oferece "Tentar enviar novamente" (gera nova intenção, pois a URL já pode ter expirado).
- **FA-03 — Arquivo infectado:** o worker marca `INFECTED`, publica `AttachmentRejected` (`reasonCode = INFECTED`); o front nunca mostra esse arquivo como disponível, apenas "Arquivo rejeitado pela verificação de segurança" para quem o enviou (sem detalhe da assinatura de malware).
- **FA-04 — Tipo real diverge do declarado:** o worker marca `REJECTED` (`reasonCode = TYPE_MISMATCH`/`TYPE_NOT_ALLOWED`, conforme storage.md §5); mensagem "O conteúdo do arquivo não corresponde a um tipo permitido".
- **FA-05 — ClamAV indisponível:** o job de varredura pausa (circuit breaker) sem consumir tentativa; o anexo permanece `SCANNING` (nunca `AVAILABLE`); alerta operacional dispara se ultrapassar 30 min (queues.md §15.3) — nenhuma ação do usuário libera o arquivo mais rápido.
- **FA-06 — Abandono da intenção:** se o usuário nunca confirma, o job `maintenance` marca o `Attachment` como `DELETED` após 24 h e a quarentena já expira pelo *lifecycle* do bucket.
- **FA-07 — Exclusão de anexo de terceiro:** exige `ATTACHMENT_DELETE`; o próprio uploader, sem essa permissão, só exclui os seus enquanto o alvo estiver editável.

## Regras de negócio
- **RN-DOC-71** — **Intenção** (`ATT-02`): exige `ATTACHMENT_UPLOAD` + alvo do mesmo tenant, visível e editável (POL-01/POL-02 ou regra equivalente do alvo — 404 se invisível, 409/403 se não editável); grava `Attachment` `PENDING_UPLOAD` e assina `PUT` para a quarentena com validade máxima de 300 s (DEC-136).
- **RN-DOC-72** — **Allowlist e tamanho:** extensão ∈ `uploads.allowedExtensions` (subconjunto de `pdf, docx, xlsx, odt, ods, csv, txt, png, jpg, jpeg`) e coerente com o `declaredMimeType`, senão `415 FILE_TYPE_NOT_ALLOWED`; `0 < sizeBytes ≤ uploads.maxFileSizeMb` (teto de 100 MB da plataforma), senão `413 FILE_TOO_LARGE` (ou `422 VALIDATION_ERROR` se zero).
- **RN-DOC-73** — **Confirmação** (`ATT-03`): exige `HEAD` bem-sucedido do objeto na quarentena (senão `409 UPLOAD_NOT_RECEIVED`); tamanho do objeto divergente do `sizeBytes` declarado → `REJECTED` (`reasonCode = SIZE_MISMATCH`) sem acionar varredura, respondendo `202` com esse status; caso contrário, `UPLOADED` + enfileira `file-scan` **após o commit**.
- **RN-DOC-74** — **Varredura** (worker `file-scan`): trava condicional para `SCANNING` (só a partir de `UPLOADED`/`SCANNING`); leitura em stream único dividido entre detecção de tipo por *magic bytes* (primeiros 8 KB), SHA-256 e `INSTREAM` do ClamAV; tipo detectado deve pertencer à allowlist da plataforma **e** do tenant e ser coerente com extensão/MIME declarados.
- **RN-DOC-75** — **Nunca libera sem varredura limpa** (princípio P3 de storage.md): somente o handler do `file-scan`, após resultado limpo do ClamAV, promove o anexo a `AVAILABLE`; ClamAV indisponível pausa o job (circuit breaker) sem consumir tentativa e sem promover o arquivo — o anexo fica retido em `SCANNING` até o antivírus voltar.
- **RN-DOC-76** — **Resultado da varredura:** limpo → `CopyObject` para o bucket definitivo, `AVAILABLE` + `sha256` + `detectedMimeType` + `scanResult` + `scannedAt`, evento `AttachmentUploaded`; malware → `INFECTED` (`reasonCode = INFECTED`); tipo/estrutura/tamanho inválido → `REJECTED` (`reasonCode ∈ {TYPE_MISMATCH, TYPE_NOT_ALLOWED, STRUCTURAL_CHECK_FAILED}`); nos dois últimos, evento `AttachmentRejected`; em qualquer desfecho, o objeto de quarentena é removido (melhor esforço).
- **RN-DOC-77** — **Isolamento e tenant** (princípios P4/P6): o bucket de quarentena nunca é legível por URL de download; toda chave é prefixada por `tenants/{tenantId}/` e validada contra o tenant do contexto de execução (API e worker); nenhuma chave é aceita vinda do cliente — sempre construída pelo servidor (`StorageKeyBuilder`).
- **RN-DOC-78** — **Abandono:** intenção sem confirmação em até 24 h é marcada `DELETED` pelo job `maintenance`; o objeto de quarentena correspondente já expira pelo *lifecycle* do bucket (1 dia).
- **RN-DOC-79** — **Exclusão** (`ATT-06`, DEC-034): exclusão lógica com `deletionReason` obrigatório; o próprio uploader usa `ATTACHMENT_UPLOAD` enquanto o alvo estiver editável; excluir anexo de terceiro exige `ATTACHMENT_DELETE`; o binário permanece retido conforme a política de retenção (PEND-07); evento `AttachmentDeleted` (`hasReason`).
- **RN-DOC-80** — **Quota do tenant:** a intenção compara o uso de armazenamento do tenant com o limite técnico da plataforma (storage.md §8; valor em PEND-17) antes de assinar a URL; acima do limite → 422 `STORAGE_QUOTA_EXCEEDED`; ao cruzar 80%/95%, log `storage.quota_threshold_reached` e aviso ao administrador do órgão. Renditions nunca são bloqueadas por quota.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Arquivo | `fileName`, `declaredMimeType`, `sizeBytes` | arquivo | Sim | RN-DOC-72 | — |
| Alvo | `targetType`, `targetId` | enum + referência | Sim | `AttachmentTargetType`; alvo existente, visível e editável | contexto da tela |
| Categoria | `categoryId` | seleção (catálogo `ATTACHMENT_CATEGORY`) | Não | item ativo | — |
| Descrição | `description` | texto curto | Não | até 500 caracteres | — |
| Motivo da exclusão | `deletionReason` | texto curto | Sim (ao excluir) | RN-DOC-79 | — |
| *(sistema)* Status | `status` | `AttachmentStatus` | — | RN-DOC-71/73/76 | `PENDING_UPLOAD` |
| *(sistema)* Hash | `sha256` | varchar(64) | — | calculado no scan | gerado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Extensão/MIME fora da allowlist do tenant | Front + API | "Este tipo de arquivo não é permitido. Tipos aceitos: {lista}." | `FILE_TYPE_NOT_ALLOWED` |
| V-02 | Tamanho acima do limite configurado | Front + API | "O arquivo excede o limite de {X} MB." | `FILE_TOO_LARGE` |
| V-03 | Arquivo vazio | Front + API | "Selecione um arquivo válido." | `VALIDATION_ERROR` |
| V-04 | Alvo não editável | API | "Não é possível anexar arquivos neste momento." | `DOCUMENT_NOT_EDITABLE` (alvo `DOCUMENT`/`DOCUMENT_VERSION`) · `INVALID_PROCESS_STATUS` (alvo `PROCESS`/`MOVEMENT`/`RISK`/`PRICE_SOURCE`/`COMMENT` com processo em status final) |
| V-05 | Confirmação sem objeto na quarentena | API | "Não encontramos o arquivo enviado. Tente novamente." | `UPLOAD_NOT_RECEIVED` |
| V-06 | Tamanho confirmado diverge do declarado | API/Worker | "O arquivo enviado não corresponde ao esperado. Envie novamente." | `REJECTED` (`reasonCode SIZE_MISMATCH`) |
| V-07 | Exclusão sem motivo | Front + API | "Informe o motivo da exclusão." | `VALIDATION_ERROR` (`REQUIRED`) |

## Permissões
- **Permissão:** `ATTACHMENT_UPLOAD` (intenção, confirmação, exclusão dos próprios anexos enquanto o alvo é editável); `ATTACHMENT_DELETE` (excluir anexos de terceiros).
- **Políticas:** a condição de "alvo editável" segue a regra do próprio alvo (POL-02 para `DOCUMENT`/`DOCUMENT_VERSION`; custódia/participação para `PROCESS`/`COMMENT`/`MOVEMENT`/`RISK`, fora deste épico).
- **MFA:** não exigido (risco médio).
- **Sem permissão:** botão "Anexar"/"Excluir" ocultos conforme a regra do alvo; API responde 403 `PERMISSION_DENIED` ou 404 (alvo invisível, DEC-024).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AttachmentUploaded` | `attachment.uploaded` | Worker `file-scan` promove a `AVAILABLE` | `attachmentId`, `targetType`, `targetId?`, `fileName`, `sizeBytes`, `sha256` |
| `AttachmentRejected` | `attachment.rejected` | Varredura resulta `INFECTED`/`REJECTED` (ou confirmação com `SIZE_MISMATCH`) | `attachmentId`, `status`, `reasonCode` |
| `AttachmentDeleted` | `attachment.deleted` | Commit de `ATT-06` | `attachmentId`, `hasReason` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `ATTACHMENT_REJECTED` | Quem enviou o arquivo | In-app | `AttachmentRejected` (events.md §6) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Upload seguro de anexos

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura A"
    And possui "ATTACHMENT_UPLOAD" sobre o documento "ETP 0003/2026", que está em "DRAFT"
    And a configuração "uploads.allowedExtensions" inclui "pdf" e "uploads.maxFileSizeMb" é 50

  Scenario: [Sucesso] Enviar um PDF válido
    When o usuário enviar o arquivo "comprovante.pdf" de 2 MB
    Then a API deve criar o "Attachment" em "PENDING_UPLOAD" e assinar uma URL de upload válida por até 300 s
    And, após o "PUT" e a confirmação, o status deve mudar para "UPLOADED"
    And o worker deve varrer o arquivo e, limpo, promovê-lo a "AVAILABLE"
    And deve gerar o evento "AttachmentUploaded"
    And deve gerar registro de auditoria "attachment.scan_result"

  Scenario: [Validação] Extensão não permitida
    When o usuário tentar enviar o arquivo "script.exe"
    Then a API deve responder 415 com código "FILE_TYPE_NOT_ALLOWED"
    And nenhuma URL de upload deve ser emitida

  Scenario: [Permissão] Usuário sem permissão de upload
    Given que "Bruno" não tem "ATTACHMENT_UPLOAD" sobre o documento
    When "Bruno" enviar "POST /api/v1/attachments"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Alvo de outro tenant
    Given que o documento "D9" pertence ao tenant "Prefeitura B"
    When um usuário da "Prefeitura A" enviar uma intenção referenciando "D9"
    Then a API deve responder 404
    And nenhum "Attachment" deve ser criado

  Scenario: [Duplicidade] Reenvio da confirmação com a mesma chave de idempotência
    Given que a confirmação foi enviada com a chave "K1" e respondeu 202 "UPLOADED"
    When a mesma confirmação for reenviada com a chave "K1"
    Then a API deve responder 202 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"

  Scenario: [Concorrência] Duas varreduras simultâneas do mesmo anexo
    Given que o anexo está em "UPLOADED"
    When dois jobs de varredura para o mesmo "attachmentId" chegarem ao mesmo tempo
    Then apenas um deve efetivamente transicionar para "SCANNING" e processar
    And o outro deve concluir sem efeito, sem duplicar a promoção a "AVAILABLE"

  Scenario: [Falha de banco] Banco indisponível na intenção
    Given que o banco de dados fica indisponível
    When o usuário tentar enviar um arquivo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum "Attachment" deve ser criado

  Scenario: [Falha de integração] ClamAV indisponível durante a varredura
    Given que o ClamAV está fora do ar
    When o worker processar o job "file-scan"
    Then o job deve pausar sem consumir tentativa enquanto o circuito estiver aberto
    And o anexo deve permanecer em "SCANNING", nunca "AVAILABLE"
    And, quando o ClamAV voltar, a varredura deve ser concluída normalmente
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Extensão/MIME não permitido | 415 | `FILE_TYPE_NOT_ALLOWED` | "Este tipo de arquivo não é permitido." | Bloqueia no seletor |
| Arquivo muito grande | 413 | `FILE_TOO_LARGE` | "O arquivo excede o limite de {X} MB." | Bloqueia no seletor |
| Alvo não editável | 409 | `DOCUMENT_NOT_EDITABLE` · `INVALID_PROCESS_STATUS` (conforme o alvo) | "Não é possível anexar arquivos neste momento." | Oculta "Anexar" |
| Upload não recebido | 409 | `UPLOAD_NOT_RECEIVED` | "Não encontramos o arquivo enviado. Tente novamente." | Botão "Enviar novamente" |
| Tamanho divergente na confirmação | 202 (status `REJECTED`) | `SIZE_MISMATCH` | "O arquivo enviado não corresponde ao esperado." | Remove da lista; permite novo envio |
| Arquivo infectado | — (evento) | `INFECTED` | "Arquivo rejeitado pela verificação de segurança." | Remove da lista; permite novo envio |
| Tipo divergente do declarado | — (evento) | `TYPE_MISMATCH` | "O conteúdo do arquivo não corresponde a um tipo permitido." | Remove da lista; permite novo envio |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para anexar arquivos aqui." | Oculta "Anexar" |
| Banco/armazenamento indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível enviar o arquivo agora. Tente novamente." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-083 (worker, filas, *retries* e *dead letter* — executa `file-scan`); US-097 (autorização na API e no frontend — base de `ATTACHMENT_UPLOAD`/`ATTACHMENT_DELETE`). Consomem/relacionam-se a esta story: US-069 (listar/baixar), US-063/US-064/US-066 (anexos em documentos e versões) e demais módulos que usam `AttachmentTargetType`.
- **Decisões/ADRs:** DEC-024, DEC-034, DEC-058, DEC-132, DEC-136, DEC-137; ADR-006 (contexto de `DOCUMENT_VERSION` como alvo).
- **Configurações:** `uploads.maxFileSizeMb`, `uploads.allowedExtensions`.
- **Lacunas nas fontes canônicas:**
  1. Sem tela dedicada a anexos: componente `AttachmentUploader` embutido em cada tela que exibe o alvo (aceito; screens.md registra o componente — tarefas D07/D08).
  2. ~~Quota por tenant~~ — resolvida: limite técnico da plataforma por tenant (não é configuração do tenant), erro `STORAGE_QUOTA_EXCEEDED` (422) em api.md §2.2; valor do limite pendente em PEND-17 (proposta 50 GB, avisos em 80%/95%).
  3. ~~Código de alvo não editável~~ — resolvida: `DOCUMENT_NOT_EDITABLE` para documento/versão; `INVALID_PROCESS_STATUS` para alvos ligados ao processo em status final.

## Impacto técnico
- Implementa o padrão B de filas (queues.md §3) para `file-scan`: a própria linha `Attachment` é a "outbox do trabalho"; enfileirar antes do commit é proibido (o job rodaria sobre uma linha que pode não existir).
- `StorageKeyBuilder` deve ser o único ponto que gera chaves (`tenants/{tenantId}/...`); nenhuma rota aceita `storageKey`/`quarantineKey` vindos do cliente (RN-DOC-77).
- O *circuit breaker* do ClamAV (`cockatiel`, meia-abertura 30 s) é compartilhado com o mesmo padrão usado para o Gotenberg em US-067 — reaproveitar o *wrapper*.
- Stream único (*tee*) entre detecção de tipo, hash e ClamAV evita ler o objeto da quarentena mais de uma vez; qualquer nova verificação futura deve se encaixar no mesmo *tee*, não adicionar uma leitura extra.
- Teto de 100 MB da plataforma (configurável por tenant até esse teto) assume ausência de *multipart upload* no MVP 1; arquivos maiores exigiriam `CreateMultipartUpload` pré-assinado, fora de escopo.

## Backend
- **Módulo(s):** `files` (dono); usa `access` (POL-01/POL-02 do alvo), `audit`, `platform` (`OutboxWriter`, fila `file-scan`, `StorageKeyBuilder`).
- **Casos de uso:** `CreateAttachmentIntentCommand` (`ATT-02`); `ConfirmAttachmentUploadCommand` (`ATT-03`); `GetAttachmentQuery` (`ATT-04`); `DeleteAttachmentCommand` (`ATT-06`). Worker: `ScanFileHandler` (consome `file-scan`).
- **Domínio:** `Attachment` com `confirmUpload()`, `startScanning()`, `markAvailable(scanResult)`, `markRejected(reasonCode)`, `delete(reason)` — máquina de estados de `AttachmentStatus`.
- **Integrações internas:** `modules/platform/storage` (presign PUT/HEAD/CopyObject/DeleteObject); cliente ClamAV (`modules/platform/antivirus`, protocolo INSTREAM); detector de tipo (`file-type`, allowlist de `packages/types`).
- **Transação:** cada passo (intenção, confirmação, resultado do scan, exclusão) em uma transação curta própria; a chamada ao S3/ClamAV ocorre fora da transação de banco (stream), com a atualização de status feita depois, em transação dedicada.

## Frontend
- **Tela(s):** componente embutido em SCR-006 e SCR-105 (ver Lacuna 1).
- **Componentes:** `AttachmentUploader` (seleção + validação local + barra de progresso via `XMLHttpRequest.upload.onprogress`), `AttachmentList` (status `PENDING_UPLOAD`/`UPLOADED`/`SCANNING`/`AVAILABLE`/`INFECTED`/`REJECTED`), `DeleteAttachmentDialog` (motivo obrigatório).
- **Estados:** enviando (progresso); verificando (`SCANNING`, "Verificando segurança do arquivo…"); disponível; rejeitado (motivo resumido, sem detalhe técnico); erro de rede (permite repetir a partir da intenção).
- **Acessibilidade e responsividade:** progresso anunciado via `aria-live="polite"` a cada 10%; lista de anexos em cartões empilhados em telas estreitas; área de soltar arquivo (*drag-and-drop*) com alternativa de clique acessível por teclado.

## Banco de dados
- **Tabelas:** `attachments` (escrita pela API e pelo worker).
- **Migrações:** nenhuma nova (entities.md §4 já define `attachments`).
- **Índices/constraints relevantes:** `(tenant_id, process_id, created_at DESC)`; `(tenant_id, target_type, target_id)`; `(tenant_id, sha256)`; `(tenant_id, status) WHERE status IN ('PENDING_UPLOAD','UPLOADED','SCANNING')` (usado pelo `maintenance` e pelo alerta de "anexo preso").

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ATT-02 | POST | `/api/v1/attachments` | `{ targetType, targetId, fileName, declaredMimeType, sizeBytes, categoryId?, description? }` + `Idempotency-Key` | `201 { data: Attachment, upload: { url, method, headers, expiresAt } }` | 201, 403, 404, 413, 415, 422, 429, 503 |
| ATT-03 | POST | `/api/v1/attachments/{id}/confirm` | — + `Idempotency-Key` | `202 { data: { status: 'UPLOADED'\|'REJECTED', reasonCode? } }` | 202, 403, 404, 409 |
| ATT-04 | GET | `/api/v1/attachments/{id}` | — | `200 { data: Attachment }` | 200, 403, 404 |
| ATT-06 | DELETE | `/api/v1/attachments/{id}` | `{ deletionReason }` + `If-Match` | `204` | 204, 403, 404, 412, 422 |

## Logs
- `info` `attachment.upload_intent_created` — `attachmentId`, `targetType`, `sizeBytes`, `correlationId`.
- `info` `attachment.scan_completed` — `attachmentId`, `result` (`AVAILABLE`/`INFECTED`/`REJECTED`), `durationMs`.
- `warn` `attachment.scan_retry` — `attachmentId`, `attempt`, `errorClass`.
- `error` `attachment.scan_failed` — `attachmentId`, `errorCode`, `correlationId`.
- **Nunca logar:** nome original do arquivo em nível acima de `debug`, conteúdo do arquivo, assinatura de malware detectada (apenas `scanResult` estruturado no banco).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `attachment.upload_intent` | `DATA_CHANGE` | Commit de `ATT-02` | `metadata`: `targetType`, `targetId`, `fileName`, `sizeBytes` |
| `attachment.confirm` | `DATA_CHANGE` | Commit de `ATT-03` | `metadata`: `attachmentId` |
| `attachment.scan_result` | `SYSTEM` | Worker conclui a varredura | `metadata`: `status`, `reasonCode?`, `sha256` |
| `attachment.delete` | `DATA_CHANGE` | Commit de `ATT-06` | `metadata`: `deletionReason` (hash + tamanho, não o texto) |

## Testes necessários
- **Unitários:** máquina de estados de `Attachment` (todas as transições de `AttachmentStatus`, inclusive as inválidas); validação de allowlist/tamanho; construção de chave (`StorageKeyBuilder`) sempre prefixada por `tenants/{tenantId}/`.
- **Integração (Testcontainers + MinIO + ClamAV real, com EICAR gerado em tempo de execução):** fluxo completo intenção→confirmação→scan→`AVAILABLE`; arquivo EICAR → `INFECTED`; arquivo renomeado (`.pdf` com bytes de executável) → `REJECTED` (`TYPE_MISMATCH`); trava condicional de `SCANNING` sob duas chamadas simultâneas.
- **API/contrato:** respostas conforme a tabela de API; `ATT-02` nunca aceita `storageKey` vindo do corpo.
- **RBAC e multi-tenant:** alvo de outro tenant → 404; exclusão de anexo de terceiro sem `ATTACHMENT_DELETE` → 403; guarda de tenant no `StorageKeyBuilder` rejeita chave fora do tenant do contexto.
- **Concorrência:** duas intenções simultâneas não colidem (`attachmentId` distintos); duas varreduras do mesmo `attachmentId` → uma processa, a outra conclui sem efeito.
- **E2E (Playwright):** upload de um PDF válido até `AVAILABLE`; upload de extensão não permitida bloqueado no seletor; exclusão com motivo.
- **Acessibilidade/performance:** k6 simulando múltiplos uploads simultâneos por tenant → respeita concorrência 3/tenant da fila `file-scan`; varredura de arquivo de 50 MB abaixo de 30 s (p95).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões (`ATTACHMENT_UPLOAD`/`ATTACHMENT_DELETE`) e políticas do alvo aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos (`AttachmentUploaded`/`Rejected`/`Deleted`) verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak" (inclusive guarda de chave de storage)
- [ ] OpenAPI de ATT-02/03/04/06 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de duração de varredura e taxa de rejeição; trace do upload ao resultado do scan
- [ ] Acessibilidade (axe) e responsividade do fluxo de upload verificadas
- [ ] Revisão de código e de segurança aprovadas (ênfase em isolamento de tenant e varredura)
- [ ] Runbook "anexo preso em SCANNING" documentado em observability.md

## Estimativa
**L** — orquestra upload direto a objeto, confirmação, varredura assíncrona com antivírus e promoção entre três buckets com isolamento estrito de tenant; é a base de segurança reaproveitada por todos os módulos que anexam arquivos.

## Prioridade
**P0** — sem upload seguro não há como instruir o processo com evidências externas (propostas, atas, comprovantes), e um antivírus ausente exporia a plataforma a risco de segurança inaceitável para um sistema de governo.
