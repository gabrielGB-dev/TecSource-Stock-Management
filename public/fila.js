/* ============================================================
   TecSource · Fila offline de lançamentos
   ------------------------------------------------------------
   Guarda cortes e contagens feitos sem conexão no próprio
   aparelho (localStorage) e reenvia em ordem quando a internet
   volta. Cada item leva uma client_key única: se o servidor já
   gravou aquele lançamento, ele responde com `repetido: true` em
   vez de debitar duas vezes.

   Exposto como window.TecFila:
     TecFila.enviar(url, corpo, { rotulo })  → Promise
         tenta enviar agora; sem conexão, guarda e devolve
         { pendente: true }
     TecFila.pendentes()                    → lista atual
     TecFila.sincronizar()                  → reenvia a fila
     TecFila.descartar()                    → limpa a fila
     TecFila.aoMudar(fn)                    → observa mudanças

   Eventos na window:
     tecfila:mudou        { pendentes, erro }
     tecfila:sincronizado { enviados }
   ============================================================ */

(() => {
    'use strict';

    const CHAVE = 'tecsource_fila_v1';
    const MAX_ITENS = 200;
    const TIMEOUT_MS = 15000;

    let memoria = null; /* fallback quando o localStorage está bloqueado */
    let sincronizando = false;
    let observadores = [];

    /* ---------- persistência ---------- */

    function ler() {
        if (memoria) return memoria;
        try {
            const bruto = localStorage.getItem(CHAVE);
            const lista = bruto ? JSON.parse(bruto) : [];
            return Array.isArray(lista) ? lista : [];
        } catch {
            memoria = [];
            return memoria;
        }
    }

    function gravar(lista) {
        if (memoria) {
            memoria = lista;
            return;
        }
        try {
            localStorage.setItem(CHAVE, JSON.stringify(lista));
        } catch {
            /* cota cheia ou modo privado: mantém em memória nesta sessão */
            memoria = lista;
        }
    }

    function novaChave() {
        try {
            if (window.crypto?.randomUUID) return crypto.randomUUID();
            const b = new Uint8Array(16);
            if (window.crypto?.getRandomValues) crypto.getRandomValues(b);
            else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
            b[6] = (b[6] & 15) | 64;
            b[8] = (b[8] & 63) | 128;
            const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
            return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        } catch {
            return 'off-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        }
    }

    /* ---------- estado ---------- */

    function estado() {
        const lista = ler();
        return {
            pendentes: lista.length,
            erro: lista.length && lista[0].erro ? lista[0].erro : null,
            online: navigator.onLine !== false,
            sincronizando
        };
    }

    function avisar() {
        const e = estado();
        observadores.forEach(fn => {
            try { fn(e); } catch { /* observador com erro não derruba a fila */ }
        });
        window.dispatchEvent(new CustomEvent('tecfila:mudou', { detail: e }));
        desenhar();
    }

    /* ---------- envio ---------- */

    async function postar(item) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            /* A fila guarda caminhos relativos ('/api/...'). Ao sincronizar,
               aponta para a API configurada (Render) quando o frontend é
               estático (GitHub Pages). */
            const destino = window.apiUrl ? window.apiUrl(item.url) : item.url;
            const res = await fetch(destino, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item.corpo),
                signal: ctrl.signal
            });
            let j;
            try {
                j = await res.json();
            } catch {
                const erro = new Error(`Resposta inválida do servidor (HTTP ${res.status}).`);
                erro.servidor = true;
                throw erro;
            }
            if (!j.ok) {
                const erro = new Error(j.erro || 'Erro no servidor.');
                erro.servidor = true;
                throw erro;
            }
            return j.data;
        } finally {
            clearTimeout(timer);
        }
    }

    function guardar(item) {
        const lista = ler();
        if (lista.length >= MAX_ITENS) lista.shift(); /* nunca cresce sem limite */
        lista.push(item);
        gravar(lista);
        avisar();
    }

    async function enviar(url, corpo, { rotulo } = {}) {
        const chave = novaChave();
        const item = {
            id: chave,
            url,
            corpo: { ...(corpo || {}), client_key: chave },
            rotulo: rotulo || 'Lançamento',
            criado_em: Date.now(),
            erro: null
        };

        if (navigator.onLine === false) {
            guardar(item);
            return { pendente: true, client_key: chave };
        }

        try {
            return await postar(item);
        } catch (e) {
            /* TypeError/AbortError = falha de rede: guarda e tenta depois */
            if (e?.name === 'AbortError' || !e?.servidor) {
                guardar(item);
                return { pendente: true, client_key: chave };
            }
            throw e; /* regra de negócio: o usuário precisa ver o erro agora */
        }
    }

    /* Reenvia em ordem. Para no primeiro erro para não aplicar cortes fora
       de sequência; o item com erro fica na fila e aparece no aviso. */
    async function sincronizar() {
        if (sincronizando) return;
        if (!ler().length) { avisar(); return; }
        if (navigator.onLine === false) { avisar(); return; }

        sincronizando = true;
        avisar();

        let enviados = 0;
        try {
            for (;;) {
                const lista = ler();
                if (!lista.length) break;
                const item = lista[0];

                try {
                    await postar(item);
                } catch (e) {
                    const listaAtual = ler();
                    if (listaAtual[0]?.id === item.id) {
                        listaAtual[0].erro = e?.servidor
                            ? (e.message || 'O servidor recusou o lançamento.')
                            : 'Sem conexão com o servidor.';
                        gravar(listaAtual);
                    }
                    if (!e?.servidor) break; /* rede caiu: tenta de novo depois */
                    break;
                }

                const restante = ler().filter(x => x.id !== item.id);
                gravar(restante);
                enviados++;
                avisar();
            }
        } finally {
            sincronizando = false;
            avisar();
        }

        if (enviados) {
            window.dispatchEvent(new CustomEvent('tecfila:sincronizado', { detail: { enviados } }));
        }
    }

    function descartar() {
        const lista = ler();
        if (!lista.length) return;
        const ok = window.confirm(
            `Descartar ${lista.length} lançamento(s) que ainda não foram enviados ao servidor?\n` +
            'Esses cortes/contagens NÃO serão registrados no estoque.'
        );
        if (!ok) return;
        gravar([]);
        avisar();
    }

    function descartarItem(id) {
        const lista = ler();
        const item = lista.find(x => x.id === id);
        if (!item) return;
        const ok = window.confirm(
            `Descartar "${item.rotulo}"?\nEle NÃO será registrado no estoque.`
        );
        if (!ok) return;
        gravar(lista.filter(x => x.id !== id));
        avisar();
    }

    /* ---------- aviso visual ---------- */

    const ESTILO = `
    #tf-banner {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 95;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      max-width: min(640px, calc(100vw - 24px));
      padding: 10px 14px;
      border-radius: 10px;
      background: #0b2135;
      color: #fff;
      border-left: 5px solid #f59e0b;
      box-shadow: 0 10px 30px rgb(11 33 53 / .35);
      font-size: .86rem;
      font-weight: 600;
      line-height: 1.3;
    }
    #tf-banner[hidden] { display: none; }
    #tf-banner.tf-erro { border-left-color: #ef4444; }
    #tf-banner.tf-sync { border-left-color: #38bdf8; }
    #tf-banner .tf-texto { flex: 1 1 220px; min-width: 0; }
    #tf-banner .tf-texto small {
      display: block;
      margin-top: 2px;
      font-weight: 500;
      color: #cbd5e1;
      word-break: break-word;
    }
    #tf-banner button {
      font: inherit;
      font-size: .8rem;
      font-weight: 700;
      border: 0;
      border-radius: 7px;
      padding: 7px 12px;
      cursor: pointer;
      background: #f59e0b;
      color: #1f2937;
    }
    #tf-banner button.tf-sec {
      background: transparent;
      color: #e2e8f0;
      border: 1px solid #475569;
    }
    #tf-banner button:disabled { opacity: .55; cursor: default; }
    @media (max-width: 700px) {
      #tf-banner {
        top: auto;
        bottom: calc(78px + env(safe-area-inset-bottom, 0px));
      }
    }
    `;

    let banner = null;
    let texto = null;
    let btnSync = null;
    let btnDescartar = null;

    function montar() {
        if (banner) return;
        const estilo = document.createElement('style');
        estilo.id = 'tf-estilo';
        estilo.textContent = ESTILO;
        document.head.appendChild(estilo);

        banner = document.createElement('div');
        banner.id = 'tf-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        banner.hidden = true;
        banner.innerHTML = `
          <div class="tf-texto"></div>
          <button type="button" class="tf-sync">Sincronizar</button>
          <button type="button" class="tf-sec tf-descartar">Descartar</button>`;
        document.body.appendChild(banner);

        texto = banner.querySelector('.tf-texto');
        btnSync = banner.querySelector('.tf-sync');
        btnDescartar = banner.querySelector('.tf-descartar');
        btnSync.addEventListener('click', () => sincronizar());
        btnDescartar.addEventListener('click', () => {
            const lista = ler();
            /* item recusado pelo servidor: remove só ele; senão limpa a fila */
            if (lista.length && lista[0].erro) descartarItem(lista[0].id);
            else descartar();
        });
    }

    function desenhar() {
        if (typeof document === 'undefined' || !document.body) return;
        const e = estado();
        if (!e.pendentes) {
            if (banner) banner.hidden = true;
            return;
        }
        montar();
        banner.hidden = false;
        banner.classList.toggle('tf-erro', !!e.erro);
        banner.classList.toggle('tf-sync', e.sincronizando);

        if (e.sincronizando) {
            texto.innerHTML = `⏳ Sincronizando ${e.pendentes} lançamento(s)…`;
            btnSync.disabled = true;
            btnDescartar.disabled = true;
            return;
        }

        const plural = e.pendentes === 1 ? 'lançamento' : 'lançamentos';
        if (e.erro) {
            texto.innerHTML = `⚠ ${e.pendentes} ${plural} não sincronizou(s)<small>${escapar(e.erro)}</small>`;
        } else if (!e.online) {
            texto.innerHTML = `📴 Sem conexão · ${e.pendentes} ${plural} guardado(s) neste aparelho<small>Serão enviados automaticamente quando a internet voltar.</small>`;
        } else {
            texto.innerHTML = `📥 ${e.pendentes} ${plural} aguardando envio<small>Guardado(s) neste aparelho com segurança.</small>`;
        }

        btnSync.disabled = !e.online;
        btnDescartar.disabled = false;
        btnSync.textContent = e.erro ? 'Tentar de novo' : 'Sincronizar agora';
        btnDescartar.textContent = e.erro ? 'Descartar este' : 'Descartar tudo';
    }

    function escapar(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---------- API pública ---------- */

    window.TecFila = {
        enviar,
        sincronizar,
        descartar,
        pendentes: () => ler().slice(),
        aoMudar(fn) {
            if (typeof fn !== 'function') return () => { };
            observadores.push(fn);
            try { fn(estado()); } catch { /* ignora */ }
            return () => { observadores = observadores.filter(x => x !== fn); };
        },
        _chave: novaChave
    };

    /* ---------- ciclo de vida ---------- */

    if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
            avisar();
            setTimeout(sincronizar, 400);
        });
        window.addEventListener('offline', avisar);

        const iniciar = () => {
            desenhar();
            if (navigator.onLine !== false) setTimeout(sincronizar, 700);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
        else iniciar();
    }
})();
