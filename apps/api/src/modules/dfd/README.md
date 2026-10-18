# `dfd`

Documento de Formalização da Demanda (DEC-040, nível 4). Dono de `Dfd` — o cabeçalho tipado 1:1 do
`Document` do tipo `DFD` (Decreto 10.947/2022, art. 8º). Primeiro documento tipado do produto: o
padrão aqui é o que ETP, TR, pesquisa de preços e mapa de riscos repetem.

## US-014 — Elaborar DFD em wizard (DFD-01/02/03)

- **Rotas** (`presentation/dfd.controller.ts`): DFD-01 `GET /processes/{id}/dfds`, DFD-02
  `POST /processes/{id}/dfds` (Idem.), DFD-03 `GET /dfds/{id}`. Contratos em
  `packages/validation/src/dfd/` (`dfdSchema`, `dfdMetaSchema` — com `template`, `dfdCreateSchema`,
  `dfdStepIssues`, `evaluateDfdCompleteness`).
- **id do DFD = id do documento** (CHECK `dfds_id_is_document`): a SCR-007
  (`/processos/{id}/dfd/{dfdId}`) e o painel de documentos usam o mesmo identificador; seções, itens
  (DOC-06/07), validação (DOC-08) e prévia (DOC-20) são os endpoints genéricos do `document`.
- **Criação** (`CreateDfdCommand`, uma transação): `DocumentFacade.createStructuredIn` (template
  publicado, `DFD_CREATE` + custódia POL-01 + POL-02, singular 409, número, `document.create`,
  `DocumentCreated` `document.created.dfd`, timeline) → `createDfdFromProcess` (RN-DFD-05, valores do
  processo por `ProcessFacade.dfdDefaultsIn`, data de hoje no fuso do tenant) → `dfds`. Falha em
  qualquer ponto desfaz tudo, inclusive o número (`test/tenant-leak/dfds.spec.ts`). Log
  `dfd.created`, métrica `dfd_created_total`, `dfd.create_failed` pela base do comando.
- **Completude** (`DfdDocumentValidator`, registrado no `onModuleInit`): a função pura
  `evaluateDfdCompleteness` (a MESMA do wizard), alimentada com os itens do documento, o vínculo do
  responsável, o setor e os anexos em verificação. `typedSummary` (cartão do painel) e
  `snapshotParts` (cabeçalho + itens no snapshot/PDF). O contribuidor `DfdRuleContextContributor`
  publica `documents.DFD.isComplete` para o `workflow` com a mesma avaliação (`isCompleteIn`).
- **POL-09**: a estimativa sai `null` + `estimatedValueMasked: true` em processo sigiloso para quem
  não vê o orçamento (`DocumentFacade.typedDocumentIn` → `canViewConfidentialBudget`).
- **Testes**: `domain/dfd.spec.ts`, `presentation/dfd.routes.spec.ts` (8 categorias do Gherkin +
  FA-02/05/06/09/10/11) e `test/tenant-leak/dfds.spec.ts` (PostgreSQL).
- **Fora desta story**: DFD-04 (cabeçalho), DOC-05 (seções — autosave e conflito) = US-015;
  conclusão/aprovação = US-016/017; duplicação = US-018.
