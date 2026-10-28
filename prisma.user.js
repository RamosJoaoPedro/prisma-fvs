// ==UserScript==
// @name         Prisma - FVS no SGQ
// @namespace    realiza-bot-fvs
// @version      2.20
// @author       João Pedro Ramos
// @description  Prisma: mapa das torres, fila de comandos, relatórios e preenchimento de FVS no SGQ da Realiza, com travas de segurança. Usa o login do próprio usuário no SGQ.
// @match        https://gdol.sgq2.com.br/*
// @homepageURL  https://github.com/RamosJoaoPedro/prisma-fvs
// @updateURL    https://raw.githubusercontent.com/RamosJoaoPedro/prisma-fvs/main/prisma.user.js
// @downloadURL  https://raw.githubusercontent.com/RamosJoaoPedro/prisma-fvs/main/prisma.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ============================== CONFIGURAÇÃO PADRÃO ==============================
  // Tudo aqui pode ser trocado pela aba "Configuração" do painel (fica salvo no navegador).
  const VERSAO = '2.20';
  const CANAL = 'oficial'; // 'oficial' ou 'teste' (o arquivo prisma-teste.user.js usa 'teste')
  const PADRAO = {
    obraNome: '', idObra: null,
    idInspecionado: null, nomeInspecionado: '',
    idAprovado: null, nomeAprovado: '',
    torres: [],            // descobertas sozinhas a partir do SGQ na primeira configuração
    exFuncionarios: [],
    descricaoPadrao: 'Item não conforme na 1ª inspeção: ',
    tratativaPadrao: 'Retrabalho executado e conferido na 2ª inspeção.',
    pausaMs: 400,
    leiturasJuntas: 3,     // consultas ao SGQ ao mesmo tempo ao ler o mapa e os relatórios (gravação é sempre uma por vez)
  };
  // Gabarito de fábrica da obra 054 Varandas Carioca (vale só para ela). Itens NA por FVS (aptos / por torre / hall) e "pre" = até qual item marca ao ABRIR (pré-requisitos).
  const GAB_PADRAO = {
    'FVS 011 B': { na: [2, 14, 22, 23] },
    'FVS 013 A': { na: { '2Q': [4], '3Q': [3, 5] }, pre: 5 },
    'FVS 014 B': { na: [], pre: 2 },
    'FVS 014 C': { na: [] },
    'FVS 015': { na: [2], naHall: [1, 2], pre: 5 },
    'FVS 016 A': { na: [5], naHall: [5, 7, 8, 19, 20] },
    'FVS 016 B': { na: [11] },
    'FVS 017 A': { na: [2] },
    'FVS 017 A1': { na: [] },
    'FVS 019 A': { na: [11], pre: 4 },
    'FVS 020 A': { na: [3, 5] },
    'FVS 021 A': { na: [] },
    'FVS 028 D': { na: [3, 9, 13, 15, 16] },
    'FVS 033 A': { na: [7, 11], pre: 4 },
    'FVS 033 B': { na: [3, 4, 5, 6], pre: 7 },
  };
  // ==================================================================================

  const GABP = () => (CFG.idObra === 2064 ? GAB_PADRAO : {});
  const configurado = () => !!(CFG.idObra && CFG.idInspecionado && CFG.idAprovado && CFG.torres && CFG.torres.length);
  const API = 'https://gdolproducao-api.sgq2.com.br/api';
  // ------------------------------ cópia de segurança (IndexedDB) ------------------------------
  // O SGQ apaga o localStorage inteiro quando a sessão cai ou a pessoa sai (localStorage.clear() no logout dele),
  // e era lá que ficavam configuração, gabaritos, "assumir fichas de", fila e mapa. Agora cada gravação também vai
  // para o IndexedDB do navegador, que o SGQ não mexe, e o que sumir do localStorage volta sozinho.
  const BK = { db: null };
  const bkPronto = new Promise((res) => {
    try { const r = indexedDB.open('prisma-fvs', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { BK.db = r.result; res(); }; r.onerror = r.onblocked = () => res(); } catch (e) { res(); }
  });
  const bkSet = (k, txt) => bkPronto.then(() => { try { if (BK.db) BK.db.transaction('kv', 'readwrite').objectStore('kv').put(txt, k); } catch (e) {} });
  const bkTudo = () => bkPronto.then(() => new Promise((res) => {
    const out = {}; if (!BK.db) return res(out);
    try { const c = BK.db.transaction('kv').objectStore('kv').openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return res(out); out[cur.key] = cur.value; cur.continue(); }; c.onerror = () => res(out); } catch (e) { res(out); }
  }));
  // Devolve ao localStorage as chaves do Prisma que sumiram e manda para a cópia as que ainda não estão nela. Retorna quantas voltaram.
  async function sincronizarCopia() {
    const T = await bkTudo(); let volta = 0;
    for (const [k, v] of Object.entries(T)) { try { if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); volta++; } } catch (e) {} }
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('botFvs2_') && T[k] === undefined) bkSet(k, localStorage.getItem(k)); } } catch (e) {}
    return volta;
  }
  const LS = {
    get: (k, d) => { try { const v = JSON.parse(localStorage.getItem('botFvs2_' + k)); return v ?? d; } catch (e) { return d; } },
    set: (k, v) => { const txt = JSON.stringify(v); bkSet('botFvs2_' + k, txt); try { localStorage.setItem('botFvs2_' + k, txt); return true; } catch (e) { setTimeout(() => avisoEspaco(k), 0); return false; } },
  };
  // O navegador guarda pouco por site (uns 5 MB). Se encher, avisa em vez de perder os dados calado.
  function avisoEspaco(k) { status(`Atenção: o navegador ficou sem espaço e não salvou "${String(k).replace(/_\d+$/, '')}". Apague dias antigos na aba Histórico ou planos que não usa mais.`); }
  let CFG = Object.assign({}, PADRAO, LS.get('cfg', {}));
  const K = (k) => k + '_' + CFG.idObra; // chaves por obra

  // ---------------------------------- utilidades ----------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const semAc = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const codNorm = (c) => norm(c).replace(/^FVS\s*/, 'FVS ');
  // Usa as mesmas credenciais que a própria tela do SGQ está mandando (ela é a fonte certa da sessão atual).
  // O Prisma só observa os cabeçalhos das chamadas do SGQ para a API dele; não guarda nada fora deste navegador.
  const API_RX = /gdolproducao-api\.sgq2\.com\.br/;
  const CAP = { h: {}, ts: 0 };
  const fetchOrig = window.fetch.bind(window);
  (function capturar() {
    const guarda = (k, v) => { k = String(k).toLowerCase(); if (k === 'content-type' || k === 'content-length') return; CAP.h[k] = String(v); CAP.ts = Date.now(); };
    try {
      const op = XMLHttpRequest.prototype.open, sh = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function (m, u) { this.__pu = String(u || ''); return op.apply(this, arguments); };
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { if (API_RX.test(this.__pu || '')) guarda(k, v); } catch (e) {} return sh.apply(this, arguments); };
    } catch (e) {}
    try {
      window.fetch = function (input, init) {
        try { const u = typeof input === 'string' ? input : (input && input.url) || ''; if (API_RX.test(u)) new Headers((init && init.headers) || (input && input.headers) || {}).forEach((v, k) => guarda(k, v)); } catch (e) {}
        return fetchOrig.apply(this, arguments);
      };
    } catch (e) {}
  })();
  const token = () => { const a = CAP.h.authorization; return a ? a.replace(/^Bearer\s+/i, '') : localStorage.getItem('token'); };
  const cabecalhos = (json) => { const h = Object.assign({}, CAP.h); if (!h.authorization) h.authorization = 'Bearer ' + localStorage.getItem('token'); if (json) h['content-type'] = 'application/json'; return h; };
  const sessaoDaTela = () => !!CAP.h.authorization;
  const tokenDiferente = () => sessaoDaTela() && CAP.h.authorization.replace(/^Bearer\s+/i, '') !== localStorage.getItem('token');
  const hojeStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const isoDia = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toISOString(); };        // meia-noite local (igual à tela)
  const isoItem = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12).toISOString(); };  // meio-dia local
  const fmt = (s) => s ? s.split('-').reverse().join('/') : '';
  const totalPreenchido = (i) => (i.totalA || 0) + (i.totalNA || 0) + (i.totalR || 0) + (i.totalX || 0) + (i.totalRA || 0);
  const listaNum = (t) => (String(t || '').match(/\d+/g) || []).map(Number);

  let PARAR = false;
  let RODANDO = false; // fila rodando: trava outro "Executar" e o que mexe na fila até terminar
  let LENDO = false;   // relatório, painel ou PPC lendo o SGQ (aba Relatório/Qualidade, que tem o próprio Parar)
  const ocupado = () => {
    const m = RODANDO ? 'Espere a fila terminar (ou clique em Parar na aba Fila) antes de fazer isso.' : LENDO ? 'Espere o relatório terminar (ou clique em Parar na aba Relatório/Qualidade).' : '';
    if (m) status(m); return !!m;
  };

  // ------------------------------ aviso central (GitHub) ------------------------------
  // aviso.json no repositório: { "manutencao": true/false, "mensagem": "...", "versaoMinima": "2.12" }
  // Editar esse arquivo no GitHub muda o aviso para todo mundo, sem mexer no código.
  const AVISO_URL = 'https://raw.githubusercontent.com/RamosJoaoPedro/prisma-fvs/main/aviso.json';
  let AVISO = null, AVISO_TS = 0;
  const cmpVer = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  async function lerAviso(forcar) {
    if (!forcar && AVISO_TS && Date.now() - AVISO_TS < 60000) return AVISO;
    try { const r = await fetchOrig(AVISO_URL + '?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) { AVISO = await r.json(); AVISO_TS = Date.now(); } } catch (e) {}
    return AVISO; // sem internet ou sem arquivo: segue normal
  }
  const bloqueio = () => { const a = AVISO || {};
    if (a.manutencao) return 'Prisma em manutenção' + (a.mensagem ? ': ' + a.mensagem : '.') + ' Gravar está bloqueado até liberar (simular e consultar continuam).';
    if (a.versaoMinima && cmpVer(VERSAO, a.versaoMinima) < 0) return `Esta versão (${VERSAO}) foi bloqueada para gravar. Atualize: painel do Tampermonkey → verificar atualizações (precisa da ${a.versaoMinima} ou mais nova).`;
    return ''; };
  const avisoHtml = () => { const a = AVISO || {}; const b = bloqueio(); if (b) return `<div class="aviso-c bloq">${esc(b)}</div>`; return a.mensagem ? `<div class="aviso-c">${esc(a.mensagem)}</div>` : ''; };

  async function api(method, path, body) {
    for (let tent = 1; ; tent++) {
      await sleep(CFG.pausaMs);
      const r = await fetchOrig(API + path, { method, headers: cabecalhos(true), body: body ? JSON.stringify(body) : undefined });
      // SGQ pediu para ir mais devagar (429 = recusou sem gravar nada): espera e tenta de novo, até 3 vezes.
      // Outros erros não repetem: um 503 pode chegar depois de o SGQ já ter gravado, e repetir duplicaria a ficha.
      if (r.status === 429 && tent < 3) { await sleep(2000 * tent); continue; }
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      if (r.status === 401) throw new Error('Sessão expirada: faça login de novo no SGQ e rode outra vez.');
      return { st: r.status, j, t };
    }
  }
  // Lê vários locais ao mesmo tempo (só consultas). Gravar no SGQ continua sendo uma ficha por vez, na fila.
  // Para no primeiro erro que escapar de fn (ex.: sessão expirada) e, se parar=true, quando o usuário clica em Parar.
  async function emParalelo(lista, fn, { parar = true } = {}) {
    let prox = 0, erro = null;
    const n = Math.max(1, Math.min(+CFG.leiturasJuntas || 3, 6, lista.length));
    const trab = async () => { while (!erro && !(parar && PARAR) && prox < lista.length) { const k = prox++; try { await fn(lista[k], k); } catch (e) { erro = erro || e; } } };
    await Promise.all(Array.from({ length: n }, trab));
    if (erro) throw erro;
  }
  const msgErro = (r) => (r.j && r.j.message ? [].concat(r.j.message).join(' ') : (r.t || '').slice(0, 200)) || ('HTTP ' + r.st);

  // ---------------------------------- dados do SGQ ----------------------------------
  let AREAS = null;              // [{idObraAreaChecklist, descricao}]
  let NOMES = LS.get(K('nomes'), {}); // código FVS -> nome
  let MAPA = LS.get(K('mapa'), { ts: {}, areas: {} }); // areas[nome] = {id, fvs:{cod:[idS,status,total,ir,irep]}}

  async function listarAreas() {
    if (!AREAS) {
      const r = await api('POST', '/obras/area-checklists', { idObra: CFG.idObra, area: '', status: 2, page: 1, rowsPerPage: 3000 });
      if (r.st !== 200) throw new Error('Não consegui ler as áreas da obra (' + r.st + ').');
      AREAS = r.j.items.map((a) => ({ id: a.idObraAreaChecklist, nome: a.descricao.trim() }));
    }
    return AREAS;
  }
  async function carregarNomes() {
    const r = await api('POST', '/obras/servico/dropdown', { idObra: CFG.idObra });
    if (r.st !== 200) return;
    for (const it of r.j.itens || []) {
      const m = /^\s*(FVS\s+\d{3}(?:\s*[A-Z]\d?)?)\s*-\s*([\s\S]*)$/i.exec(it.descricao || '');
      if (m) NOMES[codNorm(m[1])] = m[2].replace(/\s+/g, ' ').trim();
    }
    LS.set(K('nomes'), NOMES);
  }
  async function servicosDaArea(idArea) {
    const r = await api('POST', '/obras/obra-checklist-servicos', { idObra: CFG.idObra, idObraAreaChecklist: idArea, statusChecklist: 2, statusVerificacao: 3, page: 1, rowsPerPage: 300 });
    if (r.st !== 200) throw new Error('erro ao ler as FVS da área (' + r.st + ')');
    return r.j.items;
  }
  async function atualizarArea(nome) {
    const a = (await listarAreas()).find((x) => norm(x.nome) === norm(nome));
    if (!a) return;
    const S = await servicosDaArea(a.id);
    const fvs = {};
    for (const x of S) { const c = codNorm(x.codigo); fvs[c] = [x.idObraChecklistServico, x.status, x.total, +(x.ir > 0), +(x.irep > 0)]; if (!NOMES[c]) NOMES[c] = (x.descricao || '').trim(); }
    const antes = MAPA.areas[a.nome];
    if (antes && antes.fvs) { // compara com a leitura anterior e registra o que mudou no SGQ
      const agora = new Date().toISOString(), recente = (cod) => HIST.some((x) => x.src === 'prisma' && x.a === a.nome && x.f === cod && Date.now() - new Date(x.q) < 15 * 60000);
      for (const [cod, e] of Object.entries(fvs)) {
        const o = antes.fvs[cod]; let ev = null;
        if (!o) ev = 'nova'; else if (o[1] !== 1 && e[1] === 1) ev = 'finalizada'; else if (o[1] === 1 && e[1] !== 1) ev = 'reaberta'; else if (!(o[2] > 0) && e[2] > 0) ev = 'iniciada'; else if (o[2] > 0 && !(e[2] > 0) && e[1] !== 1) ev = 'zerada';
        if (ev && !recente(cod)) HIST.push({ q: agora, a: a.nome, f: cod, ev, src: 'sgq' });
      }
      if (HIST.length > 6000) HIST = HIST.slice(-6000);
      salvarHist();
    }
    MAPA.areas[a.nome] = { id: a.id, fvs };
  }
  const salvarMapa = () => LS.set(K('mapa'), MAPA);

  // ---------------------------------- torres ----------------------------------
  // Leitura genérica dos nomes das áreas do SGQ, para qualquer obra. Exemplos que o Prisma entende sozinho:
  //   unidade: "BLOCO 01 - APTO 1701", "TORRE A - AP 101", "BLOCO B - 1203", "CASA 15", "QUADRA 2 - CASA 04"
  //   hall:    "BLOCO 01 - 16º PAVIMENTO", "TORRE A - PAVIMENTO 3", "TORRE A - 3º ANDAR", "BLOCO 01 - 00 TÉRREO"
  // Se uma obra escrever diferente, o perfil enviado pelo Claude (aba Configuração) traz a regra, sem mudar o script.
  const UNID = 'APTO|APARTAMENTO|APT|AP|UNIDADE|UND|UN|CASA|SOBRADO|LOTE|SALA|LOJA';
  const HORIZ = /^(CASA|SOBRADO|LOTE)$/;
  let RXP = null; const MEMO = new Map();
  function regrasPerfil() { const p = LS.get('perfil_' + CFG.idObra, {}) || {}; const mk = (s) => { try { return s ? new RegExp(s, 'i') : null; } catch (e) { return null; } }; return { un: mk(p.rxUn), pav: mk(p.rxPav) }; }
  function zerarLeitura() { RXP = null; MEMO.clear(); }
  function unid(b, u, n) {
    u = String(u || '').toUpperCase(); const num = +n; const vert = String(n).length >= 3 && !HORIZ.test(u);
    return { tipo: 'un', bloco: String(b || '').trim() || (u ? u + 'S' : 'UNIDADES'), un: u, num, andar: vert ? Math.floor(num / 100) : 0, pos: vert ? num % 100 : num };
  }
  function lerArea(nome) {
    const s = String(nome || '').replace(/\s+/g, ' ').trim();
    if (MEMO.has(s)) return MEMO.get(s);
    if (!RXP) RXP = regrasPerfil();
    let m, r = null;
    if (RXP.un && (m = RXP.un.exec(s)) && m.groups && m.groups.n) r = unid(m.groups.b, m.groups.u, m.groups.n);
    else if (RXP.pav && (m = RXP.pav.exec(s)) && m.groups) r = { tipo: 'hall', bloco: (m.groups.b || '').trim(), pav: m.groups.p && /\d/.test(m.groups.p) ? +m.groups.p.replace(/\D/g, '') : 0 };
    else if ((m = new RegExp('^(.+?) ?- ?(' + UNID + ')\\.? ?(\\d{1,4})$', 'i').exec(s))) r = unid(m[1], m[2], m[3]);
    else if ((m = new RegExp('^(' + UNID + ')\\.? ?(\\d{1,4})$', 'i').exec(s))) r = unid('', m[1], m[2]);
    else if ((m = /^(.+?) ?- ?(\d{3,4})$/.exec(s))) r = unid(m[1], '', m[2]);
    else if ((m = /^(.+?) ?- ?(?:\d{1,2} ?)?T[ÉE]RREO$/i.exec(s))) r = { tipo: 'hall', bloco: m[1].trim(), pav: 0 };
    else if ((m = /^(.+?) ?- ?(\d{1,2}) ?(?:º|°|ª|o)? ?(?:PAVIMENTO|PAV\.?|ANDAR)$/i.exec(s)) || (m = /^(.+?) ?- ?(?:PAVIMENTO|PAV\.?|ANDAR) ?(\d{1,2})$/i.exec(s))) r = { tipo: 'hall', bloco: m[1].trim(), pav: +m[2] };
    else { const i = s.indexOf(' - '); r = { tipo: 'outro', bloco: i > 0 ? s.slice(0, i).trim() : s }; }
    MEMO.set(s, r); return r;
  }
  const torreDe = (area) => { const b = lerArea(area).bloco; return CFG.torres.find((t) => t.bloco === b) || CFG.torres.find((t) => area === t.bloco || area.startsWith(t.bloco + ' - ')); };
  const ehHall = (area) => lerArea(area).tipo !== 'un';
  const rotUn = (p) => (p.un === 'APTO' || p.un === 'AP' || p.un === 'APT' || p.un === 'APARTAMENTO' ? 'Apto' : p.un ? p.un.charAt(0) + p.un.slice(1).toLowerCase() : 'Un.');
  function estruturaTorre(T) {
    const nomes = (AREAS || []).map((a) => a.nome).concat(Object.keys(MAPA.areas));
    const todas = [...new Set(nomes.filter((n) => torreDe(n) === T))];
    const un = {}, halls = {}, porNum = {}; let maxPos = 0;
    for (const n of todas) {
      const p = lerArea(n);
      if (p.tipo === 'un') { (un[p.andar] = un[p.andar] || {})[p.pos] = n; if (!porNum[p.num]) porNum[p.num] = n; if (p.pos > maxPos) maxPos = p.pos; }
      else if (p.tipo === 'hall' && !halls[p.pav]) halls[p.pav] = n;
    }
    const plano = !Object.keys(un).some((a) => +a > 0);
    const P = plano ? 10 : Math.min(+T.pos || maxPos || 8, 24);
    const M = plano ? P : Math.max(0, Math.min(P, T.meio != null && T.meio !== '' ? +T.meio : Math.ceil(P / 2)));
    const andares = plano ? [] : Object.keys(un).map(Number).filter((a) => a > 0).sort((a, b) => b - a);
    const apto = (an, p) => (un[an] || {})[p];
    const hall = (an) => halls[an + (T.hall || 0)];
    const temHall = !plano && andares.some((an) => hall(an));
    const casas = plano ? Object.values(un[0] || {}).sort((a, b) => lerArea(a).num - lerArea(b).num) : [];
    const ordem = [];
    andares.forEach((an) => { for (let p = 1; p <= P; p++) if (apto(an, p)) ordem.push(apto(an, p)); if (hall(an)) ordem.push(hall(an)); });
    casas.forEach((n) => ordem.push(n));
    const usados = new Set(ordem);
    const outros = todas.filter((n) => !usados.has(n)).sort((a, b) => a.localeCompare(b, 'pt', { numeric: true }));
    return { andares, outros, todas, P, M, plano, casas, apto, hall, temHall, porNum, halls, ordem };
  }
  const localCurto = (a) => { const p = lerArea(a); const T = torreDe(a);
    if (p.tipo === 'un') return rotUn(p) + ' ' + (p.andar ? String(p.num).padStart(4, '0').replace(/^0/, '') : p.num);
    if (p.tipo === 'hall') return p.pav === 0 ? 'Térreo' : `Hall ${p.pav}º pav.`;
    return T && a === T.bloco ? 'Bloco geral' : T ? a.replace(T.bloco + ' - ', '') : a; };
  const localComTorre = (a) => { const T = torreDe(a); return (T ? T.nome + ' · ' : '') + localCurto(a); };

  // ---------------------------------- gabaritos ----------------------------------
  let GAB_USER = LS.get(K('gab'), {});
  function gabarito(cod, torre, hall) {
    const g = GAB_USER[cod] || GABP()[cod];
    if (!g) return null;
    let na = hall && g.naHall ? g.naHall : g.na;
    if (na && !Array.isArray(na)) na = na[torre];
    if (!Array.isArray(na)) return null;
    return { na, pre: g.pre || null, origem: GAB_USER[cod] ? 'seu' : 'padrão' };
  }
  const SIGLAS = ['BIT', 'GLP', 'SPDA'];
  function nomeLimpo(c) {
    let s = String(NOMES[c] || '').replace(/\(\s*AMOSTRAGEM[^)]*\)/gi, '').replace(/\(\s*NOVO\s*\)/gi, '').replace(/\(\s*Pr[eé]dio\s*\)/gi, '')
      .replace(/\bREV\.?\s*\d+\s*$/i, '').replace(/\s+/g, ' ').replace(/(\s*-\s*)+$/, '').replace(/\s+-\s+-\s+/g, ' - ').trim().toLowerCase();
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return s.replace(/\b[a-z]+\b/gi, (w) => SIGLAS.includes(w.toUpperCase()) ? w.toUpperCase() : w) || c;
  }

  // Aprende o gabarito lendo fichas já encerradas daquela FVS na torre (prefere as suas).
  async function aprenderGabarito(cod, torreNome, log) {
    const T = CFG.torres.find((t) => t.nome === torreNome);
    const cand = Object.entries(MAPA.areas).filter(([n, a]) => torreDe(n) === T && a.fvs[cod] && a.fvs[cod][1] === 1);
    const aptos = cand.filter(([n]) => !ehHall(n)).slice(0, 10), halls = cand.filter(([n]) => ehHall(n)).slice(0, 4);
    if (!aptos.length && !halls.length) return { erro: 'Não achei FVS finalizada desse serviço na ' + torreNome + '. Atualize o mapa da torre ou defina na mão.' };
    const amostras = [];
    for (const [n, a] of aptos.concat(halls)) {
      log && log(`lendo ${n}...`);
      const v = ((await api('POST', '/obras/inspecoes-obra', { idObraChecklistServico: a.fvs[cod][0], page: 1, rowsPerPage: 20 })).j || {}).items || [];
      const enc = v.find((i) => i.status === 1 || i.status === 2); if (!enc) continue;
      const d = ((await api('GET', '/obras/inspecoes-obra/' + enc.idInspecaoObra)).j || {}).item || {};
      const it = ((await api('POST', '/obras/inspecoes-obra/' + enc.idInspecaoObra + '/items', { page: 1, rowsPerPage: 300 })).j || {}).items || [];
      amostras.push({ area: n, hall: ehHall(n), meu: d.idFuncionarioInspecionado === CFG.idInspecionado, itens: it.map((x) => ({ o: parseInt(x.ordem, 10), v: x.inspecao1, d: x.descricao })) });
    }
    const calc = (L) => {
      if (!L.length) return null;
      const base = L.some((x) => x.meu) ? L.filter((x) => x.meu) : L;
      const cont = {}; base.forEach((s) => s.itens.forEach((x) => { cont[x.o] = cont[x.o] || [0, 0]; cont[x.o][1]++; if (x.v === 'N') cont[x.o][0]++; }));
      const na = Object.entries(cont).filter(([, [k, t]]) => k * 2 >= t && k > 0).map(([o]) => +o).sort((a, b) => a - b);
      const duvida = Object.entries(cont).filter(([, [k, t]]) => k > 0 && k < t).map(([o, [k, t]]) => `item ${o}: NA em ${k} de ${t}`);
      // variação por final de apto (ex.: finais 05 diferentes)
      const finais = {};
      base.filter((s) => !s.hall).forEach((s) => { const f = String(lerArea(s.area).pos).padStart(2, '0'); s.itens.forEach((x) => { const isNa = x.v === 'N'; if (isNa !== na.includes(x.o)) (finais[f] = finais[f] || new Set()).add(x.o); }); });
      return { na, duvida, finais: Object.entries(finais).map(([f, s]) => `final ${f}: itens ${[...s].join(', ')} diferentes`), n: base.length, meus: base.filter((x) => x.meu).length };
    };
    const ap = calc(amostras.filter((x) => !x.hall)), hl = calc(amostras.filter((x) => x.hall));
    if (!amostras.length) return { erro: `Achei ${aptos.length + halls.length} FVS finalizada(s) desse serviço na ${torreNome}, mas nenhuma tinha ficha encerrada para ler. Use "Montar na ficha" e marque na mão.` };
    const ref = (amostras.find((x) => !x.hall) || amostras[0]).itens;
    let pre = 0; for (const x of ref.sort((a, b) => a.o - b.o)) { if (/pessoal|epi|epc|ferrament|materia|treinad|liberad|projeto|conclu[ií]d|instalad/i.test(x.d || '') && x.o === pre + 1) pre = x.o; else break; }
    return { ap, hl, pre: pre || null, total: ref.length, itens: ref };
  }

  // ---------------------------------- motor de gravação ----------------------------------
  // "Yuri Rodrigues" vale para "YURI GALDIANO RODRIGUES": o primeiro nome tem que bater e as outras palavras digitadas
  // precisam estar no nome completo (acento e maiúscula não importam). O começo do nome ("Yuri Galdiano") continua valendo.
  const palavrasNome = (s) => norm(semAc(s)).split(' ').filter((w) => w && !['DA', 'DE', 'DO', 'DAS', 'DOS', 'E'].includes(w));
  const nomeBate = (digitado, completo) => {
    if (!norm(digitado)) return false;
    if (norm(semAc(completo)).startsWith(norm(semAc(digitado)))) return true;
    const a = palavrasNome(digitado), b = palavrasNome(completo);
    return a.length >= 2 && a[0] === b[0] && a.every((w) => b.includes(w));
  };
  const podeAssumir = (nome) => CFG.exFuncionarios.some((n) => nomeBate(n, nome));
  // Mostra, na Configuração, com quem cada nome da lista "Assumir fichas de" bate.
  function conferirEx(L, funcs) {
    if (!L.length) return '';
    if (!funcs.length) return 'A lista de funcionários ainda não carregou: o nome é conferido na hora de assumir a ficha.';
    return L.map((n) => { const m = funcs.filter((f) => nomeBate(n, f.nome));
      if (m.length === 1) return `✓ ${esc(n)} → <b>${esc(m[0].nome)}</b>`;
      if (m.length) return `⚠ ${esc(n)} bate com ${m.length} pessoas (${m.slice(0, 4).map((f) => esc(f.nome)).join(', ')}${m.length > 4 ? '…' : ''}): escreva mais um sobrenome.`;
      return `⚠ ${esc(n)}: não achei na lista de funcionários. Se for ex-funcionário, confira se o primeiro nome e um sobrenome estão como na ficha do SGQ.`; }).join('<br>');
  }
  const OK = (msg) => ({ resultado: 'OK', msg });
  const PEND = (msg) => ({ resultado: 'PENDENTE', msg });

  async function salvarFicha(idInspecao, status, itens, dataEncerramento) {
    await sleep(CFG.pausaMs);
    const fd = new FormData();
    fd.append('idInspecaoObra', String(idInspecao)); fd.append('idObra', String(CFG.idObra));
    fd.append('idFuncionarioAprovado', String(CFG.idAprovado)); fd.append('idFuncionarioInspecionado', String(CFG.idInspecionado));
    fd.append('status', String(status)); if (dataEncerramento) fd.append('dataEncerramento', dataEncerramento);
    itens.forEach((it, k) => {
      fd.append(`inspecaoObraItens[${k}][idInspecaoObraItem]`, String(it.idInspecaoObraItens));
      fd.append(`inspecaoObraItens[${k}][inspecao1]`, it.inspecao1 || '');
      fd.append(`inspecaoObraItens[${k}][inspecao2]`, it.inspecao2 || '');
      if (it.dataInspecao1) fd.append(`inspecaoObraItens[${k}][dataInspecao1]`, it.dataInspecao1);
      if (it.dataInspecao2) fd.append(`inspecaoObraItens[${k}][dataInspecao2]`, it.dataInspecao2);
    });
    for (let n = 1; n <= 5; n++) fd.append('limparArquivo' + n, 'false');
    const r = await fetchOrig(API + '/obras/inspecoes-obra/update-with-validation', { method: 'POST', headers: cabecalhos(false), body: fd });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { ok: r.status === 200, msg: msgErro({ st: r.status, j, t }) };
  }
  const listarVerif = async (idS) => ((await api('POST', '/obras/inspecoes-obra', { idObraChecklistServico: idS, page: 1, rowsPerPage: 50 })).j || {}).items || [];
  const finalizarFvs = async (idS) => (await api('POST', '/obras/obra-checklist-servicos/update/status', { idObraChecklistServico: idS, status: 1 })).st === 200;

  // t = { area, fvs, acao:'abrir'|'fechar', dAbrir, dFechar, na?, pre?, opc:{assumir, segunda, tratativa} }
  async function executarTarefa(t, simular) {
    if (!configurado()) return PEND('Prisma ainda não configurado (aba Configuração)');
    const T = torreDe(t.area); const hall = ehHall(t.area);
    const g = t.na ? { na: t.na, pre: t.pre || null } : gabarito(t.fvs, T && T.nome, hall);
    if (!g) return PEND('FVS sem gabarito: defina na aba Gabaritos');
    if (t.acao === 'abrir' && !g.pre) return PEND('sem pré-requisitos definidos para abrir (aba Gabaritos)');
    const hj = hojeStr();
    if (t.dAbrir > hj || t.dFechar > hj) return PEND('data no futuro');
    if (t.acao === 'fechar' && t.dAbrir > t.dFechar) return PEND('data de abertura depois da de fechamento');

    const a = (await listarAreas()).find((x) => norm(x.nome) === norm(t.area));
    if (!a) return PEND('área não encontrada no SGQ');
    let fv = (await servicosDaArea(a.id)).filter((x) => codNorm(x.codigo) === t.fvs);
    if (!fv.length) return PEND('FVS não existe nessa área');
    if (fv.length > 1) { // a mesma FVS cadastrada 2x na área: só segue se sobrar exatamente uma não finalizada
      const nf = fv.filter((x) => x.status !== 1);
      if (!nf.length) return OK(`a FVS aparece ${fv.length} vezes na área e todas já estão finalizadas`);
      if (nf.length > 1) return PEND(`a FVS aparece ${fv.length} vezes na área e ${nf.length} não estão finalizadas: conferir na tela qual é a certa`);
      fv = nf;
    }
    const idS = fv[0].idObraChecklistServico;

    let verifs = await listarVerif(idS);
    let abertas = verifs.filter((i) => i.status === 0 || i.status === 3);
    let lista = null;
    if (abertas.length > 1) { // confere todas antes de gravar qualquer uma
      const dt = (s) => s ? new Date(s).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?';
      const bloq = [];
      for (const v of abertas) {
        const d = ((await api('GET', '/obras/inspecoes-obra/' + v.idInspecaoObra)).j || {}).item || {};
        const dono = (d.funcionarioInspecionado || '').trim();
        if (d.idFuncionarioInspecionado && d.idFuncionarioInspecionado !== CFG.idInspecionado && !(t.opc.assumir && podeAssumir(dono))) bloq.push(`aberta em ${dt(v.dataAbertura)} por ${dono}, ${totalPreenchido(v)}/${v.totalItens} itens`);
        else if (!d.idFuncionarioInspecionado && totalPreenchido(v) > 0) bloq.push(`aberta em ${dt(v.dataAbertura)} sem inspetor e com itens marcados`);
      }
      if (bloq.length) return PEND(`${abertas.length} verificações abertas; não posso mexer em: ${[...new Set(bloq)].join(' | ')}. Para assumir, coloque o nome em Configuração → Assumir fichas de, e marque a opção no Mapa.`);
      lista = abertas.slice().sort((x, y) => String(x.dataAbertura).localeCompare(String(y.dataAbertura)));
    }
    let V = abertas[0], criada = false;
    const naTxt = g.na.length ? 'NA ' + g.na.join(', ') : 'sem NA';

    const comOc = !!(t.oc && t.oc.length);
    if (!V) {
      if (verifs.length) {
        if (comOc) return PEND('a verificação desta FVS já está encerrada: a ocorrência não foi criada (registre pela tela do SGQ)');
        if (t.acao === 'abrir') return OK('já tinha verificação encerrada');
        if (fv[0].status === 1) return OK('já estava encerrada e finalizada');
        if (simular) return OK('SIMULAÇÃO: só finalizaria a FVS (verificação já encerrada)');
        return (await finalizarFvs(idS)) ? OK('verificação já estava encerrada; FVS finalizada') : PEND('erro ao finalizar a FVS');
      }
      if (simular) return OK(`SIMULAÇÃO: criaria a ficha em ${fmt(t.dAbrir)}, ${comOc ? `${t.acao === 'abrir' ? `marcaria os itens 1 a ${g.pre}` : 'preencheria os itens'}, marcaria R e criaria ocorrência no ${t.oc.map((o) => 'item ' + o.item).join(', ')} e deixaria iniciada (sem encerrar)` : t.acao === 'abrir' ? `marcaria os itens 1 a ${g.pre} e deixaria iniciada` : `preencheria tudo e encerraria em ${fmt(t.dFechar)}`} (${naTxt})`);
      const c = await api('POST', '/obras/inspecoes-obra/create', { idObraChecklistServico: idS, data: isoDia(t.dAbrir), campo1: null, campo2: null, campo3: null, campo4: null });
      if (c.st !== 200) return PEND('erro ao criar verificação: ' + msgErro(c));
      verifs = await listarVerif(idS); abertas = verifs.filter((i) => i.status === 0 || i.status === 3);
      if (abertas.length !== 1) return PEND(`depois de criar apareceram ${abertas.length} verificações abertas: conferir`);
      V = abertas[0]; criada = true;
    }

    // Uma ou várias verificações abertas da mesma FVS: preenche cada uma (o SGQ não deixa o usuário excluir duplicadas).
    const alvos = lista || [V];
    const res = [];
    for (let k = 0; k < alvos.length; k++) {
      const rr = await processarVerif(k === 0 ? t : { ...t, oc: [] }, g, alvos[k], criada && k === 0, simular, naTxt, idS); // ocorrência só na primeira verificação
      if (rr.resultado === 'PENDENTE') return PEND((alvos.length > 1 ? `verificação ${k + 1} de ${alvos.length}: ` : '') + rr.msg + (k && !simular ? ` (as ${k} anteriores já foram gravadas)` : ''));
      res.push(rr.msg);
    }
    const junta = (alvos.length > 1 ? `${alvos.length} verificações abertas, todas tratadas: ` : '') + (() => { const c = new Map(); res.forEach((m) => c.set(m, (c.get(m) || 0) + 1)); return [...c].map(([m, n]) => n > 1 ? `${m} (×${n})` : m).join(' | '); })();
    if (comOc) return OK((simular ? 'SIMULAÇÃO: ' : '') + junta + ' · FVS fica aberta até a tratativa');
    if (simular) return OK('SIMULAÇÃO: ' + junta + (t.acao === 'fechar' ? ' e finalizaria' : ''));
    if (t.acao === 'abrir') return OK(junta);
    return (await finalizarFvs(idS)) ? OK(junta + ' e FVS finalizada') : PEND(junta + ', mas deu erro ao finalizar a FVS');
  }

  async function processarVerif(t, g, V, criada, simular, naTxt, idS) {
    const det = ((await api('GET', '/obras/inspecoes-obra/' + V.idInspecaoObra)).j || {}).item;
    if (!det) return PEND('não consegui ler a verificação');
    let assumidaDe = '';
    if (det.idFuncionarioInspecionado && det.idFuncionarioInspecionado !== CFG.idInspecionado) {
      const ex = podeAssumir(det.funcionarioInspecionado);
      if (!(t.opc.assumir && ex)) return PEND('verificação aberta por ' + (det.funcionarioInspecionado || '').trim() + (ex ? ' (marque "Assumir fichas de" no Mapa)' : ' (para assumir, coloque o nome em Configuração → Assumir fichas de)'));
      assumidaDe = (det.funcionarioInspecionado || '').trim();
    }
    if (!det.idFuncionarioInspecionado && !criada && totalPreenchido(V) > 0) return PEND('verificação com itens marcados e sem inspetor: conferir');

    const itens = ((await api('POST', '/obras/inspecoes-obra/' + V.idInspecaoObra + '/items', { page: 1, rowsPerPage: 300 })).j || {}).items || [];
    if (!itens.length) return PEND('verificação sem itens');
    if (t.oc && t.oc.length) return processarOcorrencias(t, g, V, itens, simular, naTxt, idS, assumidaDe);
    const ruins = itens.filter((x) => ['R', 'X'].includes(x.inspecao1) || x.inspecao2);
    const lista2 = (arr) => arr.map((b) => `${parseInt(b.ordem, 10)}=${b.inspecao1}${b.inspecao2 ? '/' + b.inspecao2 : ''}`).join(', ');
    let aprov2 = [];
    if (ruins.length && t.acao === 'fechar') {
      if (!t.opc.segunda) return PEND('item R/X: ' + lista2(ruins) + ' (marque "aprovar 2ª inspeção")');
      const rep = ruins.filter((x) => x.inspecao2 && x.inspecao2 !== 'A');
      if (rep.length) return PEND('2ª inspeção já reprovada: ' + lista2(rep));
      aprov2 = ruins.filter((x) => ['R', 'X'].includes(x.inspecao1) && !x.inspecao2);
      for (const x of aprov2) { x.inspecao2 = 'A'; x.dataInspecao2 = isoItem(t.dFechar); }
    }
    let preenchidos = 0;
    for (const x of itens) {
      const o = parseInt(x.ordem, 10);
      if (t.acao === 'abrir' && o > g.pre) continue;
      if (!x.inspecao1) { x.inspecao1 = g.na.includes(o) ? 'N' : 'A'; x.dataInspecao1 = isoItem(g.pre && o <= g.pre ? t.dAbrir : t.dFechar); preenchidos++; }
    }
    if (t.acao === 'abrir' && !preenchidos && V.status === 3 && !assumidaDe) return OK('já estava iniciada com os pré-requisitos');

    let ocCriar = [], ocCompletar = [];
    if (t.acao === 'fechar' && t.opc.segunda) {
      const ocs = ((await api('POST', '/obras/inspecoes-obra/' + V.idInspecaoObra + '/ocorrencias', { page: 1, rowsPerPage: 200 })).j || {}).items || [];
      ocCompletar = ocs.filter((o) => !o.tratativa || !o.dataTratativa);
      ocCriar = itens.filter((x) => ['R', 'X'].includes(x.inspecao1) && !ocs.some((o) => o.idInspecaoObraItens === x.idInspecaoObraItens));
    }
    const trat = (t.opc.tratativa || '').trim() || CFG.tratativaPadrao;
    if (simular) {
      return OK(`${assumidaDe ? 'assumiria a ficha de ' + assumidaDe + ', ' : ''}${aprov2.length ? 'aprovaria a 2ª inspeção de ' + lista2(aprov2) + ', ' : ''}${ocCriar.length ? 'criaria ' + ocCriar.length + ' ocorrência(s), ' : ''}${ocCompletar.length ? 'completaria ' + ocCompletar.length + ' ocorrência(s), ' : ''}preencheria ${preenchidos} itens e ${t.acao === 'abrir' ? 'deixaria iniciada' : 'encerraria em ' + fmt(t.dFechar)} (${naTxt})`);
    }
    for (const x of ocCriar) {
      const c = await api('POST', '/obras/inspecoes-obra/' + V.idInspecaoObra + '/ocorrencias/create', { idObra: CFG.idObra, idInspecaoObraItens: x.idInspecaoObraItens, inspecao: 1, descricao: CFG.descricaoPadrao + (x.descricao || '').trim(), dataDescricao: x.dataInspecao1 || isoDia(t.dAbrir), tratativa: trat, dataTratativa: isoDia(t.dFechar) });
      if (c.st !== 200) return PEND('erro ao criar ocorrência do item ' + parseInt(x.ordem, 10) + ': ' + msgErro(c));
    }
    for (const o of ocCompletar) {
      const u = await api('POST', '/obras/inspecoes-obra/' + V.idInspecaoObra + '/ocorrencias/update', { idObra: CFG.idObra, idInformacoesInspecaoObra: o.idInformacoesInspecaoObra, idInspecaoObraItens: o.idInspecaoObraItens, inspecao: o.inspecaoValue || 1, descricao: o.descricao, dataDescricao: o.data || isoDia(t.dAbrir), tratativa: o.tratativa || trat, dataTratativa: o.dataTratativa || isoDia(t.dFechar) });
      if (u.st !== 200) return PEND('erro ao completar ocorrência: ' + msgErro(u));
    }
    const alvo = t.acao === 'abrir' ? 3 : 1;
    const s = await salvarFicha(V.idInspecaoObra, alvo, itens, t.acao === 'abrir' ? null : isoDia(t.dFechar));
    if (!s.ok) return PEND('o SGQ recusou salvar: ' + s.msg);
    const dep = (await listarVerif(idS)).find((i) => i.idInspecaoObra === V.idInspecaoObra);
    if (!dep) return PEND('salvou, mas não achei a verificação depois: conferir');
    if (dep.status !== alvo) return PEND('salvou, mas o status ficou ' + dep.status + ': conferir');
    const tot = totalPreenchido(dep);
    if (t.acao === 'abrir') return OK(`${assumidaDe ? 'assumida de ' + assumidaDe + '; ' : ''}iniciada em ${fmt(t.dAbrir)}, ${Math.min(tot, dep.totalItens)}/${dep.totalItens} itens`);
    if (tot < dep.totalItens) return PEND(`encerrou com ${tot}/${dep.totalItens} itens: conferir`);
    if (aprov2.length) {
      const novos = ((await api('POST', '/obras/inspecoes-obra/' + V.idInspecaoObra + '/items', { page: 1, rowsPerPage: 300 })).j || {}).items || [];
      const falhou = aprov2.filter((a2) => (novos.find((n) => n.idInspecaoObraItens === a2.idInspecaoObraItens) || {}).inspecao2 !== 'A');
      if (falhou.length) return PEND('encerrou, mas a 2ª inspeção não gravou: conferir na tela (FVS não finalizada)');
    }
    return OK(`${assumidaDe ? 'assumida de ' + assumidaDe + '; ' : ''}${aprov2.length ? '2ª inspeção aprovada; ' : ''}encerrada em ${fmt(t.dFechar)} (${Math.min(tot, dep.totalItens)}/${dep.totalItens})`);
  }
  // Ocorrência pedida na fila (botão "Criar ocorrência"): preenche o resto pelo gabarito, cria a ocorrência SEM tratativa
  // no item escolhido, marca o item como R e deixa a ficha INICIADA. O SGQ não deixa encerrar com ocorrência sem tratativa,
  // então a FVS fica aberta até alguém fazer a tratativa. A ocorrência vem antes de salvar porque o SGQ recusa item R sem ocorrência.
  async function processarOcorrencias(t, g, V, itens, simular, naTxt, idS, assumidaDe) {
    const dia = t.acao === 'abrir' ? t.dAbrir : t.dFechar;
    const alvo = [];
    for (const oc of t.oc) {
      const x = itens.find((i) => parseInt(i.ordem, 10) === +oc.item);
      if (!x) return PEND(`ocorrência: a ficha não tem o item ${oc.item}`);
      if (x.inspecao2) return PEND(`ocorrência: o item ${oc.item} já tem 2ª inspeção (${x.inspecao1}/${x.inspecao2}); registre pela tela do SGQ`);
      alvo.push([oc, x]);
    }
    let preenchidos = 0;
    for (const x of itens) {
      const o = parseInt(x.ordem, 10);
      if (alvo.some(([, y]) => y === x) || (t.acao === 'abrir' && o > g.pre)) continue;
      if (!x.inspecao1) { x.inspecao1 = g.na.includes(o) ? 'N' : 'A'; x.dataInspecao1 = isoItem(g.pre && o <= g.pre ? t.dAbrir : t.dFechar); preenchidos++; }
    }
    const ocs = ((await api('POST', '/obras/inspecoes-obra/' + V.idInspecaoObra + '/ocorrencias', { page: 1, rowsPerPage: 200 })).j || {}).items || [];
    // rodou de novo (ex.: o salvar falhou da outra vez): não cria a mesma ocorrência duas vezes
    const novas = alvo.filter(([oc, x]) => !ocs.some((o) => o.idInspecaoObraItens === x.idInspecaoObraItens && String(o.descricao || '').trim() === oc.texto.trim()));
    const txtItens = alvo.map(([oc]) => 'item ' + oc.item).join(', ');
    if (simular) return OK(`${assumidaDe ? 'assumiria a ficha de ' + assumidaDe + ', ' : ''}preencheria ${preenchidos} itens, marcaria R e criaria ocorrência no ${txtItens} e deixaria a ficha iniciada, sem encerrar (${naTxt})`);
    for (const [oc, x] of novas) {
      const c = await api('POST', '/obras/inspecoes-obra/' + V.idInspecaoObra + '/ocorrencias/create', { idObra: CFG.idObra, idInspecaoObraItens: x.idInspecaoObraItens, inspecao: 1, descricao: oc.texto.trim(), dataDescricao: isoDia(dia), tratativa: null, dataTratativa: null });
      if (c.st !== 200) return PEND(`erro ao criar a ocorrência do item ${oc.item}: ${msgErro(c)}`);
    }
    for (const [, x] of alvo) { x.inspecao1 = 'R'; x.dataInspecao1 = isoItem(dia); }
    const s = await salvarFicha(V.idInspecaoObra, 3, itens, null);
    if (!s.ok) return PEND(`ocorrência criada (${txtItens}), mas o SGQ recusou salvar a ficha: ${s.msg}`);
    const dep = (await listarVerif(idS)).find((i) => i.idInspecaoObra === V.idInspecaoObra);
    if (!dep || dep.status !== 3) return PEND('ocorrência criada, mas confira a ficha na tela (status ' + (dep ? dep.status : '?') + ')');
    return OK(`${assumidaDe ? 'assumida de ' + assumidaDe + '; ' : ''}ocorrência criada no ${txtItens} (item marcado R); ficha iniciada, não encerrada até a tratativa`);
  }

  // ---------------------------------- estado da tela ----------------------------------
  const S = Object.assign({
    aba: 'mapa', torre: (CFG.torres[0] || {}).nome || '', serv: 'FVS 013 A', busca: '', ordem: 'cod', detalhe: '',
    acao: 'fechar', dAbrir: hojeStr(), dFechar: hojeStr(), assumir: false, segunda: false, tratativa: '',
  }, LS.get(K('tela'), {}), { sel: [] });
  let FILA = LS.get(K('fila'), []);
  let HIST = LS.get(K('hist'), []);
  const salvarHist = () => LS.set(K('hist'), HIST);
  let ARR = null; // arrasto de seleção no mapa
  document.addEventListener('mouseup', () => { if (ARR) { ARR = null; if (S.aba === 'mapa') renderMapa(); } });
  let PLANOS = LS.get(K('planos'), {});
  let RESULT = LS.get(K('result'), []);
  const salvarTela = () => { const { sel, ...r } = S; LS.set(K('tela'), r); };
  const salvarFila = () => LS.set(K('fila'), FILA);

  // ---------------------------------- interface ----------------------------------
  const CSS = `
  #bf2-btn{position:fixed;right:20px;bottom:64px;z-index:2147483000;background:#6d3fd1;color:#fff;border:0;border-radius:28px;padding:13px 24px;font:700 16px system-ui,"Segoe UI",sans-serif;letter-spacing:.04em;cursor:pointer;box-shadow:0 6px 18px #6d3fd166;display:flex;align-items:center;gap:10px;transition:transform .15s,box-shadow .15s}
  #bf2-btn:hover{transform:translateY(-2px);box-shadow:0 10px 24px #6d3fd188}
  #bf2-btn::before{content:"";width:20px;height:20px;background:conic-gradient(from 200deg,#b79bff,#fff,#6d3fd1,#b79bff);clip-path:polygon(50% 0,100% 100%,0 100%)}
  @keyframes bf2gira{0%{transform:rotate(0) scale(1)}60%{transform:rotate(300deg) scale(1.3)}100%{transform:rotate(360deg) scale(1)}}
  #bf2-btn.gira::before,#bf2 .marca .ic.gira::before{animation:bf2gira .7s cubic-bezier(.3,.7,.3,1) var(--d,0ms) both}
  @media (prefers-reduced-motion:reduce){#bf2-btn.gira::before,#bf2 .marca .ic.gira::before{animation:none}}
  #bf2{--nav:#001e44;--roxo:#6d3fd1;--roxo2:#5a2fbf;--roxoSoft:#efe9fd;--verm:#cd143e;--bg:#f3f5f9;--line:#dfe4ec;--ink:#14213d;--muted:#64708a;
    position:fixed;inset:12px;z-index:2147483001;background:var(--bg);color:var(--ink);border-radius:14px;box-shadow:0 10px 50px #001e4466;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:none;flex-direction:column;overflow:hidden}
  #bf2 *{box-sizing:border-box}
  #bf2 .top{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--nav);color:#fff;flex-wrap:wrap}
  #bf2 .marca{display:flex;align-items:center;gap:10px}
  #bf2 .marca .ic{width:30px;height:30px;border-radius:8px;background:var(--roxo);display:grid;place-items:center}
  #bf2 .marca .ic::before{content:"";width:14px;height:14px;background:conic-gradient(from 200deg,#d9c9ff,#fff,#b79bff,#d9c9ff);clip-path:polygon(50% 0,100% 100%,0 100%)}
  #bf2 .marca b{font-size:16px;letter-spacing:.02em;display:block;line-height:1.1}
  #bf2 .marca small{font-size:10.5px;color:#9fb0cc;letter-spacing:.06em;text-transform:uppercase}
  #bf2 .tabs{display:flex;gap:4px;flex-wrap:wrap}
  #bf2 .tabs button{background:transparent;color:#c6d1e4;border:0;border-radius:8px;padding:7px 12px;cursor:pointer;font:600 13px system-ui,sans-serif}
  #bf2 .tabs button:hover{background:#ffffff14}
  #bf2 .tabs button.on{background:#ffffff1f;color:#fff;box-shadow:inset 3px 0 0 var(--roxo)}
  #bf2 .x{margin-left:auto;background:transparent;color:#c6d1e4;border:1px solid #ffffff33;border-radius:8px;padding:6px 12px;cursor:pointer;font:600 13px system-ui,sans-serif}
  #bf2 .x:hover{background:var(--verm);border-color:var(--verm);color:#fff}
  #bf2 .body{flex:1;overflow:auto;padding:14px}
  #bf2 .lay{display:grid;grid-template-columns:clamp(210px,21%,280px) minmax(0,1fr) clamp(220px,23%,310px);gap:12px;align-items:start}
  @media (max-width:760px){#bf2 .lay{grid-template-columns:minmax(0,1fr)}}
  #bf2 .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:9px;min-width:0;box-shadow:0 1px 2px #001e440d}
  #bf2 .gabt td:nth-child(2){min-width:260px}#bf2 .gabt th{white-space:nowrap}
  #bf2 .modal{position:absolute;inset:0;z-index:5;background:#001e4499;display:grid;place-items:center;padding:16px}
  #bf2 .modal .card{width:min(560px,100%);max-height:calc(100% - 20px);overflow:auto;box-shadow:0 20px 60px #001e4488}
  #bf2 .modal .xm{justify-self:end;background:transparent;border:0;font:700 18px system-ui;color:var(--muted);cursor:pointer;line-height:1}
  #bf2 .card.topo{border-top:3px solid var(--roxo)}
  #bf2 h4{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}
  #bf2 label{display:grid;gap:3px;font-size:12px;color:var(--muted)}
  #bf2 input,#bf2 select,#bf2 textarea{font:inherit;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:8px;padding:7px 9px;width:100%}
  #bf2 input:focus,#bf2 select:focus,#bf2 textarea:focus{outline:2px solid var(--roxo);outline-offset:0;border-color:var(--roxo)}
  #bf2 textarea{font:12px ui-monospace,Consolas,monospace;min-height:120px}
  #bf2 details summary{cursor:pointer;color:var(--muted);font-size:12px}
  #bf2 .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  #bf2 .b{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:8px;padding:7px 11px;cursor:pointer;font:600 12.5px system-ui,sans-serif}
  #bf2 .b:hover{border-color:var(--roxo);color:var(--roxo)}
  #bf2 .b.p{background:var(--roxo);border-color:var(--roxo);color:#fff}
  #bf2 .b.p:hover{background:var(--roxo2);color:#fff}
  #bf2 .b.n{background:var(--nav);border-color:var(--nav);color:#fff}
  #bf2 .b.w{background:#fff;border-color:var(--verm);color:var(--verm)}
  #bf2 .b.full{width:100%;text-align:left}
  #bf2 .b:disabled{opacity:.45;cursor:not-allowed}
  #bf2 .seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}
  #bf2 .seg button{border:0;background:transparent;padding:7px 12px;cursor:pointer;font:600 12.5px system-ui,sans-serif;color:var(--muted)}
  #bf2 .seg button.on{background:var(--nav);color:#fff}
  #bf2 .chk{display:flex;gap:8px;align-items:center;font:700 11.5px system-ui,sans-serif;letter-spacing:.04em;color:var(--ink);text-transform:uppercase;padding:7px 9px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
  #bf2 .chk input{width:16px;height:16px;accent-color:var(--roxo);margin:0}
  #bf2 .grid{user-select:none;display:grid;grid-template-columns:34px repeat(4,minmax(0,1fr)) minmax(0,.85fr) repeat(4,minmax(0,1fr));gap:3px}
  #bf2 .c{position:relative;border:0;border-radius:5px;min-height:28px;font:600 11px ui-monospace,Consolas,monospace;cursor:pointer;background:#e6eaf1;color:var(--ink);padding:0;min-width:0}
  #bf2 .c.fin{background:#2f9a5a;color:#fff}#bf2 .c.ini{background:#e3a21a;color:#2b1d00}#bf2 .c.nao{background:#d2463c;color:#fff}
  #bf2 .c.none{background:#e6eaf1;color:#a3adbf;cursor:default;background-image:repeating-linear-gradient(135deg,transparent 0 5px,#cfd6e2 5px 6px)}
  #bf2 .c.unk{background:#f3f5f9;color:#a3adbf;border:1px dashed #c3cbd8}
  #bf2 .c.hall{font:700 9px system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase}
  #bf2 .c.rx::after{content:"";position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:#6d3fd1;box-shadow:0 0 0 1.5px #fff}
  #bf2 .c.sel{outline:3px solid var(--roxo);outline-offset:1px;z-index:1}
  #bf2 .c.sel::before{content:"✓";position:absolute;left:3px;top:1px;font-size:10px}
  #bf2 .c.det{box-shadow:inset 0 0 0 2px var(--nav)}
  #bf2 .lab{font:700 10px ui-monospace,Consolas,monospace;color:var(--muted);background:none;border:0;cursor:pointer;padding:0}
  #bf2 .lab:hover{color:var(--roxo)}
  #bf2 .outros{display:flex;flex-wrap:wrap;gap:4px}#bf2 .outros .c{padding:4px 8px;font:600 11px system-ui,sans-serif}
  #bf2 .leg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--muted)}
  #bf2 .leg i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:4px;vertical-align:-1px}
  #bf2 table{border-collapse:collapse;width:100%;font-size:12px}
  #bf2 th{background:var(--nav);color:#fff;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  #bf2 td,#bf2 th{border:1px solid var(--line);padding:5px 7px;text-align:left;vertical-align:top}
  #bf2 tr.ok td{background:#eaf7ee}#bf2 tr.pend td{background:#fdeef0}
  #bf2 .hchip{display:inline-flex;gap:5px;align-items:center;background:var(--card,#fff);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px}
  #bf2 .chip{font-size:10px;font-weight:700;text-transform:uppercase;border-radius:20px;padding:1px 7px;white-space:nowrap;color:#fff}
  #bf2 .chip.fin{background:#2f9a5a}#bf2 .chip.ini{background:#e3a21a;color:#2b1d00}#bf2 .chip.nao{background:#d2463c}
  #bf2 .painel{display:grid;gap:4px}
  #bf2 .pl{display:grid;grid-template-columns:minmax(150px,26%) minmax(0,1fr) 120px;gap:8px;align-items:center;font-size:12px}
  #bf2 .pn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#bf2 .pn small{color:var(--muted)}
  #bf2 .pb{display:flex;height:20px;border-radius:5px;overflow:hidden;background:var(--line)}
  #bf2 .pb span{display:grid;place-items:center;font:700 10.5px system-ui,sans-serif;min-width:0;overflow:hidden}
  #bf2 .pt{font:600 11px ui-monospace,Consolas,monospace;color:var(--muted);text-align:right}
  #bf2 .lst{display:grid;gap:2px;max-height:46vh;overflow:auto}
  #bf2 .lst div{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:6px;align-items:center;padding:3px 5px;border-radius:5px}
  #bf2 .lst div.hl{background:var(--roxoSoft)}
  #bf2 .lst span.d{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
  #bf2 .msg{font-weight:600}
  #bf2 .muted{color:var(--muted);font-size:12px}
  #bf2 .aviso-c{padding:8px 16px;background:#efe7ff;color:#3b1f8f;font:600 13px system-ui,sans-serif;border-bottom:1px solid #d6c8ff}
  #bf2 .aviso-c.bloq{background:#fde8e6;color:#8a1c12;border-color:#f3b8b1}
  #bf2.dark .aviso-c{background:#2a1f4d;color:#e2d8ff;border-color:#3d2f6e}#bf2.dark .aviso-c.bloq{background:#4a1d19;color:#ffd6d1;border-color:#6e2a24}
  #bf2 .warn{background:#fff7e0;border:1px solid #efd07a;border-radius:8px;padding:7px 9px;font-size:12px}
  #bf2 .nota{background:var(--roxoSoft);border-radius:8px;padding:8px 10px;font-size:12px;color:#3d2a78}
  #bf2 .logo{background:var(--nav);border-radius:12px;padding:10px 12px;display:grid;place-items:center;gap:6px}
  #bf2 .logo img{width:min(130px,70%);height:auto;display:block}
  #bf2 .logo span{font-size:10px;color:#9fb0cc;letter-spacing:.08em;text-transform:uppercase}
  #bf2 .foot{padding:7px 16px;border-top:1px solid var(--line);background:#fff;display:flex;gap:10px;align-items:center}
  #bf2 .assin{margin-left:auto;flex:none;font:italic 500 11px system-ui,sans-serif;letter-spacing:.02em;color:var(--ink);opacity:.32;user-select:none;white-space:nowrap}
  #bf2 .foot::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--roxo);flex:none}
  #bf2.dark{--bg:#0d1526;--line:#25324a;--ink:#e4e9f2;--muted:#93a0b8;--roxoSoft:#2a2150;--card:#152039}
  #bf2.dark .card,#bf2.dark .b,#bf2.dark .seg,#bf2.dark .foot,#bf2.dark input,#bf2.dark select,#bf2.dark textarea,#bf2.dark .chk{background:#152039;color:var(--ink);border-color:var(--line)}
  #bf2.dark .b.p{background:var(--roxo);color:#fff}#bf2.dark .b.n,#bf2.dark .seg button.on{background:#2b3d63;color:#fff}
  #bf2.dark .c{background:#24314b;color:var(--ink)}#bf2.dark .c.none{background:#1b2740;color:#56637d;background-image:repeating-linear-gradient(135deg,transparent 0 5px,#2a3854 5px 6px)}
  #bf2.dark .c.unk{background:#152039;border-color:#33425f}
  #bf2.dark .c.fin{background:#2f8f55;color:#fff}#bf2.dark .c.ini{background:#d39a1c;color:#1c1300}#bf2.dark .c.nao{background:#c4433a;color:#fff}
  #bf2.dark tr.ok td{background:#163a27}#bf2.dark tr.pend td{background:#40202a}#bf2.dark td{border-color:var(--line)}
  #bf2.dark .warn{background:#3a2f12;border-color:#6b5520;color:#f3e2b0}#bf2.dark .nota{color:#d9ccff}
  #bf2.dark .c.rx::after{box-shadow:0 0 0 1.5px #152039}
  `;

  const LOGO = 'data:image/jpeg;base64,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';
  const $ = (s, r = document) => r.querySelector(s);
  let root;

  // Giro do logo: ao abrir gira o do topo do painel (o painel cobre o botão), ao fechar gira o do botão.
  // Se a tela se redesenhar no meio do giro, o logo continua de onde estava (--d negativo) em vez de recomeçar.
  let GIRA = 0;
  const girar = (el) => { if (!el) return; el.classList.remove('gira'); void el.offsetWidth; el.classList.add('gira'); };
  function montar() {
    if ($('#bf2-btn')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const b = document.createElement('button'); b.id = 'bf2-btn'; b.textContent = 'Prisma';
    root = document.createElement('div'); root.id = 'bf2';
    document.body.append(b, root);
    b.onclick = () => { const abre = root.style.display !== 'flex'; root.style.display = abre ? 'flex' : 'none'; if (abre) { GIRA = Date.now(); abrir(); } else girar(b); };
  }

  async function abrir() {
    await INICIO; // espera a cópia de segurança devolver o que o SGQ tiver apagado
    if (!configurado()) { S.aba = 'cfg'; status('Bem-vindo ao Prisma! Faça a configuração inicial (uma vez só).'); render(); return; }
    render();
    lerAviso(true).then(() => { if (root && root.style.display === 'flex') render(); });
    try {
      if (!token()) return status('Entre no SGQ primeiro.');
      await listarAreas();
      if (!Object.keys(NOMES).length) await carregarNomes();
      const T = CFG.torres.find((t) => t.nome === S.torre);
      if (!MAPA.ts[S.torre]) await atualizarTorre(T);
      render();
    } catch (e) { status('Erro: ' + e.message); }
  }

  let STATUS = '';
  function status(m) { STATUS = m; const e = $('#bf2-status'); if (e) e.textContent = m; }

  async function atualizarTorre(T) {
    const { todas } = estruturaTorre(T);
    let i = 0;
    await emParalelo(todas, async (n) => {
      try { await atualizarArea(n); } catch (e) { if (/Sessão expirada/.test(e.message)) throw e; }
      i++; status(`Lendo a ${T.nome} no SGQ: ${i}/${todas.length} (${n.replace(T.bloco + ' - ', '')})`);
      if (i % 20 === 0) { salvarMapa(); renderMapa(); }
    });
    // Parou no meio: não marca a torre como lida, senão o mapa fica incompleto parecendo atualizado.
    if (i < todas.length) { salvarMapa(); status(`Leitura da ${T.nome} interrompida em ${i}/${todas.length}. Clique em "Atualizar ${T.nome}" para ler tudo.`); return; }
    MAPA.ts[T.nome] = new Date().toISOString(); salvarMapa(); LS.set(K('nomes'), NOMES);
    status(`${T.nome} atualizada às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`);
  }

  const servicosDisponiveis = () => {
    const set = new Set(Object.keys(NOMES));
    Object.values(MAPA.areas).forEach((a) => Object.keys(a.fvs).forEach((c) => set.add(c)));
    return [...set];
  };
  function statusCel(area, cod) {
    const a = MAPA.areas[area]; if (!a) return 'unk';
    const e = a.fvs[cod]; if (!e) return 'none';
    return e[1] === 1 ? 'fin' : e[2] > 0 ? 'ini' : 'nao';
  }

  function render() {
    if (!root) return;
    const nFila = FILA.reduce((n, g) => n + g.areas.length, 0);
    root.classList.toggle('dark', !!CFG.escuro);
    root.innerHTML = `
      <div class="top"><div class="marca">${(() => { const t = Date.now() - GIRA; return t < 700 ? `<span class="ic gira" style="--d:-${t}ms"></span>` : '<span class="ic"></span>'; })()}<span><b>Prisma</b><small>FVS · ${esc(CFG.obraNome)}</small></span></div>
        <div class="tabs">${[['mapa', 'Mapa'], ['fila', `Fila (${nFila})`], ['rel', 'Relatório/Qualidade'], ['hist', 'Histórico'], ['colar', 'Colar roteiro'], ['gab', 'Gabaritos'], ['cfg', 'Configuração']].map(([k, t]) => `<button data-aba="${k}" class="${S.aba === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        <button class="x" id="bf2-x">Fechar</button></div>
      ${avisoHtml()}<div class="body" id="bf2-body"></div>
      <div class="foot"><span class="msg" id="bf2-status">${esc(STATUS)}</span><span class="assin">Prisma v${VERSAO}${CANAL === 'teste' ? ' (TESTE)' : ''} · criado por João Pedro Ramos</span></div>`;
    root.querySelectorAll('[data-aba]').forEach((b) => b.onclick = () => { if (!configurado() && b.dataset.aba !== 'cfg') return status('Termine a configuração inicial primeiro.'); S.aba = b.dataset.aba; salvarTela(); render(); });
    if (!configurado()) S.aba = 'cfg';
    $('#bf2-x').onclick = () => { root.style.display = 'none'; girar($('#bf2-btn')); };
    ({ mapa: renderMapa, fila: renderFila, rel: renderRel, hist: renderHist, colar: renderColar, gab: renderGab, cfg: renderCfg })[S.aba]();
  }

  // ------------------------------ aba MAPA ------------------------------
  function renderMapa() {
    const body = $('#bf2-body'); if (!body || S.aba !== 'mapa') return;
    const T = CFG.torres.find((t) => t.nome === S.torre) || CFG.torres[0];
    const est = estruturaTorre(T);
    const q = semAc(S.busca).trim();
    let cods = servicosDisponiveis().filter((c) => !q || semAc(c + ' ' + nomeLimpo(c)).includes(q) || semAc(c.replace(/FVS|\s/g, '')).includes(q.replace(/\s/g, '')));
    cods.sort(S.ordem === 'nome' ? (a, b) => nomeLimpo(a).localeCompare(nomeLimpo(b), 'pt') : (a, b) => a.localeCompare(b, 'pt', { numeric: true }));
    if (!q && cods.length && !cods.includes(S.serv)) S.serv = cods[0]; // serviço guardado que não existe nesta obra (ex.: o 013 A do Varandas)
    const g = gabarito(S.serv, T.nome, false), gh = gabarito(S.serv, T.nome, true);
    const cont = { fin: 0, ini: 0, nao: 0 };
    est.todas.forEach((n) => { const s = statusCel(n, S.serv); if (cont[s] !== undefined) cont[s]++; });
    const avisoGab = !g ? `<div class="warn">${esc(S.serv)} ainda não tem gabarito. Defina ou aprenda na aba <b>Gabaritos</b> antes de mandar para a fila.</div>`
      : (S.acao === 'abrir' && !g.pre ? `<div class="warn">Para <b>abrir</b> ${esc(S.serv)} falta definir até qual item vão os pré-requisitos (aba Gabaritos).</div>` : '');
    body.innerHTML = `<div class="lay">
      <div class="card topo">
        <h4>Serviço</h4>
        <input id="m-busca" type="search" placeholder="buscar: reboco, shaft, 028…" value="${esc(S.busca)}">
        <select id="m-serv">${cods.map((c) => `<option value="${esc(c)}" ${c === S.serv ? 'selected' : ''}>${S.ordem === 'nome' ? esc(nomeLimpo(c)) + ' · ' + esc(c.replace('FVS ', '')) : esc(c) + ' · ' + esc(nomeLimpo(c))}</option>`).join('')}</select>
        <div class="row"><span class="seg"><button data-o="cod" class="${S.ordem !== 'nome' ? 'on' : ''}">Nº FVS</button><button data-o="nome" class="${S.ordem === 'nome' ? 'on' : ''}">A–Z</button></span>
          ${CFG.torres.length > 4 // muitas torres (ex.: 15 blocos): lista de escolha em vez de botões, que não cabiam no cartão
            ? `<label style="flex:1;min-width:140px">Torre<select id="m-torre">${CFG.torres.map((t) => `<option value="${esc(t.nome)}" ${t.nome === T.nome ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>`
            : `<span class="seg">${CFG.torres.map((t) => `<button data-t="${esc(t.nome)}" class="${t.nome === T.nome ? 'on' : ''}">${esc(t.nome)}</button>`).join('')}</span>`}</div>
        <div class="muted">${cont.fin} finalizadas · ${cont.ini} iniciadas · ${cont.nao} não iniciadas${g ? `<br>Gabarito (${g.origem}): ${g.na.length ? 'NA ' + g.na.join(', ') : 'sem NA'}${gh && gh.na.join() !== g.na.join() ? ' · hall: NA ' + gh.na.join(', ') : ''}${g.pre ? ' · abrir: itens 1 a ' + g.pre : ''}` : ''}</div>
        <h4>Seleção</h4>
        <button class="b full" id="m-selini"><span style="color:#c98a00">■</span> Selecionar todos os amarelos</button>
        <button class="b full" id="m-selnao"><span style="color:#d2463c">■</span> Selecionar todos os vermelhos</button>
        <button class="b full" id="m-limpa">Limpar seleção</button>
        <button class="b full" id="m-tudo-sel">Fechar todas as FVS não finalizadas da seleção</button><div id="m-tudo-sel-out"></div>
        <div class="muted">${S.sel.length} local(is) selecionado(s). Clique ou arraste por cima dos apartamentos; clique no número do andar ou da coluna para pegar a linha inteira.</div>
        <h4>O que fazer</h4>
        <span class="seg">${[['abrir', 'Abrir'], ['fechar', 'Fechar']].map(([k, t]) => `<button data-a="${k}" class="${S.acao === k ? 'on' : ''}">${t}</button>`).join('')}</span>
        <label>Data de abertura (se precisar criar a ficha)<input type="date" id="m-dA" value="${esc(S.dAbrir)}" max="${hojeStr()}"></label>
        ${S.acao === 'fechar' ? `<label>Data de fechamento<input type="date" id="m-dF" value="${esc(S.dFechar)}" max="${hojeStr()}"></label>` : ''}
        ${S.acao === 'fechar' ? `<label class="chk"><input type="checkbox" id="m-seg" ${S.segunda ? 'checked' : ''}> Aprovar 2ª inspeção de itens R/X</label>
        ${S.segunda ? `<label>Tratativa (vazio = padrão)<input id="m-trat" value="${esc(S.tratativa)}" placeholder="${esc(CFG.tratativaPadrao)}"></label>` : ''}` : ''}
        <label class="chk"><input type="checkbox" id="m-ass" ${S.assumir ? 'checked' : ''}> Assumir fichas de: ${CFG.exFuncionarios.length ? esc(CFG.exFuncionarios.map((n) => n.split(/\s+/).slice(0, 2).join(' ')).join(', ')) : '<span class="muted">ninguém (Configuração)</span>'}</label>
        ${avisoGab}
        <button class="b p" id="m-add" ${!S.sel.length || !g || (S.acao === 'abrir' && !g.pre) ? 'disabled' : ''}>Adicionar à fila: ${S.acao === 'abrir' ? 'abrir' : 'fechar'} ${S.sel.length} local(is)</button>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between"><h4>${esc(T.nome)}${norm(T.nome) !== norm(T.bloco) ? ' · ' + esc(T.bloco) : ''} · ${esc(S.serv)}${nomeLimpo(S.serv) !== S.serv ? ' ' + esc(nomeLimpo(S.serv)) : ''}</h4>
          <span class="row"><span class="muted">${MAPA.ts[T.nome] ? 'lido às ' + new Date(MAPA.ts[T.nome]).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ainda não lido'}</span><button class="b n" id="m-atu">Atualizar ${esc(T.nome)}</button></span></div>
        <div class="leg"><span><i style="background:#2f9a5a"></i>Finalizada</span><span><i style="background:#e3a21a"></i>Iniciada</span><span><i style="background:#d2463c"></i>Não iniciada</span><span><i style="background:#e6eaf1"></i>Sem esta FVS</span><span><i style="background:#6d3fd1;border-radius:50%"></i>R/X em aberto</span></div>
        ${est.outros.length ? `<div class="outros">${est.outros.map((n) => celula(n, n.replace(T.bloco + ' - ', '').replace(T.bloco, 'Bloco geral'), 'hall')).join('')}</div>` : ''}
        ${gradeTorre(T, est)}
      </div>
      <div style="display:grid;gap:14px;min-width:0"><div class="card">${detalheHtml()}<h4>Fila</h4>${resumoFila()}<button class="b p" data-ir="fila">Ver fila e executar</button></div>
        <div class="logo"><img src="${LOGO}" alt="Realiza Construtora"><span>Prisma · controle de FVS</span></div></div>
    </div>`;
    const on = (id, ev, fn) => { const e = $(id, body); if (e) e[ev] = fn; };
    on('#m-busca', 'oninput', (e) => { S.busca = e.target.value; const first = servicosDisponiveis().find((c) => semAc(c + ' ' + nomeLimpo(c)).includes(semAc(S.busca).trim())); if (S.busca && first && !semAc(S.serv + ' ' + nomeLimpo(S.serv)).includes(semAc(S.busca).trim())) S.serv = first; salvarTela(); renderMapa(); const i = $('#m-busca'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
    on('#m-serv', 'onchange', (e) => { S.serv = e.target.value; S.sel = []; salvarTela(); renderMapa(); });
    body.querySelectorAll('[data-o]').forEach((b) => b.onclick = () => { S.ordem = b.dataset.o; salvarTela(); renderMapa(); });
    const trocaTorre = async (nome) => { S.torre = nome; S.sel = []; salvarTela(); renderMapa(); const T2 = CFG.torres.find((t) => t.nome === S.torre); if (!MAPA.ts[S.torre]) { try { await atualizarTorre(T2); } catch (e) { status('Erro: ' + e.message); } renderMapa(); } };
    body.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => trocaTorre(b.dataset.t));
    on('#m-torre', 'onchange', (e) => trocaTorre(e.target.value));
    body.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => { S.acao = b.dataset.a; salvarTela(); renderMapa(); });
    on('#m-dA', 'onchange', (e) => { S.dAbrir = e.target.value; if (S.dFechar < S.dAbrir) S.dFechar = S.dAbrir; salvarTela(); renderMapa(); });
    on('#m-dF', 'onchange', (e) => { S.dFechar = e.target.value; salvarTela(); });
    on('#m-seg', 'onchange', (e) => { S.segunda = e.target.checked; salvarTela(); renderMapa(); });
    on('#m-trat', 'onchange', (e) => { S.tratativa = e.target.value; salvarTela(); });
    on('#m-ass', 'onchange', (e) => { S.assumir = e.target.checked; salvarTela(); });
    on('#m-limpa', 'onclick', () => { S.sel = []; renderMapa(); });
    on('#m-tudo', 'onclick', () => fecharTudo([S.detalhe], 'm-tudo-out'));
    on('#m-tudo-sel', 'onclick', () => (S.sel.length ? fecharTudo([...S.sel], 'm-tudo-sel-out') : status('Selecione os locais no mapa primeiro (clique ou arraste por cima).')));
    const selPor = (cls) => { est.todas.forEach((n) => { if (statusCel(n, S.serv) === cls && !S.sel.includes(n)) S.sel.push(n); }); renderMapa(); };
    on('#m-selini', 'onclick', () => selPor('ini'));
    on('#m-selnao', 'onclick', () => selPor('nao'));
    on('#m-atu', 'onclick', async () => { if (ocupado()) return; PARAR = false; try { await atualizarTorre(T); } catch (e) { status('Erro: ' + e.message); } renderMapa(); });
    on('#m-add', 'onclick', () => {
      if (S.acao === 'fechar' && S.dAbrir > S.dFechar) return status('A data de abertura não pode ser depois da de fechamento.');
      FILA.push({ id: Date.now(), fvs: S.serv, acao: S.acao, areas: [...S.sel].sort((a, b) => a.localeCompare(b, 'pt', { numeric: true })), dAbrir: S.dAbrir, dFechar: S.acao === 'fechar' ? S.dFechar : S.dAbrir, opc: { assumir: S.assumir, segunda: S.acao === 'fechar' && S.segunda, tratativa: S.segunda ? S.tratativa : '' } });
      salvarFila(); status(`Adicionado à fila: ${S.acao} ${S.sel.length} local(is) de ${S.serv}.`); S.sel = []; render();
    });
    // clicar ou arrastar: o primeiro quadradinho decide se o arrasto marca ou desmarca
    const celSel = (c, modo) => { const n = c.dataset.area; if (c.classList.contains('none') || !MAPA.areas[n]) return; const i = S.sel.indexOf(n);
      if (modo === 'add' && i < 0) S.sel.push(n); if (modo === 'rem' && i >= 0) S.sel.splice(i, 1); c.classList.toggle('sel', S.sel.includes(n)); };
    body.querySelectorAll('.c[data-area]').forEach((c) => {
      c.onmousedown = (e) => { if (e.button !== 0) return; e.preventDefault(); const n = c.dataset.area; S.detalhe = n;
        if (c.classList.contains('none')) { ARR = null; renderMapa(); return; }
        ARR = { modo: S.sel.includes(n) ? 'rem' : 'add' }; celSel(c, ARR.modo); };
      c.onmouseenter = () => { if (ARR) celSel(c, ARR.modo); };
    });
    const toggleGrupo = (nomes) => { nomes = nomes.filter((n) => !['none'].includes(statusCel(n, S.serv)) && MAPA.areas[n]); const todos = nomes.every((n) => S.sel.includes(n)); nomes.forEach((n) => { const i = S.sel.indexOf(n); if (todos && i >= 0) S.sel.splice(i, 1); else if (!todos && i < 0) S.sel.push(n); }); renderMapa(); };
    body.querySelectorAll('[data-and]').forEach((b) => b.onclick = () => { const an = +b.dataset.and; toggleGrupo(Array.from({ length: est.P }, (_, k) => est.apto(an, k + 1)).filter(Boolean)); });
    body.querySelectorAll('[data-col]').forEach((b) => b.onclick = () => { const p = +b.dataset.col; toggleGrupo(est.andares.map((an) => est.apto(an, p)).filter(Boolean)); });
    body.querySelectorAll('[data-ir]').forEach((b) => b.onclick = () => { S.aba = b.dataset.ir; render(); });
  }
  // Desenho da torre a partir do perfil: N unidades por andar, hall no meio (ou casas em fileiras de 10).
  function gradeTorre(T, est) {
    const rot = (n) => String(lerArea(n).num);
    if (est.plano) return `<div class="grid" style="grid-template-columns:repeat(10,minmax(0,1fr))">${est.casas.map((n) => celula(n, rot(n))).join('')}</div>`;
    const ap = (an, p) => { const n = est.apto(an, p); return n ? celula(n, rot(n)) : '<span></span>'; };
    const hl = (an) => { const n = est.hall(an); return n ? celula(n, lerArea(n).pav === 0 ? 'térreo' : 'hall', 'hall') : '<span></span>'; };
    const A = Array.from({ length: est.M }, (_, k) => k + 1), B = Array.from({ length: est.P - est.M }, (_, k) => est.M + k + 1);
    const col = (p) => `<button class="lab" data-col="${p}">${String(p).padStart(2, '0')}</button>`;
    return `<div class="grid" style="grid-template-columns:34px repeat(${est.M},minmax(0,1fr))${est.temHall ? ' minmax(0,.85fr)' : ''} repeat(${est.P - est.M},minmax(0,1fr))">
          <span></span>${A.map(col).join('')}${est.temHall ? '<span class="lab" style="text-align:center">hall</span>' : ''}${B.map(col).join('')}
          ${est.andares.map((an) => `<button class="lab" data-and="${an}">${an}</button>${A.map((p) => ap(an, p)).join('')}${est.temHall ? hl(an) : ''}${B.map((p) => ap(an, p)).join('')}`).join('')}
        </div>`;
  }
  function celula(area, rot, extra = '') {
    if (!MAPA.areas[area] && !(AREAS || []).some((a) => a.nome === area)) return '<span></span>';
    const s = statusCel(area, S.serv); const e = MAPA.areas[area] && MAPA.areas[area].fvs[S.serv];
    const rx = e && e[1] !== 1 && (e[3] || e[4]);
    return `<button class="c ${extra} ${s} ${rx ? 'rx' : ''} ${S.sel.includes(area) ? 'sel' : ''} ${S.detalhe === area ? 'det' : ''}" data-area="${esc(area)}" title="${esc(area)}">${esc(rot)}</button>`;
  }
  function detalheHtml() {
    const n = S.detalhe, a = MAPA.areas[n];
    if (!a) return '<h4>Local</h4><div class="muted">Clique num apartamento para ver todas as FVS dele.</div>';
    const L = Object.entries(a.fvs).sort((x, y) => x[0].localeCompare(y[0], 'pt', { numeric: true }));
    const st = (e) => e[1] === 1 ? 'fin' : e[2] > 0 ? 'ini' : 'nao';
    const T = torreDe(n), semGab = (c) => !gabarito(c, T && T.nome, ehHall(n));
    const nf = L.filter(([, e]) => e[1] !== 1);
    return `<h4>${esc(n)}</h4><div class="lst">${L.map(([c, e]) => `<div class="${c === S.serv ? 'hl' : ''}"><b>${esc(c.replace('FVS ', ''))}</b><span class="d">${esc(nomeLimpo(c))}${e[1] !== 1 && semGab(c) ? ' · <i style="color:var(--verm)">sem gabarito</i>' : ''}</span><span class="chip ${st(e)}">${({ fin: 'final.', ini: 'inic.', nao: 'não inic.' })[st(e)]}${e[1] !== 1 && (e[3] || e[4]) ? ' · R/X' : ''}</span></div>`).join('')}</div>
      ${nf.length ? `<button class="b p full" id="m-tudo">Fechar todas as ${nf.length} FVS não finalizadas deste local</button><div id="m-tudo-out"></div>` : '<div class="muted">Todas as FVS deste local já estão finalizadas.</div>'}`;
  }
  // "Fechar tudo": todas as FVS não finalizadas dos locais vão para a fila como FECHAR, cada uma com o seu gabarito,
  // usando as datas e opções do painel "O que fazer". Se faltar gabarito de alguma, mostra quais e não manda nada sem você decidir.
  function fecharTudo(areas, outId) {
    const com = new Map(), sem = new Map();
    const poe = (M, cod, n) => { if (!M.has(cod)) M.set(cod, []); M.get(cod).push(n); };
    for (const n of areas) { const a = MAPA.areas[n]; if (!a) continue; const T = torreDe(n);
      for (const [cod, e] of Object.entries(a.fvs)) if (e[1] !== 1) poe(gabarito(cod, T && T.nome, ehHall(n)) ? com : sem, cod, n); }
    if (!com.size && !sem.size) return status('Nada para fechar: todas as FVS desses locais já estão finalizadas.');
    if (S.dAbrir > S.dFechar) return status('A data de abertura está depois da de fechamento (painel "O que fazer"). Ajuste e tente de novo.');
    const nCom = [...com.values()].reduce((s, L) => s + L.length, 0);
    const locais = new Set([...com.values()].flat());
    const manda = () => {
      const txt = `Vai pôr na fila para FECHAR ${nCom} ficha(s) de ${locais.size} local(is):\n\n${[...com].map(([cod, L]) => `• ${cod} ${nomeLimpo(cod)}: ${L.length}`).join('\n')}\n\nAbre em ${fmt(S.dAbrir)} (se precisar criar a ficha) e fecha em ${fmt(S.dFechar)}.\nAprovar 2ª inspeção de R/X: ${S.segunda ? 'sim' : 'não'} · Assumir fichas da lista: ${S.assumir ? 'sim' : 'não'}\n(datas e opções do painel "O que fazer")\n\nNada é gravado agora: depois você simula e executa na aba Fila.`;
      if (!confirm(txt)) return;
      let i = 0;
      for (const [cod, L] of com) FILA.push({ id: Date.now() + i++, fvs: cod, acao: 'fechar', areas: [...new Set(L)].sort((a, b) => a.localeCompare(b, 'pt', { numeric: true })), dAbrir: S.dAbrir, dFechar: S.dFechar, opc: { assumir: S.assumir, segunda: S.segunda, tratativa: S.segunda ? S.tratativa : '' } });
      salvarFila(); status(`Na fila: fechar ${nCom} ficha(s) de ${locais.size} local(is), ${com.size} serviço(s). Simule na aba Fila antes de executar.`); render();
    };
    if (!sem.size) return manda();
    const box = $('#' + outId); if (!box) return;
    box.innerHTML = `<div class="warn" style="margin-top:6px"><b>Falta gabarito de ${sem.size} serviço(s)</b> (sem ele o Prisma não sabe o que vai NA):
      ${[...sem].map(([cod, L]) => `<div class="row" style="justify-content:space-between;margin-top:4px"><span>${esc(cod.replace('FVS ', ''))} ${esc(nomeLimpo(cod))} · ${L.length} local(is)</span><button class="b" data-gabir="${esc(cod)}">Definir gabarito</button></div>`).join('')}
      ${nCom ? `<button class="b p full" id="${outId}-ok" style="margin-top:8px">Mandar só as ${nCom} que já têm gabarito</button>` : '<div style="margin-top:6px">Defina os gabaritos e clique de novo.</div>'}</div>`;
    box.querySelectorAll('[data-gabir]').forEach((b) => b.onclick = () => { S.gabCod = b.dataset.gabir; ED = null; S.aba = 'gab'; salvarTela(); render(); });
    const ok = $('#' + outId + '-ok'); if (ok) ok.onclick = manda;
  }
  function resumoFila() {
    if (!FILA.length) return '<div class="muted">Vazia. Selecione locais e clique em "Adicionar à fila".</div>';
    return `<div class="muted">${FILA.map((g) => `${g.acao === 'abrir' ? 'Abrir' : 'Fechar'} ${esc(g.fvs)}: ${g.areas.length}`).join('<br>')}</div>`;
  }

  // ------------------------------ aba FILA ------------------------------
  function tarefasDaFila() {
    const t = [];
    FILA.forEach((g) => g.areas.forEach((area) => t.push({ grupo: g.id, area, fvs: g.fvs, acao: g.acao, dAbrir: g.dAbrir, dFechar: g.dFechar, na: g.na, pre: g.pre, opc: g.opc || {}, oc: (g.oc || []).filter((o) => o.area === area) })));
    return t;
  }
  // ------------------------------ janela CRIAR OCORRÊNCIA (aba Fila) ------------------------------
  // Só deixa escolher apartamento e serviço que estão na fila. Fica por cima do Prisma: nada mais responde até salvar ou fechar.
  function abrirOcorrencia() {
    if (ocupado()) return;
    const areas = [...new Set(FILA.flatMap((g) => g.areas))].sort((a, b) => a.localeCompare(b, 'pt', { numeric: true }));
    if (!areas.length) return status('A fila está vazia: ponha o apartamento e o serviço na fila primeiro.');
    const M = { area: '', cod: '', itens: null };
    const m = document.createElement('div'); m.className = 'modal'; m.id = 'oc-m';
    m.innerHTML = `<div class="card topo" role="dialog" aria-modal="true" aria-label="Criar ocorrência">
      <div class="row" style="justify-content:space-between"><h4>Criar ocorrência</h4><button class="xm" id="oc-x" title="Fechar sem salvar">×</button></div>
      <div class="nota">Quando a fila rodar, o Prisma marca o item como <b>R</b>, cria a ocorrência <b>sem tratativa</b> e deixa a ficha <b>iniciada</b>: o SGQ não deixa encerrar até alguém fazer a tratativa.</div>
      <label>Apartamento (só os que estão na fila)<input id="oc-qa" type="search" placeholder="buscar: 401, hall 3, bloco 02…"><select id="oc-a" size="6"></select></label>
      <label>Serviço (só os deste local na fila)<input id="oc-qs" type="search" placeholder="buscar serviço…"><select id="oc-s" size="4"></select></label>
      <label>Item da ficha<select id="oc-i" disabled><option>Escolha o apartamento e o serviço</option></select></label>
      <label>O que foi encontrado<textarea id="oc-t" style="min-height:80px;font:inherit" placeholder="ex.: choco encontrado na sala e na cozinha"></textarea></label>
      <div class="row"><button class="b p" id="oc-ok" disabled>Salvar ocorrência</button><button class="b" id="oc-c">Cancelar</button><span class="muted" id="oc-msg"></span></div></div>`;
    root.appendChild(m);
    const q = (s) => m.querySelector(s), msg = (t) => { q('#oc-msg').textContent = t; };
    const fecha = () => { document.removeEventListener('keydown', tecla, true); m.remove(); };
    const tecla = (e) => { if (e.key === 'Escape') { e.stopPropagation(); fecha(); } };
    document.addEventListener('keydown', tecla, true);
    const pode = () => { q('#oc-ok').disabled = !(M.area && M.cod && q('#oc-i').value && q('#oc-t').value.trim()); };
    const listaA = () => { const f = semAc(q('#oc-qa').value).trim(); q('#oc-a').innerHTML = areas.filter((a) => !f || semAc(localComTorre(a) + ' ' + a).includes(f)).map((a) => `<option value="${esc(a)}" ${a === M.area ? 'selected' : ''}>${esc(localComTorre(a))}</option>`).join(''); };
    const servs = () => [...new Set(FILA.filter((g) => g.areas.includes(M.area)).map((g) => g.fvs))];
    const listaS = () => { const f = semAc(q('#oc-qs').value).trim(); q('#oc-s').innerHTML = M.area ? servs().filter((c) => !f || semAc(c + ' ' + nomeLimpo(c)).includes(f)).map((c) => `<option value="${esc(c)}" ${c === M.cod ? 'selected' : ''}>${esc(c.replace('FVS ', ''))} · ${esc(nomeLimpo(c))}</option>`).join('') : ''; };
    const carregaItens = async () => {
      const sel = q('#oc-i'); sel.disabled = true; sel.innerHTML = '<option>Buscando os itens da ficha no SGQ...</option>'; pode();
      const cod = M.cod, area = M.area;
      try {
        let L = await itensDaFicha(cod);
        const e = MAPA.areas[area] && MAPA.areas[area].fvs[cod];
        if (!L && e) { const v = await listarVerif(e[0]); if (v.length) { const it = ((await api('POST', '/obras/inspecoes-obra/' + v[0].idInspecaoObra + '/items', { page: 1, rowsPerPage: 300 })).j || {}).items || []; if (it.length) L = it.map((x) => ({ o: parseInt(x.ordem, 10), d: (x.descricao || '').trim() })).sort((a, b) => a.o - b.o); } }
        if (M.cod !== cod || M.area !== area) return; // trocou no meio
        if (!L) { sel.innerHTML = '<option value="">Não achei os itens dessa FVS na obra</option>'; msg('Abra uma ficha dessa FVS pelo SGQ uma vez e tente de novo.'); return; }
        sel.innerHTML = '<option value="">Escolha o item…</option>' + L.map((x) => `<option value="${x.o}">${x.o} · ${esc(x.d.length > 90 ? x.d.slice(0, 90) + '…' : x.d)}</option>`).join('');
        M.itens = L; sel.disabled = false; msg('');
      } catch (err) { sel.innerHTML = '<option value="">Erro ao ler os itens</option>'; msg('Erro: ' + err.message); }
      pode();
    };
    listaA();
    q('#oc-qa').oninput = listaA;
    q('#oc-a').onchange = (e) => { M.area = e.target.value; M.cod = ''; M.itens = null; q('#oc-qs').value = ''; listaS(); const s = servs(); if (s.length === 1) { M.cod = s[0]; listaS(); carregaItens(); } else { q('#oc-i').disabled = true; q('#oc-i').innerHTML = '<option>Escolha o serviço</option>'; } pode(); };
    q('#oc-qs').oninput = listaS;
    q('#oc-s').onchange = (e) => { M.cod = e.target.value; carregaItens(); };
    q('#oc-i').onchange = pode; q('#oc-t').oninput = pode;
    q('#oc-x').onclick = fecha; q('#oc-c').onclick = fecha;
    q('#oc-ok').onclick = () => {
      const item = +q('#oc-i').value, texto = q('#oc-t').value.trim(); if (!M.area || !M.cod || !item || !texto) return;
      const g = FILA.find((x) => x.fvs === M.cod && x.areas.includes(M.area)); if (!g) return msg('Esse local saiu da fila.');
      const it = (M.itens || []).find((x) => x.o === item) || {};
      g.oc = (g.oc || []).filter((o) => !(o.area === M.area && o.item === item)).concat({ id: Date.now(), area: M.area, item, itemDesc: it.d || '', texto });
      salvarFila(); fecha(); status(`Ocorrência guardada na fila: ${localComTorre(M.area)} · ${M.cod} · item ${item}. Ela é criada no SGQ quando a fila rodar.`); render();
    };
    setTimeout(() => q('#oc-qa').focus(), 0);
  }
  function renderFila() {
    const body = $('#bf2-body');
    const nomesPlanos = Object.keys(PLANOS).sort();
    body.innerHTML = `<div class="card topo">
      <h4>Fila de comandos</h4>
      ${FILA.length ? `<table><tr><th>Serviço</th><th>Ação</th><th>Datas</th><th>Locais</th><th>Opções</th><th></th></tr>
        ${FILA.map((g) => `<tr><td><b>${esc(g.fvs)}</b><br><span class="muted">${esc(nomeLimpo(g.fvs))}</span></td><td>${g.acao === 'abrir' ? 'Abrir' : 'Fechar'}</td>
          <td>${g.acao === 'abrir' ? 'abre ' + fmt(g.dAbrir) : 'abre ' + fmt(g.dAbrir) + '<br>fecha ' + fmt(g.dFechar)}</td>
          <td>${g.areas.map((a) => esc(localComTorre(a))).join(', ')}</td>
          <td class="muted">${[g.opc && g.opc.assumir ? 'assume fichas da lista' : '', g.opc && g.opc.segunda ? '2ª inspeção' + (g.opc.tratativa ? ': "' + esc(g.opc.tratativa) + '"' : '') : '', g.na ? 'gabarito do roteiro' : ''].filter(Boolean).join('<br>')}
            ${(g.oc || []).map((o) => `<div style="color:var(--verm)">ocorrência · ${esc(localCurto(o.area))} · item ${o.item}: "${esc(o.texto.length > 60 ? o.texto.slice(0, 60) + '…' : o.texto)}" <a href="#" data-ocdel="${g.id}|${o.id}" style="color:var(--muted)">tirar</a></div>`).join('')}</td>
          <td><button class="b" data-del="${g.id}" ${RODANDO ? 'disabled' : ''}>Tirar</button></td></tr>`).join('')}</table>` : '<div class="muted">A fila está vazia. Monte no Mapa ou cole um roteiro.</div>'}
      <div class="row">
        <button class="b" id="f-sim" ${FILA.length && !RODANDO ? '' : 'disabled'}>Simular (não grava)</button>
        <button class="b p" id="f-run" ${FILA.length && !RODANDO ? '' : 'disabled'}>Executar no SGQ</button>
        <button class="b w" id="f-stop" ${RODANDO ? '' : 'disabled'}>Parar</button>
        <button class="b" id="f-limpa" ${FILA.length && !RODANDO ? '' : 'disabled'}>Esvaziar fila</button>
        <button class="b" id="f-oc" ${FILA.length && !RODANDO ? '' : 'disabled'} style="border-color:var(--verm);color:var(--verm)">Criar ocorrência</button>
      </div>
      <h4>Planos (para repetir, ex.: abrir na segunda e fechar na sexta)</h4>
      <div class="row"><input id="p-nome" placeholder="nome do plano, ex.: semana 20/10" style="max-width:260px"><button class="b" id="p-salva" ${FILA.length ? '' : 'disabled'}>Salvar fila como plano</button></div>
      ${nomesPlanos.length ? `<table><tr><th>Plano</th><th>Conteúdo</th><th></th></tr>${nomesPlanos.map((n) => `<tr><td>${esc(n)}</td><td class="muted">${PLANOS[n].map((g) => `${g.acao} ${esc(g.fvs)} (${g.areas.length})`).join(', ')}</td>
        <td class="row"><button class="b" data-pl="${esc(n)}">Carregar igual</button><button class="b" data-plf="${esc(n)}">Carregar como FECHAR</button><button class="b" data-pld="${esc(n)}">Apagar</button></td></tr>`).join('')}</table>
        <label style="max-width:260px">Data de fechamento ao "carregar como FECHAR"<input type="date" id="p-df" value="${esc(S.dFechar)}" max="${hojeStr()}"></label>` : '<div class="muted">Nenhum plano salvo.</div>'}
      <h4>Último resultado</h4>
      <div class="row"><button class="b" id="r-copia" ${RESULT.length ? '' : 'disabled'}>Copiar resultado (para colar na planilha)</button></div>
      <div id="f-res">${tabelaRes(RESULT)}</div></div>`;
    body.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { if (ocupado()) return; FILA = FILA.filter((g) => String(g.id) !== b.dataset.del); salvarFila(); render(); });
    $('#f-limpa').onclick = () => { if (ocupado()) return; if (confirm('Esvaziar a fila?')) { FILA = []; salvarFila(); render(); } };
    $('#f-stop').onclick = () => { if (!RODANDO) return; PARAR = true; status('Parando depois da ficha atual...'); };
    $('#f-oc').onclick = abrirOcorrencia;
    body.querySelectorAll('[data-ocdel]').forEach((a) => a.onclick = (e) => { e.preventDefault(); if (ocupado()) return; const [gid, oid] = a.dataset.ocdel.split('|'); const g = FILA.find((x) => String(x.id) === gid); if (g) g.oc = (g.oc || []).filter((o) => String(o.id) !== oid); salvarFila(); render(); });
    $('#f-sim').onclick = () => rodarFila(true);
    $('#f-run').onclick = () => rodarFila(false);
    $('#p-salva').onclick = () => { const n = ($('#p-nome').value || '').trim() || ('plano ' + new Date().toLocaleDateString('pt-BR')); PLANOS[n] = JSON.parse(JSON.stringify(FILA)).map(({ oc, ...g }) => g); LS.set(K('planos'), PLANOS); status('Plano "' + n + '" salvo.'); render(); };
    body.querySelectorAll('[data-pl]').forEach((b) => b.onclick = () => { FILA = FILA.concat(JSON.parse(JSON.stringify(PLANOS[b.dataset.pl])).map((g, i) => ({ ...g, id: Date.now() + i }))); salvarFila(); render(); });
    body.querySelectorAll('[data-plf]').forEach((b) => b.onclick = () => { const df = $('#p-df').value || hojeStr(); FILA = FILA.concat(JSON.parse(JSON.stringify(PLANOS[b.dataset.plf])).map((g, i) => ({ ...g, id: Date.now() + i, acao: 'fechar', dFechar: df }))); salvarFila(); status('Plano carregado como FECHAR em ' + fmt(df) + '. As fichas mantêm a data de abertura do plano.'); render(); });
    body.querySelectorAll('[data-pld]').forEach((b) => b.onclick = () => { if (confirm('Apagar o plano "' + b.dataset.pld + '"?')) { delete PLANOS[b.dataset.pld]; LS.set(K('planos'), PLANOS); render(); } });
    $('#r-copia').onclick = () => {
      const tsv = ['Local\tFVS\tAção\tResultado\tDetalhe\tQuando'].concat(RESULT.map((x) => [x.area, x.fvs, x.acao, x.resultado, x.msg, x.quando].join('\t'))).join('\n');
      navigator.clipboard.writeText(tsv).then(() => status('Resultado copiado.'), () => status('Não deu para copiar.'));
    };
  }
  function tabelaRes(L) {
    if (!L.length) return '<div class="muted">Nada executado ainda.</div>';
    const ok = L.filter((x) => x.resultado === 'OK').length;
    return `<div class="muted">${ok} OK · ${L.length - ok} pendente(s)${L[0] && L[0].simulacao ? ' · SIMULAÇÃO (nada gravado)' : ''}</div><table><tr><th>Local</th><th>FVS</th><th>Ação</th><th>Resultado</th><th>Detalhe</th></tr>${L.map((x) => `<tr class="${x.resultado === 'OK' ? 'ok' : 'pend'}"><td>${esc(x.area)}</td><td>${esc(x.fvs)}</td><td>${esc(x.acao)}</td><td>${esc(x.resultado)}</td><td>${esc(x.msg)}</td></tr>`).join('')}</table>`;
  }
  // Só uma execução por vez: um clique duplo em "Executar" podia rodar a fila duas vezes ao mesmo tempo e criar duas verificações na mesma FVS.
  async function rodarFila(simular) {
    if (ocupado()) return;
    const tarefas = tarefasDaFila();
    if (!tarefas.length) return;
    RODANDO = true; render(); // redesenha já com os botões travados
    try { await rodarFilaJa(simular, tarefas); } finally { RODANDO = false; PARAR = false; render(); } // PARAR não fica ligado e corta a próxima leitura do mapa
  }
  async function rodarFilaJa(simular, tarefas) {
    if (!simular) { await lerAviso(true); const b = bloqueio(); if (b) { render(); status(b); return; } }
    if (!simular && !sessaoDaTela()) { status('Antes de gravar, clique em qualquer menu do SGQ (ex.: Dashboard) e espere carregar: o Prisma usa a mesma sessão da tela.'); return; }
    if (!simular && !confirm(`Vai GRAVAR no SGQ ${tarefas.length} ficha(s):\n\n${FILA.map((g) => `• ${g.acao === 'abrir' ? 'ABRIR em ' + fmt(g.dAbrir) : 'FECHAR em ' + fmt(g.dFechar)} · ${g.fvs} · ${g.areas.length} local(is)`).join('\n')}\n\nInspecionado por: ${CFG.nomeInspecionado}\nAprovado por: ${CFG.nomeAprovado}\n\nContinuar?`)) return;
    PARAR = false; RESULT = []; const feitos = new Set();
    for (let k = 0; k < tarefas.length; k++) {
      if (PARAR) { status('Parado por você.'); break; }
      const t = tarefas[k];
      status(`${simular ? 'Simulando' : 'Gravando'} ${k + 1}/${tarefas.length}: ${t.area} · ${t.fvs}`);
      let r; try { r = await executarTarefa(t, simular); } catch (e) { r = PEND('erro: ' + e.message); if (/Sessão expirada/.test(e.message)) PARAR = true; }
      if (r.resultado === 'PENDENTE' && /funcion[aá]rio vinculado/i.test(r.msg || '')) { PARAR = true; r.msg += ' · Seu login do SGQ está sem funcionário vinculado: o próprio SGQ recusa qualquer gravação, até pela tela. Fila parada para não repetir o erro em todas as fichas. Peça para a TI/administrador do SGQ vincular seu usuário ao seu cadastro de funcionário e rode de novo.'; status('Fila parada: seu login do SGQ está sem funcionário vinculado. Fale com a TI e rode de novo depois.'); }
      RESULT.push({ area: t.area, fvs: t.fvs, acao: t.acao, ...r, quando: new Date().toLocaleString('pt-BR'), simulacao: simular });
      if (!simular) { HIST.push({ q: new Date().toISOString(), a: t.area, f: t.fvs, ac: t.acao, r: r.resultado, d: r.msg, src: 'prisma', u: CFG.nomeInspecionado }); if (HIST.length > 6000) HIST = HIST.slice(-6000); salvarHist(); }
      if (!simular && r.resultado === 'OK') { feitos.add(t.area); const g = FILA.find((x) => x.id === t.grupo); if (g) { g.areas = g.areas.filter((a) => a !== t.area); g.oc = (g.oc || []).filter((o) => o.area !== t.area); } }
      const fr = $('#f-res'); if (fr) fr.innerHTML = tabelaRes(RESULT);
    }
    LS.set(K('result'), RESULT);
    if (!simular) {
      FILA = FILA.filter((g) => g.areas.length); salvarFila();
      status('Atualizando o mapa dos locais gravados...');
      await emParalelo([...feitos], async (a) => { try { await atualizarArea(a); } catch (e) {} }, { parar: false }); // mesmo depois de Parar, atualiza o que foi gravado
      salvarMapa();
    }
    const ok = RESULT.filter((x) => x.resultado === 'OK').length;
    status(`${simular ? 'Simulação' : 'Execução'} terminada: ${ok} OK, ${RESULT.length - ok} pendente(s).${simular ? ' Nada foi gravado.' : ' O que deu OK saiu da fila; o pendente ficou nela.'}`);
  }

  // ------------------------------ aba COLAR ROTEIRO ------------------------------
  function renderColar() {
    const body = $('#bf2-body');
    body.innerHTML = `<div class="card topo"><h4>Colar roteiro</h4>
      <div class="nota">Para listas prontas no formato de roteiro (como os Roteiros 1 a 5 que o Claude gera). A planilha da qualidade ainda não entra aqui direto: mande ela para o Claude, que ele devolve o roteiro pronto para colar.</div>
      <textarea id="c-txt" placeholder="ID	Área no SGQ	FVS	Situação hoje	O que fazer	Itens a marcar	Status final	Ocorrências	Feito"></textarea>
      <div class="row"><label style="max-width:200px">Abrir em<input type="date" id="c-dA" value="${esc(S.dAbrir)}" max="${hojeStr()}"></label><label style="max-width:200px">Fechar em<input type="date" id="c-dF" value="${esc(S.dFechar)}" max="${hojeStr()}"></label>
        <button class="b p" id="c-ok">Mandar para a fila</button></div></div>`;
    $('#c-ok').onclick = () => {
      const dA = $('#c-dA').value, dF = $('#c-dF').value; let n = 0; const pulou = [];
      for (const linha of $('#c-txt').value.split(/\r?\n/)) {
        const c = linha.split('\t').map((x) => (x || '').trim());
        if (!/^\d+$/.test(c[0] || '')) continue;
        // Linha com colunas faltando (copiada pela metade) não pode derrubar o roteiro inteiro.
        const [, area = '', fvs = '', , oq = '', itens = '', stf = '', oc = '', feito = ''] = c;
        if (!area || !fvs) { pulou.push(c[0]); continue; }
        if (/^(true|verdadeiro|sim|x|ok)$/i.test(feito || '') || /parad/i.test(oq)) continue;
        const abrir = /iniciada/i.test(stf) && !/encerrad/i.test(stf);
        const na = listaNum((itens.match(/NA n[oa]s? ([0-9 ,e]+)/i) || [])[1]);
        const fx = itens.match(/itens (\d+) a (\d+)/i);
        FILA.push({ id: Date.now() + n, fvs: codNorm(fvs), acao: abrir ? 'abrir' : 'fechar', areas: [area], dAbrir: dA, dFechar: abrir ? dA : dF, na, pre: abrir && fx ? +fx[2] : null,
          opc: { assumir: /assumir/i.test(oq), segunda: /2[ªa] inspe|segunda inspe|tratativa/i.test(oq), tratativa: (/^tratativa:\s*(.+)$/i.exec(oc || '') || [])[1] || '' } });
        n++;
      }
      salvarFila(); S.aba = 'fila'; render();
      status(n + ' linha(s) mandadas para a fila.' + (pulou.length ? ` ${pulou.length} linha(s) ignorada(s) por falta de área ou FVS (ID ${pulou.join(', ')}).` : ''));
    };
  }

  // ------------------------------ aba GABARITOS ------------------------------
  // Editor no formato da própria ficha: cada item com A/NA por torre e hall, e "abrir até aqui" (pré-requisitos).
  let ED = null; // { cod, itens:[{o,d}], na:{torre:Set}, hall:Set|null, pre }
  async function itensDaFicha(cod) {
    const cache = LS.get(K('itens'), {});
    if (cache[cod] && cache[cod].length) return cache[cod];
    const cand = Object.entries(MAPA.areas).filter(([, a]) => a.fvs[cod] && (a.fvs[cod][1] === 1 || a.fvs[cod][2] > 0));
    for (const [, a] of cand.slice(0, 8)) {
      const v = await listarVerif(a.fvs[cod][0]);
      for (const i of v) {
        const it = ((await api('POST', '/obras/inspecoes-obra/' + i.idInspecaoObra + '/items', { page: 1, rowsPerPage: 300 })).j || {}).items || [];
        if (it.length) { const L = it.map((x) => ({ o: parseInt(x.ordem, 10), d: (x.descricao || '').trim() })).sort((p, q) => p.o - q.o); cache[cod] = L; LS.set(K('itens'), cache); return L; }
      }
    }
    return null;
  }
  function edDe(cod, itens) {
    const g = GAB_USER[cod] || GABP()[cod] || {};
    const na = {};
    CFG.torres.forEach((t) => { const v = Array.isArray(g.na) ? g.na : (g.na && g.na[t.nome]) || []; na[t.nome] = new Set(v); });
    return { cod, itens, na, hall: g.naHall ? new Set(g.naHall) : null, pre: g.pre || 0 };
  }
  function renderGab() {
    const body = $('#bf2-body');
    const cods = servicosDisponiveis().sort((a, b) => a.localeCompare(b, 'pt', { numeric: true }));
    const cod = S.gabCod || '';
    const g = cod ? (GAB_USER[cod] || GABP()[cod]) : null;
    const resumo = (gg) => { if (!gg) return 'ainda sem gabarito'; const naT = CFG.torres.map((t) => { const v = Array.isArray(gg.na) ? gg.na : (gg.na && gg.na[t.nome]) || []; return `${t.nome}: ${v.length ? 'NA ' + v.join(', ') : 'tudo A'}`; }).join(' · '); return naT + (gg.naHall ? ` · hall: NA ${gg.naHall.join(', ') || 'nenhum'}` : '') + (gg.pre ? ` · abrir: itens 1 a ${gg.pre}` : ' · sem pré-requisitos'); };
    body.innerHTML = `<div class="card topo" style="max-width:1000px"><h4>Gabaritos</h4>
      <div class="nota">O gabarito diz quais itens vão como <b>NA</b> (não se aplica) e quais vão como <b>A</b>, e até qual item são os pré-requisitos marcados quando a ficha é <b>aberta</b>. Cada pessoa e cada obra pode ter o seu.</div>
      <label>Serviço<select id="g-cod"><option value="">Escolha um serviço…</option>${cods.map((c) => `<option value="${esc(c)}" ${c === cod ? 'selected' : ''}>${esc(c)} · ${esc(nomeLimpo(c))}${GAB_USER[c] ? ' (seu)' : GABP()[c] ? ' (padrão)' : ''}</option>`).join('')}</select></label>
      ${cod ? `<div class="muted"><b>Atual:</b> ${esc(resumo(g))}</div>
      <div class="row"><button class="b p" id="g-ficha">Montar na ficha</button>
        ${CFG.torres.length > 3
          ? `<select id="g-torre" style="width:auto">${CFG.torres.map((t) => `<option ${t.nome === (S.gabTorre || CFG.torres[0].nome) ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select><button class="b" id="g-apr1">Aprender por esta torre</button>`
          : CFG.torres.map((t) => `<button class="b" data-apr="${esc(t.nome)}">Aprender pela ${esc(t.nome)}</button>`).join('')}
        ${GAB_USER[cod] ? '<button class="b w" id="g-pad">Apagar o meu gabarito deste serviço</button>' : ''}</div>
      <div id="g-out" class="muted"></div><div id="g-ed"></div>` : '<div class="muted">Nada é lido do SGQ até você escolher um serviço.</div>'}</div>`;
    $('#g-cod').onchange = (e) => { S.gabCod = e.target.value; ED = null; salvarTela(); renderGab(); };
    if (!cod) return;
    const bp = $('#g-pad'); if (bp) bp.onclick = () => { if (confirm('Apagar o seu gabarito de ' + cod + '?')) { delete GAB_USER[cod]; LS.set(K('gab'), GAB_USER); ED = null; renderGab(); } };
    $('#g-ficha').onclick = async () => {
      const out = $('#g-out'); out.textContent = 'Buscando os itens da ficha no SGQ...';
      try {
        if (!Object.keys(MAPA.areas).length) await garantirMapa([CFG.torres.find((t) => t.nome === S.torre) || CFG.torres[0]]);
        const it = await itensDaFicha(cod);
        if (!it) { out.textContent = 'Não achei nenhuma ficha desse serviço já preenchida na obra para copiar os itens. Atualize o mapa da outra torre ou abra uma ficha uma vez pelo SGQ.'; return; }
        ED = edDe(cod, it); out.textContent = ''; desenharEditor();
      } catch (e) { out.textContent = 'Erro: ' + e.message; }
    };
    // A mensagem do "Aprender" fica acima da ficha: antes ficava embaixo da tabela e, com muitas torres, ninguém via (parecia que o botão não fazia nada).
    const aprender = async (nome) => {
      const out = $('#g-out'); const diz = (m) => { if (out) out.textContent = m; status(m); };
      diz('Aprender pela ' + nome + ': lendo fichas encerradas...');
      try {
        const T = CFG.torres.find((t) => t.nome === nome);
        if (!MAPA.ts[T.nome]) { diz('Lendo o mapa da ' + T.nome + ' primeiro (pode levar um minuto)...'); await atualizarTorre(T); }
        const r = await aprenderGabarito(cod, T.nome, diz);
        if (r.erro) { diz(r.erro); return; }
        if (!ED) ED = edDe(cod, r.itens.map((x) => ({ o: x.o, d: x.d })).sort((p, q) => p.o - q.o));
        // Serviço ainda sem gabarito numa obra de muitas torres: o aprendido vale para todas (ajuste depois a torre que for diferente).
        const paraTodas = CFG.torres.length > 3 && !(GAB_USER[cod] || GABP()[cod]);
        if (r.ap) (paraTodas ? CFG.torres : [T]).forEach((t) => { ED.na[t.nome] = new Set(r.ap.na); });
        if (r.hl) ED.hall = new Set(r.hl.na);
        if (r.pre && !ED.pre) ED.pre = r.pre;
        if (CFG.torres.length > 3) ED.modo = paraTodas ? '*' : T.nome;
        desenharEditor();
        out.innerHTML = `<b>Aprendido pela ${esc(T.nome)}:</b> ${r.ap ? `${r.ap.n} ficha(s)${r.ap.meus ? ', ' + r.ap.meus + ' suas' : ' de outras pessoas'}` : 'sem fichas de apto'}${r.hl ? ` · hall: ${r.hl.n} ficha(s)` : ''}${[...(r.ap ? r.ap.duvida : []), ...(r.ap ? r.ap.finais : [])].map((x) => '<br>⚠ ' + esc(x)).join('')}<br>Confira na ficha abaixo e clique em <b>Salvar gabarito</b>.`;
        status('Gabarito aprendido pela ' + T.nome + '. Confira e salve.');
      } catch (e) { diz('Erro: ' + e.message); }
    };
    body.querySelectorAll('[data-apr]').forEach((b) => b.onclick = () => aprender(b.dataset.apr));
    const gt = $('#g-torre'); if (gt) gt.onchange = (e) => { S.gabTorre = e.target.value; salvarTela(); };
    const ga1 = $('#g-apr1'); if (ga1) ga1.onclick = () => aprender($('#g-torre').value);
    if (ED && ED.cod === cod) desenharEditor();
  }
  function desenharEditor() {
    const box = $('#g-ed'); if (!box || !ED) return;
    const tog = (on, attrs) => `<span class="seg" ${on === null ? 'title="Varia entre as torres"' : ''}><button ${attrs} data-v="A" class="${on === false ? 'on' : ''}">A</button><button ${attrs} data-v="N" class="${on ? 'on' : ''}">NA</button></span>`;
    // Até 3 torres: uma coluna por torre, lado a lado. Mais que isso (ex.: 15 blocos): uma coluna só, editando
    // "todas as torres juntas" ou uma torre escolhida na lista; antes a tabela ficava gigante e o texto do item espremido.
    const muitas = CFG.torres.length > 3;
    if (muitas && !ED.modo) { const vals = CFG.torres.map((t) => [...ED.na[t.nome]].sort().join()); ED.modo = vals.every((v) => v === vals[0]) ? '*' : CFG.torres[0].nome; }
    const cols = muitas ? [ED.modo] : CFG.torres.map((t) => t.nome);
    const valor = (col, o) => { if (col !== '*') return ED.na[col].has(o); const n = CFG.torres.filter((t) => ED.na[t.nome].has(o)).length; return n === 0 ? false : n === CFG.torres.length ? true : null; };
    box.innerHTML = `${muitas ? `<div class="row"><label style="max-width:320px">Editando os aptos de<select id="g-modo"><option value="*" ${ED.modo === '*' ? 'selected' : ''}>Todas as torres juntas</option>${CFG.torres.map((t) => `<option ${ED.modo === t.nome ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>
        <span class="muted">Em "todas juntas", um clique vale para as ${CFG.torres.length} torres. Escolha uma torre só quando ela for diferente.</span></div>` : ''}
      <div style="overflow:auto"><table class="gabt"><tr><th>Nº</th><th>Item da ficha</th>${cols.map((c) => `<th>Aptos ${c === '*' ? '(todas as torres)' : esc(c)}</th>`).join('')}<th>Hall ${ED.hall ? '' : '(igual aptos)'}</th><th>Abrir até aqui</th></tr>
      <tr><td></td><td class="muted">Sem pré-requisitos (só fechar)</td>${cols.map(() => '<td></td>').join('')}<td><label class="row" style="display:flex"><input type="checkbox" id="g-hallsep" ${ED.hall ? 'checked' : ''} style="width:auto"> hall diferente</label></td><td><input type="radio" name="g-pre" value="0" ${!ED.pre ? 'checked' : ''} style="width:auto"></td></tr>
      ${ED.itens.map((x) => `<tr style="${ED.pre && x.o <= ED.pre ? 'background:var(--roxoSoft)' : ''}"><td><b>${x.o}</b></td><td>${esc(x.d)}</td>
        ${cols.map((c) => `<td>${tog(valor(c, x.o), `data-t="${esc(c)}" data-o="${x.o}"`)}${valor(c, x.o) === null ? ' <span class="muted" style="font-size:11px">varia</span>' : ''}</td>`).join('')}
        <td>${ED.hall ? tog(ED.hall.has(x.o), `data-h="1" data-o="${x.o}"`) : '<span class="muted">—</span>'}</td>
        <td><input type="radio" name="g-pre" value="${x.o}" ${ED.pre === x.o ? 'checked' : ''} style="width:auto"></td></tr>`).join('')}</table></div>
      <div class="row"><button class="b p" id="g-salva">Salvar gabarito</button><span class="muted">Linhas em roxo = pré-requisitos marcados ao abrir a ficha.</span></div>`;
    const gm = $('#g-modo'); if (gm) gm.onchange = (e) => { ED.modo = e.target.value; desenharEditor(); };
    box.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { const o = +b.dataset.o; const alvo = b.dataset.t === '*' ? CFG.torres.map((t) => ED.na[t.nome]) : [ED.na[b.dataset.t]]; alvo.forEach((s) => { if (b.dataset.v === 'N') s.add(o); else s.delete(o); }); desenharEditor(); });
    box.querySelectorAll('[data-h]').forEach((b) => b.onclick = () => { const o = +b.dataset.o; if (b.dataset.v === 'N') ED.hall.add(o); else ED.hall.delete(o); desenharEditor(); });
    box.querySelectorAll('[name="g-pre"]').forEach((r) => r.onchange = () => { ED.pre = +r.value; desenharEditor(); });
    $('#g-hallsep').onchange = (e) => { ED.hall = e.target.checked ? new Set(ED.na[CFG.torres[0].nome]) : null; desenharEditor(); };
    $('#g-salva').onclick = () => {
      const arr = (s) => [...s].sort((a, b) => a - b);
      const vals = CFG.torres.map((t) => arr(ED.na[t.nome]).join());
      const na = vals.every((v) => v === vals[0]) ? arr(ED.na[CFG.torres[0].nome]) : Object.fromEntries(CFG.torres.map((t) => [t.nome, arr(ED.na[t.nome])]));
      GAB_USER[ED.cod] = { na, naHall: ED.hall ? arr(ED.hall) : undefined, pre: ED.pre || null, itens: ED.itens.length };
      LS.set(K('gab'), GAB_USER); status('Gabarito de ' + ED.cod + ' salvo.'); renderGab();
    };
  }

  // ------------------------------ aba RELATÓRIO ------------------------------
  const ALIASES = [
    [/shaft|acartonad[oa] (de )?parede/, 'FVS 014 C'], [/forro/, 'FVS 014 B'], [/gesso( corrido)?/, 'FVS 014 A'],
    [/reboco ext/, 'FVS 013 B'], [/reboco/, 'FVS 013 A'], [/regulariza|contrapiso/, 'FVS 015'], [/rejunte/, 'FVS 016 B'],
    [/revestimento|ceramica|porcelanato|assentamento/, 'FVS 016 A'], [/balcao/, 'FVS 017 E'], [/bancada/, 'FVS 017 A1'],
    [/louca/, 'FVS 017 B'], [/metais/, 'FVS 017 C'], [/tanque/, 'FVS 017 D'], [/porta (de )?madeira/, 'FVS 011 B'],
    [/porta (de )?alum|esquadria.*porta/, 'FVS 028 D'], [/contramarco/, 'FVS 028 B'], [/janela/, 'FVS 028 A'], [/peitoril/, 'FVS 033 A'], [/\bbit\b/, 'FVS 033 B'],
    [/imperm.*janela/, 'FVS 021 B'], [/impermeabiliza/, 'FVS 021 A'], [/pintura.*2|2.? dem/, 'FVS 020 B'], [/textura/, 'FVS 020 E'], [/pintura/, 'FVS 020 A'],
    [/corrimao/, 'FVS 019 A'], [/guarda.?corpo/, 'FVS 019 C'], [/chapisco/, 'FVS 007'], [/fiacao/, 'FVS 008 B'], [/acabamento eletr|eletrica.*acab/, 'FVS 008 C'],
    [/hidraulica/, 'FVS 009 A'], [/sanitaria/, 'FVS 009 B'], [/\bgas\b/, 'FVS 009 C'], [/alvenaria estrutural/, 'FVS 006 A'], [/alvenaria|vedacao/, 'FVS 006 C1'],
  ];
  function acharServico(txt) {
    const f = semAc(txt);
    const disp = servicosDisponiveis();
    for (const [re, c] of ALIASES) if (re.test(f) && disp.includes(c)) return c;
    const pal = f.replace(/\b(2q|3q|hall|pav\w*|aptos?|ap|a|e|de|do|da|ate|final)\b/g, ' ').replace(/\d+/g, ' ').trim().split(/\s+/).filter((w) => w.length > 3);
    if (!pal.length) return null;
    const cand = disp.filter((c) => pal.every((w) => semAc(nomeLimpo(c)).includes(w)));
    return cand.length ? cand.sort((a, b) => a.localeCompare(b, 'pt', { numeric: true }))[0] : null;
  }
  function lerLinhaPpc(linha) {
    const f = semAc(linha);
    const torres = CFG.torres.filter((t) => new RegExp('\\b' + semAc(t.nome) + '\\b').test(f) || new RegExp('\\b' + semAc(t.bloco) + '\\b').test(f));
    const ts = torres.length ? torres : CFG.torres;
    const locais = [];
    const ests = ts.map((T) => estruturaTorre(T)); const plano = ests.some((E) => E.plano);
    let resto = f.replace(/(?:hall|pav(?:imento)?)\s*(\d{1,2})/g, (m, n) => { ests.forEach((E) => { if (E.halls[+n]) locais.push(E.halls[+n]); }); return ' '; });
    CFG.torres.forEach((t) => { resto = resto.replace(new RegExp('\\b' + semAc(t.nome) + '\\b', 'g'), ' '); resto = resto.replace(new RegExp('\\b' + semAc(t.bloco) + '\\b', 'g'), ' '); });
    const nums = [];
    resto = resto.replace(/(\d{1,4})\s*(?:a|ate|-|ao)\s*(\d{1,4})/g, (m, a, b) => { if (!(+a >= 100 || plano)) return m; for (let x = +a; x <= +b && x - +a < 60; x++) nums.push(x); return ' '; });
    resto = resto.replace(/(?:final|andar|aptos do)\s*(\d{1,2})\b/g, (m, n) => { for (let p = 1; p <= 24; p++) nums.push(+n * 100 + p); return ' '; });
    // números curtos depois de um apto completo: "1401, 2 e 3" -> 1401, 1402, 1403
    let ultimo = null;
    for (const m of resto.matchAll(/\b(\d{1,4})\b/g)) {
      const v = +m[1];
      if (v >= 100) { nums.push(v); ultimo = v; } else if (ultimo && v >= 1 && v <= 24) nums.push(Math.floor(ultimo / 100) * 100 + v); else if (plano && v >= 1) nums.push(v);
    }
    [...new Set(nums)].forEach((n) => ests.forEach((E) => { if (E.porNum[n]) locais.push(E.porNum[n]); }));
    return { servico: acharServico(linha), locais: [...new Set(locais)].filter((a) => (AREAS || []).some((x) => x.nome === a)) };
  }
  const SIT = { fin: 'Finalizada', enc: 'Encerrada (falta finalizar)', ini: 'Iniciada', vni: 'Não iniciada (ficha criada vazia)', sem: 'Sem ficha', none: 'FVS não existe no local' };
  async function situacaoDetalhada(area, cod, ler) {
    const a = MAPA.areas[area]; const e = a && a.fvs[cod];
    const base = { area, cod, torre: (torreDe(area) || {}).nome || '', itens: '', inspetor: '', abertura: '', encerramento: '' };
    if (!e) return { ...base, sit: 'none' };
    if (!ler) return { ...base, sit: e[1] === 1 ? 'fin' : e[2] > 0 ? 'ini' : 'sem', rx: e[1] !== 1 && (e[3] || e[4]) };
    const v = await listarVerif(e[0]);
    const ult = v.slice().sort((x, y) => String(y.dataAbertura).localeCompare(String(x.dataAbertura)))[0];
    if (!ult) return { ...base, sit: e[1] === 1 ? 'fin' : 'sem' };
    const ab = v.find((i) => i.status === 0 || i.status === 3);
    const ref = ab || ult;
    let sit = e[1] === 1 ? 'fin' : ab ? (ab.status === 3 || totalPreenchido(ab) > 0 ? 'ini' : 'vni') : 'enc';
    let inspetor = '';
    { const d = ((await api('GET', '/obras/inspecoes-obra/' + ref.idInspecaoObra)).j || {}).item || {}; inspetor = (d.funcionarioInspecionado || '').trim(); } // também nas finalizadas: a planilha leva o responsável de todas
    const dt = (s) => s ? new Date(s).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
    return { ...base, sit, itens: `${totalPreenchido(ref)}/${ref.totalItens}`, inspetor, abertura: dt(ref.dataAbertura), encerramento: dt(ref.dataEncerramento), rx: (ref.totalR || 0) + (ref.totalX || 0) > 0 };
  }
  let REL = null; // { titulo, subtitulo, linhas, tipo }
  // Pedido pronto para o Claude ler as fotos da lona do PPC (o Prisma não lê foto: quem lê é o Claude, e a lista volta para cá).
  const PROMPT_PPC = `Você vai ler fotos da lona do PPC (programação semanal de produção) de uma obra da Realiza Construtora e transformar o que está escrito em uma lista para o Prisma, um sistema que confere as fichas de verificação de serviço (FVS).

O que fazer:
1. Leia todas as fotos que eu enviar. A lona tem, para cada serviço, a torre (ex.: 2Q, 3Q) e os apartamentos ou halls onde ele foi programado ou executado.
2. Devolva UMA linha por serviço e por torre, sempre neste formato:
   serviço torre locais
   Exemplos:
   regularização 3Q 1401, 1402, 1403
   reboco 2Q 1701 a 1708
   forro 3Q hall 12
   shaft 3Q final 10
3. Regras para os locais:
   - Apartamento sempre com 3 ou 4 dígitos (101, 1401). Se a lona abreviar ("1401, 2 e 3"), escreva por extenso: 1401, 1402, 1403.
   - Sequência contínua no mesmo andar pode ir como faixa: 1501 a 1508.
   - Hall ou pavimento: "hall" + número do pavimento (hall 12).
4. Use nomes simples de serviço: reboco, reboco externo, gesso, forro, shaft, regularização, revestimento, rejunte, bancada, balcão, louças, metais, tanque, porta de madeira, porta de alumínio, janela, contramarco, peitoril, BIT, impermeabilização, pintura, textura, corrimão, guarda-corpo, chapisco, alvenaria, fiação, hidráulica, sanitária, gás. Serviços que não têm FVS (limpeza, entulho, transporte etc.) também podem ir: o Prisma separa sozinho.
5. Não invente nada. Se uma palavra ou número estiver ilegível, não chute: liste esses casos no final, numa seção "Não consegui ler", dizendo em qual foto e o que parece estar escrito.
6. Responda só com a lista, dentro de um bloco de código, para eu copiar e colar direto no Prisma. A seção "Não consegui ler" vem depois do bloco, se houver.

Data do PPC: [data]`;
  // Relatório, painel e PPC leem o SGQ um de cada vez; enquanto isso o botão Parar da aba fica ativo.
  async function lendo(fn) {
    if (ocupado()) return;
    LENDO = true; PARAR = false; renderRel();
    try { await fn(); } catch (e) { status('Erro: ' + e.message); } finally { LENDO = false; PARAR = false; renderRel(); }
  }
  function renderRel() {
    const body = $('#bf2-body'); if (!body || S.aba !== 'rel') return;
    const disp = servicosDisponiveis().sort((a, b) => a.localeCompare(b, 'pt', { numeric: true }));
    S.relServ = S.relServ || []; S.relTorre = S.relTorre || 'todas';
    const q = semAc(S.relBusca || '').trim();
    const lista = disp.filter((c) => !q || semAc(c + ' ' + nomeLimpo(c)).includes(q));
    const trava = LENDO ? 'disabled' : '';
    body.innerHTML = `<div class="lay" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <div class="card topo"><h4>Relatório de FVS</h4>
        <div class="row"><label style="max-width:160px">Torre<select id="r-torre"><option value="todas">Todas</option>${CFG.torres.map((t) => `<option ${S.relTorre === t.nome ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>
          <label style="max-width:220px">Mostrar<select id="r-filtro"><option value="todas">Todas as situações</option><option value="pend" ${S.relFiltro === 'pend' ? 'selected' : ''}>Só as não finalizadas</option></select></label></div>
        <label>Serviços (<span id="r-nserv">${S.relServ.length}</span> escolhido(s))<input id="r-busca" type="search" placeholder="buscar serviço…" value="${esc(S.relBusca || '')}"></label>
        <div class="row"><button class="b" id="r-todos">Selecionar todos${q ? ' da busca' : ''}</button><button class="b" id="r-limpa">Limpar</button></div>
        <div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px;display:grid;gap:2px">${lista.map((c) => `<label class="row" style="display:flex;gap:8px;color:var(--ink)"><input type="checkbox" data-rs="${esc(c)}" ${S.relServ.includes(c) ? 'checked' : ''} style="width:auto"> <b>${esc(c.replace('FVS ', ''))}</b> ${esc(nomeLimpo(c))}</label>`).join('')}</div>
        <label class="chk"><input type="checkbox" id="r-ler" ${S.relLer !== false ? 'checked' : ''}> Ler as fichas (itens, responsável e datas; mais lento)</label>
        <div class="row"><button class="b p" id="r-gerar" ${S.relServ.length && !LENDO ? '' : 'disabled'}>Gerar relatório</button>
          <button class="b n" id="r-painel" ${trava}>Painel rápido de todos os serviços</button>
          <button class="b w" id="r-stop" ${LENDO ? '' : 'disabled'}>Parar</button></div>
        <div class="muted">O painel rápido não abre as fichas: conta pelo mapa quantas FVS de cada serviço estão sem iniciar, iniciadas e encerradas, e sai na hora.</div></div>
      <div class="card topo"><h4>Conferência do PPC</h4>
        <div class="nota">Uma linha por serviço, do jeito que está na lona. Ex.: <b>regularização 3Q 1401, 2 e 3</b> · <b>reboco 2Q 1701 a 1708</b> · <b>forro 3Q hall 12</b>.<br>Tem foto da lona? Clique em <b>Copiar pedido para o Claude</b>, cole numa conversa com o Claude, anexe as fotos e cole aqui a lista que ele devolver. Depois é só <b>Conferir no SGQ</b> e baixar a planilha (ela vem com a aba PPC).</div>
        <textarea id="r-ppc" placeholder="regularização 3Q 1401, 2 e 3&#10;shaft 3Q final 10&#10;louças 2Q 1501 a 1504">${esc(S.relPpc || '')}</textarea>
        <div class="row"><label style="max-width:200px">Data do PPC<input type="date" id="r-dppc" value="${esc(S.relDppc || hojeStr())}"></label><button class="b" id="r-prompt">Copiar pedido para o Claude</button><button class="b p" id="r-ppc-ok" ${trava}>Conferir no SGQ</button></div></div>
    </div>
    <div class="card" style="margin-top:14px" id="r-out">${REL ? previewRel() : '<div class="muted">O relatório aparece aqui, com o painel por serviço. Depois você baixa a planilha no modelo do Controle de FVS (Registro, Dashboard e Categorias).</div>'}</div>`;
    $('#r-torre').onchange = (e) => { S.relTorre = e.target.value; salvarTela(); };
    $('#r-filtro').onchange = (e) => { S.relFiltro = e.target.value; salvarTela(); };
    $('#r-ler').onchange = (e) => { S.relLer = e.target.checked; salvarTela(); };
    $('#r-busca').oninput = (e) => { S.relBusca = e.target.value; renderRel(); const i = $('#r-busca'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
    // Marcar serviço não redesenha a aba (antes redesenhava e a lista voltava para o topo).
    const marca = () => { $('#r-nserv').textContent = S.relServ.length; $('#r-gerar').disabled = !S.relServ.length || LENDO; body.querySelectorAll('[data-rs]').forEach((c) => { c.checked = S.relServ.includes(c.dataset.rs); }); salvarTela(); };
    body.querySelectorAll('[data-rs]').forEach((c) => c.onchange = () => { const v = c.dataset.rs; S.relServ = c.checked ? [...new Set([...S.relServ, v])] : S.relServ.filter((x) => x !== v); marca(); });
    $('#r-todos').onclick = () => { S.relServ = [...new Set([...S.relServ, ...lista])]; marca(); };
    $('#r-limpa').onclick = () => { S.relServ = []; marca(); };
    $('#r-ppc').onchange = (e) => { S.relPpc = e.target.value; salvarTela(); };
    $('#r-dppc').onchange = (e) => { S.relDppc = e.target.value; salvarTela(); };
    $('#r-gerar').onclick = () => lendo(() => gerarRelatorio());
    $('#r-painel').onclick = () => lendo(() => gerarRelatorio({ todos: true }));
    $('#r-stop').onclick = () => { if (!LENDO) return; PARAR = true; status('Parando a leitura...'); };
    $('#r-ppc-ok').onclick = () => { S.relPpc = $('#r-ppc').value; salvarTela(); lendo(() => conferirPpc()); };
    $('#r-prompt').onclick = async () => {
      const t = PROMPT_PPC.replace('[data]', fmt(S.relDppc || hojeStr()));
      try { await navigator.clipboard.writeText(t); status('Pedido copiado. Abra o Claude, cole (Ctrl + V), anexe as fotos da lona e envie. Depois cole aqui a lista que ele devolver.'); } catch (e) { status('Não deu para copiar sozinho.'); }
    };
    ligarBotoesRel();
  }
  // ------------------------------ aba HISTÓRICO ------------------------------
  // Duas fontes: o que o Prisma gravou (src 'prisma') e mudanças vistas ao atualizar o mapa (src 'sgq', feitas por qualquer pessoa).
  const dataLocal = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const horaLocal = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  function eventoDe(h) {
    if (h.src === 'sgq') return { finalizada: 'Finalizada', iniciada: 'Iniciada', reaberta: 'Voltou a ficar aberta', nova: 'FVS nova no local', zerada: 'Itens apagados' }[h.ev] || h.ev;
    if (h.r !== 'OK') return 'Pendente';
    if (/^(já|a FVS aparece)/.test(h.d || '')) return h.ac === 'abrir' ? 'Já estava aberta' : 'Já estava fechada';
    return h.ac === 'abrir' ? 'Aberta' : /finalizada/.test(h.d || '') ? 'Fechada e finalizada' : 'Fechada';
  }
  const COR_EV = { 'Aberta': '#e3a21a', 'Iniciada': '#e3a21a', 'Fechada e finalizada': '#2f9a5a', 'Finalizada': '#2f9a5a', 'Fechada': '#2f9a5a', 'Pendente': '#d2463c', 'Voltou a ficar aberta': '#d2463c', 'Itens apagados': '#d2463c' };
  function renderHist() {
    const body = $('#bf2-body');
    S.hDia = S.hDia || hojeStr(); S.hSrc = S.hSrc || 'todos';
    const dias = [...new Set(HIST.map((h) => dataLocal(h.q)))].sort().reverse();
    const L = HIST.filter((h) => dataLocal(h.q) === S.hDia && (S.hSrc === 'todos' || h.src === S.hSrc) && (!S.hServ || h.f === S.hServ)).sort((a, b) => b.q.localeCompare(a.q));
    const cont = {}; L.forEach((h) => { const e = eventoDe(h); cont[e] = (cont[e] || 0) + 1; });
    const servs = [...new Set(HIST.filter((h) => dataLocal(h.q) === S.hDia).map((h) => h.f))].sort((a, b) => a.localeCompare(b, 'pt', { numeric: true }));
    body.innerHTML = `<div class="card topo"><h4>Histórico do dia</h4>
      <div class="nota">O que o <b>Prisma gravou</b> e o que <b>mudou no SGQ</b> (visto ao atualizar o mapa: inclui o que foi feito na mão ou por outras pessoas; a hora é a da leitura, não a do lançamento). Fica guardado neste navegador.</div>
      <div class="row">
        <label style="max-width:170px">Dia<input type="date" id="h-dia" value="${esc(S.hDia)}" max="${hojeStr()}"></label>
        <label style="max-width:200px">Mostrar<select id="h-src"><option value="todos">Tudo</option><option value="prisma" ${S.hSrc === 'prisma' ? 'selected' : ''}>Só o que o Prisma gravou</option><option value="sgq" ${S.hSrc === 'sgq' ? 'selected' : ''}>Só mudanças vistas no SGQ</option></select></label>
        <label style="max-width:260px">Serviço<select id="h-serv"><option value="">Todos</option>${servs.map((c) => `<option value="${esc(c)}" ${S.hServ === c ? 'selected' : ''}>${esc(c)} · ${esc(nomeLimpo(c))}</option>`).join('')}</select></label>
      </div>
      <div class="row">${dias.slice(0, 7).map((d) => `<button class="b ${d === S.hDia ? 'n' : ''}" data-hd="${d}">${d === hojeStr() ? 'Hoje' : fmt(d)}</button>`).join('')}</div>
      <div class="row">${Object.keys(cont).length ? Object.entries(cont).map(([e, n]) => `<span class="hchip" style="border-left:4px solid ${COR_EV[e] || '#8a94a6'}"><b>${n}</b> ${esc(e)}</span>`).join('') : '<span class="muted">Nada registrado nesse dia.</span>'}</div>
      ${L.length ? `<div class="row"><button class="b" id="h-copiar">Copiar para o Excel</button><button class="b w" id="h-limpar">Apagar o histórico deste dia</button></div>
      <div style="overflow:auto;max-height:52vh"><table><tr><th>Hora</th><th>Local</th><th>FVS</th><th>O que aconteceu</th><th>Por</th><th>Detalhe</th></tr>
        ${L.map((h) => { const e = eventoDe(h); return `<tr><td>${horaLocal(h.q)}</td><td>${esc(localComTorre(h.a))}</td><td><b>${esc(h.f.replace('FVS ', ''))}</b> <span class="muted">${esc(nomeLimpo(h.f))}</span></td><td style="color:${COR_EV[e] || 'inherit'};font-weight:700">${esc(e)}</td><td class="muted">${h.src === 'prisma' ? 'Prisma (' + esc((h.u || '').split(' ')[0]) + ')' : 'visto no SGQ'}</td><td class="muted">${esc(h.d || '')}</td></tr>`; }).join('')}</table></div>` : ''}
    </div>`;
    $('#h-dia').onchange = (e) => { S.hDia = e.target.value || hojeStr(); S.hServ = ''; renderHist(); };
    $('#h-src').onchange = (e) => { S.hSrc = e.target.value; renderHist(); };
    $('#h-serv').onchange = (e) => { S.hServ = e.target.value; renderHist(); };
    body.querySelectorAll('[data-hd]').forEach((b) => b.onclick = () => { S.hDia = b.dataset.hd; S.hServ = ''; renderHist(); });
    const cp = $('#h-copiar'); if (cp) cp.onclick = async () => {
      const tsv = ['Dia\tHora\tTorre\tLocal\tFVS\tServiço\tO que aconteceu\tPor\tDetalhe', ...L.map((h) => [fmt(dataLocal(h.q)), horaLocal(h.q), (torreDe(h.a) || {}).nome || '', localCurto(h.a), h.f, nomeLimpo(h.f), eventoDe(h), h.src === 'prisma' ? 'Prisma (' + (h.u || '') + ')' : 'visto no SGQ', (h.d || '').replace(/\s+/g, ' ')].join('\t'))].join('\n');
      try { await navigator.clipboard.writeText(tsv); status(L.length + ' linha(s) copiadas. Cole no Excel com Ctrl + V.'); } catch (e) { status('Não deu para copiar sozinho.'); } };
    const lp = $('#h-limpar'); if (lp) lp.onclick = () => { if (!confirm('Apagar o histórico de ' + fmt(S.hDia) + ' deste navegador? (Não mexe em nada no SGQ.)')) return; HIST = HIST.filter((h) => dataLocal(h.q) !== S.hDia); salvarHist(); renderHist(); };
  }
  async function garantirMapa(torres) {
    await listarAreas(); if (!Object.keys(NOMES).length) await carregarNomes();
    for (const T of torres) if (!MAPA.ts[T.nome]) await atualizarTorre(T);
  }
  // opc.todos = painel rápido: todos os serviços, só pelo mapa (sem abrir fichas), sem o filtro de "só não finalizadas".
  async function gerarRelatorio(opc = {}) {
    const torres = S.relTorre === 'todas' ? CFG.torres : CFG.torres.filter((t) => t.nome === S.relTorre);
    await garantirMapa(torres);
    if (PARAR) return status('Leitura do mapa interrompida: nada foi montado.');
    const ler = opc.todos ? false : S.relLer !== false;
    const servs = opc.todos ? servicosDisponiveis().sort((a, b) => a.localeCompare(b, 'pt', { numeric: true })) : S.relServ;
    const soPend = !opc.todos && S.relFiltro === 'pend';
    const alvo = [];
    for (const T of torres) { const est = estruturaTorre(T); const ordem = est.ordem.concat(est.outros);
      servs.forEach((c) => ordem.filter((n) => MAPA.areas[n] && MAPA.areas[n].fvs[c]).sort((a, b) => a.localeCompare(b, 'pt', { numeric: true })).forEach((n) => alvo.push([n, c]))); }
    const lista = alvo.filter(([n, c]) => !(soPend && MAPA.areas[n].fvs[c][1] === 1));
    if (!lista.length) return status('Nenhuma FVS desses serviços nessa torre.');
    if (ler && lista.length > 800) { // cada ficha são ~2 consultas ao SGQ
      const min = Math.ceil(lista.length * 2 * ((+CFG.pausaMs || 400) / 1000 + 0.3) / Math.max(1, Math.min(6, +CFG.leiturasJuntas || 3)) / 60);
      if (!confirm(`Vai abrir ${lista.length} fichas no SGQ, o que leva uns ${min} minuto(s).\n\nDá para parar no meio pelo botão Parar.\nPara só contar por serviço, use o "Painel rápido" (não abre as fichas e sai na hora).\n\nContinuar?`)) return status('Relatório cancelado.');
    }
    const res = []; let feitos = 0; // res[k] na mesma ordem da lista, mesmo lendo várias fichas ao mesmo tempo
    await emParalelo(lista, async ([n, c], k) => {
      res[k] = await situacaoDetalhada(n, c, ler);
      feitos++; if (ler || feitos % 250 === 0) status(`Montando ${opc.todos ? 'painel' : 'relatório'}: ${feitos}/${lista.length} (${localComTorre(n)} · ${c})`);
    });
    const linhas = res.filter(Boolean);
    const parcial = linhas.length < lista.length ? `interrompido em ${linhas.length} de ${lista.length}` : '';
    const nomeServs = opc.todos ? servs.length + ' serviços, contados pelo mapa' : servs.length > 6 ? servs.length + ' serviços' : servs.map((c) => c.replace('FVS ', '') + ' ' + nomeLimpo(c)).join(' · ');
    REL = { tipo: 'fvs', titulo: opc.todos ? 'Painel de todos os serviços' : 'Relatório de FVS', subtitulo: `${nomeServs} · ${torres.map((t) => t.nome).join(' e ')}${soPend ? ' · só não finalizadas' : ''}${parcial ? ' · ' + parcial : ''}`, linhas };
    status(parcial ? `Parado: ${linhas.length} de ${lista.length} linha(s) montadas. Dá para baixar a planilha só com elas.` : `${REL.titulo} pronto: ${linhas.length} linha(s).`);
  }
  async function conferirPpc() {
    await garantirMapa(CFG.torres);
    if (PARAR) return status('Leitura do mapa interrompida: nada foi conferido.');
    const naoEntendi = [];
    const L = (S.relPpc || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const lista = [];
    for (const l of L) {
      const r = lerLinhaPpc(l);
      if (!r.servico) { naoEntendi.push(l + ' → serviço sem FVS ou não reconhecido'); continue; }
      if (!r.locais.length) { naoEntendi.push(l + ' → não achei os apartamentos'); continue; }
      r.locais.forEach((n) => lista.push([n, r.servico, l]));
    }
    const res = []; let feitos = 0;
    await emParalelo(lista, async ([n, cod, l], k) => {
      const s = await situacaoDetalhada(n, cod, true); s.origem = l; res[k] = s;
      feitos++; status(`Conferindo ${feitos}/${lista.length}: ${localComTorre(n)} · ${cod}`);
    });
    const linhas = res.filter(Boolean);
    const parcial = linhas.length < lista.length ? `interrompido em ${linhas.length} de ${lista.length}` : '';
    REL = { tipo: 'ppc', titulo: 'Conferência de FVS do PPC', subtitulo: `PPC de ${fmt(S.relDppc || hojeStr())} · ${L.length} linha(s) da lona${parcial ? ' · ' + parcial : ''}`, linhas, naoEntendi };
    status(parcial ? `Parado: ${linhas.length} de ${lista.length} ficha(s) conferidas.` : `Conferência pronta: ${linhas.length} ficha(s) conferida(s).`);
  }
  const abertaTxt = (s) => ['ini', 'enc', 'fin'].includes(s) ? 'Sim' : s === 'none' ? '—' : 'Não';
  function contarSit(L) { const c = {}; L.forEach((x) => { c[x.sit] = (c[x.sit] || 0) + 1; }); return c; }
  // Painel por serviço, como o Dashboard da planilha da qualidade: sem iniciar / iniciadas / encerradas (encerrada = verificação encerrada ou FVS finalizada).
  function painelDados(L) {
    const G = new Map();
    L.forEach((x) => { const st = STATUS_PL[x.sit]; if (!st) return; const k = categoria(x.cod);
      const g = G.get(k) || { cat: k, cods: new Set(), sem: 0, ini: 0, enc: 0 }; g.cods.add(x.cod.replace('FVS ', ''));
      g[st === 'ENCERRADA' ? 'enc' : st === 'INICIADA' ? 'ini' : 'sem']++; G.set(k, g); });
    return [...G.values()];
  }
  function painelHtml(L) {
    const D = painelDados(L); if (!D.length) return '';
    const max = Math.max(...D.map((g) => g.sem + g.ini + g.enc));
    const tot = D.reduce((t, g) => ({ sem: t.sem + g.sem, ini: t.ini + g.ini, enc: t.enc + g.enc }), { sem: 0, ini: 0, enc: 0 });
    const seg = (n, cor, tx) => (n ? `<span style="flex:${n};background:${cor};color:${tx}" title="${n}">${n}</span>` : '');
    return `<div class="card topo" style="margin:10px 0"><div class="row" style="justify-content:space-between"><h4>Painel por serviço</h4>
        <div class="row">${[['Sem iniciar', tot.sem, '#d2463c'], ['Iniciadas', tot.ini, '#e3a21a'], ['Encerradas', tot.enc, '#2f9a5a']].map(([t, n, c]) => `<span class="hchip" style="border-left:4px solid ${c}"><b>${n}</b> ${t}</span>`).join('')}</div></div>
      <div class="painel"><div class="pl muted"><span>Serviço</span><span></span><span class="pt">sem · ini · enc</span></div>
      ${D.map((g) => { const t = g.sem + g.ini + g.enc; const cods = [...g.cods].join(', ');
        return `<div class="pl"><span class="pn" title="FVS ${esc(cods)}"><b>${esc(g.cat)}</b> <small>${esc(cods)}</small></span><span class="pb" style="width:${Math.max(6, (t / max) * 100)}%">${seg(g.sem, '#d2463c', '#fff')}${seg(g.ini, '#e3a21a', '#2b1d00')}${seg(g.enc, '#2f9a5a', '#fff')}</span><span class="pt">${g.sem} · ${g.ini} · ${g.enc}</span></div>`; }).join('')}</div></div>`;
  }
  const MAX_PREVIA = 300; // tabela na tela; a planilha e o "Copiar" levam todas as linhas
  function previewRel() {
    const c = contarSit(REL.linhas);
    return `<div class="row" style="justify-content:space-between"><div><h4>${esc(REL.titulo)}</h4><div class="muted">${esc(REL.subtitulo)}</div></div>
      <div class="row"><button class="b p" id="r-xlsx">Baixar planilha (modelo Controle de FVS)</button><button class="b" id="r-copy">Copiar para Excel</button><button class="b" id="r-copy-painel">Copiar painel</button></div></div>
      ${painelHtml(REL.linhas)}
      <div class="muted">${Object.entries(c).map(([k, n]) => `${n} ${SIT[k].toLowerCase()}`).join(' · ')}</div>
      ${REL.naoEntendi && REL.naoEntendi.length ? `<div class="warn">${REL.naoEntendi.map(esc).join('<br>')}</div>` : ''}
      ${REL.linhas.length > MAX_PREVIA ? `<div class="muted">Mostrando ${MAX_PREVIA} de ${REL.linhas.length} linhas. A planilha e o "Copiar para Excel" levam todas.</div>` : ''}
      <table><tr>${REL.tipo === 'ppc' ? '<th>Linha da lona</th>' : ''}<th>Torre</th><th>Local</th><th>FVS</th><th>Situação</th>${REL.tipo === 'ppc' ? '<th>Aberta?</th>' : ''}<th>Itens</th><th>Responsável</th><th>Abertura</th><th>Encerramento</th></tr>
      ${REL.linhas.slice(0, MAX_PREVIA).map((x) => `<tr class="${x.sit === 'fin' ? 'ok' : ['sem', 'vni'].includes(x.sit) ? 'pend' : ''}">${REL.tipo === 'ppc' ? `<td>${esc(x.origem)}</td>` : ''}<td>${esc(x.torre)}</td><td>${esc(localCurto(x.area))}</td><td>${esc(x.cod.replace('FVS ', ''))} ${esc(nomeLimpo(x.cod))}</td><td>${esc(SIT[x.sit])}${x.rx ? ' · R/X' : ''}</td>${REL.tipo === 'ppc' ? `<td><b>${abertaTxt(x.sit)}</b></td>` : ''}<td>${esc(x.itens)}</td><td>${esc(x.inspetor)}</td><td>${esc(x.abertura)}</td><td>${esc(x.encerramento)}</td></tr>`).join('')}</table>`;
  }
  function ligarBotoesRel() {
    const p = $('#r-xlsx'); if (p) p.onclick = () => { try { baixarPlanilha(); } catch (e) { status('Erro ao montar a planilha: ' + e.message); } };
    const c = $('#r-copy'); if (c) c.onclick = () => {
      const tsv = [['Torre', 'Local', 'FVS', 'Serviço', 'Situação', REL.tipo === 'ppc' ? 'Aberta?' : null, 'Itens', 'Responsável', 'Abertura', 'Encerramento'].filter((x) => x !== null).join('\t')]
        .concat(REL.linhas.map((x) => [x.torre, localCurto(x.area), x.cod, nomeLimpo(x.cod), SIT[x.sit] + (x.rx ? ' · R/X' : ''), REL.tipo === 'ppc' ? abertaTxt(x.sit) : null, x.itens, x.inspetor, x.abertura, x.encerramento].filter((v) => v !== null).join('\t'))).join('\n');
      navigator.clipboard.writeText(tsv).then(() => status('Copiado. Cole no Excel ou no Google Planilhas.'), () => status('Não deu para copiar.'));
    };
    const cp = $('#r-copy-painel'); if (cp) cp.onclick = () => {
      const tsv = ['Serviço\tFVS\tSem iniciar\tIniciadas\tEncerradas\tTotal'].concat(painelDados(REL.linhas).map((g) => [g.cat, [...g.cods].join(', '), g.sem, g.ini, g.enc, g.sem + g.ini + g.enc].join('\t'))).join('\n');
      navigator.clipboard.writeText(tsv).then(() => status('Painel copiado. Cole no Excel com Ctrl + V.'), () => status('Não deu para copiar.'));
    };
  }
  // ------------------------------ PLANILHA (modelo CONTROLE DE FVS) ------------------------------
  // Gera um .xlsx igual ao controle da qualidade: abas "Registro de FVS", "Dashboard" e "Categorias de Serviços".
  // Montado aqui mesmo (zip sem compressão + XML do Excel), sem biblioteca de fora.
  const CATEG = {
    'FVS 006 A': 'Alvenaria Estrutural', 'FVS 006 C1': 'Alvenaria de Vedação', 'FVS 007': 'Chapisco', 'FVS 008 B': 'Fiação', 'FVS 008 C': 'Módulos/Acabamento',
    'FVS 009 A': 'Hidráulica', 'FVS 009 B': 'Sanitária', 'FVS 009 C': 'Gás', 'FVS 011 B': 'PORTA DE MADEIRA', 'FVS 013 A': 'Reboco', 'FVS 013 B': 'Reboco externo',
    'FVS 014 A': 'Gesso', 'FVS 014 B': 'Forro', 'FVS 014 C': 'SHAFT - ACARTONADO', 'FVS 015': 'Regularização', 'FVS 016 A': 'Revestimento', 'FVS 016 B': 'Rejunte',
    'FVS 017 A1': 'Bancada', 'FVS 017 B': 'LOUÇAS', 'FVS 017 C': 'METAIS', 'FVS 017 D': 'TANQUES', 'FVS 017 E': 'Balcão', 'FVS 019 A': 'CORRIMÃO', 'FVS 019 C': 'Guarda-corpo',
    'FVS 020 A': 'PINTURA', 'FVS 020 B': 'PINTURA 2º DEMÃO', 'FVS 020 E': 'Textura', 'FVS 021 A': 'Impermeabilização', 'FVS 021 B': 'Impermeabilização de janela',
    'FVS 028 A': 'Esquadrias', 'FVS 028 B': 'Contramarco', 'FVS 028 D': 'Porta de aluminio', 'FVS 033 A': 'Peitoril', 'FVS 033 B': 'BIT',
  };
  const categoria = (cod) => CATEG[cod] || nomeLimpo(cod).replace(/\s*\(.*$/, '').slice(0, 40);
  // Apelidos usados na planilha da qualidade do Varandas; nas outras obras vai o primeiro nome.
  const APELIDOS = ['AISSA', 'ANA LAURA', 'JOÃO VITOR', 'NETO', 'THAIANE', 'ALISSON', 'ANDRESA', 'ANA CLARA', 'RAMOS', 'VITOR', 'MARCELO', 'YURI'];
  function apelido(nome) {
    const pal = norm(semAc(nome)).split(' ').filter(Boolean); if (!pal.length) return '';
    if (CFG.idObra === 2064) { const a = APELIDOS.filter((x) => norm(semAc(x)).split(' ').every((w) => pal.includes(w))).sort((x, y) => y.length - x.length)[0]; if (a) return a; }
    return norm(nome).split(' ')[0];
  }
  const pavTxt = (n) => (n <= 0 ? 'TERREO' : n + '°');
  const STATUS_PL = { fin: 'ENCERRADA', enc: 'ENCERRADA', ini: 'INICIADA', vni: 'SEM INICIAR', sem: 'SEM INICIAR', none: '' };
  function linhaPlanilha(x) {
    const p = lerArea(x.area), T = torreDe(x.area);
    let pav, ap = '';
    if (p.tipo === 'un') { pav = p.andar ? pavTxt(p.andar + ((T && +T.hall) || 0)) : ''; ap = p.num; }
    else if (p.tipo === 'hall') { pav = pavTxt(p.pav); ap = 'HALL'; }
    else pav = localCurto(x.area).toUpperCase();
    const obs = [x.cod, x.sit === 'enc' ? 'falta finalizar a FVS' : '', x.sit === 'none' ? 'FVS não existe no local' : '', x.rx ? 'R/X em aberto' : '',
      x.itens && x.sit !== 'fin' ? x.itens + ' itens' : '', x.abertura ? 'aberta ' + x.abertura : '', x.encerramento ? 'encerrada ' + x.encerramento : '', x.origem ? 'PPC: ' + x.origem : ''].filter(Boolean).join(' · ');
    return [x.torre || p.bloco, pav, ap, categoria(x.cod), apelido(x.inspetor), STATUS_PL[x.sit] || '', obs];
  }

  // zip "store" (sem compressão), suficiente para o Excel abrir
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zipStore(arqs) {
    const enc = new TextEncoder(), partes = [], central = []; let pos = 0;
    const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const [nome, txt] of arqs) {
      const n = enc.encode(nome), d = enc.encode(txt), c = crc32(d);
      const comum = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(c), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0)];
      const loc = new Uint8Array([...u32(0x04034b50), ...comum]);
      partes.push(loc, n, d);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...comum, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(pos)]), n);
      pos += loc.length + n.length + d.length;
    }
    const tamC = central.reduce((s, b) => s + b.length, 0);
    const fim = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(arqs.length), ...u16(arqs.length), ...u32(tamC), ...u32(pos), ...u16(0)]);
    return new Blob([...partes, ...central, fim], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const xe = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colL = (i) => String.fromCharCode(65 + i);
  // célula: número, texto ou fórmula ({f, v}); s = índice do estilo (cellXfs abaixo)
  function cel(ref, v, s) {
    if (v && typeof v === 'object') return `<c r="${ref}" s="${s}"><f>${xe(v.f)}</f><v>${v.v}</v></c>`;
    if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
    return v === '' || v == null ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
  }
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  // estilos: 0 normal · 1 cabeçalho azul · 2 célula com borda centralizada · 3 observação · 4 título · 5 seção · 6 rótulo · 7 número · 8/9/10 cabeçalhos coloridos · 11 célula da tabela
  const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}>
<fonts count="5"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="26"/><color rgb="FFC00000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="12"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF92D050"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border><border><left style="medium"><color indexed="64"/></left><right style="medium"><color indexed="64"/></right><top style="medium"><color indexed="64"/></top><bottom style="medium"><color indexed="64"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="3"><dxf><fill><patternFill><bgColor rgb="FF92D050"/></patternFill></fill></dxf><dxf><fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill></dxf><dxf><fill><patternFill><bgColor rgb="FFFF0000"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;

  // 1401, 1402, 1403, 1405 -> "1401 a 1403, 1405"
  function intervalos(nums) {
    const v = [...new Set(nums)].sort((a, b) => a - b), out = [];
    for (let i = 0; i < v.length; i++) { let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++; out.push(j - i >= 2 ? `${v[i]} a ${v[j]}` : v.slice(i, j + 1).join(', ')); i = j; }
    return out.join(', ');
  }
  // Aba PPC: uma linha por linha da lona (e torre/FVS), com os apartamentos e quantos estão encerrados, iniciados e sem iniciar.
  function linhasPpc(R) {
    const G = new Map();
    R.linhas.forEach((x) => { const k = [x.origem, x.torre, x.cod].join('|'); const g = G.get(k) || { origem: x.origem, torre: x.torre, cod: x.cod, L: [] }; g.L.push(x); G.set(k, g); });
    const rot = (x) => { const p = lerArea(x.area); return p.tipo === 'un' ? p.num : p.tipo === 'hall' ? 'hall ' + p.pav : localCurto(x.area); };
    const junta = (L) => { const r = L.map(rot); return [intervalos(r.filter((v) => typeof v === 'number')), ...r.filter((v) => typeof v !== 'number')].filter(Boolean).join(', '); };
    return [...G.values()].map((g) => {
      const por = (st) => g.L.filter((x) => (st ? STATUS_PL[x.sit] === st : x.sit === 'none'));
      const det = [['Encerradas', por('ENCERRADA')], ['Iniciadas', por('INICIADA')], ['Sem iniciar', por('SEM INICIAR')], ['Sem essa FVS no local', por('')]].filter(([, L]) => L.length).map(([t, L]) => `${t}: ${junta(L)}`).join(' · ');
      return [g.origem, g.torre, categoria(g.cod), g.cod, junta(g.L), por('ENCERRADA').length, por('INICIADA').length, por('SEM INICIAR').length, det];
    });
  }
  // Gráfico de barras empilhadas do Dashboard (sem iniciar / iniciada / encerradas por serviço), lendo a tabela A11:D.
  function graficoXml(ultima) {
    const ser = [['B', 'FF0000'], ['C', 'FFC000'], ['D', '92D050']].map(([c, cor], i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>Dashboard!$${c}$11</c:f></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${cor}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:cat><c:strRef><c:f>Dashboard!$A$12:$A$${ultima}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Dashboard!$${c}$12:$${c}$${ultima}</c:f></c:numRef></c:val></c:ser>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>FVS por serviço</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:varyColors val="0"/>${ser}<c:gapWidth val="40"/><c:overlap val="100"/><c:axId val="5101"/><c:axId val="5102"/></c:barChart><c:catAx><c:axId val="5101"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="5102"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="5102"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="5101"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
  }

  function planilhaXlsx(R) {
    const L = R.linhas.map(linhaPlanilha);
    const ppc = R.tipo === 'ppc';
    const CAB = ['BLOCO', 'Pavimento', 'Apartamento', 'Categoria de Serviço', 'Responsável', 'Status', 'Observações'];
    const n = L.length + 1; // última linha com dados
    // Registro de FVS
    const reg = [`<row r="1">${CAB.map((t, i) => cel(colL(i) + 1, t, 1)).join('')}</row>`]
      .concat(L.map((r, k) => `<row r="${k + 2}">${r.map((v, i) => cel(colL(i) + (k + 2), v, i === 6 ? 3 : 2)).join('')}</row>`));
    const uniq = (i) => [...new Set(L.map((r) => r[i]).filter((v) => v !== ''))];
    const blocos = uniq(0), pavs = uniq(1).sort((a, b) => (parseInt(a, 10) || (a === 'TERREO' ? 0 : 99)) - (parseInt(b, 10) || (b === 'TERREO' ? 0 : 99))), cats = uniq(3), resp = uniq(4).sort(), stats = ['ENCERRADA', 'INICIADA', 'SEM INICIAR'];
    const CS = "'Categorias de Serviços'";
    const lista = (col, arr) => `${CS}!$${col}$2:$${col}$${Math.max(2, arr.length + 1)}`;
    const dv = [['A', 'I', blocos], ['B', 'G', pavs], ['D', 'A', cats], ['E', 'C', resp], ['F', 'E', stats]]
      .map(([c, src, arr]) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${c}2:${c}${n + 500}"><formula1>${xe(lista(src, arr))}</formula1></dataValidation>`).join('');
    const cf = [['SEM INICIAR', 2, 1], ['INICIADA', 1, 2], ['ENCERRADA', 0, 3]].map(([t, dxf, pr]) =>
      `<cfRule type="containsText" dxfId="${dxf}" priority="${pr}" operator="containsText" text="${t}"><formula>NOT(ISERROR(SEARCH("${t}",F2)))</formula></cfRule>`).join('');
    const sheetReg = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><dimension ref="A1:G${n}"/>
<sheetViews><sheetView ${ppc ? '' : 'tabSelected="1" '}zoomScale="80" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="14.4"/>
<cols><col min="1" max="1" width="13.2" customWidth="1"/><col min="2" max="2" width="13.3" customWidth="1"/><col min="3" max="3" width="13.4" customWidth="1"/><col min="4" max="4" width="24" customWidth="1"/><col min="5" max="6" width="22" customWidth="1"/><col min="7" max="7" width="70" customWidth="1"/></cols>
<sheetData>${reg.join('')}</sheetData><autoFilter ref="A1:G${n}"/><conditionalFormatting sqref="F2:F${n + 500}">${cf}</conditionalFormatting><dataValidations count="5">${dv}</dataValidations>
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape"/></worksheet>`;
    // Dashboard (fórmulas iguais às do modelo, já com o valor calculado) + gráfico por serviço
    const conta = (filtro) => L.filter(filtro).length;
    const tem = (s, t) => String(s).includes(t);
    const RG = "'Registro de FVS'";
    const ultima = 11 + cats.length;
    const dRows = [
      `<row r="1" ht="21" customHeight="1">${cel('A1', 'Controle de FVS - Obra: ' + (CFG.obraNome || ''), 4)}</row>`,
      `<row r="3">${cel('A3', 'Gerado pelo Prisma em ' + new Date().toLocaleString('pt-BR') + ' a partir do SGQ', 0)}</row>`,
      `<row r="5">${cel('A5', 'Resumo Geral de FVS', 5)}${cel('B5', '', 5)}${cel('C5', '', 5)}${cel('D5', '', 5)}</row>`,
      ...[['Encerrada', 'ENCERRADA'], ['Iniciada', 'INICIADA'], ['Sem iniciar', 'SEM INICIAR']].map(([rot, t], k) =>
        `<row r="${6 + k}">${cel('A' + (6 + k), rot, 6)}${cel('B' + (6 + k), { f: `COUNTIF(${RG}!F:F,"*${t}*")`, v: conta((r) => tem(r[5], t)) }, 7)}${cel('C' + (6 + k), '', 7)}${cel('D' + (6 + k), '', 7)}</row>`),
      `<row r="11">${cel('A11', 'Serviço', 6)}${cel('B11', 'Sem iniciar', 8)}${cel('C11', 'Iniciada', 9)}${cel('D11', 'Encerradas', 10)}</row>`,
      ...cats.map((c, k) => { const r = 12 + k; const q = (t) => ({ f: `COUNTIFS(${RG}!D:D,A${r},${RG}!F:F,"*${t}*")`, v: conta((x) => x[3] === c && tem(x[5], t)) });
        return `<row r="${r}">${cel('A' + r, c, 11)}${cel('B' + r, q('SEM INICIAR'), 2)}${cel('C' + r, q('INICIADA'), 2)}${cel('D' + r, q('ENCERRADA'), 2)}</row>`; }),
    ];
    const comGrafico = cats.length > 0;
    const sheetDash = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="14.4"/>
<cols><col min="1" max="1" width="31" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="3" max="3" width="15" customWidth="1"/><col min="4" max="4" width="13" customWidth="1"/></cols>
<sheetData>${dRows.join('')}</sheetData><mergeCells count="5"><mergeCell ref="A1:O2"/><mergeCell ref="A5:D5"/><mergeCell ref="B6:D6"/><mergeCell ref="B7:D7"/><mergeCell ref="B8:D8"/></mergeCells>
<pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/>${comGrafico ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
    const desenho = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>16</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${Math.max(24, ultima + 3)}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="FVS por serviço"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
    // Categorias de Serviços (listas das caixinhas de escolha)
    const colsCat = [['A', 'Categoria de Serviço', cats], ['C', 'Responsável', resp], ['E', 'Status', stats], ['G', 'Pavimento', pavs], ['I', 'BLOCO', blocos]];
    const maxN = Math.max(...colsCat.map((c) => c[2].length));
    const cRows = [];
    for (let r = 1; r <= maxN + 1; r++) cRows.push(`<row r="${r}">${colsCat.map(([c, t, arr]) => (r === 1 ? cel(c + r, t, 1) : arr[r - 2] != null ? cel(c + r, arr[r - 2], 11) : '')).join('')}</row>`);
    const sheetCat = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="14.4"/>
<cols><col min="1" max="1" width="34" customWidth="1"/><col min="3" max="3" width="23" customWidth="1"/><col min="5" max="5" width="18" customWidth="1"/><col min="7" max="7" width="20" customWidth="1"/><col min="9" max="9" width="20" customWidth="1"/></cols>
<sheetData>${cRows.join('')}</sheetData><pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>`;
    // PPC (só na conferência do PPC): primeira aba
    const abas = [];
    if (ppc) {
      const P = linhasPpc(R);
      const CABP = ['Linha da lona', 'Torre', 'Frente de serviço', 'FVS', 'Apartamentos', 'Encerradas', 'Iniciadas', 'Sem iniciar', 'Situação por apartamento'];
      const estCab = [1, 1, 1, 1, 1, 10, 9, 8, 1], estCel = [3, 2, 2, 2, 3, 2, 2, 2, 3];
      const rows = [`<row r="1">${CABP.map((t, i) => cel(colL(i) + 1, t, estCab[i])).join('')}</row>`]
        .concat(P.map((r, k) => `<row r="${k + 2}">${r.map((v, i) => cel(colL(i) + (k + 2), v, estCel[i])).join('')}</row>`));
      (R.naoEntendi || []).forEach((t, k) => rows.push(`<row r="${P.length + 3 + k}">${cel('A' + (P.length + 3 + k), 'Não entrou: ' + t, 0)}</row>`));
      abas.push({ nome: 'PPC', xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetViews><sheetView tabSelected="1" zoomScale="90" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="14.4"/>
<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="8" customWidth="1"/><col min="3" max="3" width="22" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/><col min="5" max="5" width="30" customWidth="1"/><col min="6" max="8" width="12" customWidth="1"/><col min="9" max="9" width="80" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData><autoFilter ref="A1:I${P.length + 1}"/><pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape"/></worksheet>` });
    }
    abas.push({ nome: 'Registro de FVS', xml: sheetReg }, { nome: 'Dashboard', xml: sheetDash, grafico: comGrafico }, { nome: 'Categorias de Serviços', xml: sheetCat });
    const iReg = abas.findIndex((a) => a.nome === 'Registro de FVS'), iDash = abas.findIndex((a) => a.grafico);
    const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const arqs = [
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${abas.map((a, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${iDash >= 0 ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' : ''}</Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><bookViews><workbookView/></bookViews><sheets>${abas.map((a, i) => `<sheet name="${xe(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="${iReg}" hidden="1">'Registro de FVS'!$A$1:$G$${n}</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">${abas.map((a, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${abas.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', ESTILOS],
      ...abas.map((a, i) => [`xl/worksheets/sheet${i + 1}.xml`, a.xml]),
    ];
    if (iDash >= 0) arqs.push(
      [`xl/worksheets/_rels/sheet${iDash + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL_NS}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`],
      ['xl/drawings/drawing1.xml', desenho],
      ['xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL_NS}/chart" Target="../charts/chart1.xml"/></Relationships>`],
      ['xl/charts/chart1.xml', graficoXml(ultima)]);
    return zipStore(arqs);
  }
  function baixarPlanilha() {
    if (!REL || !REL.linhas.length) return status('Gere o relatório primeiro.');
    const d = new Date(), dia = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    const nome = `CONTROLE DE FVS - ${(CFG.obraNome || 'obra').replace(/[\\/:*?"<>|]/g, ' ').trim()} - ${dia}${REL.tipo === 'ppc' ? ' - PPC' : ''}.xlsx`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(planilhaXlsx(REL)); a.download = nome;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    status(`Planilha baixada: ${nome} (${REL.linhas.length} linha(s)).`);
  }

  // ------------------------------ aba CONFIGURAÇÃO ------------------------------
  // Detecta as torres da obra pelos nomes das áreas (leitura genérica acima).
  const bonito = (b) => b.toLowerCase().replace(/(^|\s)(\S)/g, (m, s, c) => s + c.toUpperCase());
  function detectarTorres(areas, antigosL) {
    const nomesConhecidos = CFG.idObra === 2064 ? { 'BLOCO 01': '2Q', 'BLOCO 02': '3Q' } : {};
    const G = {};
    for (const a of areas) { const p = lerArea(a.nome); const g = G[p.bloco] = G[p.bloco] || { un: [], pav: [], outros: 0 }; if (p.tipo === 'un') g.un.push(p); else if (p.tipo === 'hall') g.pav.push(p.pav); else g.outros++; }
    const antigos = Object.fromEntries((antigosL || []).map((t) => [t.bloco, t]));
    const usados = new Set();
    const vertical = (b) => G[b].un.some((p) => p.andar > 0);
    return Object.keys(G).filter((b) => G[b].un.length >= 2).sort((a, b) => (vertical(b) - vertical(a)) || a.localeCompare(b, 'pt', { numeric: true })).map((b) => {
      const g = G[b]; const vert = g.un.some((p) => p.andar > 0);
      const floors = g.un.map((p) => p.andar).filter((x) => x > 0);
      const maxF = floors.length ? Math.max(...floors) : 0, maxP = g.pav.length ? Math.max(...g.pav) : maxF;
      const pos = vert ? Math.min(24, Math.max(...g.un.map((p) => p.pos))) : 0;
      const old = antigos[b] || {};
      let nome = old.nome || nomesConhecidos[b] || bonito(b); while (usados.has(nome)) nome += '*'; usados.add(nome);
      return { nome, bloco: b, hall: old.hall != null && old.bloco ? old.hall : (vert && maxP < maxF ? maxP - maxF : 0), pos: old.pos || pos, meio: old.meio != null ? old.meio : Math.ceil(pos / 2), tipo: vert ? 'torre' : 'casas',
        n: g.un.length, andares: floors.length ? [Math.min(...floors), maxF] : null, halls: g.pav.length, outras: g.outros };
    });
  }

  // ------------------------------ DIAGNÓSTICO DA OBRA ------------------------------
  // Só leitura. Lê a lista de áreas e de FVS da obra escolhida, monta o perfil (torres, andares, aptos por andar, halls)
  // e gera um texto sem dados pessoais para mandar ao Claude se algo não bater.
  let DIAG = null;
  function camposToken() { try { const p = JSON.parse(atob(String(token() || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return Object.keys(p); } catch (e) { return []; } }
  async function gerarDiagnostico(idObra, obraNome) {
    status('Diagnóstico: lendo as áreas da obra no SGQ (só leitura)...');
    const r = await api('POST', '/obras/area-checklists', { idObra, area: '', status: 2, page: 1, rowsPerPage: 5000 });
    if (r.st !== 200) throw new Error('Não consegui ler as áreas da obra (' + r.st + ').');
    const areas = ((r.j && r.j.items) || []).map((a) => ({ id: a.idObraAreaChecklist, nome: String(a.descricao || '').trim() }));
    status('Diagnóstico: lendo a lista de FVS da obra...');
    let fvs = []; try { const d = await api('POST', '/obras/servico/dropdown', { idObra }); fvs = ((d.j && d.j.itens) || []).map((x) => (/^\s*(FVS\s+\d{3}(?:\s*[A-Z]\d?)?)/i.exec(x.descricao || '') || [])[1]).filter(Boolean).map(codNorm); } catch (e) { if (/Sessão expirada/.test(e.message)) throw e; }
    const mesma = +idObra === +CFG.idObra; const antigos = mesma ? CFG.torres : [];
    const salvaIdObra = CFG.idObra; CFG.idObra = idObra; zerarLeitura();
    const torres = detectarTorres(areas, antigos);
    const tipos = { un: [], hall: [], outro: [] }; areas.forEach((a) => tipos[lerArea(a.nome).tipo].push(a.nome));
    const blocosT = new Set(torres.map((t) => t.bloco));
    const fora = areas.filter((a) => !blocosT.has(lerArea(a.nome).bloco)).map((a) => a.nome);
    const porAndar = {};
    torres.forEach((t) => { if (t.tipo !== 'torre') return; const L = {}; areas.forEach((a) => { const p = lerArea(a.nome); if (p.bloco === t.bloco && p.tipo === 'un') (L[p.andar] = L[p.andar] || []).push(p.pos); }); porAndar[t.bloco] = L; });
    const irregular = torres.filter((t) => t.tipo === 'torre' && Object.values(porAndar[t.bloco]).some((v) => v.length !== t.pos)).map((t) => t.bloco);
    const avisos = [];
    if (!torres.length) avisos.push('Não reconheci nenhuma torre ou conjunto de casas pelos nomes das áreas. Copie o diagnóstico e mande para o Claude.');
    if (irregular.length) avisos.push('Andares com quantidade diferente de unidades em: ' + irregular.join(', ') + ' (cobertura, garden ou numeração diferente). Confira o desenho abaixo.');
    torres.forEach((t) => { if (t.tipo === 'torre' && !t.halls) avisos.push(t.bloco + ': não achei halls/pavimentos com nome reconhecível.'); });
    if (fora.length > areas.length * 0.3) avisos.push(fora.length + ' de ' + areas.length + ' áreas ficaram fora do mapa. Se forem unidades, mande o diagnóstico para o Claude.');
    CFG.idObra = salvaIdObra; zerarLeitura();
    DIAG = { idObra, obraNome, quando: new Date().toISOString(), total: areas.length, torres, tipos, fora, fvs: [...new Set(fvs)].sort((a, b) => a.localeCompare(b, 'pt', { numeric: true })), porAndar, avisos, nomesAreas: areas.map((a) => a.nome) };
    status('Diagnóstico pronto: ' + torres.length + ' torre(s)/conjunto(s) reconhecido(s) em ' + areas.length + ' áreas.');
    return DIAG;
  }
  function textoDiagnostico(D) {
    const am = (L, n) => L.slice(0, n).map((x) => '    ' + x).join('\n') || '    (nenhuma)';
    const linhas = [
      'PRISMA · DIAGNÓSTICO DA OBRA · versão ' + VERSAO + ' · ' + new Date(D.quando).toLocaleString('pt-BR'),
      'Obra: ' + D.obraNome + ' (idObra ' + D.idObra + ')',
      'Áreas no SGQ: ' + D.total + ' · unidades: ' + D.tipos.un.length + ' · halls/pavimentos: ' + D.tipos.hall.length + ' · outras: ' + D.tipos.outro.length,
      'Regra especial do perfil: ' + (LS.get('perfil_' + D.idObra, {}).rxUn || LS.get('perfil_' + D.idObra, {}).rxPav ? 'sim' : 'não'),
      '', 'TORRES RECONHECIDAS:',
      ...D.torres.map((t) => `  - ${t.bloco} → "${t.nome}": ${t.n} unidades, ${t.tipo === 'torre' ? `andares ${t.andares[0]} a ${t.andares[1]}, até ${t.pos} por andar, hall entre a ${t.meio}ª e a ${t.meio + 1}ª, ${t.halls} halls (hall do andar N = ${t.hall ? 'pavimento N' + (t.hall > 0 ? '+' : '') + t.hall : 'pavimento N'})` : 'sem andares (casas/lotes)'}, outras áreas do bloco: ${t.outras}`),
      ...Object.entries(D.porAndar).map(([b, L]) => `  ${b} por andar: ` + Object.keys(L).map(Number).sort((a, c) => c - a).map((an) => `${an}:${L[an].sort((a, c) => a - c).join('/')}`).join('  ')),
      '', 'AVISOS:', ...(D.avisos.length ? D.avisos.map((a) => '  ! ' + a) : ['  (nenhum)']),
      '', 'EXEMPLOS DE NOMES · unidades:', am(D.tipos.un.filter((_, i) => i % Math.max(1, Math.floor(D.tipos.un.length / 8)) === 0), 8),
      'EXEMPLOS DE NOMES · halls/pavimentos:', am(D.tipos.hall.filter((_, i) => i % Math.max(1, Math.floor(D.tipos.hall.length / 6)) === 0), 6),
      'ÁREAS FORA DO MAPA (' + D.fora.length + '):', am(D.fora, 60),
      '', 'FVS DA OBRA (' + D.fvs.length + '): ' + D.fvs.join(', '),
      'Funcionários achados nesta obra: ' + (() => { const cc = (LS.get('obras', []).find((o) => +o.id === +D.idObra) || {}).cc; let L = []; try { L = JSON.parse(localStorage.getItem('funcionarios-dropdown') || '[]'); } catch (e) {} return Math.max(LS.get('funcs_' + D.idObra, []).length, cc ? L.filter((f) => +f.idCentroCusto === +cc).length : 0); })(),
      'Campos do login (só os nomes, sem valores): ' + (camposToken().join(', ') || '-'),
    ];
    return linhas.join('\n');
  }
  function miniMapa(D, t) {
    if (t.tipo !== 'torre') return `<div class="muted">${t.n} casas/lotes, mostradas em fileiras de 10 no mapa.</div>`;
    const L = D.porAndar[t.bloco] || {}; const ands = Object.keys(L).map(Number).filter((a) => a > 0).sort((a, b) => b - a);
    const P = +t.pos || 8, M = Math.min(P, +t.meio || 0);
    const vis = ands.length > 6 ? [...ands.slice(0, 3), null, ...ands.slice(-2)] : ands;
    const cel = (an, p) => `<span style="padding:2px 0;text-align:center;border-radius:4px;font:600 10px system-ui;${(L[an] || []).includes(p) ? 'background:var(--roxoSoft);color:var(--ink)' : 'color:var(--muted)'}">${(L[an] || []).includes(p) ? an * 100 + p : '·'}</span>`;
    return `<div style="display:grid;grid-template-columns:26px repeat(${M},minmax(0,1fr)) ${M < P ? 'minmax(0,.8fr)' : ''} repeat(${P - M},minmax(0,1fr));gap:2px;max-width:520px">
      ${vis.map((an) => an === null ? `<span class="muted" style="grid-column:1/-1;text-align:center">⋮</span>` : `<b style="font-size:10px">${an}</b>${Array.from({ length: M }, (_, k) => cel(an, k + 1)).join('')}${M < P ? `<span style="text-align:center;font:700 9px system-ui;color:var(--muted)">HALL</span>` : ''}${Array.from({ length: P - M }, (_, k) => cel(an, M + k + 1)).join('')}`).join('')}</div>`;
  }
  function perfilHtml() {
    if (!DIAG) return '';
    const D = DIAG;
    return `<div class="card topo" style="max-width:900px;margin-top:14px" id="k-perfil"><h4>Perfil da obra · ${esc(D.obraNome)}</h4>
      <div class="nota">É assim que o Prisma entendeu as torres desta obra pelos nomes das áreas do SGQ. Confira o desenho, ajuste o que precisar e salve. O script não muda: o perfil fica salvo neste navegador, separado por obra.</div>
      ${D.avisos.map((a) => `<div class="warn">${esc(a)}</div>`).join('')}
      ${D.torres.map((t, i) => `<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px;display:grid;gap:8px">
        <div class="row"><b>${esc(t.bloco)}</b><span class="muted">${t.n} unidades${t.andares ? ` · andares ${t.andares[0]} a ${t.andares[1]}` : ''} · ${t.halls} halls · ${t.outras} outras áreas</span></div>
        <div class="row">
          <label style="max-width:170px">Apelido no Prisma<input data-pf="nome" data-i="${i}" value="${esc(t.nome)}"></label>
          ${t.tipo === 'torre' ? `<label style="max-width:150px">Unidades por andar<input type="number" min="1" max="24" data-pf="pos" data-i="${i}" value="${esc(t.pos)}"></label>
          <label style="max-width:190px">Hall depois da unidade nº<input type="number" min="0" max="24" data-pf="meio" data-i="${i}" value="${esc(t.meio)}"></label>
          <label style="max-width:220px">Hall do andar N é o pavimento<select data-pf="hall" data-i="${i}">${[-2, -1, 0, 1].map((o) => `<option value="${o}" ${+t.hall === o ? 'selected' : ''}>N${o > 0 ? '+' + o : o < 0 ? o : ''}</option>`).join('')}</select></label>` : ''}
        </div><div id="k-mm-${i}">${miniMapa(D, t)}</div></div>`).join('')}
      <details style="margin-top:10px"><summary>${D.fora.length} área(s) fora do mapa</summary><div class="muted" style="max-height:140px;overflow:auto">${D.fora.slice(0, 300).map(esc).join('<br>') || 'nenhuma'}</div></details>
      <div class="row" style="margin-top:10px">${D.torres.length ? `<button class="b p" id="k-pf-ok">Salvar perfil${S.pfPrimeira ? ' e continuar' : ''}</button>` : ''}<button class="b" id="k-pf-cp">Copiar diagnóstico para mandar ao Claude</button></div>
      <details style="margin-top:6px"><summary>Colar perfil enviado pelo Claude</summary>
        <textarea id="k-pf-in" placeholder='{"rxUn": "...", "torres": [...]}' style="min-height:70px;margin-top:6px"></textarea>
        <div class="row"><button class="b" id="k-pf-ap">Aplicar perfil</button><span class="muted">Só para obras com nomes de áreas fora do comum.</span></div></details>
      <textarea id="k-pf-txt" readonly style="position:absolute;left:-9999px">${esc(textoDiagnostico(D))}</textarea></div>`;
  }
  function ligarPerfil(salvarCfgDe) {
    if (!DIAG || !$('#k-perfil')) return;
    document.querySelectorAll('#k-perfil [data-pf]').forEach((e) => e.oninput = e.onchange = () => { const t = DIAG.torres[+e.dataset.i]; const k = e.dataset.pf; if (k === 'nome') { if (e.value.trim()) t.nome = e.value.trim(); return; } if (e.value === '') return; t[k] = +e.value; const mm = $('#k-mm-' + e.dataset.i); if (mm) mm.innerHTML = miniMapa(DIAG, t); });
    $('#k-pf-cp').onclick = async () => { const txt = textoDiagnostico(DIAG); try { await navigator.clipboard.writeText(txt); } catch (e) { const t = $('#k-pf-txt'); t.select(); document.execCommand('copy'); } status('Diagnóstico copiado. Cole na conversa com o Claude.'); };
    $('#k-pf-ap').onclick = async () => {
      let p; try { p = JSON.parse($('#k-pf-in').value.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch (e) { return status('Esse texto não é um perfil válido. Copie de novo a mensagem do Claude, do { até o }.'); }
      for (const k of ['rxUn', 'rxPav']) if (p[k]) { try { new RegExp(p[k]); } catch (e) { return status('Regra ' + k + ' inválida no perfil.'); } }
      LS.set('perfil_' + DIAG.idObra, { rxUn: p.rxUn || '', rxPav: p.rxPav || '' });
      try {
        const D2 = await gerarDiagnostico(DIAG.idObra, DIAG.obraNome);
        (p.torres || []).forEach((o) => { const t = D2.torres.find((x) => x.bloco === o.bloco); if (t) ['nome', 'pos', 'meio', 'hall'].forEach((k) => { if (o[k] != null) t[k] = o[k]; }); });
        status('Perfil aplicado. Confira o desenho e clique em Salvar perfil.'); renderCfg();
      } catch (e) { status('Erro: ' + e.message); }
    };
    const ok = $('#k-pf-ok'); if (ok) ok.onclick = () => salvarCfgDe(DIAG);
  }
  // Salva as torres do perfil. Se o apelido mudar, leva junto o que estava guardado com o nome antigo.
  function salvarPerfil(D) {
    const nomes = D.torres.map((t) => t.nome); if (new Set(nomes).size !== nomes.length) { status('Dois apelidos iguais. Use nomes diferentes para cada torre.'); return false; }
    const novos = D.torres.map((t) => ({ nome: t.nome, bloco: t.bloco, hall: +t.hall || 0, pos: +t.pos || 0, meio: +t.meio || 0, tipo: t.tipo }));
    if (+D.idObra === +CFG.idObra) {
      const ren = {}; (CFG.torres || []).forEach((o) => { const n = novos.find((x) => x.bloco === o.bloco); if (n && n.nome !== o.nome) ren[o.nome] = n.nome; });
      if (Object.keys(ren).length) {
        Object.entries(ren).forEach(([a, b]) => { if (MAPA.ts[a]) { MAPA.ts[b] = MAPA.ts[a]; delete MAPA.ts[a]; } if (S.torre === a) S.torre = b; });
        Object.values(GAB_USER).forEach((g) => { if (g.na && !Array.isArray(g.na)) Object.entries(ren).forEach(([a, b]) => { if (g.na[a]) { g.na[b] = g.na[a]; delete g.na[a]; } }); });
        salvarMapa(); LS.set(K('gab'), GAB_USER);
      }
    }
    CFG.torres = novos; zerarLeitura();
    LS.set('cfg', Object.assign({}, LS.get('cfg', {}), { torres: novos, perfilEm: new Date().toISOString() }));
    if (!CFG.torres.find((t) => t.nome === S.torre)) S.torre = (CFG.torres[0] || {}).nome || '';
    return true;
  }

  // Lista de funcionários: 1) cache do próprio SGQ, 2) rotas de lista do SGQ, 3) nomes de quem já inspecionou/aprovou fichas na obra.
  async function carregarFuncionarios(obra) {
    const achados = new Map();
    const add = (id, nome, cc) => { id = +id; nome = String(nome || '').replace(/\s+/g, ' ').trim(); if (id && nome && !achados.has(id)) achados.set(id, { idFuncionario: id, nome, idCentroCusto: cc || obra.cc || 0 }); };
    for (const [m, path, body] of [['POST', '/commons/funcionarios/dropdown', { idCentroCusto: obra.cc, filtrarCentroCusto: true }], ['POST', '/commons/funcionarios/dropdown', {}], ['GET', '/commons/funcionarios/dropdown'], ['POST', '/commons/funcionario/dropdown', { idCentroCusto: obra.cc }]]) {
      try { const r = await api(m, path, body); const L = r.st === 200 && r.j && (r.j.itens || r.j.items || (Array.isArray(r.j) ? r.j : null)); if (L && L.length && L[0].idFuncionario) { L.forEach((f) => add(f.idFuncionario, f.nome, f.idCentroCusto)); break; } } catch (e) { if (/Sessão expirada/.test(e.message)) throw e; }
    }
    if (achados.size < 2) {
      const ar = await api('POST', '/obras/area-checklists', { idObra: obra.id, area: '', status: 2, page: 1, rowsPerPage: 3000 });
      const areas = ((ar.j && ar.j.items) || []).filter((a) => lerArea(a.descricao).tipo === 'un');
      const passo = Math.max(1, Math.floor(areas.length / 20));
      let lidas = 0;
      for (let i = 0; i < areas.length && lidas < 45; i += passo) {
        status(`Procurando nomes nas fichas da obra... (${achados.size} encontrados)`);
        const sv = await api('POST', '/obras/obra-checklist-servicos', { idObra: obra.id, idObraAreaChecklist: areas[i].idObraAreaChecklist, statusChecklist: 2, statusVerificacao: 3, page: 1, rowsPerPage: 300 });
        const fvs = ((sv.j && sv.j.items) || []).filter((x) => x.total > 0).slice(0, 3);
        for (const f of fvs) {
          const v = await listarVerif(f.idObraChecklistServico); if (!v.length) continue;
          const d = ((await api('GET', '/obras/inspecoes-obra/' + v[v.length - 1].idInspecaoObra)).j || {}).item || {};
          add(d.idFuncionarioInspecionado, d.funcionarioInspecionado); add(d.idFuncionarioAprovado, d.funcionarioAprovado); lidas++;
        }
      }
    }
    // o próprio login às vezes traz o funcionário (útil para quem ainda nunca preencheu ficha)
    try { const p = JSON.parse(atob(String(token() || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); const g = (re) => { const k = Object.keys(p).find((x) => re.test(x)); return k ? p[k] : null; };
      const id = g(/^id_?funcionario$/i), nome = g(/^(nome_?funcionario|nome|name|unique_name)$/i); if (id && nome && !/@/.test(nome)) add(id, nome); } catch (e) {}
    const L = [...achados.values()];
    LS.set('funcs_' + obra.id, L);
    return L;
  }

  function renderCfg() {
    const body = $('#bf2-body');
    let funcs = []; try { funcs = JSON.parse(localStorage.getItem('funcionarios-dropdown') || '[]'); } catch (e) {}
    // sem obra escolhida ainda, vale a que aparece na lista (antes o "Gerar diagnóstico" ficava travado mesmo com a obra na tela)
    const obraAtualId = +(S.cfgObra || CFG.idObra || (LS.get('obras', [])[0] || {}).id) || 0;
    const ids = new Set(funcs.map((f) => +f.idFuncionario)); LS.get('funcs_' + obraAtualId, []).forEach((f) => { if (!ids.has(+f.idFuncionario)) funcs.push(f); });
    funcs = funcs.map((f) => ({ id: +f.idFuncionario, cc: +f.idCentroCusto || 0, nome: (f.nome || '').replace(/\s+/g, ' ').trim() })).filter((f) => f.nome).sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
    const OBRAS = LS.get('obras', []);
    const obraSel = OBRAS.find((o) => +o.id === +(S.cfgObra || CFG.idObra)) || {};
    const daObra = obraSel.cc ? funcs.filter((f) => f.cc === obraSel.cc) : [];
    const todos = S.cfgTodos || !daObra.length;
    const listaF = todos ? funcs : daObra;
    const sel = (id, atual) => { const q = semAc(S['cfgQ' + id] || '').trim(); const L = listaF.filter((f) => !q || semAc(f.nome).includes(q) || f.id === +atual);
      return `<select id="${id}"><option value="">Escolha o nome…</option>${L.map((f) => `<option value="${f.id}" ${f.id === +atual ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select>`; };
    body.innerHTML = `<div class="card topo" style="max-width:720px"><h4>Configuração</h4>
      ${configurado() ? '' : `<div class="warn"><b>Bem-vindo ao Prisma.</b> Antes de usar, escolha a sua obra e os nomes de quem inspeciona e de quem aprova. É uma vez só; depois o Prisma lembra.</div>`}
      <div class="nota">Fica salva neste navegador. O Prisma usa o seu login do SGQ: não guarda senha. As torres e os andares são descobertos sozinhos a partir do SGQ.</div>
      <label class="chk"><input type="checkbox" id="k-escuro" ${CFG.escuro ? 'checked' : ''}> Modo escuro</label>
      <label>Obra<select id="k-obra">${(OBRAS.length ? OBRAS : CFG.idObra ? [{ id: CFG.idObra, nome: CFG.obraNome }] : [{ id: '', nome: 'Clique em "Buscar as obras do meu login"' }]).map((o) => `<option value="${o.id}" ${+o.id === +CFG.idObra ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select></label>
      <div class="row"><button class="b" id="k-det">Buscar as obras do meu login</button><span id="k-obras" class="muted"></span></div>
      <div class="row"><button class="b n" id="k-diag" ${obraAtualId ? '' : 'disabled'}>Gerar diagnóstico da obra</button><span class="muted">Só leitura. Mostra como o Prisma entendeu as torres desta obra.</span></div>
      ${funcs.length ? `<div class="muted">${todos ? `Mostrando todos os ${funcs.length} funcionários do SGQ.` : `Mostrando os ${daObra.length} funcionários desta obra.`} ${daObra.length ? `<a href="#" id="k-todos" style="color:var(--roxo)">${todos ? 'Mostrar só os desta obra' : 'Mostrar todos'}</a>` : ''}</div>
      <label>Inspecionado por (você)<input id="q-k-insp" type="search" placeholder="filtrar: joão pedro…" value="${esc(S['cfgQk-insp'] || '')}">${sel('k-insp', S.cfgInsp || CFG.idInspecionado)}</label>
      <label>Aprovado por<input id="q-k-apr" type="search" placeholder="filtrar: jhonatan…" value="${esc(S['cfgQk-apr'] || '')}">${sel('k-apr', S.cfgApr || CFG.idAprovado)}</label>` : ''}
      ${funcs.length ? `<div class="row"><button class="b" id="k-func">Atualizar lista de funcionários</button></div>` : (obraAtualId ? `<div class="warn">Buscando a lista de funcionários da obra... <button class="b" id="k-func">Buscar de novo</button></div>` : '<div class="muted">Escolha a obra para aparecer a lista de funcionários.</div>')}
      <label>Assumir fichas de (um nome por linha: ex-funcionários ou colegas que autorizaram; o Prisma só assume quando você marca a opção no Mapa). <b>Salva sozinho enquanto você digita.</b><textarea id="k-ex" style="min-height:70px">${esc(CFG.exFuncionarios.join('\n'))}</textarea></label>
      ${funcs.length ? `<div class="row"><input id="k-ex-add" list="k-ex-dl" placeholder="ou digite parte do nome e escolha da lista…" style="max-width:380px"><datalist id="k-ex-dl">${funcs.map((f) => `<option value="${esc(f.nome)}">`).join('')}</datalist><button class="b" id="k-ex-ok">Adicionar à lista</button></div>` : ''}
      <div id="k-ex-conf" class="muted">${conferirEx(CFG.exFuncionarios, funcs)}</div>
      <label>Tratativa padrão (usada na 2ª inspeção quando você não escreve uma)<input id="k-trat" value="${esc(CFG.tratativaPadrao)}"></label>
      <details><summary>Avançado</summary><label style="margin-top:8px;max-width:240px">Pausa entre consultas ao SGQ (ms)<input id="k-pausa" type="number" min="200" value="${esc(CFG.pausaMs)}"></label>
        <label style="margin-top:8px;max-width:340px">Consultas ao mesmo tempo ao ler mapa e relatórios (1 a 6; gravar é sempre uma por vez)<input id="k-par" type="number" min="1" max="6" value="${esc(CFG.leiturasJuntas || 3)}"></label></details>
      <div class="row"><button class="b p" id="k-salva">Salvar configuração</button><button class="b" id="k-reset">Voltar ao padrão</button></div></div>${perfilHtml()}`;
    // "Salvar perfil" com a configuração ainda não salva para esta obra (ex.: gerou o diagnóstico antes de salvar):
    // salva a configuração sozinho com o que está na tela e segue, em vez de mandar a pessoa voltar lá em cima.
    ligarPerfil(async (D) => {
      let agora = false;
      if (+D.idObra !== +CFG.idObra || !configurado()) {
        status('Salvando a configuração com esta obra...');
        if (!(await salvarConfig(D))) { const b = $('#bf2-body'); if (b) b.scrollTop = 0; return; }
        agora = true;
        if (+D.idObra !== +CFG.idObra) { DIAG = null; render(); return status('A obra escolhida em "Obra" é outra que a do desenho. Configuração salva; gere o diagnóstico de novo para conferir as torres.'); }
      }
      if (!salvarPerfil(D)) return;
      if (S.pfPrimeira || agora) { S.pfPrimeira = false; DIAG = null; status('Perfil salvo. Abrindo o mapa...'); S.aba = 'mapa'; abrir(); }
      else { status('Perfil salvo: ' + CFG.torres.map((t) => t.nome).join(', ') + '.'); DIAG = null; render(); }
    });
    $('#k-diag').onclick = async () => { const s = $('#k-obra'); const id = +s.value; if (!id) return; guardar(); try { await gerarDiagnostico(id, s.options[s.selectedIndex].text); renderCfg(); const pf = $('#k-perfil'); if (pf) pf.scrollIntoView({ behavior: 'smooth' }); } catch (e) { status('Erro: ' + e.message); } };
    const guardar = () => { const a = $('#k-insp'), b = $('#k-apr'); if (a && a.value) S.cfgInsp = +a.value; if (b && b.value) S.cfgApr = +b.value; };
    ['k-insp', 'k-apr'].forEach((id) => { const q = $('#q-' + id); if (q) q.oninput = (e) => { guardar(); S['cfgQ' + id] = e.target.value; renderCfg(); const i = $('#q-' + id); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
      const s = $('#' + id); if (s) s.onchange = guardar; });
    const kt = $('#k-todos'); if (kt) kt.onclick = (e) => { e.preventDefault(); guardar(); S.cfgTodos = !todos; renderCfg(); };
    $('#k-obra').onchange = (e) => { guardar(); S.cfgObra = +e.target.value; S.cfgTodos = false; renderCfg(); };
    const bf = $('#k-func');
    if (bf) bf.onclick = async () => { const ob = OBRAS.find((o) => +o.id === obraAtualId) || { id: obraAtualId }; bf.disabled = true; try { const L = await carregarFuncionarios(ob); status(L.length ? L.length + ' funcionário(s) encontrado(s).' : 'Não encontrei nomes nas fichas dessa obra.'); S.funcTentou = obraAtualId; } catch (e) { status('Erro: ' + e.message); } renderCfg(); };
    if (!funcs.length && obraAtualId && S.funcTentou !== obraAtualId && token()) { S.funcTentou = obraAtualId; setTimeout(() => { const b = $('#k-func'); if (b) b.click(); }, 60); }
    $('#k-escuro').onchange = (e) => { CFG.escuro = e.target.checked; LS.set('cfg', Object.assign({}, LS.get('cfg', {}), { escuro: CFG.escuro })); render(); };
    // "Assumir fichas de" e a tratativa salvam na hora: antes, colar um nome e sair (ou a tela se redesenhar) perdia o que não tinha sido salvo.
    const salvaCampo = (k, v) => { CFG[k] = v; LS.set('cfg', Object.assign({}, LS.get('cfg', {}), { [k]: v })); };
    const lerEx = (t) => [...new Set(String(t).split(/\r?\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))];
    let tEx = null;
    const salvaEx = () => { salvaCampo('exFuncionarios', lerEx($('#k-ex').value)); clearTimeout(tEx); tEx = setTimeout(() => { const c = $('#k-ex-conf'); if (c) c.innerHTML = conferirEx(CFG.exFuncionarios, funcs); status('Lista "Assumir fichas de" salva (' + CFG.exFuncionarios.length + ' nome(s)).'); }, 400); };
    $('#k-ex').oninput = salvaEx;
    const exAdd = () => { const i = $('#k-ex-add'); const v = (i && i.value || '').trim(); if (!v) return; const ta = $('#k-ex'); ta.value = lerEx(ta.value + '\n' + v).join('\n'); i.value = ''; salvaEx(); };
    const bxa = $('#k-ex-ok'); if (bxa) bxa.onclick = exAdd;
    const ixa = $('#k-ex-add'); if (ixa) ixa.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); exAdd(); } };
    $('#k-trat').onchange = (e) => { salvaCampo('tratativaPadrao', e.target.value.trim() || PADRAO.tratativaPadrao); status('Tratativa padrão salva.'); };
    if (!configurado() && !OBRAS.length && token()) setTimeout(() => { const b = $('#k-det'); if (b) b.click(); }, 50);
    $('#k-det').onclick = async () => {
      $('#k-obras').textContent = 'Buscando...';
      const r = await api('POST', '/obras', { tipoPesquisa: 1, valueField: null, statusDocumentos: 0, resistenciaCompressao: 0, statusEquipamentos: 0, statusObras: 0, page: 1, rowsPerPage: 100 });
      const L = ((r.j && r.j.items) || []).map((o) => ({ id: o.idObra, nome: o.centroCusto, cc: o.idCentroCusto }));
      if (!L.length) { $('#k-obras').textContent = 'Nenhuma obra encontrada para este login.'; return; }
      LS.set('obras', L); if (!S.cfgObra) S.cfgObra = L[0].id; renderCfg(); status(L.length + ' obra(s) encontrada(s).');
    };
    // D = diagnóstico já conferido na tela (vindo do "Salvar perfil"): usa ele em vez de ler a obra de novo. Retorna true se salvou.
    const salvarConfig = async (D) => {
      const pega = (id) => { const e = $('#' + id); const v = e ? +e.value : 0; return funcs.find((f) => f.id === v) || null; };
      const fi = pega('k-insp') || (CFG.idInspecionado && !funcs.length ? { id: CFG.idInspecionado, nome: CFG.nomeInspecionado } : null);
      const fa = pega('k-apr') || (CFG.idAprovado && !funcs.length ? { id: CFG.idAprovado, nome: CFG.nomeAprovado } : null);
      if (funcs.length && (!fi || !fa) && false) return status('Não achei ' + (!fi ? '"' + $('#k-insp').value + '"' : '"' + $('#k-apr').value + '"') + ' na lista de funcionários. Escolha um nome da lista.');
      const sel = $('#k-obra'); const idObra = +sel.value; const obraNome = sel.options[sel.selectedIndex].text;
      const novo = Object.assign({}, LS.get('cfg', {}), {
        obraNome, idObra,
        idInspecionado: fi ? fi.id : CFG.idInspecionado, nomeInspecionado: fi ? fi.nome : CFG.nomeInspecionado,
        idAprovado: fa ? fa.id : CFG.idAprovado, nomeAprovado: fa ? fa.nome : CFG.nomeAprovado,
        exFuncionarios: $('#k-ex').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        tratativaPadrao: $('#k-trat').value.trim() || PADRAO.tratativaPadrao,
        pausaMs: Math.max(200, +$('#k-pausa').value || 400),
        leiturasJuntas: Math.min(6, Math.max(1, Math.round(+$('#k-par').value) || 3)),
        escuro: $('#k-escuro').checked,
      });
      if (!idObra) return status('Escolha a obra (clique em "Buscar as obras do meu login").');
      if (!fi || !fa) return status('Escolha o nome de quem inspeciona e de quem aprova na lista.');
      const mudouObra = idObra !== CFG.idObra || !(CFG.torres && CFG.torres.length);
      CFG = Object.assign({}, PADRAO, novo);
      if (mudouObra) {
        AREAS = null; NOMES = LS.get(K('nomes'), {}); MAPA = LS.get(K('mapa'), { ts: {}, areas: {} }); GAB_USER = LS.get(K('gab'), {}); FILA = LS.get(K('fila'), []); PLANOS = LS.get(K('planos'), {}); HIST = LS.get(K('hist'), []);
        CFG.torres = []; zerarLeitura();
        try { const Dg = D && +D.idObra === idObra ? D : await gerarDiagnostico(idObra, obraNome); CFG.torres = Dg.torres.map((t) => ({ nome: t.nome, bloco: t.bloco, hall: t.hall, pos: t.pos, meio: t.meio, tipo: t.tipo })); novo.torres = CFG.torres; } catch (e) { status('Erro ao ler a obra: ' + e.message); }
        S.torre = (CFG.torres[0] || {}).nome || '';
        LS.set('cfg', novo);
        if (D) return CFG.torres.length > 0;
        S.pfPrimeira = true;
        if (!CFG.torres.length) { render(); return status('Não reconheci as torres pelos nomes das áreas. Clique em "Copiar diagnóstico" e mande para o Claude.'); }
        render(); const pf = $('#k-perfil'); if (pf) pf.scrollIntoView({ behavior: 'smooth' });
        return status('Configuração salva. Agora confira o perfil da obra (logo abaixo) e clique em "Salvar perfil e continuar".');
      }
      LS.set('cfg', novo);
      if (D) return true;
      status(configurado() ? 'Configuração salva. Torres encontradas: ' + CFG.torres.map((t) => t.nome).join(', ') + '.' : 'Configuração salva.'); if (configurado() && mudouObra) { S.aba = 'mapa'; abrir(); } else render();
      return true;
    };
    $('#k-salva').onclick = () => salvarConfig();
    $('#k-reset').onclick = () => { if (confirm('Voltar a configuração ao padrão do script?')) { LS.set('cfg', {}); CFG = Object.assign({}, PADRAO); render(); } };
  }

  // Ao carregar a página: se o SGQ apagou os dados do Prisma (logout), volta tudo da cópia e relê o estado.
  function recarregarEstado() {
    CFG = Object.assign({}, PADRAO, LS.get('cfg', {})); zerarLeitura(); AREAS = null;
    NOMES = LS.get(K('nomes'), {}); MAPA = LS.get(K('mapa'), { ts: {}, areas: {} }); GAB_USER = LS.get(K('gab'), {});
    FILA = LS.get(K('fila'), []); HIST = LS.get(K('hist'), []); PLANOS = LS.get(K('planos'), {}); RESULT = LS.get(K('result'), []);
    Object.assign(S, LS.get(K('tela'), {})); if (!CFG.torres.find((t) => t.nome === S.torre)) S.torre = (CFG.torres[0] || {}).nome || '';
  }
  const INICIO = sincronizarCopia().then((n) => { if (n) { recarregarEstado(); status(`O SGQ tinha apagado os dados do Prisma ao sair; recuperei ${n} item(ns) da cópia de segurança.`); } return n; });
  // Com a página aberta, o SGQ pode apagar de novo (sessão caiu): confere de tempos em tempos e quando a aba volta a ficar visível.
  const vigiar = () => { if (!LENDO && !RODANDO) sincronizarCopia().then((n) => { if (n) status(`O SGQ apagou os dados do Prisma; recuperei ${n} item(ns) da cópia de segurança.`); }); };
  setInterval(vigiar, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') vigiar(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
  setInterval(() => { if (document.body && !document.getElementById('bf2-btn')) { root = null; montar(); } }, 2000); // se a tela do SGQ recriar a página, o botão volta
})();
