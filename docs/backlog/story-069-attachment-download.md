---
id: US-069
title: "Visualizar e baixar anexos"
epic: EP-011
feature: FT-042
mvp: 1
priority: P0
estimate: S
status: Especificada
depends_on: [US-068]
modules: [files]
screens: [SCR-006, SCR-105]
endpoints: [ATT-01, ATT-04, ATT-05]
permissions: [PROCESS_VIEW]
events: []
---

# US-069 — Visualizar e baixar anexos

## Título
Visualizar e baixar anexos

## Descrição
**Como** usuário com acesso ao processo, **quero** ver os anexos vinculados a cada registro (processo, documento, versão, pesquisa de preços, comentário, tramitação, risco) e baixá-los ou pré-visualizá-los quando possível, **para** consultar evidências e arquivos externos sem depender de quem fez o upload. Cobre a listagem (`ATT-01`), o detalhe (`ATT-04`) e o download por URL pré-assinada (`ATT-05`) de anexos já `AVAILABLE` (US-068); PDF, PNG e JPEG têm prévia inline, os demais formatos oferecem apenas download.

## Contexto
O upload seguro (US-068) só tem valor se o arquivo puder ser consultado depois. O fluxo de download segue DEC-136 e está detalhado em storage.md §6: autorização por visibilidade do processo (DEC-024) e sigilo (POL-09), checagem de estado, auditoria **antes** da assinatura e entrega sempre como `attachment` (nunca inline no S3, para evitar *MIME sniffing* e scripts embutidos em PDFs de terceiros).

## Objetivo
100% dos anexos `AVAILABLE` visíveis ao usuário podem ser baixados em poucos segundos, com trilha de auditoria completa e sem expor anexos de outro tenant ou de alvos sigilosos a quem não tem permissão.

## Persona
- **Principal:** qualquer perfil com `PROCESS_VIEW` do processo (redator, aprovador, consultor externo, auditor/controle interno).

## Pré-condições
- O anexo existe (qualquer status, US-068) e o usuário tem `PROCESS_VIEW` do processo (DEC-024); se o alvo for `RESTRICTED`, também `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (POL-09).

## Fluxo principal
1. O usuário abre uma tela que exibe o alvo (documento em SCR-105, pesquisa de preços, comentário, etc.) ou a lista de anexos do processo; o front chama `ATT-01` (lista, filtrável por `targetType`/`targetId`) ou já possui o `id` e chama `ATT-04` (detalhe).
2. Para anexos com MIME diretamente renderizável, o front busca a URL (`ATT-05`) e renderiza a prévia com `pdf.js`/`<img>` via `fetch` (CORS do bucket de anexos).
3. O usuário clica em **"Baixar"**; o front chama `ATT-05`.
4. A API confere visibilidade e POL-09, verifica `AVAILABLE`, grava a auditoria `attachment.download` e assina a URL (300 s, `Content-Disposition: attachment`, nome original), respondendo `200 { data: { url, expiresAt } }`.
5. O front navega para a URL; o navegador baixa o arquivo com o nome e o tipo detectado.

## Fluxos alternativos
- **FA-01 — Prévia ou disponibilidade:** formato fora de `{pdf, png, jpg, jpeg}` mostra "Sem prévia disponível — baixar arquivo"; status `PENDING_UPLOAD`/`UPLOADED`/`SCANNING` exibe "Arquivo em verificação. Tente novamente em instantes." sem botão de download ativo.
- **FA-02 — URL expirada:** usuário demora mais de 300 s para clicar; o front solicita uma nova URL (`ATT-05`) de forma transparente, gerando novo registro de auditoria.

## Regras de negócio
- **RN-DOC-81** — Listagem (`ATT-01`): retorna os anexos do processo visíveis ao usuário (DEC-024), excluindo por padrão os `DELETED`; aceita filtro por `targetType`/`targetId`/`categoryId` e paginação (api.md §1.2); ordenação padrão `-createdAt`.
- **RN-DOC-82** — Detalhe (`ATT-04`): retorna metadados (nome, extensão, tamanho, categoria, status, uploader, data); nunca expõe `storageKey`/`quarantineKey` nem uma URL de download — isso só existe em `ATT-05`.
- **RN-DOC-83** — Download (`ATT-05`) exige `status = AVAILABLE` verificado no momento da chamada (nunca a partir de uma lista em cache do cliente); fora disso, `409 ATTACHMENT_NOT_AVAILABLE`.
- **RN-DOC-84** — Assinatura: `presignGet` por no máximo 300 s, `ResponseContentDisposition: attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>` (RFC 6266/8187), `ResponseContentType` = `detectedMimeType` (nunca o declarado) e `ResponseCacheControl: private, no-store` (storage.md §6).
- **RN-DOC-85** — A auditoria `attachment.download` (categoria `EXPORT`) é gravada **antes** de devolver a URL; falha ao gravar cancela a resposta (`503 DEPENDENCY_UNAVAILABLE`) — nunca existe URL sem trilha.
- **RN-DOC-86** — Prévia inline usa a mesma URL de `ATT-05` com `pdf.js`/`<img>` por `fetch` (exige CORS do bucket de anexos para a origem da aplicação). Quando o alvo (`Document`/`PriceSource`) tem `confidentiality = RESTRICTED` (DEC-030), detalhe e download exigem POL-09; diferente de campo monetário, o arquivo não é mascarado — sem a política, a resposta é `403 PERMISSION_DENIED` (`reasonCode = POL-09`). Essa herança de POL-09 por anexos é tratada como **proposta** em storage.md §6 (não confirmada em permissions.md — ver Lacunas).

## Campos
| Campo (UI/API) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Filtros da listagem | `targetType?`, `targetId?`, `categoryId?` | enum/uuid | Não | `targetId` exige `targetType`; itens ativos | — |
| *(sistema)* URL e validade | `url`, `expiresAt` | string/timestamp | — | assinada, 300 s, ISO 8601 UTC | gerado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `targetType` fora do enum ou paginação fora dos limites (api.md §1.2) | API | "Filtro ou página inválida." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `PROCESS_VIEW` sobre o processo do anexo (DEC-024); MFA não exigido (leitura).
- **Políticas:** POL-09 quando o alvo do anexo for `Document`/`PriceSource` com `confidentiality = RESTRICTED` (RN-DOC-86).
- **Sem permissão:** processo não visível → anexo não aparece em listas e `ATT-04`/`ATT-05` respondem 404; processo visível mas sem POL-09 sobre alvo sigiloso → 403 `PERMISSION_DENIED` (`reasonCode = POL-09`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio; apenas auditoria `attachment.download` (RN-DOC-85) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma |

## Critérios de aceite em Gherkin
```gherkin
Feature: Visualizar e baixar anexos

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui "PROCESS_VIEW" sobre o processo "0012/2026"
    And existe o anexo "parecer.pdf" com status "AVAILABLE" vinculado ao documento "ETP 0003/2026"

  Scenario: [Sucesso] Baixar anexo disponível
    When o usuário solicitar o download do anexo "parecer.pdf"
    Then a API deve responder 200 com "url" assinada (300 s) e "Content-Disposition: attachment"
    And deve gerar auditoria "attachment.download" antes de devolver a URL
  Scenario: [Validação] Anexo ainda em verificação
    Given que o anexo "planilha.xlsx" está com status "SCANNING"
    When o usuário solicitar o download
    Then a API deve responder 409 com código "ATTACHMENT_NOT_AVAILABLE"
  Scenario: [Permissão] Usuário sem acesso ao processo
    Given que "Bruno" não tem "PROCESS_VIEW" sobre o processo "0012/2026"
    When "Bruno" solicitar o download do anexo "parecer.pdf"
    Then a API deve responder 404 sem revelar que o anexo existe
  Scenario: [Tenant incorreto] Anexo de outro tenant
    Given que o anexo "orcamento.pdf" pertence ao tenant "Prefeitura B"
    When um usuário do tenant "Prefeitura de São José" solicitar esse anexo pelo id
    Then a API deve responder 404 sem ler ou alterar dados do tenant "Prefeitura B"
  Scenario: [Duplicidade] Reenvio da mesma solicitação de download
    When o usuário solicitar o download do anexo "parecer.pdf" duas vezes em seguida
    Then a API deve responder 200 nas duas vezes, cada uma com URL e registro de auditoria próprios
  Scenario: [Concorrência] Anexo excluído entre a listagem e o download
    Given que o usuário viu "parecer.pdf" como "AVAILABLE" na listagem e, em seguida, outro usuário o excluiu
    When o usuário clicar em "Baixar"
    Then a API deve responder 409 com código "ATTACHMENT_NOT_AVAILABLE"
  Scenario: [Falha de banco] Banco indisponível ao gravar a auditoria
    Given que o banco de dados fica indisponível ao gravar o registro de auditoria
    When o usuário solicitar o download do anexo "parecer.pdf"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e nenhuma URL deve ser devolvida
  Scenario: [Falha de integração] Object storage indisponível
    Given que o serviço de object storage (S3) está indisponível
    When o usuário solicitar o download do anexo "parecer.pdf"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Anexo não `AVAILABLE` | 409 | `ATTACHMENT_NOT_AVAILABLE` | "Arquivo em verificação. Tente novamente em instantes." | Desabilita "Baixar"; sugere atualizar |
| Sem POL-09 sobre alvo sigiloso | 403 | `PERMISSION_DENIED` | "Você não tem permissão para baixar este arquivo." | Oculta botão quando souber do sigilo de antemão |
| Não visível/outro tenant | 404 | `NOT_FOUND` | "Anexo não encontrado." | Remove da lista local |
| Banco/S3 indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível baixar o arquivo agora. Tente novamente em instantes." | Botão "Tentar novamente"; exibe correlationId |

## Dependências
- **Stories:** US-068 (upload seguro — origem do anexo e dos status `AttachmentStatus`).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-034, DEC-136; ADR-006.
- **Configurações:** nenhuma específica desta story (reaproveita `uploads.*` de US-068).
- **Lacunas nas fontes canônicas:** nenhuma (herança de POL-09 por anexos de documento `RESTRICTED` ratificada em permissions.md, POL-09).

## Impacto técnico
Exige CORS do **bucket de anexos** (não só o de `renditions`) liberando `GET` para a origem da aplicação, para que `pdf.js`/`<img>` consigam buscar os bytes via `fetch` e renderizar a prévia mesmo com `Content-Disposition: attachment` na resposta assinada (o cabeçalho só afeta navegação direta, não `fetch`). Nenhuma migração de banco; feature é somente leitura sobre dados de US-068.

## Backend
- **Módulo(s):** `files` (dono); usa `access` (`AuthorizationService`, POL-09), `audit` (`AuditService`, síncrono antes do presign), `platform` (`StorageService.presignGet`).
- **Casos de uso:** `ListAttachmentsQuery`, `GetAttachmentQuery`, `RequestAttachmentDownloadCommand`.
- **Domínio:** nenhuma regra nova de agregado; apenas leitura do `Attachment` (US-068) e orquestração da assinatura.
- **Integrações internas:** `StorageService.presignGet` (300 s, `ResponseContentDisposition`/`ResponseContentType`/`ResponseCacheControl`).
- **Transação:** autoriza → confere `status = AVAILABLE` → grava auditoria → assina URL; qualquer falha interrompe antes de expor a URL.

## Frontend
- **Tela(s):** SCR-006 (onde o alvo aparece) e SCR-105 (documento livre/externo).
- **Componentes:** `AttachmentList`, `AttachmentViewer` (pdf.js/imagem), botão "Baixar".
- **Estados:** loading (skeleton), vazio ("Nenhum anexo"), erro, prévia indisponível.
- **Acessibilidade e responsividade:** `aria-label` com nome e tamanho do arquivo; foco visível no link de download; lista em coluna única < 768 px.

## Banco de dados
- **Tabelas:** nenhuma nova; leitura de `attachments` (entities.md, US-068).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita `(tenant_id, process_id, created_at DESC)` e `(tenant_id, target_type, target_id)` de `attachments`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ATT-01 | GET | `/processes/{id}/attachments` | query `targetType?`, `targetId?`, `categoryId?`, paginação | `200 { data: Attachment[], meta }` | 200, 403, 404, 422 |
| ATT-04 | GET | `/attachments/{id}` | — | `200 { data: Attachment }` (sem URL) | 200, 403, 404 |
| ATT-05 | GET | `/attachments/{id}/download` | — | `200 { data: { url, expiresAt } }` | 200, 403, 404, 409, 429, 503 |

## Logs
- `info` `attachment.download_issued` — `attachmentId`, `processId`, `userId`, `sizeBytes`, `expiresAt`, `correlationId`.
- `warn` `attachment.download_denied_confidential` — quando bloqueado por POL-09.
- `error` `attachment.download_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** a URL assinada completa, nome original do arquivo em logs de nível `info` agregados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `attachment.download` | `EXPORT` | Antes de devolver a URL assinada | `metadata`: `fileName`, `sizeBytes`, `targetType`, `targetId` |

## Testes necessários
- **Unitários:** regra de estado (`AVAILABLE` obrigatório); montagem do nome de arquivo RFC 6266/8187 com acentos.
- **Integração (Testcontainers + MinIO):** presign real; auditoria gravada antes da URL; falha de auditoria impede a URL.
- **API/contrato:** respostas conforme api.md; snapshot do OpenAPI de `ATT-01`/`ATT-04`/`ATT-05`.
- **RBAC, multi-tenant e concorrência:** outro tenant → 404; sem POL-09 sobre alvo `RESTRICTED` → 403; exclusão do anexo entre listagem e download → 409 na chamada fresca.
- **E2E (Playwright) e performance:** baixar e pré-visualizar um PDF; baixar um CSV (sem prévia); emissão da URL com p95 < 300 ms, respeitando 20 req/min (api.md §1.6).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PROCESS_VIEW` e POL-09 aplicados na API; UI oculta/desabilita conforme regras
- [ ] Auditoria `attachment.download` verificada como anterior à emissão da URL em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `ATT-01`, `ATT-04` e `ATT-05` compatível com api.md
- [ ] CORS do bucket de anexos validado para prévia via `pdf.js`
- [ ] Logs sem dados sensíveis; métricas de latência de emissão de URL
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**S** — reaproveita toda a infraestrutura de upload/armazenamento de US-068; adiciona apenas leitura, assinatura de URL e prévia inline.

## Prioridade
**P0** — sem conseguir abrir os anexos enviados, o upload seguro (US-068) não entrega valor de uso.
