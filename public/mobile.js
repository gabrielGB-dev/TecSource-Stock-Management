/* ============================================================
   TecSource · Interface mobile (PWA)
   Consome a mesma API do painel desktop.
   Regra de interface: uma ação principal por tela, textos curtos
   e ajuda contextual em cada função.
   ============================================================ */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const val = s => ($(s)?.value ?? '').trim();
const fmt = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/* Converte entrada do usuário ("3,5" / "1.234,56") → número. Inválido → NaN */
const numero = s => {
    const t = String(s).trim();
    if (!t) return NaN;
    if (t.includes(',') && t.includes('.'))
        return Number(t.lastIndexOf(',') > t.lastIndexOf('.')
            ? t.replace(/\./g, '').replace(',', '.')
            : t.replace(/,/g, ''));
    return Number(t.replace(',', '.'));
};

/* Escapa textos vindos do banco antes de injetar no HTML (evita XSS) */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TITULOS = {
    painel: 'Estoque',
    qr: 'Ler QR',
    cadastro: 'Novo tecido',
    historico: 'Histórico'
};
const SIT_LABEL = { ok: 'OK', baixo: 'BAIXO', critico: 'CRÍTICO' };

const state = {
    tab: null,
    busca: '',
    situacao: '',
    ordem: 'nome',
    dir: 'asc',
    movTipo: ''
};

/* Toda chamada passa por window.apiUrl (config.js): assim o frontend
   publicado no GitHub Pages fala com a API no Render sem tocar no resto. */
const urlApi = url => (window.apiUrl ? window.apiUrl(url) : url);

async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(urlApi(url), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    let j;
    try {
        j = await res.json();
    } catch {
        throw new Error(`Resposta inválida do servidor (HTTP ${res.status}).`);
    }
    if (!j.ok) throw new Error(j.erro || 'Erro no servidor.');
    return j.data;
}

function toast(msg, ms = 3500) {
    if (msg.startsWith('❌')) ms = Math.max(ms, 5000);
    const t = $('#toast');
    t.textContent = msg;
    t.className = msg.startsWith('❌') ? 'erro' : msg.startsWith('✅') ? 'ok' : '';
    t.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.remove('show'), ms);
}

/* Executa a ação bloqueando o botão até terminar (evita duplo toque) */
async function semDuplicar(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); }
    finally { btn.disabled = false; }
}

/* ===== Fila offline + helpers de apoio ===== */

async function enviarComFila(url, body, rotulo) {
    if (window.TecFila) return window.TecFila.enviar(url, body, { rotulo });
    return api(url, { method: 'POST', body });
}

/* Devolve true quando o lançamento foi guardado ou já existia. */
function avisoDeEnvio(r, mensagemOk) {
    if (r && r.pendente) {
        toast('📥 Sem conexão: lançamento guardado e será enviado sozinho.');
        return true;
    }
    if (r && r.repetido) {
        toast('✅ Este lançamento já estava registrado — nada foi debitado de novo.');
        return true;
    }
    if (mensagemOk) toast(mensagemOk);
    return false;
}

/* Sugestões por nome/código/localização embaixo do campo de QR. */
function ligarSugestoes(inputSel, boxSel, aoEscolher) {
    const input = $(inputSel);
    const box = $(boxSel);
    if (!input || !box) return;

    let timer = null;
    const fechar = () => {
        box.classList.add('hidden');
        box.innerHTML = '';
    };

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const termo = input.value.trim();
        if (termo.length < 2 || /^(TEC:|ROL-)/i.test(termo)) return fechar();

        timer = setTimeout(async () => {
            try {
                const itens = await api('/api/tecidos?busca=' + encodeURIComponent(termo));
                if (!itens.length) return fechar();
                box.innerHTML = itens.slice(0, 6).map(t => `
                  <button type="button" class="sugestao" data-codigo="${esc(t.codigo)}">
                    <span class="sug-nome">${esc(t.nome)}</span>
                    <span class="sug-meta">${esc(t.codigo)}${t.localizacao ? ' · 📍 ' + esc(t.localizacao) : ''} · ${fmt(t.saldo_m)} m</span>
                  </button>`).join('');
                box.classList.remove('hidden');
            } catch { fechar(); }
        }, 250);
    });

    box.addEventListener('click', e => {
        const b = e.target.closest('.sugestao');
        if (!b) return;
        e.preventDefault();
        input.value = 'TEC:' + b.dataset.codigo;
        fechar();
        aoEscolher();
    });

    input.addEventListener('keydown', e => { if (e.key === 'Escape') fechar(); });
    input.addEventListener('blur', () => setTimeout(fechar, 200));
}

/* Edita a localização física do tecido a partir da ficha. */
async function editarLocalizacao(tec) {
    if (!tec) return;
    const nova = prompt(
        'Localização física do tecido (ex.: Corredor A · Prateleira 2):',
        tec.localizacao || ''
    );
    if (nova === null) return;
    try {
        const r = await api('/api/tecidos/' + tec.id, {
            method: 'PATCH',
            body: { localizacao: nova }
        });
        toast('✅ Localização atualizada.');
        if (fichaAtual) {
            fichaAtual.tecido = { ...fichaAtual.tecido, ...r };
            renderFicha(fichaAtual);
        }
        loadDashboard();
    } catch (e) { toast('❌ ' + e.message); }
}

/* Estorna uma movimentação: devolve o saldo e mantém a trilha de auditoria. */
async function estornarMovimentacao(m) {
    if (!m) return;
    const nome = m.rolos?.tecidos?.nome || 'tecido';
    if (!confirm(
        `Desfazer este lançamento de ${fmt(m.metros)} m em ${nome}?\n\n` +
        'O saldo do rolo será devolvido e o lançamento ficará marcado como cancelado ' +
        '(nada é apagado do histórico).'
    )) return;

    const motivo = prompt('Motivo do estorno (opcional):', '');
    if (motivo === null) return;

    try {
        const r = await api(`/api/movimentacoes/${m.id}/estorno`, {
            method: 'POST',
            body: {
                usuario: localStorage.getItem(OP_KEY) || '—',
                motivo: motivo.trim() || `Estorno do lançamento #${m.id}`
            }
        });
        toast(`↩ Estorno registrado. Saldo do rolo: ${fmt(r.metragem_atual)} m.`);
        loadHistorico();
        loadDashboard();
    } catch (e) { toast('❌ ' + e.message); }
}

function setConn(on) {
    $('#connDot').classList.toggle('err', !on);
    $('#connDot').title = on ? 'Conectado ao servidor' : 'Sem conexão com o servidor';
    $('#sheetConn').textContent = on ? 'conectado' : 'sem conexão';
}

/* ===== Operador ===== */
const OP_KEY = 'tecsource_operador';
const DICA_KEY = 'tecsource_dica_v1_4';

function iniciais(nome) {
    const p = String(nome).trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

function setOperador(n) {
    $('#operadorNome').textContent = n;
    $('#avatarIniciais').textContent = iniciais(n);
    ['usuarioQr', 'usuarioTecido', 'usuarioEstoque'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = n;
    });
}

function entrar() {
    const n = val('#loginNome');
    if (!n) { toast('Informe seu nome para entrar.'); return; }
    localStorage.setItem(OP_KEY, n);
    $('#loginOverlay').classList.add('hidden');
    setOperador(n);
    toast('Bem-vindo(a), ' + n);
    loadDashboard();
}

$('#btnEntrar').addEventListener('click', entrar);
$('#loginNome').addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });

$('#btnSair').addEventListener('click', () => {
    localStorage.removeItem(OP_KEY);
    location.reload();
});

/* ===== Ajuda ===== */
const helpOverlay = $('#helpOverlay');
const dicaPop = $('#dicaPop');

function abrirAjuda() {
    helpOverlay.classList.remove('hidden');
}
function fecharAjuda() {
    helpOverlay.classList.add('hidden');
}
$('#btnAjuda').addEventListener('click', abrirAjuda);
$('#btnFecharAjuda').addEventListener('click', fecharAjuda);
helpOverlay.addEventListener('click', e => {
    if (e.target === helpOverlay) fecharAjuda();
});

function esconderDica() {
    dicaPop.classList.add('hidden');
}

function mostrarDica(el) {
    const texto = el.dataset.tip;
    if (!texto) return;
    dicaPop.textContent = texto;
    dicaPop.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    const largura = dicaPop.offsetWidth;
    const altura = dicaPop.offsetHeight;
    let left = r.left + r.width / 2 - largura / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - largura - 10));
    let top = r.bottom + 8;
    if (top + altura > window.innerHeight - 10) top = r.top - altura - 8;
    dicaPop.style.left = left + 'px';
    dicaPop.style.top = Math.max(10, top) + 'px';
}

/* Funciona também para os botões "?" criados dinamicamente nos cartões. */
document.addEventListener('click', e => {
    const el = e.target.closest('[data-tip]');
    if (el) {
        e.preventDefault();
        e.stopPropagation();
        if (dicaPop.classList.contains('hidden')) mostrarDica(el);
        else esconderDica();
        return;
    }
    if (!e.target.closest('#dicaPop')) esconderDica();
});
window.addEventListener('scroll', esconderDica, true);
window.addEventListener('resize', esconderDica);

/* ===== Navegação ===== */
function tabFromHash() {
    const h = location.hash.slice(1);
    return TITULOS[h] ? h : 'painel';
}

function go(tab, { push = false, force = false } = {}) {
    if (!TITULOS[tab]) tab = 'painel';
    if (state.tab === tab && !force) return;
    state.tab = tab;

    $$('.tab-item').forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        if (on) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
    });
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + tab));

    document.title = TITULOS[tab] + ' · TecSource';
    if (push && location.hash.slice(1) !== tab) history.pushState(null, '', '#' + tab);

    if (tab !== 'qr') fecharScanner();
    fecharSheet();
    fecharEstoque();
    fecharAjuda();
    esconderDica();
    window.scrollTo(0, 0);

    if (tab === 'painel') loadDashboard();
    else if (tab === 'qr') {
        loadQrResumo();
        if (fichaAtual && !fichaEl.classList.contains('hidden')) atualizarFichaSilenciosa();
    } else if (tab === 'historico') loadHistorico();
}

$$('.tab-item').forEach(btn => btn.addEventListener('click', () => {
    go(btn.dataset.tab, { push: true, force: state.tab === btn.dataset.tab });
}));

window.addEventListener('popstate', () => go(tabFromHash()));
window.addEventListener('hashchange', () => go(tabFromHash()));

/* ===== Painel ===== */
let debounceBusca;
let seqDashboard = 0;
let tecidosPainel = [];
let alertasCache = '';

function coberturaHtml(d) {
    if (d === null || d === undefined) return '<span class="muted">—</span>';
    const cls = d <= 7 ? 'neg strong' : d <= 15 ? 'warn strong' : 'pos strong';
    return `<span class="${cls}">${fmt(d)} d</span>`;
}

function barraTecido(t) {
    const min = Number(t.estoque_minimo_m);
    const saldo = Number(t.saldo_m);
    const ref = min > 0 ? min * 2 : (saldo > 0 ? saldo : 1);
    const pct = Math.max(3, Math.min(100, (saldo / ref) * 100));
    const cor = t.situacao === 'critico' ? 'var(--crit)'
        : t.situacao === 'baixo' ? 'var(--warn)' : 'var(--ok)';
    return `<div class="tec-bar"><span style="width:${pct.toFixed(1)}%;background:${cor}"></span></div>`;
}

function cardTecido(t) {
    return `<article class="tec-card" data-codigo="${esc(t.codigo)}">
      <div class="tec-top">
        <div class="tec-name">
          <strong>${esc(t.nome)}</strong>
          <span class="mono">${esc(t.codigo)}</span>
        </div>
        <span class="pill ${esc(t.situacao)}">${esc(SIT_LABEL[t.situacao] || t.situacao)}</span>
      </div>
      ${barraTecido(t)}
      <div class="tec-stats">
        <div><small>Saldo</small><strong>${fmt(t.saldo_m)} m</strong></div>
        <div><small>Mínimo</small><span>${fmt(t.estoque_minimo_m)} m</span></div>
        <div><small>Consumo 30d</small><span>${fmt(t.consumo_30d)} m</span></div>
        <div><small>Cobertura
          <button class="help-dot" aria-label="O que é cobertura" data-tip="Quantos dias o saldo atual dura, considerando o consumo dos últimos 30 dias. — significa que não houve consumo no período.">?</button>
        </small>${coberturaHtml(t.cobertura_dias)}</div>
      </div>
      <div class="tec-foot">
        <span>${t.rolos_ativos} rolo(s) ativo(s)</span>
        <span>Última mov. ${t.ultima_movimentacao ? new Date(t.ultima_movimentacao).toLocaleDateString('pt-BR') : '—'}</span>
      </div>
      ${t.localizacao ? `<p class="tec-local">📍 ${esc(t.localizacao)}</p>` : ''}
      <button type="button" class="btn-mini big" data-id="${t.id}">＋ Estoque</button>
    </article>`;
}

async function loadDashboard() {
    const seq = ++seqDashboard;
    try {
        const q = new URLSearchParams({
            busca: state.busca,
            situacao: state.situacao,
            ordem: state.ordem,
            dir: state.dir
        });
        const { itens, resumo } = await api('/api/dashboard?' + q.toString());
        if (seq !== seqDashboard) return; /* resposta obsoleta: descarta */

        setConn(true);
        tecidosPainel = itens;

        $('#kpiTotal').textContent = `${fmt(resumo.total_m)} m`;
        $('#kpiTotalCap').textContent = `${resumo.total_tecidos} tecido(s) · ${resumo.total_rolos} rolo(s) ativo(s)`;
        $('#kpiCortado').textContent = `${fmt(resumo.total_cortado_30d)} m`;

        const alertas = Number(resumo.total_alertas || 0);
        const criticos = Number(resumo.total_criticos || 0);
        const baixos = Number(resumo.total_baixos || 0);
        $('#kpiAlertas').textContent = alertas;
        $('#kpiAlertaCap').textContent = alertas
            ? (criticos || baixos ? `${criticos} crítico(s) · ${baixos} baixo(s)` : 'abaixo do mínimo')
            : 'estoque em dia';
        $('#kpiAlertaCard').classList.toggle('alerta', alertas > 0);

        const alertasHtml = alertas > 0
            ? `<div class="alerta-banner" role="alert">
                 <span class="alerta-icon" aria-hidden="true">⚠</span>
                 <div class="alerta-texto">
                   <strong>${alertas} tecido(s) precisam de reposição</strong>
                   <span>${[criticos ? `${criticos} crítico(s)` : '', baixos ? `${baixos} baixo(s)` : ''].filter(Boolean).join(' · ')}${criticos || baixos ? ' · ' : ''}${esc(resumo.alertas_nomes)}</span>
                 </div>
                 <button type="button" class="alerta-acao" data-filtrar-alerta>Ver alertas</button>
               </div>`
            : '';
        if (alertasHtml !== alertasCache) {
            alertasCache = alertasHtml;
            $('#alertas').innerHTML = alertasHtml;
        }

        $('#listaTecidos').innerHTML = itens.map(cardTecido).join('');
        $('#emptyTec').classList.toggle('hidden', itens.length > 0);
        $('#emptyTec').textContent = (state.busca || state.situacao)
            ? 'Nenhum tecido encontrado para os filtros atuais.'
            : 'Nenhum tecido cadastrado ainda. Cadastre o primeiro na aba Tecido.';
        $('#qtdConsulta').textContent = `${itens.length} de ${resumo.total_tecidos} tecido(s)`;

        const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        $('#atualizadoEm').textContent = `Atualizado às ${agora}`;
        loadCortesMobile();
    } catch {
        setConn(false);
        $('#atualizadoEm').textContent = 'Sem conexão com o servidor';
    }
}

/* Metragem cortada — contabilização automática dos cortes */
async function loadCortesMobile() {
    try {
        const c = await api('/api/cortes/resumo?dias=30');
        $('#corteMini').innerHTML = `
          <div class="corte-mini-item"><span>Hoje</span><strong>${fmt(c.totais.hoje_m)} m</strong><small>${c.totais.hoje_lancamentos} corte(s)</small></div>
          <div class="corte-mini-item"><span>7 dias</span><strong>${fmt(c.totais.sete_dias_m)} m</strong><small>via QR</small></div>
          <div class="corte-mini-item destaque"><span>30 dias</span><strong>${fmt(c.totais.periodo_m)} m</strong><small>${c.totais.lancamentos} corte(s)</small></div>`;

        const max = Math.max(...c.tecidos.map(t => t.total_m), 1);
        $('#corteTopMobile').innerHTML = c.tecidos.length
            ? '<p class="step-label">Mais cortados no período</p>' + c.tecidos.slice(0, 3).map(t => `
              <div class="corte-linha">
                <div class="corte-linha-top"><span>${esc(t.nome)}</span><strong>${fmt(t.total_m)} m</strong></div>
                <div class="corte-barra"><span style="width:${Math.max(3, (t.total_m / max) * 100).toFixed(1)}%"></span></div>
              </div>`).join('')
            : '<p class="corte-vazio muted">Nenhum corte no período. Ao registrar um corte, a metragem entra aqui automaticamente.</p>';
    } catch {
        $('#corteTopMobile').innerHTML = '<p class="corte-vazio muted">Não foi possível carregar a metragem cortada.</p>';
    }
}

$('#btnAtualizar').addEventListener('click', () => loadDashboard());

$('#buscaTecido').addEventListener('input', e => {
    clearTimeout(debounceBusca);
    const v = e.target.value.trim();
    debounceBusca = setTimeout(() => { state.busca = v; loadDashboard(); }, 300);
});

$('#chipsSituacao').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#chipsSituacao .chip').forEach(c => c.classList.toggle('active', c === chip));
    state.situacao = chip.dataset.situacao || '';
    loadDashboard();
});

$('#ordemTecidos').addEventListener('change', e => {
    const [ordem, dir] = e.target.value.split('|');
    state.ordem = ordem;
    state.dir = dir;
    loadDashboard();
});

$('#alertas').addEventListener('click', e => {
    if (!e.target.closest('[data-filtrar-alerta]')) return;
    $('#chipsSituacao .chip[data-situacao="alerta"]').click();
});

$('#listaTecidos').addEventListener('click', e => {
    /* ＋ Estoque continua como atalho direto no card. */
    const btnEstoque = e.target.closest('button[data-id]');
    if (btnEstoque) {
        const tec = tecidosPainel.find(t => String(t.id) === btnEstoque.dataset.id);
        if (tec) abrirEstoque(tec);
        return;
    }
    /* Qualquer outro toque no card abre a ficha (hub da aba Ler QR). */
    if (e.target.closest('button')) return;   /* help-dots e afins */
    const card = e.target.closest('.tec-card');
    if (card?.dataset.codigo) abrirFichaTecido(card.dataset.codigo);
});

/* ===== Leitor de QR (overlay) ===== */
let scanner = null;
let scanToken = 0;

async function abrirScanner() {
    if (typeof Html5Qrcode === 'undefined') {
        toast('Câmera indisponível neste navegador. Digite o código do tecido.');
        return;
    }
    if (scanner) return;

    const token = ++scanToken;
    let s = null;
    $('#scanOverlay').classList.remove('hidden');
    try {
        s = new Html5Qrcode('reader');
        scanner = s;
        await s.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 240, height: 240 } },
            aoLerQr
        );
        /* usuário fechou o leitor enquanto a câmera iniciava */
        if (token !== scanToken) {
            try { await s.stop(); } catch { /* já parado */ }
            try { await s.clear(); } catch { /* sem elementos */ }
        }
    } catch (e) {
        if (token !== scanToken) return;
        scanner = null;
        $('#scanOverlay').classList.add('hidden');
        try { await s.clear(); } catch { /* sem elementos */ }
        toast('❌ Não foi possível acessar a câmera: ' + (e?.message || 'permissão negada.'));
    }
}

async function fecharScanner() {
    scanToken++;
    const s = scanner;
    scanner = null;
    $('#scanOverlay').classList.add('hidden');
    if (!s) return;
    try { await s.stop(); } catch { /* já parado */ }
    try { await s.clear(); } catch { /* sem elementos */ }
}

function aoLerQr(texto) {
    fecharScanner();
    const input = $('#codigoQr');
    if (!input) return;
    input.value = String(texto).trim().toUpperCase();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    buscarCodigo();
}

$('#btnScannerQr').addEventListener('click', abrirScanner);
$('#btnFecharScanner').addEventListener('click', fecharScanner);

$('#codigoQr').addEventListener('change', e => {
    e.target.value = e.target.value.trim().toUpperCase();
});

/* ===== Ler QR: corte e contagem no mesmo fluxo ===== */
let roloAtual = null;
let modoLancamento = 'corte';

$('#btnBuscarQr').addEventListener('click', buscarCodigo);
$('#codigoQr').addEventListener('keydown', e => { if (e.key === 'Enter') buscarCodigo(); });

async function loadQrResumo() {
    try {
        const c = await api('/api/cortes/resumo?dias=7');
        $('#qrHoje').textContent =
            `Hoje: ${fmt(c.totais.hoje_m)} m · ${c.totais.hoje_lancamentos} corte(s) · 7 dias: ${fmt(c.totais.sete_dias_m)} m`;
    } catch {
        $('#qrHoje').textContent = 'Hoje: —';
    }
}

/* Códigos de rolo começam com ROL-. Qualquer outro código é tratado
   como QR do tecido (TEC:<codigo>) e abre a ficha do tecido. */
function ehCodigoRolo(codigo) {
    return /^ROL-/i.test(String(codigo).trim());
}

function atualizarFormulario() {
    const bloqueado = roloAtual && roloAtual.status === 'esgotado' && modoLancamento === 'corte';
    $('#formLancamento').classList.toggle('hidden', !!bloqueado);
    return !bloqueado;
}

function definirModo(modo) {
    modoLancamento = modo === 'contagem' ? 'contagem' : 'corte';
    $$('#modoLancamento .mode').forEach(b =>
        b.classList.toggle('active', b.dataset.modo === modoLancamento));

    const corte = modoLancamento === 'corte';
    $('#rotuloMetros').textContent = corte ? 'Metros cortados' : 'Metragem real (m)';
    $('#metrosQr').placeholder = corte ? 'ex.: 12,5' : 'ex.: 38,5';
    $('#btnConfirmarQr').textContent = corte ? 'Confirmar corte' : 'Registrar contagem';
    $('#qrAjuda').textContent = corte
        ? 'O corte baixa os metros do saldo do rolo.'
        : 'A contagem acerta o saldo do rolo. A diferença fica no histórico; diferença zero não grava nada.';

    if (roloAtual) atualizarFormulario();
}

function limparRolo() {
    roloAtual = null;
    $('#qrLancamento').classList.add('hidden');
    $('#qrRoloInfo').classList.add('hidden');
    $('#formLancamento').classList.add('hidden');
}

async function carregarRolo(codigo, modo = 'corte') {
    try {
        roloAtual = await api('/api/rolos/' + encodeURIComponent(codigo));
        setConn(true);
        $('#codigoQr').value = codigo;
        $('#metrosQr').value = '';
        definirModo(modo);

        const esgotado = roloAtual.status === 'esgotado';
        const card = $('#qrLancamento');
        const novidade = card.classList.contains('hidden');
        card.classList.remove('hidden');
        const volta = $('#btnVoltarFicha');
        volta.classList.remove('hidden');
        volta.textContent = fichaAtual ? '← Voltar à ficha' : '← Nova leitura';
        $('#qrRoloInfo').classList.remove('hidden');
        $('#qrRoloInfo').innerHTML = `
          <div class="roll-head">
            <strong>${esc(roloAtual.tecidos.nome)}</strong>
            <span class="pill ${esgotado ? 'critico' : 'ok'}">${esgotado ? 'ESGOTADO' : 'ATIVO'}</span>
          </div>
          <div class="mono roll-code">${esc(roloAtual.codigo_qr)}</div>
          <div class="roll-saldo">
            <span>Saldo disponível</span>
            <strong>${fmt(roloAtual.metragem_atual)} m</strong>
          </div>`;

        /* Entrando no estado de lançamento, a ficha dá lugar ao formulário. */
        if (novidade) {
            fecharFicha();
            $('#qrLeitura').classList.add('hidden');
            requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
        if (atualizarFormulario()) $('#metrosQr').focus();
        else toast('Rolo esgotado: use 📏 Contar para ajustar a metragem.');
    } catch (e) {
        limparRolo();
        if (e instanceof TypeError) setConn(false);
        toast('❌ ' + e.message);
    }
}

async function buscarCodigo() {
    const codigo = val('#codigoQr').toUpperCase();
    if (!codigo) { toast('Informe ou escaneie o QR do tecido.'); return; }
    if (!ehCodigoRolo(codigo)) {
        /* Evita confirmar um lançamento no rolo anterior depois de abrir a ficha. */
        limparRolo();
        await abrirFichaTecido(codigo);
        return;
    }
    await carregarRolo(codigo);
}

$('#modoLancamento').addEventListener('click', e => {
    const b = e.target.closest('.mode');
    if (!b) return;
    definirModo(b.dataset.modo);
    if (roloAtual && atualizarFormulario()) $('#metrosQr').focus();
});

$('#btnConfirmarQr').addEventListener('click', () => semDuplicar($('#btnConfirmarQr'), async () => {
    if (!roloAtual) { toast('Busque um rolo antes de confirmar.'); return; }
    const metros = val('#metrosQr');

    if (modoLancamento === 'corte' && !(numero(metros) > 0)) {
        toast('Informe os metros cortados.'); return;
    }
    if (modoLancamento === 'contagem') {
        if (metros === '' || Number.isNaN(numero(metros))) { toast('Informe a metragem real contada.'); return; }
        if (numero(metros) < 0) { toast('A metragem real não pode ser negativa.'); return; }
    }

    const ehCorte = modoLancamento === 'corte';
    try {
        const r = ehCorte
            ? await enviarComFila('/api/movimentacoes/saida', {
                codigo_qr: roloAtual.codigo_qr,
                metros,
                usuario: val('#usuarioQr')
            }, `Corte de ${metros} m · ${roloAtual.codigo_qr}`)
            : await enviarComFila('/api/movimentacoes/ajuste', {
                codigo_qr: roloAtual.codigo_qr,
                metragem_real: metros,
                usuario: val('#usuarioQr')
            }, `Contagem de ${metros} m · ${roloAtual.codigo_qr}`);

        const mensagem = ehCorte
            ? `✅ Corte registrado. Restam ${fmt(r.metragem_atual)} m no rolo.`
            : `📏 Saldo corrigido para ${fmt(r.metragem_atual)} m (diferença: ${fmt(r.diferenca)} m).`;

        if (avisoDeEnvio(r, mensagem)) {
            if (r.pendente) {
                setConn(false);
                $('#metrosQr').value = '';
                return;
            }
        }
        $('#metrosQr').value = '';
        carregarRolo(roloAtual.codigo_qr, modoLancamento);
        atualizarFichaSilenciosa();   /* ao voltar à ficha, saldo já atualizado */
        loadQrResumo();
        loadDashboard();
    } catch (e) {
        toast('❌ ' + e.message);
    }
}));

$('#metrosQr').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#btnConfirmarQr').click();
});

/* ===== Ficha do tecido (inline na aba Ler QR) ===== */
const fichaEl = $('#qrFicha');
let fichaAtual = null;

function fecharFicha() {
    fichaEl.classList.add('hidden');
}

/* × = nova leitura: esconde a ficha e volta para o card de leitura. */
function novaLeitura() {
    fecharFicha();
    fichaAtual = null;
    $('#qrLeitura').classList.remove('hidden');
    $('#codigoQr').value = '';
    $('#codigoQr').focus();
}

/* Atualiza a ficha em segundo plano (pode estar escondida no estado de lançamento). */
async function atualizarFichaSilenciosa() {
    if (!fichaAtual) return;
    try {
        const f = await api('/api/tecidos/qr/' + encodeURIComponent(fichaAtual.tecido.codigo));
        fichaAtual = f;
        renderFicha(f);
    } catch { /* sem rede: mantém a versão em tela */ }
}

function renderFicha(f) {
    const t = f.tecido;
    const c = f.cortes;

    $('#fichaTitulo').textContent = t.nome;
    $('#fichaSub').textContent =
        `${t.codigo} · mínimo ${fmt(t.estoque_minimo_m)} m` + (t.localizacao ? ` · 📍 ${t.localizacao}` : '');

    const rolosHtml = f.rolos.length
        ? `<div class="ficha-rolos">${f.rolos.map(r => {
            const esgotado = r.status === 'esgotado';
            return `
            <div class="ficha-rolo${esgotado ? ' esgotado' : ''}">
              <div class="fr-info">
                <span class="fr-code mono">${esc(r.codigo_qr)}</span>
                <span class="fr-saldo">${fmt(r.metragem_atual)} m</span>
              </div>
              <div class="fr-acoes">
                <button type="button" class="btn-mini" data-rolo="${esc(r.codigo_qr)}" data-modo="corte"
                    ${esgotado ? 'disabled' : ''}>✂ Cortar</button>
                <button type="button" class="btn-mini ghost" data-rolo="${esc(r.codigo_qr)}"
                    data-modo="contagem">📏 Contar</button>
              </div>
            </div>`;
        }).join('')}</div>`
        : '<p class="ficha-vazio">Nenhum rolo cadastrado. Use ＋ Estoque para criar.</p>';

    const cortesHtml = c.ultimos.length
        ? `<div class="ficha-cortes">${c.ultimos.map(m => `
            <div class="ficha-corte">
              <span>${new Date(m.criado_em).toLocaleString('pt-BR', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
              })}</span>
              <span class="mono muted">${esc(m.codigo_qr)}</span>
              <strong class="neg">-${fmt(m.metros)} m</strong>
            </div>`).join('')}</div>`
        : '<p class="ficha-vazio">Nenhum corte registrado ainda.</p>';

    $('#fichaCorpo').innerHTML = `
      <div class="ficha-kpis">
        <div class="ficha-kpi"><span>Metragem</span><strong>${fmt(t.saldo_m)} m</strong></div>
        <div class="ficha-kpi"><span>Rolos ativos</span><strong>${t.rolos_ativos}</strong></div>
        <div class="ficha-kpi"><span>Cortes (30d)</span><strong>${fmt(c.consumo_30d_m)} m</strong></div>
        <div class="ficha-kpi"><span>Cortado total</span><strong>${fmt(c.total_m)} m</strong></div>
      </div>
      <p class="ficha-meta">
        <span class="pill ${esc(t.situacao)}">${esc(SIT_LABEL[t.situacao] || t.situacao)}</span>
        Cobertura: ${coberturaHtml(t.cobertura_dias)}
        · ${c.total_lancamentos} corte(s) · hoje: ${fmt(c.hoje_m)} m
      </p>
      <div class="ficha-secao">
        <strong>Rolos</strong>
        <p class="ficha-ajuda">Toque em <b>Cortar</b> para baixar metros do rolo ou em <b>Contar</b> para acertar a
            metragem real.</p>
        ${rolosHtml}
      </div>
      <div class="ficha-secao">
        <strong>Últimos cortes</strong>
        ${cortesHtml}
      </div>
      <div class="ficha-acoes">
        <button type="button" class="btn-primary" data-acao="estoque">＋ Estoque</button>
        <button type="button" class="btn-secondary" data-acao="local">📍 ${t.localizacao ? 'Editar localização' : 'Definir localização'}</button>
        <button type="button" class="btn-secondary" data-acao="imprimir">Imprimir etiqueta do tecido</button>
      </div>`;
}

async function abrirFichaTecido(codigo) {
    try {
        const f = await api('/api/tecidos/qr/' + encodeURIComponent(codigo));
        fichaAtual = f;
        renderFicha(f);
        limparRolo();               /* a ficha substitui o estado de lançamento */
        fichaEl.classList.remove('hidden');
        $('#qrLeitura').classList.add('hidden');   /* já leu: sem card de busca na tela */
        go('qr', { push: true });
        setConn(true);
        requestAnimationFrame(() => fichaEl.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (e) {
        if (e instanceof TypeError) setConn(false);
        toast('❌ ' + e.message);
    }
}

/* Rolo escolhido na ficha: mesma aba, estado de lançamento (com volta). */
function selecionarRolo(codigo, modo) {
    fecharFicha();
    carregarRolo(codigo, modo);
}

$('#btnFecharFicha').addEventListener('click', novaLeitura);

/* Voltar da ficha → form: reaparece a ficha com dados atualizados.
   Sem ficha (código ROL- digitado direto): volta ao card de leitura. */
$('#btnVoltarFicha').addEventListener('click', async () => {
    if (!fichaAtual) {
        limparRolo();
        novaLeitura();
        return;
    }
    const codigo = fichaAtual.tecido.codigo;
    limparRolo();
    await abrirFichaTecido(codigo);
});

$('#fichaCorpo').addEventListener('click', e => {
    const acao = e.target.closest('[data-acao]');
    if (acao) {
        if (!fichaAtual) return;
        if (acao.dataset.acao === 'estoque') {
            /* A ficha fica visível atrás da folha de estoque. */
            abrirEstoque(fichaAtual.tecido);
        } else if (acao.dataset.acao === 'local') {
            editarLocalizacao(fichaAtual.tecido);
        } else if (acao.dataset.acao === 'imprimir') {
            imprimirEtiquetaTecido(fichaAtual.tecido.codigo, fichaAtual.tecido.nome);
        }
        return;
    }

    const rolo = e.target.closest('[data-rolo]');
    if (!rolo) return;
    selecionarRolo(rolo.dataset.rolo, rolo.dataset.modo);
});

/* ===== Novo tecido ===== */
function atualizarPreviewTecido() {
    const metros = numero(val('#tecMetros'));
    const qtd = Math.max(1, parseInt(val('#tecRoloQtd'), 10) || 1);
    if (!(metros > 0)) {
        $('#tecidoLotePreview').textContent = 'Sem estoque inicial: apenas o cadastro do tecido.';
        return;
    }
    $('#tecidoLotePreview').textContent = `${qtd} rolo(s) × ${fmt(metros)} m = ${fmt(metros * qtd)} m no total.`;
}

['#tecMetros', '#tecRoloQtd'].forEach(sel =>
    $(sel).addEventListener('input', atualizarPreviewTecido));
atualizarPreviewTecido();

$('#btnTecido').addEventListener('click', () => semDuplicar($('#btnTecido'), async () => {
    if (!val('#tecCodigo') || !val('#tecNome')) { toast('Informe código e nome do tecido.'); return; }
    const min = val('#tecMin');
    if (min !== '' && !(numero(min) >= 0)) { toast('Estoque mínimo inválido.'); return; }

    const metrosTecido = val('#tecMetros');
    const temMetragem = metrosTecido !== '';
    if (temMetragem && !(numero(metrosTecido) > 0)) {
        toast('Informe a metragem ou deixe o campo vazio.');
        return;
    }
    const qtdTecido = Math.max(1, parseInt(val('#tecRoloQtd'), 10) || 1);
    if (temMetragem && (qtdTecido < 1 || qtdTecido > 100)) {
        toast('Quantidade de rolos deve ser entre 1 e 100.');
        return;
    }

    try {
        const r = await api('/api/tecidos', {
            method: 'POST',
            body: {
                codigo: val('#tecCodigo'),
                nome: val('#tecNome'),
                estoque_minimo_m: min || 10,
                localizacao: val('#tecLocal'),
                ...(temMetragem ? {
                    modo: 'rolos',
                    metragem: metrosTecido,
                    quantidade: qtdTecido,
                    usuario: val('#usuarioTecido')
                } : {})
            }
        });

        const resumoTecido = r.rolos && r.rolos.length
            ? (r.quantidade === 1
                ? `✅ Tecido salvo com 1 rolo de <strong>${fmt(r.total_m)} m</strong>`
                : `✅ Tecido salvo com ${r.quantidade} rolos × ${fmt(r.metragem)} m = <strong>${fmt(r.total_m)} m</strong>`)
            : '✅ Tecido salvo sem estoque inicial.';
        await mostrarEtiquetaTecido(r.codigo, r.nome, resumoTecido);
        toast(r.rolos && r.rolos.length
            ? `✅ Tecido salvo com ${r.quantidade} rolo(s).`
            : '✅ Tecido salvo.');

        $('#tecCodigo').value = '';
        $('#tecNome').value = '';
        $('#tecLocal').value = '';
        $('#tecMetros').value = '';
        $('#tecRoloQtd').value = '1';
        atualizarPreviewTecido();
        loadDashboard();
    } catch (e) {
        toast('❌ ' + e.message);
    }
}));

$('#btnIrPainel').addEventListener('click', () => go('painel', { push: true, force: true }));

/* ===== Adicionar estoque (novos rolos ou reposição) ===== */
const estoqueOverlay = $('#estoqueOverlay');
let tecidoEstoque = null;
let modoEstoque = 'novo';

function setModoEstoque(modo) {
    modoEstoque = modo;
    $$('#modoEstoque .mode').forEach(b => b.classList.toggle('active', b.dataset.modo === modo));
    $('#blocoNovo').classList.toggle('hidden', modo !== 'novo');
    $('#blocoRolo').classList.toggle('hidden', modo !== 'rolo');
}

function atualizarPreviewEstoque() {
    const qtd = Math.max(1, parseInt(val('#estoqueQtd'), 10) || 1);
    const metros = numero(val('#estoqueMetros'));
    const total = Number.isFinite(metros) && metros > 0 ? metros * qtd : 0;
    $('#estoquePreview').textContent = total > 0
        ? `${qtd} rolo(s) × ${fmt(metros)} m = ${fmt(total)} m no total.`
        : 'Informe os metros para ver o total.';
}

async function abrirEstoque(tec) {
    tecidoEstoque = tec;
    $('#estoqueTitulo').textContent = 'Adicionar estoque';
    $('#estoqueResumo').textContent =
        `${tec.nome} · saldo ${fmt(tec.saldo_m)} m · ${tec.rolos_ativos} rolo(s) ativo(s)`;
    $('#estoqueMetros').value = '';
    $('#estoqueMetrosRolo').value = '';
    $('#estoqueQtd').value = '1';
    $('#obsEstoque').value = '';
    $('#estoqueResultado').innerHTML = '';
    $('#estoqueResultado').classList.add('hidden');
    const op = localStorage.getItem(OP_KEY);
    if (!$('#usuarioEstoque').value && op) $('#usuarioEstoque').value = op;
    setModoEstoque('novo');
    atualizarPreviewEstoque();
    $('#estoqueRolo').innerHTML = '<option value="">Carregando rolos…</option>';
    estoqueOverlay.classList.remove('hidden');

    try {
        const rolos = await api(`/api/tecidos/${tec.id}/rolos`);
        $('#estoqueRolo').innerHTML = rolos.length
            ? rolos.map(r => `<option value="${r.id}">${esc(r.codigo_qr)} · ${fmt(r.metragem_atual)} m${r.status === 'esgotado' ? ' (esgotado)' : ''}</option>`).join('')
            : '<option value="">Nenhum rolo cadastrado</option>';
    } catch {
        $('#estoqueRolo').innerHTML = '<option value="">Não foi possível carregar os rolos</option>';
    }
}

function fecharEstoque() {
    estoqueOverlay.classList.add('hidden');
    tecidoEstoque = null;
}

$('#modoEstoque').addEventListener('click', e => {
    const btn = e.target.closest('.mode');
    if (btn) setModoEstoque(btn.dataset.modo);
});
['#estoqueMetros', '#estoqueQtd'].forEach(sel =>
    $(sel).addEventListener('input', atualizarPreviewEstoque));
$('#btnFecharEstoque').addEventListener('click', fecharEstoque);
estoqueOverlay.addEventListener('click', e => {
    if (e.target === estoqueOverlay) fecharEstoque();
});

$('#btnAddEstoque').addEventListener('click', () => semDuplicar($('#btnAddEstoque'), async () => {
    if (!tecidoEstoque) return;

    const emRolo = modoEstoque === 'rolo';
    const metros = emRolo ? val('#estoqueMetrosRolo') : val('#estoqueMetros');
    if (!(numero(metros) > 0)) { toast('Informe uma metragem maior que zero.'); return; }

    const qtd = emRolo ? 1 : Math.max(1, parseInt(val('#estoqueQtd'), 10) || 1);
    if (!emRolo && (qtd < 1 || qtd > 100)) {
        toast('Quantidade de rolos deve ser entre 1 e 100.');
        return;
    }
    if (emRolo && !val('#estoqueRolo')) {
        toast('Selecione o rolo que vai receber os metros.');
        return;
    }

    try {
        const r = await api(`/api/tecidos/${tecidoEstoque.id}/metros`, {
            method: 'POST',
            body: {
                metros,
                usuario: val('#usuarioEstoque'),
                observacao: val('#obsEstoque'),
                ...(emRolo
                    ? { rolo_id: val('#estoqueRolo') }
                    : { modo: 'rolos', quantidade: qtd })
            }
        });

        if (r.modo === 'novo') {
            const nome = r.tecido.nome;
            const resumo = r.quantidade === 1
                ? `✅ 1 rolo criado com ${fmt(r.metros)} m.`
                : `✅ ${r.quantidade} rolos criados com ${fmt(r.metros)} m cada · total ${fmt(r.total_m)} m.`;
            $('#estoqueResultado').innerHTML = `
              <div class="resultado-ok">${resumo}</div>
              <p class="field-help">O QR é único por tecido. Use a etiqueta abaixo para identificar este tecido.</p>
              <div class="label-actions">
                <button type="button" id="btnImprimirEstoque">Imprimir etiqueta do tecido</button>
                <button type="button" id="btnCopiarEstoque">Copiar código do tecido</button>
              </div>`;
            $('#estoqueResultado').classList.remove('hidden');
            $('#btnImprimirEstoque').onclick = () => imprimirEtiquetaTecido(r.tecido.codigo, nome);
            $('#btnCopiarEstoque').onclick = () => copiar('TEC:' + r.tecido.codigo);
            toast(`✅ ${r.quantidade} rolo(s) criado(s) · ${fmt(r.total_m)} m no total.`);
        } else {
            $('#estoqueResultado').innerHTML = `
              <div class="resultado-ok">✅ ${fmt(r.metros)} m adicionados ao rolo
                <span class="mono">${esc(r.codigo_qr)}</span>.<br>Novo saldo: <strong>${fmt(r.metragem_atual)} m</strong>.</div>
              <div class="label-actions">
                <button type="button" id="btnImprimirEstoque">Imprimir etiqueta do tecido</button>
              </div>`;
            $('#estoqueResultado').classList.remove('hidden');
            $('#btnImprimirEstoque').onclick = () => imprimirEtiquetaTecido(r.tecido.codigo, r.tecido.nome);
            toast(`✅ Metragem somada ao rolo ${r.codigo_qr}.`);
        }

        $('#estoqueMetros').value = '';
        $('#estoqueMetrosRolo').value = '';
        $('#estoqueQtd').value = '1';
        atualizarPreviewEstoque();
        loadDashboard();
        loadQrResumo();
        atualizarFichaSilenciosa();   /* ficha aberta atrás da folha */
    } catch (e) {
        toast('❌ ' + e.message);
    }
}));

/* ===== Etiqueta única por tecido (QR TEC:<codigo>) ===== */
async function qrTecido(codigo) {
    const [qr] = await api('/api/qrcode', {
        method: 'POST',
        body: { textos: ['TEC:' + codigo] }
    });
    return qr;
}

function etiquetaTecidoHtml(codigo, nome, qr) {
    return `<div class="etiquetas-grid">
      <div class="etiqueta-item etiqueta-tecido">
        <img src="${qr}" alt="QR do tecido ${esc(codigo)}">
        <strong class="mono codigo">TEC:${esc(codigo)}</strong>
        <small>${esc(nome)}</small>
      </div>
    </div>`;
}

async function mostrarEtiquetaTecido(codigo, nome, resumoHtml = '') {
    $('#etiquetaTecido').classList.remove('hidden');
    $('#etiquetaTecido').innerHTML = `
      ${resumoHtml ? `<div class="lote-resumo">${resumoHtml}</div>` : ''}
      <div id="etiquetaTecidoQr" class="etiqueta compacta"><span class="muted">Gerando QR do tecido…</span></div>
      <div class="label-actions">
        <button type="button" id="btnImprimirTecido" disabled>Imprimir etiqueta</button>
        <button type="button" id="btnCopiarTecido">Copiar código</button>
      </div>`;
    $('#btnCopiarTecido').onclick = () => copiar('TEC:' + codigo);
    try {
        const qr = await qrTecido(codigo);
        $('#etiquetaTecidoQr').innerHTML = etiquetaTecidoHtml(codigo, nome, qr);
        $('#btnImprimirTecido').disabled = false;
        $('#btnImprimirTecido').onclick = () => imprimirEtiquetaTecido(codigo, nome);
    } catch (e) {
        $('#etiquetaTecidoQr').innerHTML = '<p class="ficha-vazio">Não foi possível gerar o QR do tecido.</p>';
        toast('❌ ' + e.message);
    }
}

/* Impressão da etiqueta do tecido */
async function imprimirEtiquetaTecido(codigo, nome) {
    try {
        const qr = await qrTecido(codigo);
        $('#printArea').innerHTML = `<div class="etiquetas-print">
          <div class="etiqueta-print etiqueta-tecido">
            <img src="${qr}" alt="QR do tecido ${esc(codigo)}">
            <strong class="mono">TEC:${esc(codigo)}</strong>
            <span>${esc(nome)}</span>
            <small>QR do tecido · TecSource · MAITE Decorações</small>
          </div>
        </div>`;
        /* Espera o QR (data URL) carregar antes de abrir a impressão. */
        const img = $('#printArea img');
        if (img && !img.complete) {
            await new Promise(res => { img.onload = img.onerror = res; });
        }
        window.print();
    } catch (e) { toast('❌ ' + e.message); }
}

window.addEventListener('afterprint', () => {
    $('#printArea').innerHTML = '';
});

async function copiar(texto) {
    if (!texto) return;
    try {
        await navigator.clipboard.writeText(texto);
        toast('Código copiado.');
    } catch {
        const ta = document.createElement('textarea');
        ta.value = texto;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('Código copiado.'); }
        catch { toast('Não foi possível copiar o código.'); }
        ta.remove();
    }
}

/* ===== Histórico ===== */
let movsCache = [];

async function loadHistorico() {
    try {
        movsCache = await api('/api/movimentacoes?limit=100');
        setConn(true);
        renderHistorico();
    } catch {
        setConn(false);
        $('#listaMov').innerHTML = '';
        $('#emptyMov').classList.remove('hidden');
        $('#emptyMov').textContent = 'Sem conexão com o servidor.';
    }
}

function cardMov(m) {
    const tipo = m.tipo;
    const icone = tipo === 'entrada' ? '↑' : tipo === 'saida' ? '↓' : tipo === 'estorno' ? '↩' : '±';
    const sinal = tipo === 'saida' ? '-' : (m.metros > 0 ? '+' : '');
    const classeMetros = tipo === 'saida' ? 'neg' : (m.metros > 0 ? 'pos' : '');
    const data = new Date(m.criado_em).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });
    const cancelada = !!m.cancelada_em;
    const podeEstornar = !cancelada && tipo !== 'estorno';
    return `<article class="mov-card ${cancelada ? 'mov-cancelada' : ''}">
      <div class="mov-icon ${esc(tipo)}" aria-hidden="true">${icone}</div>
      <div class="mov-body">
        <div class="mov-top">
          <strong>${esc(m.rolos?.tecidos?.nome ?? '—')}</strong>
          <span class="mov-metros ${classeMetros}">${sinal}${fmt(m.metros)} m</span>
        </div>
        <div class="mov-meta">
          <span class="mono">${esc(m.rolos?.codigo_qr ?? '')}</span>
          <span class="badge ${esc(tipo)}">${esc(tipo).toUpperCase()}</span>
          ${cancelada ? '<span class="badge cancelada">CANCELADA</span>' : ''}
          <span>${esc(data)}</span>
          <span>${esc(m.usuario) || 'sem responsável'}</span>
        </div>
        ${podeEstornar ? `<button type="button" class="btn-mini ghost mov-estorno" data-estorno="${m.id}">↩ Estornar</button>` : ''}
      </div>
    </article>`;
}

function renderHistorico() {
    const lista = state.movTipo ? movsCache.filter(m => m.tipo === state.movTipo) : movsCache;
    $('#listaMov').innerHTML = lista.map(cardMov).join('');
    $('#emptyMov').classList.toggle('hidden', lista.length > 0);
    if (!lista.length) $('#emptyMov').textContent = 'Nenhuma movimentação encontrada.';
}

$('#chipsMov').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#chipsMov .chip').forEach(c => c.classList.toggle('active', c === chip));
    state.movTipo = chip.dataset.tipo || '';
    renderHistorico();
});

$('#btnAtualizarHistorico').addEventListener('click', loadHistorico);

$('#listaMov').addEventListener('click', e => {
    const btn = e.target.closest('[data-estorno]');
    if (!btn) return;
    const m = movsCache.find(x => String(x.id) === btn.dataset.estorno);
    if (m) estornarMovimentacao(m);
});

/* ===== Menu do operador ===== */
function abrirSheet() {
    $('#sheetOverlay').classList.remove('hidden');
}

function fecharSheet() {
    $('#sheetOverlay').classList.add('hidden');
}

$('#avatar').addEventListener('click', abrirSheet);
$('#btnFecharSheet').addEventListener('click', fecharSheet);
$('#sheetOverlay').addEventListener('click', e => {
    if (e.target === $('#sheetOverlay')) fecharSheet();
});

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    fecharSheet();
    fecharScanner();
    fecharEstoque();
    fecharFicha();
    fecharAjuda();
    esconderDica();
});

/* ===== Dica de primeira visita ===== */
if (!localStorage.getItem(DICA_KEY)) $('#dicaBoasVindas').classList.remove('hidden');
$('#btnFecharDica').addEventListener('click', () => {
    localStorage.setItem(DICA_KEY, '1');
    $('#dicaBoasVindas').classList.add('hidden');
});

/* ===== PWA: instalação e service worker ===== */
let deferredPrompt = null;
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    if (!standalone) $('#btnInstalar').classList.remove('hidden');
});

$('#btnInstalar').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch { /* usuário fechou */ }
    deferredPrompt = null;
    $('#btnInstalar').classList.add('hidden');
});

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
if (isIOS && !standalone) $('#iosHint').classList.remove('hidden');
if (!window.isSecureContext) $('#insecureHint').classList.remove('hidden');
if (standalone) $('#avatar').setAttribute('title', 'Aplicativo instalado');

if ('serviceWorker' in navigator) {
    const seguro = location.protocol === 'https:' ||
        ['localhost', '127.0.0.1'].includes(location.hostname);
    if (seguro) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(() => { /* PWA opcional */ });
        });
    }
}

/* ===== Sugestões por nome no campo de QR ===== */
ligarSugestoes('#codigoQr', '#sugestoesQr', buscarCodigo);

/* ===== Fila offline ===== */
window.addEventListener('tecfila:sincronizado', e => {
    toast(`📤 ${e.detail.enviados} lançamento(s) sincronizado(s).`);
    setConn(true);
    loadDashboard();
    if (state.tab === 'historico') loadHistorico();
});

/* ===== Conexão ===== */
window.addEventListener('offline', () => setConn(false));
window.addEventListener('online', () => loadDashboard());

/* ===== Inicialização ===== */
const operadorSalvo = localStorage.getItem(OP_KEY);
if (operadorSalvo) {
    $('#loginOverlay').classList.add('hidden');
    setOperador(operadorSalvo);
}

go(tabFromHash());
if (!location.hash) history.replaceState(null, '', '#painel');

setInterval(() => {
    if (document.visibilityState === 'visible' && state.tab === 'painel') loadDashboard();
}, 30000);
