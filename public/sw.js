/* TecSource — Service Worker (PWA mobile)
   Estratégia:
   - Estáticos do app: cache-first com atualização em segundo plano.
   - Navegação: network-first com fallback para o shell em cache (offline).
   - API: sempre rede (dados de estoque nunca devem ser servidos do cache).
*/
const VERSAO = 'tecsource-v14';
const CACHE = `${VERSAO}-estatico`;

const ESTATICOS = [
    './mobile.html',
    './mobile.css',
    './mobile.js',
    './config.js',
    './fila.js',
    './manifest.webmanifest',
    './vendor/html5-qrcode.min.js',
    './img/logo-tecsource.jpg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE)
            .then(cache => cache.addAll(ESTATICOS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(chaves => Promise.all(
                chaves.filter(k => k.startsWith('tecsource-') && k !== CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    /* API: somente rede. Em falha, o app trata a ausência de conexão. */
    if (url.pathname.startsWith('/api/')) return;

    /* Navegação: rede primeiro; offline cai para o shell do app mobile. */
    if (req.mode === 'navigate') {
        const shell = () => caches.match('./mobile.html');
        const semConexao = () => new Response('Sem conexão com o servidor.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (url.pathname.endsWith('/mobile.html')) {
                        const copia = res.clone();
                        caches.open(CACHE).then(c => c.put('./mobile.html', copia)).catch(() => { });
                    }
                    return res;
                })
                .catch(async () => {
                    if (url.pathname.endsWith('/mobile.html')) return (await shell()) || semConexao();
                    return (await caches.match(req)) || semConexao();
                })
        );
        return;
    }

    /* Shell do app (HTML/JS/CSS): rede primeiro, cache só offline.
       Cache-first aqui misturava HTML novo com JS antigo e quebrava
       o fluxo da ficha ("null.classList") no primeiro acesso pós-update. */
    const SHELL = ['mobile.html', 'mobile.css', 'mobile.js', 'config.js', 'fila.js'];
    if (SHELL.includes(url.pathname.split('/').pop())) {
        event.respondWith(
            fetch(req).then(res => {
                if (res && res.ok) {
                    const copia = res.clone();
                    caches.open(CACHE).then(c => c.put(req, copia)).catch(() => { });
                }
                return res;
            }).catch(() => caches.match(req))
        );
        return;
    }

    /* Estáticos: cache primeiro, revalidando em segundo plano. */
    event.respondWith(
        caches.match(req).then(cacheado => {
            const rede = fetch(req).then(res => {
                if (res && res.ok) {
                    const copia = res.clone();
                    caches.open(CACHE).then(c => c.put(req, copia)).catch(() => { });
                }
                return res;
            }).catch(() => cacheado);
            return cacheado || rede;
        })
    );
});
