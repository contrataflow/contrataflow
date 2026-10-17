# 3.12 Comentários e anexos (`collaboration`, `files`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| CMT-01 | GET | `/processes/{id}/comments` | `PROCESS_VIEW` | US-071 |
| CMT-02 | POST | `/processes/{id}/comments` | `COMMENT_CREATE` | US-071, US-072 |
| CMT-03 | PATCH | `/comments/{id}` | autor, ≤15 min | US-071 |
| CMT-04 | DELETE | `/comments/{id}` | autor ou `COMMENT_MODERATE` | US-071 |
| CMT-05 | GET | `/processes/{id}/mention-candidates` | `COMMENT_CREATE` | US-072 |
| ATT-01 | GET | `/processes/{id}/attachments` | `PROCESS_VIEW` | US-069 |
| ATT-02 | POST | `/attachments` | `ATTACHMENT_UPLOAD` + alvo editável | US-068 |
| ATT-03 | POST | `/attachments/{id}/confirm` | uploader | US-068 |
| ATT-04 | GET | `/attachments/{id}` | `PROCESS_VIEW` | US-068, US-069 |
| ATT-05 | GET | `/attachments/{id}/download` | `PROCESS_VIEW` + POL-09 | US-069 |
| ATT-06 | DELETE | `/attachments/{id}` | `ATTACHMENT_UPLOAD` (próprio) ou `ATTACHMENT_DELETE` | US-068 |

### CMT-01 — Listar comentários
`GET /api/v1/processes/{id}/comments` · **Permissão:** `PROCESS_VIEW` · **Story:** US-071
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório); query `cursor` (opaco, opcional); `limit` (int ≤100, opcional); `targetType` (`CommentTargetType`, opcional); `documentId` (uuid, opcional); `sectionKey` (texto, opcional); `parentId` (uuid, opcional)
- **Request:** —
- **Response:** `200 { data: [Comment], meta: { nextCursor, hasMore } }`, cada item com `replies[]` e `replyCount`; `Comment { id, processId, targetType, document: { id, code, title } | null, sectionKey, parentId, author: { id, name, departmentName }, body | null, bodyMasked, createdAt, editedAt, isDeleted, deletedByModerator, deletionReason (só autor/moderador), canEdit, editableUntil, canDelete, canModerate, version }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Processo inexistente, outro tenant ou não visível |
  | 422 | `VALIDATION_ERROR` | `cursor`/`limit`/filtros inválidos |
- **Efeitos:** —
- **Notas:** leitura; não gera auditoria.

### CMT-02 — Criar comentário
`POST /api/v1/processes/{id}/comments` · **Permissão:** `COMMENT_CREATE` · **Story:** US-071, US-072
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ body: RichText (TipTap JSON restrito, obrigatório, ≤10.000 caracteres de texto, JSON ≤100 KB, nós/marcas/atributos do schema permitido — RN-CMT-03..06; pode conter nós mention com attrs { kind: 'USER'|'DEPARTMENT', id, label }; links apenas http/https/mailto); targetType: CommentTargetType ('PROCESS'|'DOCUMENT', obrigatório); documentId?: uuid (obrigatório se targetType='DOCUMENT' — RN-CMT-01); sectionKey?: string (SCREAMING_SNAKE, opcional, deve existir no template do documento); parentId?: uuid (opcional, mesmo alvo do comentário pai — RN-CMT-02) }`
- **Response:** `201 { data: Comment }` (shape de CMT-01) + `mentions: [{ id, kind, targetId }]` · `Location`, `ETag`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `COMMENT_CREATE` |
  | 404 | `PROCESS_NOT_FOUND` | Processo inexistente/não visível |
  | 409 | `INVALID_PROCESS_STATUS` | Processo em status final (comentários somente leitura) |
  | 409 | `INVALID_STATE` | Documento `CANCELED` |
  | 422 | `VALIDATION_ERROR` | `body` vazio/>10.000 caracteres; `documentId`/`parentId` inválidos (`REFERENCE_NOT_FOUND`); alvo da resposta diverge do pai |
  | 422 | `RICH_TEXT_INVALID` | Nó/marca/atributo fora do schema; JSON >100 KB; link com protocolo não permitido; nó `mention` fora do schema |
  | 422 | `SECTION_NOT_IN_TEMPLATE` | `sectionKey` inexistente no template ou em documento externo |
  | 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |
- **Efeitos:**
  - Eventos: `CommentCreated` (`comment.created`; `commentId`, `targetType`, `documentId?`, `sectionKey?`, `parentId?`, `parentAuthorId?`) · `UserMentioned` (`comment.user_mentioned`, um por `Mention` novo; `commentId`, `mentionId`, `mentionedUserId?`, `mentionedDepartmentId?`; sem entrada de timeline — RN-CMT-25)
  - Timeline/projeção síncrona: `COMMENT_ADDED`
  - Auditoria: `comment.create` (`DATA_CHANGE`; `changes.body = { sha256, length }`; `metadata`: `processCode`, `targetType`, `documentCode?`, `sectionKey?`, `parentId?`, `idempotencyKey`, `mentionedUserIds[]`, `mentionedDepartmentIds[]`) · `access.denied` (`reasonCode = COMMENT_CREATE`)
- **Notas:** alvo de menção sem visibilidade do processo ou inativo no commit não bloqueia a publicação — o comentário é salvo normalmente e a menção não recebe link (RN-CMT-22, silenciosa).

### CMT-03 — Editar comentário
`PATCH /api/v1/comments/{id}` · **Permissão:** autor do comentário, dentro de 15 minutos · **Story:** US-071
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ body: RichText (mesmas regras de CMT-02, obrigatório) }`
- **Response:** `200 { data: Comment }` · `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Usuário não é o autor |
  | 404 | `COMMENT_NOT_FOUND` | Inexistente/outro tenant |
  | 409 | `COMMENT_EDIT_WINDOW_EXPIRED` | Janela de 15 min de edição vencida |
  | 409 | `INVALID_STATE` | Comentário já excluído |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` / `RICH_TEXT_INVALID` | Corpo inválido (mesmas regras de CMT-02) |
- **Efeitos:** Evento `CommentUpdated` (`comment.updated`; `commentId`) e, se houver novas menções, `UserMentioned`; auditoria `comment.update` (`DATA_CHANGE`; `changes.body` antes/depois como `{ sha256, length }`)
- **Notas:** api.md §2.2 define o código dedicado `COMMENT_EDIT_WINDOW_EXPIRED` (409) para o vencimento da janela de edição, mas a tabela de validações/erros da própria US-071 (V-10) usa `INVALID_STATE` para esse caso — inconsistência entre a story e o catálogo genérico; esta especificação segue a story (fonte principal da tarefa) e sinaliza a divergência para reconciliação na implementação.

### CMT-04 — Excluir ou moderar comentário
`DELETE /api/v1/comments/{id}` · **Permissão:** autor do comentário ou `COMMENT_MODERATE` · **Story:** US-071
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ reason?: string (10–1.000 caracteres; obrigatório quando a exclusão é moderação, isto é, ator ≠ autor) }`
- **Response:** `204`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Nem autor nem `COMMENT_MODERATE` |
  | 404 | `COMMENT_NOT_FOUND` | Inexistente/outro tenant |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` (`REQUIRED`) | `reason` ausente ou fora de 10–1.000 na moderação |
- **Efeitos:** Evento `CommentDeleted` (`comment.deleted`; `byModerator: boolean`); projeção síncrona `COMMENT_REMOVED` quando moderação; auditoria `comment.delete` (`DATA_CHANGE`; exclusão pelo autor; `metadata`: `processCode`, `hadReplies`) ou `comment.moderate` (`DATA_CHANGE`; remoção por moderador; `metadata`: `processCode`, `authorId`, `reason`); `access.denied` (`reasonCode = COMMENT_MODERATE`)
- **Notas:** —

### CMT-05 — Buscar candidatos de menção
`GET /api/v1/processes/{id}/mention-candidates` · **Permissão:** `COMMENT_CREATE` · **Story:** US-072
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório); query `q` (texto, obrigatório, mín. 1 caractere, digitado após "@")
- **Request:** —
- **Response:** `200 { data: [{ kind: 'USER'|'DEPARTMENT', id, label, secondaryLabel? }] }` (máx. 10 itens)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `COMMENT_CREATE` |
  | 404 | `PROCESS_NOT_FOUND` | Processo não visível |
  | 422 | `VALIDATION_ERROR` | `q` com menos de 1 caractere |
- **Efeitos:** —
- **Notas:** alimenta o autocomplete do compositor de comentários; visibilidade do alvo é revalidada no commit do comentário (CMT-02), não aqui.

### ATT-01 — Listar anexos
`GET /api/v1/processes/{id}/attachments` · **Permissão:** `PROCESS_VIEW` · **Story:** US-069
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório); query `targetType?` (`AttachmentTargetType`: `DOCUMENT`\|`DOCUMENT_VERSION`\|`PROCESS`\|`MOVEMENT`\|`RISK`\|`PRICE_SOURCE`\|`COMMENT`); `targetId?` (uuid, exige `targetType`); `categoryId?` (uuid, item ativo do catálogo); paginação padrão (api.md §1.2)
- **Request:** —
- **Response:** `200 { data: Attachment[], meta }`; `Attachment { id, processId, targetType, targetId, fileName, extension, declaredMimeType, sizeBytes, categoryId?, description?, status: AttachmentStatus, reasonCode?, sha256?, createdAt, uploadedAt?, scannedAt?, uploadedById, version }` — `reasonCode` (US-068) é o motivo resumido de `INFECTED`/`REJECTED` (`AttachmentReasonCode`, nunca a assinatura do malware); chaves de storage e o resultado bruto do antivírus nunca saem na API
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` |
  | 404 | `NOT_FOUND` | Processo inexistente/outro tenant |
  | 422 | `VALIDATION_ERROR` | `targetType` fora do enum ou paginação fora dos limites |
- **Efeitos:** —
- **Notas:** —

### ATT-02 — Registrar intenção de upload
`POST /api/v1/attachments` · **Permissão:** `ATTACHMENT_UPLOAD` + alvo editável · **Story:** US-068
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ targetType: AttachmentTargetType (obrigatório); targetId: uuid (obrigatório, existente/visível/editável); fileName: string (obrigatório); declaredMimeType: string (obrigatório); sizeBytes: number (obrigatório); categoryId?: uuid (item ativo do catálogo `ATTACHMENT_CATEGORY`); description?: string (≤500) }`
- **Response:** `201 { data: Attachment, upload: { url, method, headers, expiresAt } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `ATTACHMENT_UPLOAD` |
  | 404 | `NOT_FOUND` | Alvo inexistente/não visível |
  | 409 | `DOCUMENT_NOT_EDITABLE` | Alvo `DOCUMENT`/`DOCUMENT_VERSION` não editável (POL-02) |
  | 409 | `INVALID_PROCESS_STATUS` | Alvo `PROCESS`/`MOVEMENT`/`RISK`/`PRICE_SOURCE`/`COMMENT` com processo em status final |
  | 413 | `FILE_TOO_LARGE` | Tamanho acima de `uploads.maxFileSizeMb` |
  | 415 | `FILE_TYPE_NOT_ALLOWED` | Extensão/MIME fora da allowlist do tenant |
  | 422 | `VALIDATION_ERROR` | Arquivo vazio |
  | 422 | `STORAGE_QUOTA_EXCEEDED` | Upload acima do limite de armazenamento do tenant (api.md §2.2; limite técnico — valor em `storage.md` §8, PEND-17) |
- **Efeitos:** Auditoria `attachment.upload_intent` (`DATA_CHANGE`; `metadata`: `targetType`, `targetId`, `fileName`, `sizeBytes`); nenhum evento de domínio nesta chamada
- **Notas:** quando o alvo é um documento com confidencialidade `RESTRICTED`, o acesso ao anexo (download, ver ATT-05) herda a exigência de POL-09 do documento — não há mascaramento de campo, apenas bloqueio de acesso.
- **Implementação (US-068):** `upload.headers` traz o `Content-Type` assinado (o navegador o envia exatamente assim; o `Content-Length` também é assinado e o S3 recusa outro tamanho). Alvos com leitor registrado: `PROCESS` (processo visível e fora de status final) e `DOCUMENT`/`DOCUMENT_VERSION` (POL-02 de edição + documento `DRAFT`/`RETURNED`); os demais tipos respondem 404 até o módulo dono registrar o seu leitor (`AttachmentTargetRegistry` — `price-research`, `collaboration`, `risk`, ativos do tenant). A quota compara a soma de `sizeBytes` em `UPLOADED`/`SCANNING`/`AVAILABLE`/`DELETED` com `STORAGE_TENANT_QUOTA_GB` (padrão 50 — PEND-17).

### ATT-03 — Confirmar upload
`POST /api/v1/attachments/{id}/confirm` · **Permissão:** uploader (autor da intenção) · **Story:** US-068
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `202 { data: { status: 'UPLOADED'|'REJECTED', reasonCode? } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Ator não é o uploader |
  | 404 | `NOT_FOUND` | Intenção inexistente/outro tenant |
  | 409 | `UPLOAD_NOT_RECEIVED` | Sem objeto na quarentena |
- **Efeitos:**
  - Dispara job assíncrono `file-scan`; resposta imediata `REJECTED` com `reasonCode = SIZE_MISMATCH` quando o tamanho confirmado diverge do declarado
  - Eventos (assíncronos, ao fim do scan): `AttachmentUploaded` (`attachment.uploaded`, promoção a `AVAILABLE`; `attachmentId`, `targetType`, `targetId?`, `fileName`, `sizeBytes`, `sha256`) · `AttachmentRejected` (`attachment.rejected`, varredura resulta `INFECTED`/`REJECTED`; `attachmentId`, `status`, `reasonCode`)
  - Auditoria: `attachment.confirm` (`DATA_CHANGE`; `metadata.attachmentId`) e, ao final do scan, `attachment.scan_result` (`SYSTEM`; `metadata`: `status`, `reasonCode?`, `sha256`)
- **Notas:** `202` reflete processamento assíncrono; o cliente deve consultar ATT-04 para conhecer o status final (`AVAILABLE`); `reasonCode` observados na story: `SIZE_MISMATCH`, `INFECTED`, `TYPE_MISMATCH`.

### ATT-04 — Obter anexo
`GET /api/v1/attachments/{id}` · **Permissão:** `PROCESS_VIEW` · **Story:** US-068, US-069
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Attachment }` (sem URL de download; shape de ATT-01)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` |
  | 404 | `NOT_FOUND` | Inexistente/outro tenant/não visível |
- **Efeitos:** —
- **Notas:** para baixar o arquivo, ver ATT-05 (inclui herança de POL-09 quando o alvo é documento `RESTRICTED`).

### ATT-05 — Baixar anexo
`GET /api/v1/attachments/{id}/download` · **Permissão:** `PROCESS_VIEW` + política POL-09 (quando o alvo é documento sigiloso) · **Story:** US-069
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: { url, expiresAt } }` — URL assinada, validade 300 s, `expiresAt` ISO 8601 UTC
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem POL-09 sobre alvo sigiloso |
  | 404 | `NOT_FOUND` | Inexistente/outro tenant/não visível |
  | 409 | `ATTACHMENT_NOT_AVAILABLE` | Anexo ainda não está `AVAILABLE` |
- **Efeitos:** Auditoria `attachment.download` (`EXPORT`; registrada antes de devolver a URL; `metadata`: `fileName`, `sizeBytes`, `targetType`, `targetId`)
- **Notas:** anexos de documentos com confidencialidade `RESTRICTED` herdam a exigência de POL-09 do documento (acesso bloqueado por completo em 403, sem campo mascarado — diferente da máscara monetária de api.md §1.4).

### ATT-06 — Excluir anexo
`DELETE /api/v1/attachments/{id}` · **Permissão:** `ATTACHMENT_UPLOAD` (próprio) ou `ATTACHMENT_DELETE` · **Story:** US-068
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ deletionReason: string (obrigatório) }`
- **Response:** `204`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Nem uploader nem `ATTACHMENT_DELETE` |
  | 404 | `NOT_FOUND` | Inexistente/outro tenant |
  | 409 | `ATTACHMENT_NOT_AVAILABLE` | Anexo fora de `AVAILABLE` (ainda em verificação ou rejeitado — US-068) |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` (`REQUIRED`) | `deletionReason` ausente |
- **Efeitos:** Evento `AttachmentDeleted` (`attachment.deleted`; `attachmentId`, `hasReason`); auditoria `attachment.delete` (`DATA_CHANGE`; `metadata.deletionReason` armazenado como hash + tamanho, não o texto)
- **Notas:** —
