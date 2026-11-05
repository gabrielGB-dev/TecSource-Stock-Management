/* ============================================================
   TecSource · Interface desktop
   Regras de interface: uma ação principal por tela, textos curtos
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
    painel: 'Painel de estoque',
    cortar: 'Registrar corte',
    contagem: 'Contagem',
    cadastro: 'Novo tecido',
    historico: 'Histórico'
};

const SIT_LABEL = { ok: 'OK', baixo: 'BAIXO', critico: 'CRÍTICO' };

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

/* Executa a ação bloqueando o botão até terminar (evita duplo clique) */
async function semDuplicar(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); }
    finally { btn.disabled = false; }
}

/* ===== Fila offline + helpers de apoio ===== */

/* Envia pela fila quando ela está disponível. Sem fila (HTML antigo em
   cache), cai no envio direto para não perder a função. */
async function enviarComFila(url, body, rotulo) {
    if (window.TecFila) return window.TecFila.enviar(url, body, { rotulo });
    return api(url, { method: 'POST', body });
}

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
        /* código completo (digitado ou escaneado) não precisa de sugestão */
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

    /* mousedown antes do blur: escolher a sugestão não fecha a lista antes */
    box.addEventListener('mousedown', e => {
        const b = e.target.closest('.sugestao');
        if (!b) return;
        e.preventDefault();
        input.value = 'TEC:' + b.dataset.codigo;
        fechar();
        aoEscolher();
    });

    input.addEventListener('keydown', e => { if (e.key === 'Escape') fechar(); });
    input.addEventListener('blur', () => setTimeout(fechar, 150));
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

/* ===== Operador ===== */
const OP_KEY = 'tecsource_operador';

function setOperador(n) {
    $('#operadorNome').textContent = n;
    ['usuarioSaida', 'usuarioAjuste', 'usuarioTecido', 'usuarioEstoque'].forEach(id => {
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
}

$('#btnEntrar').onclick = entrar;
$('#loginNome').addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });
$('#btnSair').onclick = () => {
    localStorage.removeItem(OP_KEY);
    location.reload();
};

/* ===== Ajuda ===== */
const helpOverlay = $('#helpOverlay');
const dicaPop = $('#dicaPop');

function abrirAjuda() {
    helpOverlay.classList.remove('hidden');
}
function fecharAjuda() {
    helpOverlay.classList.add('hidden');
}
$('#btnAjuda').onclick = abrirAjuda;
$('#btnFecharAjuda').onclick = fecharAjuda;
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

$$('.help-dot').forEach(btn => btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (dicaPop.classList.contains('hidden')) mostrarDica(btn);
    else esconderDica();
}));

document.addEventListener('click', e => {
    if (!e.target.closest('.help-dot') && !e.target.closest('#dicaPop')) esconderDica();
});
window.addEventListener('scroll', esconderDica, true);
window.addEventListener('resize', esconderDica);

/* ===== Acesso pelo celular (QR) ===== */
const mobileOverlay = $('#mobileOverlay');

$('#btnMobile').onclick = async () => {
    const url = new URL('mobile.html', location.href).href;
    $('#mobileUrl').textContent = url;
    $('#mobileQr').innerHTML = '<span class="muted">Gerando QR Code…</span>';
    const viaLocalhost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    $('#mobileHint').classList.toggle('hidden', !viaLocalhost);
    if (viaLocalhost) {
        $('#mobileHint').textContent = 'Você está em localhost. Para o celular abrir o QR, use o endereço IP desta máquina na rede (ex.: http://192.168.x.x:3000).';
    }
    mobileOverlay.classList.remove('hidden');
    try {
        const qr = await api('/api/qrcode/' + encodeURIComponent(url));
        $('#mobileQr').innerHTML = `<img src="${qr}" alt="QR Code para abrir a versão mobile">`;
    } catch {
        $('#mobileQr').innerHTML = '<span class="muted">Não foi possível gerar o QR Code.</span>';
    }
};

function fecharMobile() {
    mobileOverlay.classList.add('hidden');
}
$('#btnFecharMobile').onclick = fecharMobile;
mobileOverlay.addEventListener('click', e => {
    if (e.target === mobileOverlay) fecharMobile();
});

/* ===== Navegação ===== */
const CARREGADORES = {
    painel: loadDashboard,
    cortar: loadCorteHoje,
    historico: loadHistorico
};

$$('.menu-item').forEach(btn => btn.onclick = () => {
    $$('.menu-item').forEach(b => b.classList.toggle('active', b === btn));
    $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    $('#pageTitle').textContent = TITULOS[btn.dataset.tab];
    pararScanner();
    fecharFicha();
    esconderDica();
    CARREGADORES[btn.dataset.tab]?.();
});

/* ===== Relógio e conexão ===== */
function tick() {
    $('#clock').textContent = new Date().toLocaleString('pt-BR', {
        weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}
tick();
setInterval(tick, 10000);

function setConn(on) {
    const el = $('#connStatus');
    el.className = 'conn ' + (on ? 'ok' : 'err');
    el.innerHTML = '<span class="dot"></span>' + (on ? 'Online' : 'Sem conexão');
}

/* ===== Painel ===== */
let consultaEstado = { busca: '', situacao: '', ordem: 'nome', dir: 'asc' };
let debounceBusca;
let seqDashboard = 0;
let tecidosPainel = [];

function coberturaHtml(d) {
    if (d === null || d === undefined) return '<span class="muted">—</span>';
    const cls = d <= 7 ? 'neg strong' : d <= 15 ? 'warn strong' : 'pos strong';
    return `<span class="${cls}">${fmt(d)} d</span>`;
}

function updateSetasOrdem() {
    $$('th[data-ordem]').forEach(th => {
        const ativo = th.dataset.ordem === consultaEstado.ordem;
        th.classList.toggle('sorted', ativo);
        th.querySelector('.seta').textContent = ativo ? (consultaEstado.dir === 'asc' ? '▲' : '▼') : '';
    });
}

function renderKpis(resumo) {
    const alertas = Number(resumo.total_alertas || 0);
    const criticos = Number(resumo.total_criticos || 0);
    const baixos = Number(resumo.total_baixos || 0);
    const capAlertas = alertas
        ? (criticos || baixos ? `${criticos} crítico(s) · ${baixos} baixo(s)` : 'abaixo do mínimo')
        : 'estoque em dia';

    $('#kpis').innerHTML = `
      <div class="kpi destaque">
        <div class="k-label">Estoque total</div>
        <div class="k-value">${fmt(resumo.total_m)} m</div>
        <div class="k-cap">${resumo.total_tecidos} tecido(s) · ${resumo.total_rolos} rolo(s) ativo(s)</div>
      </div>
      <div class="kpi kpi-corte">
        <div class="k-label">Cortado (30d)</div>
        <div class="k-value">${fmt(resumo.total_cortado_30d)} m</div>
        <div class="k-cap">${fmt(resumo.total_cortado_hoje)} m hoje · via QR</div>
      </div>
      <div class="kpi ${alertas ? 'alerta' : ''}">
        <div class="k-label">Alertas</div>
        <div class="k-value">${alertas}</div>
        <div class="k-cap">${capAlertas}</div>
      </div>`;
}

let alertasCache = '';

function renderAlertas(resumo) {
    const total = Number(resumo.total_alertas || 0);
    if (!total) {
        if (!alertasCache) return;
        alertasCache = '';
        $('#alertas').innerHTML = '';
        return;
    }

    const criticos = Number(resumo.total_criticos || 0);
    const baixos = Number(resumo.total_baixos || 0);
    const detalhe = [
        criticos ? `${criticos} crítico(s)` : '',
        baixos ? `${baixos} baixo(s)` : ''
    ].filter(Boolean).join(' · ');

    const html = `
      <div class="alerta-banner" role="alert">
        <span class="alerta-icon" aria-hidden="true">⚠</span>
        <div class="alerta-texto">
          <strong>${total} tecido(s) precisam de reposição</strong>
          <span>${detalhe ? detalhe + ' · ' : ''}${esc(resumo.alertas_nomes)}</span>
        </div>
        <button type="button" class="alerta-acao" data-filtrar-alerta>Ver alertas</button>
      </div>`;

    if (html === alertasCache) return;
    alertasCache = html;
    $('#alertas').innerHTML = html;
}

$('#alertas').addEventListener('click', e => {
    if (!e.target.closest('[data-filtrar-alerta]')) return;
    consultaEstado.situacao = 'alerta';
    $('#filtroSituacao').value = 'alerta';
    loadDashboard();
    $('#filtroSituacao').focus();
});

function renderTabela(itens, resumo) {
    $('#tbodyTecidos').innerHTML = itens.map(t => `<tr>
      <td><span class="tbl-name">${esc(t.nome)}</span><span class="mono muted tbl-code">${esc(t.codigo)}</span>${t.localizacao ? `<span class="tbl-local">📍 ${esc(t.localizacao)}</span>` : ''}</td>
      <td class="num"><strong>${fmt(t.saldo_m)} m</strong><span class="tbl-code muted">mín. ${fmt(t.estoque_minimo_m)} m</span></td>
      <td class="num muted">${t.rolos_ativos}</td>
      <td class="num">${fmt(t.consumo_30d)} m</td>
      <td class="num">${coberturaHtml(t.cobertura_dias)}</td>
      <td><span class="pill ${esc(t.situacao)}">${esc(SIT_LABEL[t.situacao] || t.situacao)}</span></td>
      <td class="num"><button type="button" class="btn-mini" data-id="${t.id}" title="Adicionar estoque a este tecido">＋ Estoque</button></td>
    </tr>`).join('');

    $('#emptyTec').classList.toggle('hidden', itens.length > 0);
    $('#qtdConsulta').textContent = `${itens.length} de ${resumo.total_tecidos} tecido(s)`;
    updateSetasOrdem();
}

async function loadDashboard() {
    const seq = ++seqDashboard;
    try {
        const q = new URLSearchParams({
            busca: consultaEstado.busca,
            situacao: consultaEstado.situacao,
            ordem: consultaEstado.ordem,
            dir: consultaEstado.dir
        });
        const { itens, resumo } = await api('/api/dashboard?' + q.toString());
        if (seq !== seqDashboard) return; /* resposta obsoleta: descarta */
        setConn(true);
        tecidosPainel = itens;
        renderKpis(resumo);
        renderAlertas(resumo);
        renderTabela(itens, resumo);
        loadCortesResumo();
    } catch {
        setConn(false);
    }
}

/* ===== Metragem cortada ===== */
function renderCorteHoje(c) {
    $('#corteHojeInfo').textContent =
        `Hoje: ${fmt(c.totais.hoje_m)} m · ${c.totais.hoje_lancamentos} corte(s) · últimos 7 dias: ${fmt(c.totais.sete_dias_m)} m`;
}

async function loadCortesResumo() {
    try {
        const c = await api('/api/cortes/resumo?dias=30');
        $('#corteKpis').innerHTML = `
          <div class="corte-kpi"><span>Hoje</span><strong>${fmt(c.totais.hoje_m)} m</strong><small>${c.totais.hoje_lancamentos} corte(s)</small></div>
          <div class="corte-kpi"><span>7 dias</span><strong>${fmt(c.totais.sete_dias_m)} m</strong><small>registros por QR</small></div>
          <div class="corte-kpi destaque"><span>30 dias</span><strong>${fmt(c.totais.periodo_m)} m</strong><small>${c.totais.lancamentos} corte(s)</small></div>`;

        const max = Math.max(...c.tecidos.map(t => t.total_m), 1);
        $('#corteTop').innerHTML = c.tecidos.length
            ? '<div class="corte-lista-head">Mais cortados no período</div>' + c.tecidos.slice(0, 3).map(t => `
              <div class="corte-linha">
                <div class="corte-linha-top"><span>${esc(t.nome)}</span><strong>${fmt(t.total_m)} m</strong></div>
                <div class="corte-barra"><span style="width:${Math.max(3, (t.total_m / max) * 100).toFixed(1)}%"></span></div>
              </div>`).join('')
            : '<p class="muted corte-vazio">Nenhum corte no período. Ao registrar um corte, a metragem aparece aqui automaticamente.</p>';
        renderCorteHoje(c);
    } catch {
        $('#corteTop').innerHTML = '<p class="muted corte-vazio">Não foi possível carregar a metragem cortada.</p>';
    }
}

async function loadCorteHoje() {
    try {
        const c = await api('/api/cortes/resumo?dias=7');
        renderCorteHoje(c);
    } catch {
        $('#corteHojeInfo').textContent = 'Hoje: —';
    }
}

$('#buscaTecido').addEventListener('input', e => {
    clearTimeout(debounceBusca);
    debounceBusca = setTimeout(() => {
        consultaEstado.busca = e.target.value.trim();
        loadDashboard();
    }, 300);
});

$('#filtroSituacao').addEventListener('change', e => {
    consultaEstado.situacao = e.target.value;
    loadDashboard();
});

$$('th[data-ordem]').forEach(th => th.onclick = () => {
    const o = th.dataset.ordem;
    if (consultaEstado.ordem === o) consultaEstado.dir = consultaEstado.dir === 'asc' ? 'desc' : 'asc';
    else { consultaEstado.ordem = o; consultaEstado.dir = 'asc'; }
    loadDashboard();
});

$('#tbodyTecidos').addEventListener('click', e => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    const tec = tecidosPainel.find(t => String(t.id) === btn.dataset.id);
    if (tec) abrirEstoque(tec);
});

/* ===== Corte ===== */
let roloAtual = null;
let scanner = null;
let scannerAo = null;

async function pararScanner() {
    const s = scanner;
    scanner = null;
    scannerAo = null;
    $('#reader').classList.add('hidden');
    $('#readerAjuste').classList.add('hidden');
    if (!s) return;
    try { await s.stop(); } catch { /* já parado */ }
    try { await s.clear(); } catch { /* sem elementos */ }
}

async function iniciarScanner(containerId, aoLer) {
    if (typeof Html5Qrcode === 'undefined') {
        toast('Câmera indisponível. Digite o código ou use um leitor USB.');
        return;
    }
    if (scanner) { await pararScanner(); return; }

    $(containerId).classList.remove('hidden');
    try {
        scanner = new Html5Qrcode(containerId.slice(1));
        scannerAo = aoLer;
        await scanner.start({ facingMode: 'environment' }, { fps: 10 }, code => {
            const texto = String(code).trim().toUpperCase();
            const ao = scannerAo;
            pararScanner().then(() => ao && ao(texto));
        });
    } catch (e) {
        await pararScanner();
        toast('❌ Não foi possível acessar a câmera: ' + (e?.message || 'permissão negada.'));
    }
}

$('#btnScanner').onclick = () => iniciarScanner('#reader', codigo => {
    $('#codigoSaida').value = codigo;
    buscarRolo();
});

$('#codigoSaida').addEventListener('keydown', e => { if (e.key === 'Enter') buscarRolo(); });
$('#btnBuscarRolo').onclick = buscarRolo;

/* Códigos de rolo começam com ROL-. Qualquer outro código é tratado
   como QR do tecido (TEC:<codigo>) e abre a ficha do tecido. */
function ehCodigoRolo(codigo) {
    return /^ROL-/i.test(String(codigo).trim());
}

async function buscarRolo() {
    const codigo = val('#codigoSaida').toUpperCase();
    if (!codigo) { toast('Informe ou escaneie o QR do tecido.'); return; }
    if (!ehCodigoRolo(codigo)) {
        /* Evita confirmar um corte no rolo anterior depois de abrir a ficha. */
        roloAtual = null;
        $('#roloInfo').classList.add('hidden');
        $('#formSaida').classList.add('hidden');
        await abrirFichaTecido(codigo, 'cortar');
        return;
    }
    try {
        roloAtual = await api('/api/rolos/' + encodeURIComponent(codigo));
        setConn(true);
        $('#metrosSaida').value = '';
        const esgotado = roloAtual.status === 'esgotado';
        $('#roloInfo').classList.remove('hidden');
        $('#roloInfo').innerHTML = `
          <strong>${esc(roloAtual.tecidos.nome)}</strong> · <span class="mono">${esc(roloAtual.codigo_qr)}</span>
          <span class="pill ${esgotado ? 'critico' : 'ok'}">${esgotado ? 'ESGOTADO' : 'ATIVO'}</span><br>
          Saldo disponível: <strong>${fmt(roloAtual.metragem_atual)} m</strong>`;
        $('#formSaida').classList.toggle('hidden', esgotado);
        if (!esgotado) $('#metrosSaida').focus();
    } catch (e) {
        roloAtual = null;
        $('#roloInfo').classList.add('hidden');
        $('#formSaida').classList.add('hidden');
        if (e instanceof TypeError) setConn(false);
        toast('❌ ' + e.message);
    }
}

$('#btnConfirmarSaida').onclick = () => semDuplicar($('#btnConfirmarSaida'), async () => {
    if (!roloAtual) { toast('Busque um rolo antes de confirmar o corte.'); return; }
    const metros = val('#metrosSaida');
    if (!(numero(metros) > 0)) { toast('Informe os metros cortados.'); return; }
    try {
        const r = await enviarComFila('/api/movimentacoes/saida', {
            codigo_qr: roloAtual.codigo_qr,
            metros,
            usuario: val('#usuarioSaida')
        }, `Corte de ${metros} m · ${roloAtual.codigo_qr}`);
        if (avisoDeEnvio(r, `✅ Corte registrado. Restam ${fmt(r.metragem_atual)} m no rolo.`)) {
            if (r.pendente) {
                setConn(false);
                $('#metrosSaida').value = '';
                $('#formSaida').classList.add('hidden');
                return;
            }
        }
        $('#metrosSaida').value = '';
        buscarRolo();
        loadCorteHoje();
        loadDashboard();
    } catch (e) { toast('❌ ' + e.message); }
});

/* ===== Contagem física ===== */
function tratarCodigoAjuste(codigo) {
    const c = String(codigo || '').trim().toUpperCase();
    if (!c) { toast('Informe ou escaneie o QR do tecido.'); return; }
    if (!ehCodigoRolo(c)) { abrirFichaTecido(c, 'contagem'); return; }
    $('#codigoAjuste').value = c;
    $('#metragemReal').focus();
}

$('#btnScannerAjuste').onclick = () => iniciarScanner('#readerAjuste', tratarCodigoAjuste);

$('#codigoAjuste').addEventListener('keydown', e => {
    if (e.key === 'Enter') tratarCodigoAjuste(val('#codigoAjuste'));
});

$('#btnAjuste').onclick = () => semDuplicar($('#btnAjuste'), async () => {
    const codigo = val('#codigoAjuste').toUpperCase();
    if (!codigo) { toast('Informe ou escaneie o QR do tecido.'); return; }
    if (!ehCodigoRolo(codigo)) { await abrirFichaTecido(codigo, 'contagem'); return; }
    const real = val('#metragemReal');
    if (real === '' || Number.isNaN(numero(real))) { toast('Informe a metragem real contada.'); return; }
    if (numero(real) < 0) { toast('A metragem real não pode ser negativa.'); return; }
    try {
        const r = await enviarComFila('/api/movimentacoes/ajuste', {
            codigo_qr: codigo,
            metragem_real: real,
            usuario: val('#usuarioAjuste')
        }, `Contagem de ${real} m · ${codigo}`);
        if (avisoDeEnvio(r, `📏 Saldo corrigido para ${fmt(r.metragem_atual)} m (diferença: ${fmt(r.diferenca)} m).`)) {
            if (r.pendente) {
                setConn(false);
                $('#metragemReal').value = '';
                return;
            }
        }
        $('#metragemReal').value = '';
        loadDashboard();
    } catch (e) { toast('❌ ' + e.message); }
});

/* ===== Ficha do tecido (QR por tecido) ===== */
const modalTecido = $('#modalTecido');
let fichaAtual = null;
let fichaAcao = 'cortar';

function fecharFicha() {
    modalTecido.classList.add('hidden');
}

function irParaTab(tab) {
    const btn = $$('.menu-item').find(b => b.dataset.tab === tab);
    if (btn) btn.click();
}

function renderFicha(f) {
    const t = f.tecido;
    const c = f.cortes;
    const acao = fichaAcao === 'contagem' ? 'Contar' : 'Cortar';
    $('#fichaTitulo').textContent = t.nome;
    $('#fichaSub').textContent =
        `${t.codigo} · mínimo ${fmt(t.estoque_minimo_m)} m` + (t.localizacao ? ` · 📍 ${t.localizacao}` : '');

    const rolosHtml = f.rolos.length
        ? `<div class="ficha-rolos">${f.rolos.map(r => `
            <button type="button" class="ficha-rolo ${r.status === 'esgotado' ? 'esgotado' : ''}"
                    ${r.status === 'esgotado' && fichaAcao !== 'contagem' ? 'disabled' : ''}
                    data-rolo="${esc(r.codigo_qr)}">
              <span class="fr-code mono">${esc(r.codigo_qr)}</span>
              <span class="fr-saldo">${fmt(r.metragem_atual)} m</span>
              <span class="fr-acao">${r.status === 'esgotado' && fichaAcao !== 'contagem' ? 'Esgotado' : acao}</span>
            </button>`).join('')}</div>`
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
        <p class="ficha-ajuda">Escolha um rolo para ${fichaAcao === 'contagem' ? 'contar' : 'registrar o corte'}.</p>
        ${rolosHtml}
      </div>
      <div class="ficha-secao">
        <strong>Últimos cortes</strong>
        ${cortesHtml}
      </div>
      <div class="ficha-acoes">
        <button type="button" class="btn-primary" data-acao="estoque">＋ Estoque</button>
        <button type="button" class="btn-secondary" data-acao="local">📍 ${t.localizacao ? 'Editar localização' : 'Definir localização'}</button>
        <button type="button" class="btn-secondary" data-acao="imprimir">🖨 Etiqueta do tecido</button>
      </div>`;
}

async function abrirFichaTecido(codigo, acao = 'cortar') {
    try {
        const f = await api('/api/tecidos/qr/' + encodeURIComponent(codigo));
        fichaAtual = f;
        fichaAcao = acao;
        renderFicha(f);
        modalTecido.classList.remove('hidden');
        setConn(true);
    } catch (e) {
        if (e instanceof TypeError) setConn(false);
        toast('❌ ' + e.message);
    }
}

$('#btnFecharFicha').onclick = fecharFicha;
modalTecido.addEventListener('click', e => {
    if (e.target === modalTecido) fecharFicha();
});

$('#fichaCorpo').addEventListener('click', e => {
    const acao = e.target.closest('[data-acao]');
    if (acao) {
        if (!fichaAtual) return;
        if (acao.dataset.acao === 'estoque') {
            const tec = fichaAtual.tecido;
            fecharFicha();
            abrirEstoque(tec);
        } else if (acao.dataset.acao === 'local') {
            editarLocalizacao(fichaAtual.tecido);
        } else if (acao.dataset.acao === 'imprimir') {
            imprimirEtiquetaTecido(fichaAtual.tecido.codigo, fichaAtual.tecido.nome);
        }
        return;
    }

    const rolo = e.target.closest('[data-rolo]');
    if (!rolo) return;
    const codigo = rolo.dataset.rolo;
    fecharFicha();
    if (fichaAcao === 'contagem') {
        irParaTab('contagem');
        $('#codigoAjuste').value = codigo;
        $('#metragemReal').value = '';
        toast('Rolo selecionado. Informe a metragem real.');
        $('#metragemReal').focus();
    } else {
        irParaTab('cortar');
        $('#codigoSaida').value = codigo;
        buscarRolo();
    }
});

/* ===== Adicionar estoque (novos rolos ou reposição) ===== */
const modalEstoque = $('#modalEstoque');
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
    $('#estoqueTitulo').textContent = 'Adicionar estoque — ' + tec.nome;
    $('#estoqueResumo').textContent =
        `Saldo atual: ${fmt(tec.saldo_m)} m · ${tec.rolos_ativos} rolo(s) ativo(s) · mínimo ${fmt(tec.estoque_minimo_m)} m`;
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
    modalEstoque.classList.remove('hidden');
    setTimeout(() => $('#estoqueMetros').focus(), 50);

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
    modalEstoque.classList.add('hidden');
    tecidoEstoque = null;
}

$('#modoEstoque').addEventListener('click', e => {
    const btn = e.target.closest('.mode');
    if (btn) setModoEstoque(btn.dataset.modo);
});
['#estoqueMetros', '#estoqueQtd'].forEach(sel =>
    $(sel).addEventListener('input', atualizarPreviewEstoque));
$('#btnFecharEstoque').onclick = fecharEstoque;
modalEstoque.addEventListener('click', e => {
    if (e.target === modalEstoque) fecharEstoque();
});

$('#btnAddEstoque').onclick = () => semDuplicar($('#btnAddEstoque'), async () => {
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
              <button type="button" class="btn-secondary" id="btnImprimirEstoque">🖨 Imprimir etiqueta do tecido</button>`;
            $('#estoqueResultado').classList.remove('hidden');
            $('#btnImprimirEstoque').onclick = () => imprimirEtiquetaTecido(r.tecido.codigo, nome);
            toast(`✅ ${r.quantidade} rolo(s) cadastrado(s) · ${fmt(r.total_m)} m no total.`);
        } else {
            $('#estoqueResultado').innerHTML = `
              <div class="resultado-ok">✅ ${fmt(r.metros)} m adicionados ao rolo
                <span class="mono">${esc(r.codigo_qr)}</span>.<br>Novo saldo: <strong>${fmt(r.metragem_atual)} m</strong>.</div>
              <button type="button" class="btn-secondary" id="btnImprimirEstoque">🖨 Imprimir etiqueta do tecido</button>`;
            $('#estoqueResultado').classList.remove('hidden');
            $('#btnImprimirEstoque').onclick = () => imprimirEtiquetaTecido(r.tecido.codigo, r.tecido.nome);
            toast(`✅ Metragem somada ao rolo ${r.codigo_qr}.`);
        }

        $('#estoqueMetros').value = '';
        $('#estoqueMetrosRolo').value = '';
        $('#estoqueQtd').value = '1';
        atualizarPreviewEstoque();
        loadDashboard();
        loadCorteHoje();
    } catch (e) { toast('❌ ' + e.message); }
});

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
        <strong class="mono">TEC:${esc(codigo)}</strong>
        <small>${esc(nome)}</small>
      </div>
    </div>`;
}

async function mostrarEtiquetaTecido(codigo, nome, resumoHtml = '') {
    $('#etiquetaTecido').classList.remove('hidden');
    $('#etiquetaTecido').innerHTML = `
      ${resumoHtml ? `<div class="lote-resumo">${resumoHtml}</div>` : ''}
      <div id="etiquetaTecidoQr" class="etiqueta compacta"><span class="muted">Gerando QR do tecido…</span></div>
      <button type="button" class="btn-secondary" id="btnImprimirTecido" disabled>🖨 Imprimir etiqueta do tecido</button>`;
    try {
        const qr = await qrTecido(codigo);
        $('#etiquetaTecidoQr').innerHTML = etiquetaTecidoHtml(codigo, nome, qr);
        const btn = $('#btnImprimirTecido');
        btn.disabled = false;
        btn.onclick = () => imprimirEtiquetaTecido(codigo, nome);
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

/* ===== Novo tecido ===== */
function atualizarPreviewTecido() {
    const metros = numero(val('#tecMetros'));
    const qtd = Math.max(1, parseInt(val('#tecRoloQtd'), 10) || 1);
    if (!(metros > 0)) {
        $('#tecLotePreview').textContent = 'Sem estoque inicial: apenas o cadastro do tecido.';
        return;
    }
    $('#tecLotePreview').textContent = `${qtd} rolo(s) × ${fmt(metros)} m = ${fmt(metros * qtd)} m no total.`;
}

['#tecMetros', '#tecRoloQtd'].forEach(sel =>
    $(sel).addEventListener('input', atualizarPreviewTecido));

$('#btnTecido').onclick = () => semDuplicar($('#btnTecido'), async () => {
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
    } catch (e) { toast('❌ ' + e.message); }
});

/* ===== Histórico ===== */
let movsCache = [];

async function loadHistorico() {
    try {
        movsCache = await api('/api/movimentacoes?limit=100');
        setConn(true);
        renderHistorico();
    } catch {
        setConn(false);
        $('#tbodyMov').innerHTML = '';
        $('#emptyMov').textContent = 'Sem conexão com o servidor.';
        $('#emptyMov').classList.remove('hidden');
    }
}

function renderHistorico() {
    const tipo = $('#filtroMov').value;
    const lista = tipo ? movsCache.filter(m => m.tipo === tipo) : movsCache;
    $('#tbodyMov').innerHTML = lista.map(m => {
        const data = new Date(m.criado_em).toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
        const cancelada = !!m.cancelada_em;
        const sinal = m.tipo === 'saida' ? '-' : m.metros > 0 ? '+' : '';
        const classe = m.tipo === 'saida' ? 'neg' : m.metros > 0 ? 'pos' : '';
        const podeEstornar = !cancelada && m.tipo !== 'estorno';
        const acao = podeEstornar
            ? `<button type="button" class="btn-mini ghost" data-estorno="${m.id}" title="Desfazer este lançamento">↩ Estornar</button>`
            : cancelada ? '<span class="muted small">já estornada</span>' : '';
        return `<tr class="${cancelada ? 'linha-cancelada' : ''}">
          <td class="muted">${esc(data)}</td>
          <td><span class="badge ${esc(m.tipo)}">${esc(m.tipo).toUpperCase()}</span>${cancelada ? '<span class="badge cancelada">CANCELADA</span>' : ''}</td>
          <td class="strong">${esc(m.rolos?.tecidos?.nome ?? '—')}</td>
          <td class="muted mono">${esc(m.rolos?.codigo_qr ?? '')}</td>
          <td class="num strong ${classe}">${sinal}${fmt(m.metros)} m</td>
          <td>${esc(m.usuario) || '—'}</td>
          <td class="num">${acao}</td>
        </tr>`;
    }).join('');
    $('#emptyMov').classList.toggle('hidden', lista.length > 0);
    if (!lista.length) $('#emptyMov').textContent = 'Nenhuma movimentação encontrada.';
}

$('#filtroMov').addEventListener('change', renderHistorico);
$('#btnAtualizarHistorico').onclick = loadHistorico;

$('#tbodyMov').addEventListener('click', e => {
    const btn = e.target.closest('[data-estorno]');
    if (!btn) return;
    const m = movsCache.find(x => String(x.id) === btn.dataset.estorno);
    if (m) estornarMovimentacao(m);
});

/* ===== Dica de primeira visita ===== */
const DICA_KEY = 'tecsource_dica_v1_4';
if (!localStorage.getItem(DICA_KEY)) $('#dicaBoasVindas').classList.remove('hidden');
$('#btnFecharDica').onclick = () => {
    localStorage.setItem(DICA_KEY, '1');
    $('#dicaBoasVindas').classList.add('hidden');
};

/* ===== Teclado ===== */
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    fecharMobile();
    fecharAjuda();
    fecharEstoque();
    fecharFicha();
    esconderDica();
    pararScanner();
});

/* ===== Sugestões por nome nos campos de QR ===== */
ligarSugestoes('#codigoSaida', '#sugestoesSaida', buscarRolo);
ligarSugestoes('#codigoAjuste', '#sugestoesAjuste', () => tratarCodigoAjuste(val('#codigoAjuste')));

/* ===== Fila offline ===== */
window.addEventListener('tecfila:sincronizado', e => {
    toast(`📤 ${e.detail.enviados} lançamento(s) sincronizado(s).`);
    setConn(true);
    loadDashboard();
    if ($('#tab-historico').classList.contains('active')) loadHistorico();
});

/* ===== Inicialização ===== */
const operadorSalvo = localStorage.getItem(OP_KEY);
if (operadorSalvo) {
    $('#loginOverlay').classList.add('hidden');
    setOperador(operadorSalvo);
}

atualizarPreviewTecido();
loadDashboard();
setInterval(loadDashboard, 30000);
