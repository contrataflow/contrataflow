# Protótipo navegável — ContrataFlow (MVP 1)

Protótipo de **interface** da jornada principal do MVP 1: só HTML/CSS/JS estático, com **dados fictícios** e **sem backend**. Serve para validar fluxo, conteúdo e navegação com o produto e com o cliente-piloto. Não é o código do produto, e o design final (identidade visual, microinterações) pode ser refinado por um designer.

## Como abrir
Abra `prototype/index.html` no navegador (duplo clique). O roteiro lista as telas na ordem da jornada.
Precisa de internet: Tailwind CSS (Play CDN), ícones Lucide e a fonte Inter vêm de CDN.

## Telas
| Arquivo | Tela | Especificação |
|---|---|---|
| `entrar.html` | Login (tela do Authentik, simulada); `?motivo=sessao-expirada`, `saiu` ou `senha-redefinida` mostra a página de motivo | SCR-001 |
| `selecionar-orgao.html` | Seleção de órgão/instituição | SCR-101 |
| `painel.html` | Dashboard | SCR-003 |
| `processos.html` | Lista de processos | SCR-004 |
| `processo-novo.html` | Novo processo (assistente) | SCR-005 |
| `processo.html` | Detalhe do processo, com o painel situacional, as abas, o encaminhamento (SCR-103) e a devolução (SCR-104) | SCR-006 |
| `dfd.html` | DFD em assistente | SCR-007 |
| `tarefas.html` | Caixa de tarefas | SCR-013 |
| `aprovacoes.html` | Aprovações | SCR-014 |
| `aprovacao.html` | Detalhe da aprovação (decidir) | SCR-015 |
| `pesquisa-precos.html` | Pesquisa de preços | SCR-009 |
| `mapa-comparativo.html` | Mapa comparativo | SCR-010 |

Especificação completa de cada tela: [`docs/mvp-01/screens.md`](../docs/mvp-01/screens.md).

## Cenário fictício
- **Instituição:** Prefeitura de São José (também há vínculo com a Câmara Municipal de Vila Nova).
- **Pessoas:**
  - Ana Souza — requisitante, Setor de Manutenção;
  - Carlos Lima — secretário de Obras, titular que aprova o DFD;
  - Marcos Pereira — Departamento de Compras;
  - Beatriz Rocha — planejamento, Saúde;
  - Eva Martins — consultora externa;
  - Rui Alves — Setor de Manutenção.
- **Processo principal:** **0012/2026** — Aquisição de cimento para manutenção de vias.
  - Secretaria de Obras › Setor de Manutenção; responsável Ana Souza.
  - Etapa "Formalização da demanda"; valor estimado R$ 98.000,00.
  - DFD **DFD 0005/2026** em elaboração. Depois de enviado, é aprovado por Carlos Lima.
- **Processo da pesquisa de preços:** **0008/2026** — Material de expediente para as escolas.
  - Secretaria de Educação; Departamento de Compras; Marcos Pereira.
  - Pesquisa **PP 0003/2026**; valor estimado R$ 62.400,00.
- **Workflow padrão** (DEC-015), em sete etapas:
  1. Formalização da demanda
  2. Aprovação da demanda
  3. ETP e mapa de riscos
  4. Pesquisa de preços
  5. Termo de Referência
  6. Aprovação da autoridade competente
  7. Planejamento da contratação concluído
- **Data de referência:** 07/10/2026.

## Convenções técnicas (para quem editar)
Toda página usa o mesmo `<head>` (Tailwind CDN + `assets/tailwind-config.js` + Lucide + `assets/app.css`), coloca o conteúdo em `<main id="page">` e carrega `assets/app.js` no fim do `<body>`.

**Casca autenticada:** `<body data-shell="app" data-active="processos" data-breadcrumb="Processos|processos.html > 0012/2026">`.
- `data-active` aceita `painel`, `tarefas`, `aprovacoes` ou `processos`.
- `data-user` e `data-role` trocam a pessoa logada.
- Telas sem casca (login e seleção de órgão) não usam `data-shell`.

**Interações por atributos `data-*`** (todas em `assets/app.js`):

| Atributo | Efeito |
|---|---|
| `data-open="id"` | Abre `<dialog id>` (modal). |
| `data-close` | Fecha o diálogo. |
| `<dialog class="cf-drawer">` | Painel lateral. |
| `data-tabs="grupo"` + `data-tab="x"` | Abas; os painéis são `data-panel="x" data-group="grupo"`. A URL guarda `#aba-x`. Estilo ativo: `data-[state=active]:…`. |
| `data-wizard` com `data-step="n"`, `data-step-indicator="n"`, `data-next`, `data-prev`, `data-go-step`, `data-step-label` | Assistente em passos. O botão "Próximo" valida os campos `required` do passo. |
| `<form data-fake-submit="mensagem">` | Valida o formulário, fecha o diálogo, mostra um aviso e, se tiver `data-redirect="url"`, navega. |
| `data-toast="mensagem"` (+ `data-toast-type`, `data-redirect`, `data-close-after`) | Mostra um aviso (toast). `data-toast-type` aceita `success`, `error` ou `info`. |
| `data-filter-group="nome"` + `data-filter-tag="tag"` | Filtros rápidos (`aria-pressed`) sobre `[data-filter-target="nome"] [data-row data-tags="…"]`. |
| `data-filter-search="nome"` | Busca textual nas mesmas linhas. |
| `data-filter-count="nome"` | Exibe a contagem de linhas visíveis. |
| `data-filter-empty="nome"` | Estado vazio, mostrado quando nenhuma linha passa no filtro. |
| `data-autosave` + `data-autosave-status` | Simula o salvamento automático: "Salvando…" e depois "Salvo às HH:MM". |
| `minlength` + `[data-count-for="idDoCampo"]` | Contador de caracteres. |
| `data-confidential="R$ 98.000,00"` + checkbox `data-toggle-masked` | Simula o orçamento sigiloso (POL-09). |
| `data-menu-toggle="id"` + `data-menu="id"` | Menus suspensos. |
