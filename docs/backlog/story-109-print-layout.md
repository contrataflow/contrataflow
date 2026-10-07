---
id: US-109
title: "Layout de impressão (timbre, cabeçalho, rodapé)"
epic: EP-018
feature: FT-058
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-067, US-107]
modules: [document]
screens: [SCR-114]
endpoints: [TPL-08, TPL-09, TPL-12, TPL-13, ATT-02, ATT-03, ATT-04, ATT-05]
permissions: [TEMPLATE_VIEW, TEMPLATE_MANAGE, ATTACHMENT_UPLOAD]
events: []
---

# US-109 — Layout de impressão (timbre, cabeçalho, rodapé)

## Título
Layout de impressão (timbre, cabeçalho, rodapé)

## Descrição
**Como** administrador de configurações documentais do órgão, **quero** configurar o layout de impressão do template — margens, fonte, cabeçalho, rodapé e timbre (logo) — e visualizar uma prévia em PDF antes de publicar, **para** que os documentos gerados a partir do template saiam com a identidade visual oficial do órgão, sem depender de ajustes manuais depois de impressos.

A edição ocorre na aba "Layout" de SCR-114, sobre a mesma versão de trabalho (rascunho) da US-107, usando a estrutura `LayoutDefinition` (entities.md §5.2). A prévia reaproveita a fila `document-render` e o Gotenberg já usados pela geração de PDF de documentos (US-067), sem criar um documento real.

## Contexto
- DEC-060 define a geração de PDF: um worker converte HTML (snapshot do documento + layout do template) e envia ao Gotenberg, calculando hash e armazenando a renderização; US-067 entrega esse pipeline para documentos reais. Esta story aplica o mesmo pipeline a uma amostra do template, antes de haver qualquer documento.
- `LayoutDefinition` (§5.2) é um campo `NOT NULL` de `DocumentTemplateVersion` desde a criação (US-107 já inicializa com os padrões do sistema); esta story é o editor desse campo.
- Timbre e logo são ativos do próprio órgão, não do documento: são anexos `TENANT_ASSET` no bucket `documents` (storage.md §4), reaproveitando o subsistema genérico de anexos (upload em duas etapas + varredura antivírus).

## Objetivo
Permitir configurar cabeçalho, rodapé, logo, margens e tipografia de um template e confirmar visualmente o resultado via prévia em PDF, antes de publicar (US-108), sem exigir conhecimento técnico de HTML/CSS.

## Persona
- **Principal:** Administrador de configurações documentais do órgão (detentor de `TEMPLATE_MANAGE`).
- **Secundárias:** Detentores de `TEMPLATE_VIEW` (podem gerar/ver prévias de versões publicadas, sem editar o layout).

## Pré-condições
- Tenant `ACTIVE`; usuário com `TEMPLATE_MANAGE` (editar layout) ou `TEMPLATE_VIEW` (gerar prévia de versão publicada).
- Existe o template com uma versão em `DRAFT` (US-107).
- Para usar logo: existe um anexo `TENANT_ASSET` já carregado e `AVAILABLE` (fluxo genérico de anexos, US-068).

## Fluxo principal
1. Na aba "Layout" de SCR-114, o usuário ajusta orientação, margens, fonte, tamanho e entrelinha; edita cabeçalho e rodapé em um editor rich text com um seletor de variáveis (`{{...}}`); liga/desliga numeração de página, hash no rodapé e marca d'água de rascunho.
2. Para o timbre, o usuário seleciona um logo já carregado ou envia um novo: `POST /attachments` (ATT-02, `targetType = TENANT_ASSET`) → `POST /attachments/{id}/confirm` (ATT-03) → acompanha o status via `GET /attachments/{id}` (ATT-04) até `AVAILABLE`; escolhe posição e altura máxima.
3. Cada alteração é salva por `PATCH /template-versions/{versionId}` (TPL-08) com `layout` atualizado e `If-Match`; a API valida (RN-TPL-21..24) e responde com novo `ETag`, ou `TEMPLATE_INVALID` se houver variável desconhecida ou referência de logo inválida.
4. O usuário clica em **"Gerar prévia"**: `POST /template-versions/{versionId}/preview` (TPL-09) enfileira a renderização na fila `document-render` e responde **202** com um `renditionId` de prévia.
5. O worker monta o HTML a partir do layout corrente e das seções (com `defaultContent` ou texto de espaço reservado quando vazio), resolvendo todas as variáveis de §5.2 com dados do próprio tenant/usuário e valores de exemplo para `process.*`/`document.*`; envia ao Gotenberg; grava o PDF resultante e marca a prévia como pronta.
6. O front consulta o status da prévia e, quando pronta, exibe o PDF embutido (com marca d'água "RASCUNHO") e oferece download.

## Fluxos alternativos
- **FA-01 — Prévia de versão publicada (somente leitura):** usuário com `TEMPLATE_VIEW` gera a prévia de uma versão `PUBLISHED`/`RETIRED` para consulta, sem poder alterar o layout.
- **FA-02 — Remover o logo:** limpa `layout.logo`; a próxima prévia/renderização sai sem timbre.
- **FA-03 — Falha ao gerar a prévia:** a prévia fica com status de falha e mensagem; o usuário pode tentar novamente sem precisar refazer a configuração.
- **FA-04 — Trocar a fonte/margens depois de já ter gerado uma prévia:** a prévia anterior permanece disponível até expirar; uma nova prévia precisa ser gerada para refletir a mudança (RN-TPL-27).

## Regras de negócio
- **RN-TPL-21** — `layout` só é editável na versão `DRAFT` (mesma regra RN-TPL-03). `pageSize` é fixo em `'A4'` no MVP 1; `orientation` ∈ {`portrait`, `landscape`}; `marginsMm` (top/right/bottom/left) entre 10 e 40 mm cada; `fontFamily` ∈ {Inter, Arial, Times New Roman, Liberation Serif}; `fontSizePt` entre 9 e 14; `lineHeight` entre 1,0 e 2,0.
- **RN-TPL-22** — `header`/`footer` (TipTapDoc) usam o catálogo **completo** de variáveis de §5.2, incluindo `page`, `pages`, `document.hash` e `document.version` — diferente de `defaultContent` de seção (RN-TPL-06, US-107), pois são resolvidas no momento da renderização em PDF, não na criação do documento. Variável fora do catálogo → `TEMPLATE_INVALID`.
- **RN-TPL-23** — `logo.attachmentId` deve referenciar um `Attachment` do próprio tenant com `targetType = TENANT_ASSET` e `status = AVAILABLE`, de tipo imagem permitido (PNG, JPEG ou SVG); `position` ∈ {`left`, `center`, `right`}; `maxHeightMm` > 0 e ≤ margem superior configurada.
- **RN-TPL-24** — `showPageNumbers`, `showDocumentHashInFooter` e `draftWatermark` são booleanos independentes (padrão `true` nos três — §5.2). `showDocumentHashInFooter` só tem efeito visível em renderizações de versão de documento com `contentHash` calculado; não produz nada na prévia de template (que não tem versão de documento).
- **RN-TPL-25** — A prévia (TPL-09) renderiza o `layout` e as `sections` do rascunho corrente com `defaultContent` (ou um texto de espaço reservado quando a seção não tiver conteúdo padrão) e variáveis resolvidas com dados do próprio tenant/usuário (exemplos para `process.*`/`document.*`); não cria `Document` nem `DocumentVersion`; reaproveita a fila `document-render` e o Gotenberg (US-067). A prévia sempre exibe a marca d'água "RASCUNHO", independentemente do valor de `draftWatermark` (que vale para documentos reais).
- **RN-TPL-26** — A prévia expira em 24 h (mesmo prazo das renderizações `PREVIEW` de documento — DEC-060); pode ser descartada e regenerada livremente. Falha na geração registra `errorCode`/`errorMessage` e permite nova tentativa sem limite adicional além do rate limit de renderização (api.md §1.6).
- **RN-TPL-27** — Sem efeito retroativo: alterar o layout do rascunho não afeta versões já publicadas nem documentos criados a partir delas (RN-TPL-16). A prévia sempre reflete o rascunho corrente no momento da geração — uma nova edição de layout exige nova prévia para ser refletida.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Orientação | `orientation` | seleção | Sim | `portrait`\|`landscape` | `portrait` |
| Margens (sup./dir./inf./esq.) | `marginsMm.{top,right,bottom,left}` | número (mm) | Sim | 10–40 cada | 20 cada |
| Fonte | `fontFamily` | seleção | Sim | enum fixo | `Inter` |
| Tamanho da fonte | `fontSizePt` | número | Sim | 9–14 | 11 |
| Entrelinha | `lineHeight` | número | Sim | 1,0–2,0 | 1,15 |
| Cabeçalho | `header` | rich text | Não | ≤ 1 MB; variáveis RN-TPL-22 | vazio |
| Rodapé | `footer` | rich text | Não | ≤ 1 MB; variáveis RN-TPL-22 | vazio |
| Logo | `logo.attachmentId` | referência a anexo | Não | `TENANT_ASSET`, `AVAILABLE` (RN-TPL-23) | vazio |
| Posição do logo | `logo.position` | seleção | Condicional (se logo definido) | `left`\|`center`\|`right` | `left` |
| Altura máxima do logo | `logo.maxHeightMm` | número (mm) | Condicional (se logo definido) | > 0 e ≤ margem superior | 15 |
| Numeração de página | `showPageNumbers` | interruptor | Não | — | `true` |
| Hash no rodapé | `showDocumentHashInFooter` | interruptor | Não | — | `true` |
| Marca d'água de rascunho | `draftWatermark` | interruptor | Não | — | `true` |
| *(sistema)* Tamanho da página | `pageSize` | — | — | fixo `'A4'` no MVP 1 | `'A4'` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Margem fora de 10–40 mm | Front + API | "A margem deve estar entre 10 e 40 mm." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-02 | `fontSizePt` fora de 9–14 | Front + API | "O tamanho da fonte deve estar entre 9 e 14." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-03 | `lineHeight` fora de 1,0–2,0 | Front + API | "A entrelinha deve estar entre 1,0 e 2,0." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-04 | Variável desconhecida no cabeçalho/rodapé | Front + API | "A variável {{...}} não é reconhecida." | `TEMPLATE_INVALID` |
| V-05 | `logo.attachmentId` inexistente, de outro tenant ou não disponível | API | "Selecione um logo válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) / `ATTACHMENT_NOT_AVAILABLE` |
| V-06 | `logo.position` fora do enum | Front + API | "Selecione uma posição válida para o logo." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-07 | PATCH de layout em versão não `DRAFT` | API | "Esta versão está publicada e não pode ser alterada." | `TEMPLATE_VERSION_NOT_DRAFT` |
| V-08 | Prévia solicitada com layout/seções inválidos | API | "Corrija as pendências do template antes de gerar a prévia." | `TEMPLATE_INVALID` |

## Permissões
- **Permissão:** `TEMPLATE_MANAGE` para editar o layout (TPL-08) e enviar/trocar o logo (`ATTACHMENT_UPLOAD` + alvo editável = o rascunho do template); `TEMPLATE_VIEW` para gerar/consultar prévias (TPL-09, inclusive de versões publicadas).
- **Políticas:** nenhuma política contextual adicional; o alvo do anexo (`TENANT_ASSET`) não pertence a um processo, logo não há verificação de `PROCESS_VIEW`/POL-09.
- **MFA:** não exigido por padrão (`TEMPLATE_MANAGE`, risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** aba "Layout" fica somente leitura para quem só tem `TEMPLATE_VIEW`; API responde 403 `PERMISSION_DENIED` em PATCH de layout sem `TEMPLATE_MANAGE`.

## Eventos gerados
Nenhum evento de domínio nesta story — edição de layout e geração de prévia produzem apenas auditoria (reaproveita `template.update`) e logs técnicos do worker de renderização.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: configuração de layout e prévia são atividades síncronas com feedback na própria tela. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Layout de impressão (timbre, cabeçalho, rodapé)

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o template "Ofício padrão" tem a versão 3 em "DRAFT"
    And existe o anexo "brasao.png" disponível com targetType "TENANT_ASSET"
    And o usuário "Felipe" tem vínculo ativo e o perfil com "TEMPLATE_MANAGE"

  Scenario: [Sucesso] Configurar cabeçalho, rodapé, margens e logo
    When "Felipe" definir margens de 25 mm, fonte "Times New Roman" 12 pt, cabeçalho com "{{organization.name}}" e o logo "brasao.png" na posição "center"
    Then o "layout" da versão 3 deve ser salvo com esses valores
    And a API deve responder 200 com novo "ETag"
    And deve gerar registro de auditoria "template.update"

  Scenario: [Sucesso] Gerar prévia do layout
    When "Felipe" clicar em "Gerar prévia"
    Then a API deve responder 202 com um "renditionId"
    And, quando o worker concluir, a prévia deve ficar disponível para visualização com a marca d'água "RASCUNHO"

  Scenario: [Validação] Variável desconhecida no rodapé
    When "Felipe" definir o rodapé com "{{document.assinante}}"
    Then a API deve responder 422 com código "TEMPLATE_INVALID"
    And o layout não deve ser salvo

  Scenario: [Validação] Tamanho de fonte fora da faixa permitida
    When "Felipe" definir "fontSizePt" igual a 20
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" no campo "fontSizePt"

  Scenario: [Permissão] Usuário só com TEMPLATE_VIEW tenta editar o layout
    Given que "Marina" possui apenas "TEMPLATE_VIEW"
    When "Marina" enviar PATCH de layout para a versão 3
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    When "Marina" gerar uma prévia da versão publicada corrente
    Then a API deve responder 202 normalmente

  Scenario: [Tenant incorreto] Logo de outro tenant
    Given que existe o anexo "logo-b.png" no tenant "Prefeitura B"
    When "Felipe", no tenant "Prefeitura de São José", definir "logo.attachmentId" com o anexo "logo-b.png"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "logo.attachmentId"
    And a resposta não deve revelar que o anexo existe em outro tenant

  Scenario: [Duplicidade] Cliques repetidos em "Gerar prévia"
    Given que "Felipe" já solicitou uma prévia que está em processamento
    When "Felipe" clicar em "Gerar prévia" novamente antes de a primeira concluir
    Then a segunda solicitação deve responder com o mesmo "renditionId" em processamento
    And apenas um PDF deve ser gerado

  Scenario: [Concorrência] Edição simultânea do layout
    Given que "Felipe" e "Marina" (ambos com TEMPLATE_MANAGE) abriram o layout com "ETag" igual a "5"
    When "Felipe" salvar primeiro e a versão passar a "ETag" igual a "6"
    And "Marina" enviar PATCH com "If-Match" igual a "5"
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao salvar o layout
    Given que o banco de dados fica indisponível durante o PATCH
    When "Felipe" salvar uma alteração de margem
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o layout não deve ser alterado

  Scenario: [Falha de integração] Gotenberg indisponível ao gerar a prévia
    Given que o serviço Gotenberg está indisponível
    When "Felipe" clicar em "Gerar prévia"
    Then a solicitação deve ser aceita com 202
    And a prévia deve terminar com status de falha e código de erro de dependência indisponível
    And "Felipe" deve poder tentar novamente depois que o Gotenberg for restabelecido
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo de layout fora da faixa | 422 | `VALIDATION_ERROR` | "Revise os valores destacados." | Marca o campo com `errors[]` |
| Variável desconhecida em cabeçalho/rodapé | 422 | `TEMPLATE_INVALID` | "A variável {{...}} não é reconhecida." | Destaca o trecho no editor |
| Logo inexistente/outro tenant/indisponível | 422/409 | `VALIDATION_ERROR` / `ATTACHMENT_NOT_AVAILABLE` | "Selecione um logo válido." | Reabre o seletor de anexos |
| PATCH em versão publicada/aposentada | 409 | `TEMPLATE_VERSION_NOT_DRAFT` | "Esta versão está publicada e não pode ser alterada." | Abre em modo leitura |
| Edição concorrente | 412 | `VERSION_CONFLICT` | "O layout foi alterado por outra pessoa. Recarregue." | Oferece recarregar |
| Prévia solicitada com template inválido | 422 | `TEMPLATE_INVALID` | "Corrija as pendências antes de gerar a prévia." | Lista as pendências |
| Falha na renderização (Gotenberg/fila) | — (assíncrono) | `DEPENDENCY_UNAVAILABLE` (em `errorCode` da prévia) | "Não foi possível gerar a prévia agora. Tente novamente." | Botão "Tentar novamente" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar o layout." | Oculta campos de edição |
| Limite de renderização | 429 | `RATE_LIMITED` | "Muitas prévias solicitadas. Aguarde um pouco." | Respeita `Retry-After` |

## Dependências
- **Stories:** US-067 (fila `document-render` e Gotenberg, reaproveitados pela prévia), US-107 (versão de trabalho do template e padrão de `If-Match`). Indiretas: US-068 (upload genérico de anexos, usado para o logo `TENANT_ASSET`), US-073 (auditoria), US-097 (autorização).
- **Decisões/ADRs:** DEC-001, DEC-056 (rich text de cabeçalho/rodapé), DEC-060/ADR-007 (geração de PDF), DEC-082, DEC-104.
- **Configurações:** nenhuma chave específica (faixas de margem/fonte são validação de domínio, não configuração por tenant).
- **Lacunas nas fontes canônicas:** nenhuma (prévia de template como estado efêmero em Redis, TTL 24 h, sem linha em `document_renditions`; status/download em `TPL-12`/`TPL-13`, api.md §3; chave no bucket `renditions` em storage.md §4).

## Impacto técnico
- Reaproveitar integralmente o worker/fila de US-067 (`document-render`, Gotenberg, cálculo de hash) para a prévia evita duplicar infraestrutura; a única diferença é a origem do HTML (seções do rascunho + dados de exemplo, em vez de um `DocumentVersion` real) e o destino do resultado (Redis efêmero, não `document_renditions`).
- Mudança de fonte/margens altera a paginação; a prévia deve ser sempre regerada após qualquer edição de layout (RN-TPL-27) — a UI deve invalidar a prévia anterior visualmente ao detectar alteração não refletida.
- Upload de logo reaproveita 100% o subsistema de anexos (quarentena, varredura antivírus, URL assinada) apenas trocando `targetType` para `TENANT_ASSET` e o alvo de autorização para o template.

## Backend
- **Módulo(s):** `document` (dono); integra `attachment` (`AttachmentFacade.assertAvailable(attachmentId, 'TENANT_ASSET')`), `platform` (fila `document-render`, Redis para a prévia efêmera), `audit`.
- **Casos de uso:** `UpdateTemplateLayoutCommand` (TPL-08, subconjunto de campos) → `UpdateTemplateLayoutHandler`; `RenderTemplatePreviewCommand` (TPL-09) → `RenderTemplatePreviewHandler` (enfileira job, grava estado efêmero).
- **Domínio:** `LayoutDefinition` (value object, RN-TPL-21..24); `TemplateContentValidator` estendido para variáveis de cabeçalho/rodapé (RN-TPL-22); `TemplatePreviewJob` (worker, reaproveita `DocumentRenderWorker` de US-067 com uma estratégia de origem "TEMPLATE" em vez de "DOCUMENT_VERSION").
- **Transação:** PATCH de layout é um `UPDATE` único com checagem de `version`; a prévia não é transacional (assíncrona) — estado em Redis com TTL 24 h.

## Frontend
- **Tela(s):** SCR-114 (`/admin/templates/[id]/versoes/[versionId]`, aba "Layout").
- **Componentes:** `LayoutFormPanel` (margens, fonte, orientação), `HeaderFooterEditor` (rich text com seletor de variáveis, incluindo `page`/`pages`/`document.hash`), `LogoUploader` (reaproveita o componente genérico de upload de anexos com `targetType = TENANT_ASSET`), `PreviewButton` + `PreviewViewer` (polling do status até `READY`/`FAILED`, exibição do PDF embutido).
- **Estados:** skeleton ao carregar o layout; prévia com estado "Gerando…" (spinner), "Pronta" (visualizador) e "Falhou" (mensagem + "Tentar novamente"); aviso quando o layout foi alterado após a última prévia gerada.
- **Acessibilidade e responsividade:** visualizador de PDF com alternativa de download para leitores de tela; formulário de layout em coluna única abaixo de 768 px; foco anunciado ao concluir a prévia (`aria-live`).

## Banco de dados
- **Tabelas:** `document_template_versions` (coluna `layout`, já existente — só o conteúdo jsonb muda). Nenhuma tabela nova: a prévia efêmera vive em Redis (ver lacuna), não em `document_renditions`.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** nenhum adicional além dos já existentes em `document_template_versions`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TPL-08 | PATCH | `/template-versions/{versionId}` | `{ layout }` + `If-Match` | `200 { data: TemplateVersion }` | 200, 403, 404, 409, 412, 422 |
| TPL-09 | POST | `/template-versions/{versionId}/preview` | `If-Match` opcional (prévia não altera o recurso) | `202 { data: { renditionId } }` | 202, 403, 404, 422, 429 |
| ATT-02 | POST | `/attachments` | `{ targetType: "TENANT_ASSET", fileName, mimeType, sizeBytes }` + `Idempotency-Key` | `201 { data: { id, uploadUrl } }` | 201, 403, 422 |
| ATT-03 | POST | `/attachments/{id}/confirm` | — | `202` (dispara job `file-scan`) | 202, 403, 409 |
| ATT-04 | GET | `/attachments/{id}` | — | `200 { data: Attachment }` (status `AVAILABLE` quando pronto) | 200, 404 |
| ATT-05 | GET | `/attachments/{id}/download` | — | `200 { data: { url, expiresAt } }` | 200, 403, 409 |

## Logs
- `info` `template_version.layout_updated` — `templateVersionId`, camposAlterados, `durationMs`.
- `info` `template_preview.requested` / `template_preview.ready` / `template_preview.failed` — `templateVersionId`, `renditionId`, `durationMs`, `errorCode` (se falha).
- `warn` `template_preview.gotenberg_unavailable` — ao falhar por dependência externa.
- **Nunca logar:** conteúdo do cabeçalho/rodapé/seções.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `template.update` | `CONFIGURATION` | Layout do rascunho alterado | `changes`: `layoutChangedFields[]` (ex.: `fontFamily`, `logo.attachmentId`) |
| `access.denied` | `ACCESS` | Tentativa de editar sem `TEMPLATE_MANAGE` | `reasonCode = TEMPLATE_MANAGE` |

Geração de prévia não gera entrada de auditoria (ação de consulta/visualização, não alteração de dados), apenas os logs técnicos acima.

## Testes necessários
- **Unitários:** validação de faixas (margens, fonte, entrelinha); validação de variáveis de cabeçalho/rodapé (RN-TPL-22, incluindo as variáveis exclusivas de renderização); resolução de `logo.attachmentId`.
- **Integração (Testcontainers + Redis):** PATCH de layout com `If-Match`; fluxo completo da prévia (enfileirar → worker simulado → status `READY`/`FAILED`) com TTL de 24 h.
- **API/contrato:** respostas e erros conforme api.md; `202` com `renditionId`; reaproveitamento dos contratos de ATT-02..05.
- **RBAC e multi-tenant:** `TEMPLATE_VIEW` só gera prévia, não edita; logo de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas edições de layout com `If-Match` desatualizado → 412; duas solicitações de prévia quase simultâneas → mesmo `renditionId` em processamento.
- **E2E (Playwright):** configurar layout completo, enviar logo, gerar prévia e visualizar o PDF com marca d'água "RASCUNHO".
- **Acessibilidade/performance:** axe no formulário de layout e no visualizador de PDF; tempo de geração de prévia p95 dentro do SLA do worker de US-067.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `TEMPLATE_MANAGE`/`TEMPLATE_VIEW` aplicados corretamente; UI oculta edição sem permissão
- [ ] Prévia reaproveita o worker/fila de US-067 sem código duplicado
- [ ] Teste de isolamento incluído na suíte "tenant leak" (logo de outro tenant)
- [ ] OpenAPI de TPL-08/09/12/13 compatível com api.md
- [ ] Logs sem conteúdo de cabeçalho/rodapé/seções
- [ ] Layout e visualizador de PDF acessíveis (axe) e responsivos (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Prévia efêmera (Redis, TTL 24 h; TPL-12/13) coberta por teste de integração

## Estimativa
**M** — reaproveita integralmente o pipeline de renderização de US-067 e o padrão de edição de versão de US-107; o trabalho novo é o formulário de layout, o seletor de variáveis e o visualizador de prévia.

## Prioridade
**P1** — importante para a identidade visual oficial dos documentos, mas não bloqueia a criação/publicação de templates (US-107/US-108), que funcionam com o layout padrão do sistema.
