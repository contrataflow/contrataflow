# `document`

Tipos, templates, documentos, versões imutáveis, renderização e itens de documento (DEC-040).

## Ciclo de vida do documento (US-065 · DEC-017/018)

- **Rotas** (`DocumentController`): DOC-03 `GET /documents/{id}` (mínimo para a SCR-105; a US-062
  completa o painel), DOC-04 `PATCH` (título/responsável do rascunho), DOC-08 `GET …/validation`,
  DOC-09 `POST …/submit`, DOC-10 `POST …/finalize`, DOC-12 `POST …/reopen`, DOC-13
  `POST …/cancel`, DOC-14 `DELETE`. Mutações exigem `If-Match` (412 com `currentVersion`); DOC-09/10
  aceitam `Idempotency-Key`. Respostas `{ data: Document, meta: { allowedActions } }` + `ETag`.
- **Autorização:** a permissão de edição/submissão depende do TIPO (`DOCUMENT_*` nos livres/externos;
  `DFD_*`, `ETP_*`, `TERM_*`, `RISK_*`, `PRICE_RESEARCH_*` nos tipados — `domain/document-permissions.ts`),
  então DOC-04/09/10/14 são `@ImplicitAccess` + `@Policy('POL-02')` e o caso de uso confere tudo
  sobre o processo do documento (`AccessFacade.assertCanOnProcess` — perfil com escopo ∪
  participação, MFA, `access.denied`). DOC-12 declara `DOCUMENT_REOPEN` + POL-11; DOC-13,
  `DOCUMENT_CANCEL` + POL-01 (custódia — `NOT_PROCESS_CUSTODIAN`). Documento de processo não
  visível, excluído ou de outro tenant → 404 `NOT_FOUND`.
- **Ordem das checagens:** 404 → 403 (permissão, custódia/participação) → 409
  `INVALID_PROCESS_STATUS` / 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` → 412 `If-Match` → 409
  `INVALID_STATE` (transição do domínio) → 422 `DOCUMENT_INCOMPLETE`/`WARNINGS_NOT_ACKNOWLEDGED`.

### Padrão `DocumentLifecycleService` (reúso pelos módulos tipados)

`application/document-lifecycle.service.ts` concentra as peças; os comandos
(`application/document.commands.ts`, base `TransactionalCommandHandler` com nome
`document.transition`) e as transições acionadas por outros módulos
(`application/document-approval.transitions.ts`) as combinam, sempre numa ÚNICA transação:

1. `load(tx, id)` — documento + tipo + versão de template + processo (porta
   `DocumentProcessContextRegistry`, implementada por `process`) e a visibilidade (DEC-024).
2. `actorOf(context)` + `authorizePol02`/`authorizeReopen`/`authorizeCancel`.
3. `assertVersion(context, ifMatch)`.
4. Transição pura do domínio (`domain/document.ts` — a tabela de DEC-018) via `transition(() => …)`:
   recusa vira 409 `INVALID_STATE`/`DOCUMENT_NOT_EDITABLE`. Nunca se muda `status` fora dela
   (RN-DOC-41).
5. `evaluate(tx, context)` — completude genérica (`domain/document-completeness.ts`) + o
   `DocumentValidator` do módulo tipado, num único `violations[]`; `gateCompleteness` decide.
6. `save(tx, next, expectedVersion)` — `UPDATE … WHERE version = esperada` ANTES de criar a versão:
   o perdedor de duas transições simultâneas recebe 412 sem gravar nada (FKs de versão/aprovação
   são `DEFERRABLE`).
7. `createVersion(…)` — snapshot (entities.md §5.3.2) com `contentHash` = SHA-256 do JSON canônico
   (RFC 8785); `UPLOADED` congela o arquivo da versão corrente.
8. Auditoria (`document.*`, texto livre só como hash + tamanho) → outbox (`Document*`, routing key
   `document.<fato>.<tipo>`; a timeline projeta no mesmo `tx`).

`meta.allowedActions` vem de `allowedDocumentActions` (função pura do domínio — a mesma para o
painel da US-062 e para o visualizador): `UPDATE`, `FINALIZE` | `SUBMIT` (conforme
`requiresApproval`), `REOPEN`, `CANCEL`, `DELETE`. A retirada (`WITHDRAW`, DOC-11) entra com a
US-053 — a transição `withdrawSubmission` já existe no domínio.

### Porta `DocumentValidator` (módulos tipados: DFD, ETP, TR, mapa de riscos, pesquisa de preços)

Declarada em `application/document.ports.ts`; o módulo tipado (nível 4, importa `DocumentModule`)
implementa e registra no `onModuleInit`:

```ts
@Injectable()
export class DfdDocumentValidator implements DocumentValidator {
  readonly module = 'DFD';
  // RN-DOC-51 b: códigos com o prefixo do módulo, no formato único de violations[] (api.md §2.1.2).
  async validate(tx, { document, type, template }) { return [/* DFD_ITEMS_REQUIRED … */]; }
  // RN-DOC-52: resumo serializável para DocumentFinalized (só STRUCTURED); null = omitido.
  async typedSummary(tx, subject) { return { itemsCount: 3 }; }
  // Cabeçalho tipado e coleções congelados no snapshot; também liga a checagem dos campos
  // obrigatórios do cabeçalho (`fieldConfig[k].required` do template).
  async snapshotParts(tx, subject) { return { header: { … }, collections: { items: [ … ] } }; }
}
// no módulo dfd: onModuleInit() { this.documents.registerValidator(this.validator); }
```

Tudo roda no `tx` do caso de uso (RLS), sem I/O externo. Um validador por `SystemDocumentModule`
(`DocumentValidatorRegistry` recusa o segundo). Tipo estruturado sem validador usa só as regras
genéricas — a ausência de registro nunca falha a ação.

### Criação, singularidade e aprovações

- `DocumentFacade.createIn(tx, input)` (`DocumentCreationService`) é o ÚNICO ponto de criação:
  tipo ativo, processo do tenant, `singletonKey = documentTypeId` quando
  `allowMultiplePerProcess = false` (409 `DOCUMENT_ALREADY_EXISTS`; o índice único parcial
  `documents_singleton_key` decide a corrida), número por último (DEC-028), `document.create` e
  `DocumentCreated`. Autorização de criação e etapa são de quem chama (DOC-02 na US-063/064).
- Submissão avulsa (DOC-09): a `Approval` (`subjectType = DOCUMENT`) é aberta no mesmo `tx` pela
  porta `DocumentApprovalRegistry` (`#shared/document/document-approval.ts`), implementada pelo
  módulo `approval` (resolução do aprovador pela `approvalPolicy`; titular da unidade, evento
  `ApprovalRequested` e concessão `APPROVER` ficam para a US-051).
- Tramitação/aprovação (US-047/051/052): `DocumentFacade.enterApprovalStageIn` (RN-DOC-44) e
  `applyApprovalDecisionIn` (RN-DOC-45), no `tx` de quem chama.
- **Banco:** migração `20261016130000_documents` — `documents`, `document_versions` (só INSERT,
  gatilho `document_versions_append_only`), `approvals`, `approval_documents`; RLS; FKs compostas
  por tenant; cancelado é final (gatilho); exclusão só lógica. Testes com PostgreSQL:
  `test/tenant-leak/documents.spec.ts`.
