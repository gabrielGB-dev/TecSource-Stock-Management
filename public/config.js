/* ============================================================
   TecSource · configuração de ambiente do frontend
   ------------------------------------------------------------
   Carregado antes de fila.js / app.js / mobile.js.

   apiBase:
     ''  → a API é servida pelo mesmo host do frontend
           (npm start local, ou o próprio backend no Render).
     'https://seu-servico.onrender.com'
         → frontend estático (GitHub Pages) chamando a API no Render.

   Ao publicar no GitHub Pages, preencha apiBase com a URL do Render.
   Toda chamada do app passa por window.apiUrl(), então esse é o único
   lugar que precisa mudar.
   ============================================================ */

window.TECSOURCE_CONFIG = {
    apiBase: ''
};

/* Monta a URL final da API sem duplicar barras. */
window.apiUrl = caminho => {
    const base = String(window.TECSOURCE_CONFIG?.apiBase || '').replace(/\/+$/, '');
    return base + (String(caminho).startsWith('/') ? caminho : '/' + caminho);
};
