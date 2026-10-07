/* ContrataFlow — protótipo navegável (sem backend).
 * Casca da aplicação (menu lateral, cabeçalho, seletor de órgão, notificações) e interações comuns,
 * acionadas por atributos data-* — ver prototype/README.md. */
(function () {
  'use strict';
  var body = document.body;
  var ORG = 'Prefeitura de São José';
  var NAV = [
    { id: 'painel', label: 'Painel', icon: 'layout-dashboard', href: 'painel.html' },
    { id: 'tarefas', label: 'Caixa de tarefas', icon: 'inbox', href: 'tarefas.html', badge: '7' },
    { id: 'aprovacoes', label: 'Aprovações', icon: 'stamp', href: 'aprovacoes.html', badge: '2' },
    { id: 'processos', label: 'Processos', icon: 'folder-kanban', href: 'processos.html' }
  ];
  var ADMIN = [
    ['users', 'Usuários'], ['shield-check', 'Perfis e permissões'], ['building-2', 'Estrutura organizacional'],
    ['workflow', 'Workflows'], ['file-text', 'Templates'], ['list-checks', 'Catálogos'],
    ['settings', 'Configurações'], ['scroll-text', 'Auditoria']
  ];
  var NOTIFS = [
    { t: 'Processo 0012/2026 recebido na sua unidade', s: 'Setor de Manutenção · há 5 min', href: 'processo.html', unread: true },
    { t: 'Aprovação solicitada: DFD 0005/2026', s: 'Secretaria de Obras · há 1 h', href: 'aprovacao.html', unread: true },
    { t: 'Prazo da etapa vence amanhã — 0010/2026', s: 'ETP e mapa de riscos · há 3 h', href: 'processo.html', unread: true },
    { t: 'Marcos mencionou você em um comentário', s: 'Pesquisa de preços PP 0003/2026 · ontem', href: 'pesquisa-precos.html', unread: false }
  ];

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function icons() { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); }

  /* ---------- Casca ---------- */
  function navLinks(active) {
    var html = NAV.map(function (n) {
      var on = n.id === active;
      return '<a href="' + n.href + '"' + (on ? ' aria-current="page"' : '') + ' class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ' +
        (on ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100') + '">' +
        '<i data-lucide="' + n.icon + '" class="h-4 w-4 ' + (on ? 'text-brand-700' : 'text-slate-500') + '"></i><span class="flex-1">' + n.label + '</span>' +
        (n.badge ? '<span class="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">' + n.badge + '<span class="sr-only"> pendentes</span></span>' : '') + '</a>';
    }).join('');
    html += '<p class="mt-6 px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Administração</p>';
    html += ADMIN.map(function (a) {
      return '<a href="#" data-toast="“' + a[1] + '” não faz parte deste protótipo (telas administrativas, grupo B)." class="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">' +
        '<i data-lucide="' + a[0] + '" class="h-4 w-4 text-slate-400"></i>' + a[1] + '</a>';
    }).join('');
    return html;
  }

  function sidebar(active) {
    return '<div class="flex h-full flex-col">' +
      '<a href="painel.html" class="flex h-14 flex-none items-center gap-2 border-b border-slate-200 px-4">' +
      '<span class="grid h-8 w-8 place-items-center rounded-md bg-brand-700 text-sm font-bold text-white">CF</span>' +
      '<span class="text-base font-semibold tracking-tight text-slate-900">ContrataFlow</span></a>' +
      '<nav aria-label="Menu principal" class="flex-1 space-y-1 overflow-y-auto p-3">' + navLinks(active) + '</nav>' +
      '<div class="border-t border-slate-200 p-3 text-xs text-slate-500">Lei 14.133/2021 · MVP 1</div></div>';
  }

  function header() {
    var user = body.dataset.user || 'Ana Souza';
    var role = body.dataset.role || 'Requisitante · Setor de Manutenção';
    var initials = user.split(' ').map(function (p) { return p[0]; }).slice(0, 2).join('');
    var crumbs = (body.dataset.breadcrumb || '').split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    var unread = NOTIFS.filter(function (n) { return n.unread; }).length;
    var crumbHtml = crumbs.map(function (c, i) {
      var parts = c.split('|'); var label = parts[0].trim(); var href = parts[1] ? parts[1].trim() : '';
      var last = i === crumbs.length - 1;
      var inner = (href && !last) ? '<a href="' + href + '" class="hover:text-slate-900 hover:underline">' + esc(label) + '</a>' : '<span' + (last ? ' aria-current="page" class="font-medium text-slate-900"' : '') + '>' + esc(label) + '</span>';
      return '<li class="flex min-w-0 items-center gap-1">' + (i ? '<i data-lucide="chevron-right" class="h-3.5 w-3.5 flex-none"></i>' : '') + '<span class="truncate">' + inner + '</span></li>';
    }).join('');
    return '<header class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur cf-no-print">' +
      '<button type="button" class="rounded-md p-2 hover:bg-slate-100 md:hidden" data-open="cf-mobile-nav" aria-label="Abrir menu"><i data-lucide="menu" class="h-5 w-5"></i></button>' +
      '<nav aria-label="Trilha de navegação" class="hidden min-w-0 flex-1 sm:block"><ol class="flex min-w-0 items-center gap-1 text-sm text-slate-500">' + crumbHtml + '</ol></nav>' +
      '<div class="ml-auto flex flex-none items-center gap-2">' +
      '<form action="processos.html" class="relative hidden 2xl:block" role="search"><label><span class="sr-only">Buscar processos</span>' +
      '<i data-lucide="search" class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400"></i>' +
      '<input type="search" name="q" placeholder="Buscar processo (número, título, objeto)" class="h-9 w-72 rounded-md border border-slate-300 bg-white pl-8 pr-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"></label></form>' +
      // seletor de órgão
      '<div class="relative"><button type="button" data-menu-toggle="cf-org" aria-haspopup="menu" aria-expanded="false" class="flex h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-sm hover:bg-slate-50">' +
      '<i data-lucide="building-2" class="h-4 w-4 text-slate-500"></i><span class="hidden whitespace-nowrap sm:inline">' + ORG + '</span><i data-lucide="chevron-down" class="h-4 w-4 text-slate-500"></i></button>' +
      '<div data-menu="cf-org" hidden role="menu" class="absolute right-0 z-40 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">' +
      '<p class="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Instituição ativa</p>' +
      '<a href="painel.html" role="menuitem" class="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-slate-100">' + ORG + '<i data-lucide="check" class="h-4 w-4 text-brand-700"></i></a>' +
      '<a href="selecionar-orgao.html" role="menuitem" class="block rounded-md px-3 py-2 text-sm hover:bg-slate-100">Câmara Municipal de Vila Nova</a>' +
      '<a href="selecionar-orgao.html" role="menuitem" class="mt-1 block border-t border-slate-100 px-3 py-2 text-sm text-brand-700 hover:bg-slate-100">Trocar de instituição…</a></div></div>' +
      // notificações
      '<div class="relative"><button type="button" data-menu-toggle="cf-notif" aria-haspopup="menu" aria-expanded="false" class="relative rounded-md p-2 hover:bg-slate-100" aria-label="Notificações: ' + unread + ' não lidas">' +
      '<i data-lucide="bell" class="h-5 w-5 text-slate-600"></i><span class="absolute -right-0.5 -top-0.5 grid h-4 min-w-[1rem] place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">' + unread + '</span></button>' +
      '<div data-menu="cf-notif" hidden role="menu" class="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-slate-200 bg-white shadow-lg">' +
      '<div class="flex items-center justify-between border-b border-slate-100 px-4 py-3"><p class="text-sm font-semibold">Notificações</p>' +
      '<button type="button" class="text-xs text-brand-700 hover:underline" data-toast="Todas as notificações foram marcadas como lidas." data-toast-type="success">Marcar todas como lidas</button></div>' +
      '<ul class="max-h-80 overflow-y-auto">' + NOTIFS.map(function (n) {
        return '<li><a href="' + n.href + '" class="flex gap-3 px-4 py-3 hover:bg-slate-50">' +
          (n.unread ? '<span class="mt-1.5 h-2 w-2 flex-none rounded-full bg-brand-600"><span class="sr-only">Não lida</span></span>' : '<span class="mt-1.5 h-2 w-2 flex-none"></span>') +
          '<span><span class="block text-sm ' + (n.unread ? 'font-medium text-slate-900' : 'text-slate-700') + '">' + esc(n.t) + '</span><span class="block text-xs text-slate-500">' + esc(n.s) + '</span></span></a></li>';
      }).join('') + '</ul>' +
      '<a href="#" data-toast="A central de notificações completa (SCR-036) não faz parte deste protótipo." class="block border-t border-slate-100 px-4 py-2.5 text-center text-sm text-brand-700 hover:bg-slate-50">Ver todas</a></div></div>' +
      // usuário
      '<div class="relative"><button type="button" data-menu-toggle="cf-user" aria-haspopup="menu" aria-expanded="false" class="flex items-center gap-2 rounded-md p-1 pr-2 hover:bg-slate-100">' +
      '<span class="grid h-8 w-8 place-items-center rounded-full bg-slate-800 text-xs font-semibold text-white">' + esc(initials) + '</span>' +
      '<span class="hidden max-w-[14rem] text-left xl:block"><span class="block truncate text-sm font-medium leading-4">' + esc(user) + '</span><span class="block truncate text-xs text-slate-500">' + esc(role) + '</span></span>' +
      '<i data-lucide="chevron-down" class="h-4 w-4 text-slate-500"></i></button>' +
      '<div data-menu="cf-user" hidden role="menu" class="absolute right-0 z-40 mt-2 w-60 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">' +
      '<div class="px-3 py-2 xl:hidden"><p class="text-sm font-medium">' + esc(user) + '</p><p class="text-xs text-slate-500">' + esc(role) + '</p></div>' +
      '<a href="#" role="menuitem" data-toast="“Meu perfil” (SCR-039) não faz parte deste protótipo." class="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-slate-100"><i data-lucide="user" class="h-4 w-4"></i>Meu perfil</a>' +
      '<a href="entrar.html" role="menuitem" class="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-slate-100"><i data-lucide="log-out" class="h-4 w-4"></i>Sair</a></div></div>' +
      '</div></header>';
  }

  function buildShell() {
    var page = document.getElementById('page');
    if (!page || body.dataset.shell !== 'app') return;
    var active = body.dataset.active || '';
    var wrap = document.createElement('div');
    wrap.innerHTML = '<a href="#page" class="cf-skip rounded-md bg-white px-3 py-2 text-sm font-medium shadow">Pular para o conteúdo</a>' +
      '<div class="flex min-h-screen">' +
      '<aside class="sticky top-0 hidden h-screen w-64 flex-none border-r border-slate-200 bg-white md:block cf-no-print">' + sidebar(active) + '</aside>' +
      '<div class="flex min-w-0 flex-1 flex-col" id="cf-main-col">' +
      '<div class="cf-no-print border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">Protótipo navegável · dados fictícios · sem backend — <a href="index.html" class="font-medium underline">ver o roteiro das telas</a></div>' +
      header() + '</div></div>' +
      '<dialog id="cf-mobile-nav" class="cf-drawer-left bg-white" aria-label="Menu">' + sidebar(active) +
      '<button type="button" data-close class="absolute right-2 top-3 rounded-md p-2 hover:bg-slate-100" aria-label="Fechar menu"><i data-lucide="x" class="h-5 w-5"></i></button></dialog>';
    body.insertBefore(wrap, page);
    page.classList.add('flex-1', 'outline-none');
    page.setAttribute('tabindex', '-1');
    wrap.querySelector('#cf-main-col').appendChild(page);
  }

  /* ---------- Toasts ---------- */
  function toast(msg, type) {
    var box = document.getElementById('cf-toasts');
    if (!box) {
      box = document.createElement('div'); box.id = 'cf-toasts';
      box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    var t = type || 'info';
    var icon = { success: 'circle-check', error: 'circle-alert', info: 'info' }[t] || 'info';
    var color = { success: 'text-emerald-600', error: 'text-red-600', info: 'text-brand-600' }[t] || 'text-brand-600';
    var el = document.createElement('div');
    el.className = 'flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg';
    el.innerHTML = '<i data-lucide="' + icon + '" class="mt-0.5 h-5 w-5 flex-none ' + color + '"></i><p class="flex-1 text-slate-800">' + esc(msg) + '</p>' +
      '<button type="button" class="rounded p-0.5 text-slate-400 hover:text-slate-700" aria-label="Fechar aviso"><i data-lucide="x" class="h-4 w-4"></i></button>';
    el.querySelector('button').addEventListener('click', function () { el.remove(); });
    box.appendChild(el); icons();
    setTimeout(function () { el.remove(); }, 5000);
  }
  window.cfToast = toast;

  function go(url, delay) { if (url) setTimeout(function () { window.location.href = url; }, delay == null ? 700 : delay); }

  /* ---------- Menus suspensos ---------- */
  function closeMenus(except) {
    document.querySelectorAll('[data-menu]').forEach(function (m) {
      if (m.dataset.menu !== except) { m.hidden = true; var b = document.querySelector('[data-menu-toggle="' + m.dataset.menu + '"]'); if (b) b.setAttribute('aria-expanded', 'false'); }
    });
  }

  /* ---------- Abas ---------- */
  function activateTab(group, id, updateHash) {
    document.querySelectorAll('[data-tabs="' + group + '"] [data-tab]').forEach(function (t) {
      var on = t.dataset.tab === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.dataset.state = on ? 'active' : 'inactive';
      t.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('[data-panel][data-group="' + group + '"]').forEach(function (p) { p.hidden = p.dataset.panel !== id; });
    if (updateHash && history.replaceState) history.replaceState(null, '', '#aba-' + id);
  }
  function initTabs() {
    document.querySelectorAll('[data-tabs]').forEach(function (g) {
      var group = g.dataset.tabs; g.setAttribute('role', 'tablist');
      var tabs = g.querySelectorAll('[data-tab]');
      tabs.forEach(function (t) { t.setAttribute('role', 'tab'); });
      var fromHash = (location.hash || '').replace('#aba-', '');
      var initial = (fromHash && g.querySelector('[data-tab="' + fromHash + '"]')) ? fromHash : (g.querySelector('[data-tab][data-default]') || tabs[0] || {}).dataset;
      activateTab(group, typeof initial === 'string' ? initial : (initial ? initial.tab : ''), false);
    });
  }

  /* ---------- Assistente em passos ---------- */
  function wizardShow(w, n, noFocus) {
    var steps = w.querySelectorAll('[data-step]'); var total = steps.length;
    steps.forEach(function (s) { s.hidden = Number(s.dataset.step) !== n; });
    w.querySelectorAll('[data-step-indicator]').forEach(function (ind) {
      var k = Number(ind.dataset.stepIndicator);
      ind.dataset.state = k < n ? 'done' : (k === n ? 'current' : 'todo');
      if (k === n) ind.setAttribute('aria-current', 'step'); else ind.removeAttribute('aria-current');
    });
    w.querySelectorAll('[data-step-label]').forEach(function (l) { l.textContent = 'Passo ' + n + ' de ' + total; });
    w.dataset.current = String(n);
    var first = w.querySelector('[data-step="' + n + '"] h2, [data-step="' + n + '"] h3');
    if (first && !noFocus) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: false }); }
  }
  function stepValid(w) {
    var cur = w.querySelector('[data-step="' + (w.dataset.current || '1') + '"]');
    if (!cur) return true;
    var fields = cur.querySelectorAll('input, select, textarea');
    for (var i = 0; i < fields.length; i++) { if (!fields[i].checkValidity()) { fields[i].reportValidity(); return false; } }
    return true;
  }

  /* ---------- Filtro de tabelas/listas ---------- */
  // Linhas: [data-filter-target="nome"] [data-row data-tags="..."]. Se houver tabela e lista de cartões
  // (desktop/celular), ambas são filtradas; a contagem usa o primeiro contêiner.
  function applyFilter(name) {
    var pressed = Array.prototype.map.call(document.querySelectorAll('[data-filter-group="' + name + '"] [data-filter-tag][aria-pressed="true"]'), function (b) { return b.dataset.filterTag; });
    var qEl = document.querySelector('[data-filter-search="' + name + '"]');
    var q = qEl ? qEl.value.trim().toLowerCase() : '';
    var counts = [];
    document.querySelectorAll('[data-filter-target="' + name + '"]').forEach(function (target) {
      var n = 0;
      target.querySelectorAll('[data-row]').forEach(function (r) {
        var tags = (r.dataset.tags || '').split(/\s+/);
        var ok = pressed.every(function (p) { return tags.indexOf(p) >= 0; }) && (!q || r.textContent.toLowerCase().indexOf(q) >= 0);
        r.hidden = !ok; if (ok) n++;
      });
      counts.push(n);
    });
    var count = counts.length ? counts[0] : 0;
    document.querySelectorAll('[data-filter-count="' + name + '"]').forEach(function (c) { c.textContent = count; });
    document.querySelectorAll('[data-filter-empty="' + name + '"]').forEach(function (e) { e.hidden = count > 0; });
  }

  /* ---------- Orçamento sigiloso (POL-09) ---------- */
  function renderConfidential() {
    var masked = body.classList.contains('cf-masked');
    document.querySelectorAll('[data-confidential]').forEach(function (el) {
      el.innerHTML = masked
        ? '<span class="inline-flex items-center gap-1 text-slate-500"><i data-lucide="lock" class="h-3.5 w-3.5"></i>Sigiloso</span>'
        : esc(el.dataset.confidential);
    });
    icons();
  }

  /* ---------- Salvamento automático simulado ---------- */
  function autosave(container) {
    var status = container.querySelector('[data-autosave-status]') || document.querySelector('[data-autosave-status]');
    if (!status) return;
    status.innerHTML = '<span class="inline-flex items-center gap-1.5 text-slate-500"><i data-lucide="refresh-cw" class="h-3.5 w-3.5 animate-spin"></i>Salvando…</span>';
    icons();
    clearTimeout(container._cfTimer);
    container._cfTimer = setTimeout(function () {
      var d = new Date(); var hh = String(d.getHours()).padStart(2, '0'); var mm = String(d.getMinutes()).padStart(2, '0');
      status.innerHTML = '<span class="inline-flex items-center gap-1.5 text-emerald-700"><i data-lucide="circle-check" class="h-3.5 w-3.5"></i>Salvo às ' + hh + ':' + mm + '</span>';
      icons();
    }, 900);
  }

  /* ---------- Contador de caracteres ---------- */
  function updateCounter(field) {
    var out = document.querySelector('[data-count-for="' + field.id + '"]');
    if (!out) return;
    var min = Number(field.getAttribute('minlength') || 0); var n = field.value.trim().length;
    out.textContent = n + (min ? ' de no mínimo ' + min + ' caracteres' : ' caracteres');
    out.className = out.className.replace(/text-(red|slate|emerald)-\d00/g, '') + (min && n < min ? ' text-red-600' : ' text-slate-500');
  }

  /* ---------- Eventos ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var toggle = t.closest('[data-menu-toggle]');
    if (toggle) {
      var id = toggle.dataset.menuToggle; var menu = document.querySelector('[data-menu="' + id + '"]');
      var willOpen = menu && menu.hidden; closeMenus(id);
      if (menu) { menu.hidden = !willOpen; toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false'); }
      return;
    }
    if (!t.closest('[data-menu]')) closeMenus();

    var opener = t.closest('[data-open]');
    if (opener) {
      var d = document.getElementById(opener.dataset.open);
      if (d && d.showModal) {
        e.preventDefault(); closeMenus(); d.showModal();
        var f = d.querySelector('[autofocus]') || d.querySelector('textarea, input:not([type=hidden]), select');
        if (f) f.focus();
      }
      return;
    }
    if (t.tagName === 'DIALOG') { t.close(); return; } // clique no fundo
    var closer = t.closest('[data-close]');
    if (closer) { var dlg = closer.closest('dialog'); if (dlg) dlg.close(); return; }

    var tab = t.closest('[data-tab]');
    if (tab) { var g = tab.closest('[data-tabs]'); if (g) { activateTab(g.dataset.tabs, tab.dataset.tab, true); } return; }

    var next = t.closest('[data-next]'); var prev = t.closest('[data-prev]');
    if (next || prev) {
      var w = (next || prev).closest('[data-wizard]');
      if (w) {
        var cur = Number(w.dataset.current || '1');
        if (next && !stepValid(w)) return;
        wizardShow(w, next ? cur + 1 : cur - 1);
      }
      return;
    }
    var goStep = t.closest('[data-go-step]');
    if (goStep) { var w2 = goStep.closest('[data-wizard]'); if (w2) wizardShow(w2, Number(goStep.dataset.goStep)); return; }

    var chip = t.closest('[data-filter-tag]');
    if (chip) { chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); applyFilter(chip.closest('[data-filter-group]').dataset.filterGroup); return; }

    var pressable = t.closest('[data-toggle-pressed]');
    if (pressable) { pressable.setAttribute('aria-pressed', pressable.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); }

    var toastEl = t.closest('[data-toast]');
    if (toastEl) {
      if (toastEl.tagName === 'BUTTON' && toastEl.type === 'submit' && toastEl.form) return; // tratado no submit do formulário
      if (toastEl.tagName === 'A' && ((toastEl.getAttribute('href') || '#') === '#' || toastEl.dataset.redirect)) e.preventDefault();
      toast(toastEl.dataset.toast, toastEl.dataset.toastType);
      if (toastEl.hasAttribute('data-close-after')) { var dd = toastEl.closest('dialog'); if (dd) dd.close(); }
      go(toastEl.dataset.redirect);
    }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.matches('form[data-fake-submit]')) return;
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    var dlg = form.closest('dialog'); if (dlg) dlg.close();
    toast(form.dataset.fakeSubmit, form.dataset.toastType || 'success');
    go(form.dataset.redirect);
  });

  document.addEventListener('input', function (e) {
    var el = e.target;
    var s = el.closest('[data-filter-search]') ? el : null;
    if (s) applyFilter(s.dataset.filterSearch);
    var auto = el.closest('[data-autosave]'); if (auto) autosave(auto);
    if (el.matches('textarea[id], input[id]')) updateCounter(el);
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.matches('[data-toggle-masked]')) { body.classList.toggle('cf-masked', el.checked); renderConfidential(); }
    var auto = el.closest('[data-autosave]'); if (auto && el.matches('select, input[type=checkbox], input[type=radio]')) autosave(auto);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenus();
    var tab = e.target.closest && e.target.closest('[data-tab]');
    if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      var list = Array.prototype.slice.call(tab.closest('[data-tabs]').querySelectorAll('[data-tab]'));
      var i = list.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
      var nt = list[(i + list.length) % list.length]; nt.focus(); nt.click();
    }
  });

  /* ---------- Inicialização ---------- */
  buildShell();
  initTabs();
  document.querySelectorAll('[data-wizard]').forEach(function (w) { wizardShow(w, Number(w.dataset.start || '1'), true); });
  document.querySelectorAll('[data-filter-group]').forEach(function (g) { applyFilter(g.dataset.filterGroup); });
  document.querySelectorAll('textarea[id][minlength], input[id][minlength]').forEach(updateCounter);
  if (document.querySelector('[data-confidential]')) renderConfidential();
  var q = new URLSearchParams(location.search).get('q');
  if (q) { var sEl = document.querySelector('[data-filter-search]'); if (sEl) { sEl.value = q; applyFilter(sEl.dataset.filterSearch); } }
  icons();
})();
