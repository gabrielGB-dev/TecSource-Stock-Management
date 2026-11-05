# TecSource — Gestão de Estoque de Tecidos

Sistema interno da **MAITE Decorações** para controlar o estoque de tecidos com baixa por **QR Code do tecido** no momento do corte, alertas de reposição, contagem física e histórico auditável.

A v1.4.0 mantém o **tecido** no centro (QR único por tecido, ficha com metragem, rolos e cortes) e adiciona o que faltava para o uso real: **fila offline com reenvio automático**, **busca por nome e localização**, **estorno auditável** de lançamentos e **reset de demonstração** com histórico de 60 dias. A base da v1.3.0 (QR por tecido, corte com seleção de rolo, entrada unificada) continua igual.

---

## O que mudou na v1.4.0

- **Fila offline de cortes e contagens.** Se a internet cair ou o servidor não responder, o lançamento é guardado no próprio aparelho e reenviado sozinho quando a conexão volta. Um aviso fixo mostra quantos lançamentos estão pendentes e permite sincronizar ou descartar.
- **Idempotência de verdade.** Cada lançamento leva uma `client_key` única. Se o mesmo corte for reenviado (retry, duplo toque, reconexão), o servidor devolve `repetido: true` e **não debita duas vezes**.
- **Busca por nome, código e localização.** O painel filtra pelos três campos e os campos de QR mostram sugestões enquanto o nome é digitado — sem precisar decorar o código.
- **Localização física do tecido.** Campo novo no cadastro, exibido no painel, na ficha e no cartão mobile, com edição pela própria ficha.
- **Estorno auditável.** O botão **↩ Estornar** no histórico desfaz um lançamento: o saldo do rolo é devolvido, a linha original fica marcada como `CANCELADA` e uma linha de `estorno` registra quem desfez e o motivo. Nada é apagado.
- **`demo:reset` com cenário pronto.** Recria o banco com 14 tecidos, 20 rolos e ~60 dias de cortes coerentes para apresentações.
- **Confiabilidade:** fuso horário fixado (`-03:00`), janelas de 30 dias em dias de calendário (a série do gráfico fecha com o total), códigos de rolo de 48 bits com retry, versão única lida do `package.json` e encerramento limpo do servidor.

---

## Funcionalidades

### Desktop (`/`)

- **Painel:** estoque total, cortado nos últimos 30 dias, alertas e lista de tecidos com saldo, mínimo, rolos ativos, consumo, cobertura, situação, localização e **＋ Estoque**.
- **Corte:** leitura do QR do tecido (ou código antigo de rolo), ficha com metragem/rolos/cortes, seleção do rolo e registro da metragem cortada. Com o campo de código vazio, digitar parte do nome mostra sugestões.
- **Contagem:** leitura do QR do tecido, seleção do rolo e informação da metragem real; a diferença vira um ajuste auditável.
- **Novo tecido:** cadastro com estoque mínimo, localização opcional, primeiros rolos opcionais (metros por rolo × quantidade) e etiqueta QR única do tecido.
- **Histórico:** entradas, cortes, ajustes e estornos com tecido, rolo, metros e responsável. Lançamentos podem ser desfeitos com **↩ Estornar**.
- **Metragem cortada:** totais de hoje, 7 e 30 dias e os tecidos mais cortados.
- **Acesso pelo celular:** QR Code que abre a interface mobile na rede local.
- **Fila offline:** cortes e contagens feitos sem conexão ficam guardados no aparelho e são enviados automaticamente quando a rede volta.

### Mobile (`/mobile.html`)

- Navegação inferior com **Painel, Ler QR, Tecido e Histórico**.
- A aba **Ler QR** é o hub único, com três estados na mesma tela: **leitura** (escanear ou digitar/buscar por nome) → **ficha inline** do tecido (saldo, rolos, cortes, ＋ Estoque, 📍 Localização, etiqueta) → **lançamento** no rolo escolhido (✂ Cortar / 📏 Contar), com **← Voltar à ficha**. Sem popups: um escaneio, uma tela.
- Tocar no **cartão do tecido no Painel** abre a mesma ficha na aba Ler QR (o atalho **＋ Estoque** continua no card).
- Os mesmos 3 indicadores e os mesmos cartões de tecido.
- Leitor de QR em tela cheia e impressão/cópia do código `TEC:<codigo>`.
- Busca com sugestões por nome, localização no cartão do tecido e estorno pelo histórico.
- Fila offline com o mesmo aviso de sincronização do desktop.
- Guia **Como usar** e dicas contextuais em cada tela.
- PWA instalável, com cache do app shell.

---

## Stack e estrutura

| Camada | Tecnologia |
|---|---|
| Servidor | Node.js 18+ e Express 4 |
| Banco | PostgreSQL 15+ — **Supabase** em produção, `docker compose` no local |
| Driver | `pg` (node-postgres) |
| QR Code | `qrcode` (backend) e `html5-qrcode` (leitura) |
| Frontend | HTML, CSS e JavaScript puros, sem build |

```
.
├── public/                                      # Publicado no GitHub Pages
│   ├── index.html / app.js / style.css          # Desktop
│   ├── mobile.html / mobile.js / mobile.css     # Mobile (PWA)
│   ├── config.js                                # ⚙ apiBase — endereço da API
│   ├── fila.js                                  # Fila offline de lançamentos
│   ├── manifest.webmanifest / sw.js / icons/    # PWA
│   ├── img/logo-tecsource.jpg                   # Logotipo TecSource
│   └── vendor/html5-qrcode.min.js
├── server/                                      # Publicado no Render
│   ├── src/index.js                             # Rotas, CORS e regras de negócio
│   ├── src/db.js                                # Pool pg, transações e tradução de tipos
│   ├── scripts/db-setup.js                      # Cria/atualiza estrutura e dados demo
│   ├── .env.example                             # Modelo das variáveis de ambiente
│   └── package.json
├── sql/schema.sql                               # PostgreSQL: funções, tabelas, RLS
├── sql/view.sql                                 # View de saldo e indicadores
├── docker-compose.yml                           # PostgreSQL local (dev/feira)
├── .github/workflows/pages.yml                  # Publica public/ no GitHub Pages
├── render.yaml                                  # Blueprint do backend no Render
├── MVP                                          # Contexto do problema
├── ANALISE.md                                   # Análise técnica
├── documentacao_do_sistema.md                   # Documento de apresentação
└── README.md
```

---

## Setup rápido

Todos os comandos de servidor são executados em `server/`.

```bash
cd server
npm install
cp .env.example .env    # edite com a DATABASE_URL do Supabase
npm run db:setup        # cria tabelas, funções, índices, RLS e view
npm start
```

Acesse:

- Desktop: <http://localhost:3000>
- Mobile: <http://localhost:3000/mobile.html>

`.env`:

```env
DATABASE_URL=postgresql://postgres.SEU_PROJETO:SUA_SENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
DATABASE_SSL=true
PORT=3000
# ORIGENS_PERMITIDAS=https://usuario.github.io
```

> A connection string está em **Project Settings → Database → Connection string → URI**. Prefira a porta **6543 (Connection Pooler)** para a API no Render; a 5432 (conexão direta) também funciona. Senhas com `@`, `#`, `/` ou `:` precisam de `encodeURIComponent`.

`DATABASE_SSL=true` é obrigatório no Supabase (o certificado é gerenciado). Sem ele: `SELF_SIGNED_CERT_IN_CHAIN`.

### Banco local (sem depender do Supabase)

```bash
docker compose up -d     # PostgreSQL 16 na porta 5432
```

```env
DATABASE_URL=postgresql://postgres:tecsource@localhost:5432/tecsource
DATABASE_SSL=false
```

Depois: `cd server && npm run db:setup`.

### Comandos

| Comando | O que faz |
|---|---|
| `npm run db:setup` | Cria/atualiza funções de data, tabelas, colunas novas, índices, RLS e view. Seguro para repetir. |
| `npm run db:demo` | Setup + dados de exemplo, se o banco estiver vazio. |
| `npm run db:check` | Diagnóstico da conexão, estrutura e RLS. |
| `npm run db:reset` | **Apaga tabelas e view** (o database é preservado) e recria vazio. Exige confirmação: `CONFIRMAR_RESET=1 npm run db:reset`. |
| `npm run demo:reset` | Recria com o cenário de demonstração (14 tecidos, 20 rolos, ~60 dias de cortes). |
| `npm run feira:reset` | **Modo feira:** troca os dados (em transação, sem apagar a estrutura) pelo cenário dos **4 tecidos com QR impresso** (TEX-001…TEX-004) + ~60 dias de histórico coerente. Use entre visitantes para restaurar o stand em ~1 s. |
| `npm run feira:check` | Valida o cenário carregado: view do painel, saldo por rolo, série de 30 dias e datas. |
| `npm start` | Inicia o servidor. |

> `db:reset` e `demo:reset` **apagam os dados existentes**. Faça backup antes de rodar contra o banco real.

Alternativa manual (SQL Editor do Supabase, ou `psql`):

```bash
psql "$DATABASE_URL" -f sql/schema.sql
psql "$DATABASE_URL" -f sql/view.sql
```

> No Supabase, também dá para colar o conteúdo de `sql/schema.sql` e depois `sql/view.sql` no **SQL Editor**. A ordem importa: a view usa `tecsource_dia()`, criada no schema.

---

## Como usar

O guia completo também está dentro do sistema em **Como usar** (desktop) ou no botão **?** da barra superior (mobile). Os botões **?** ao lado dos títulos explicam cada função.

### 1. Cadastrar o tecido

Em **Novo tecido**, informe código, nome e estoque mínimo. Se o material já chegou, preencha **metros por rolo** e **quantidade de rolos**. Preencha **Localização** com o ponto físico (ex.: `Corredor A · Prateleira 2`), que aparece no painel e ajuda a achar o rolo. Ao salvar, o sistema gera **uma etiqueta QR do tecido** com o conteúdo `TEC:<codigo>`. Sem metragem, apenas o cadastro e a etiqueta são gerados.

A localização também pode ser corrigida depois pela **ficha do tecido**, no botão **📍 Editar localização**.

### 2. Dar entrada em mais material

No **Painel**, clique em **＋ Estoque** no tecido e escolha:

- **Novo(s) rolo(s)** — informe metros por rolo e quantidade;
- **Repor em rolo** — escolha o rolo existente e informe os metros.

A etiqueta do tecido não muda: o QR é do tecido, e os rolos ficam dentro da ficha.

### 3. Registrar o corte

Em **Ler QR**, escaneie o **QR do tecido** (ou digite o código). Se preferir não escanear, digite parte do nome e escolha o tecido na lista de sugestões. A ficha mostra metragem, rolos e cortes. Toque em **✂ Cortar** no rolo desejado, informe os metros cortados e confirme. O saldo cai na hora e a metragem entra no indicador **Cortado (30d)**.

Sem conexão, o corte é guardado no aparelho e enviado sozinho quando a rede voltar. O aviso no topo mostra quantos lançamentos estão pendentes.

### 4. Conferir a contagem

Na mesma aba **Ler QR**, escaneie o QR do tecido e toque em **📏 Contar** no rolo que foi medido. Informe a metragem real. A diferença entre o sistema e o físico é gravada como **ajuste**. Se for zero, nada é registrado. Códigos antigos de rolo (`ROL-…`) também funcionam.

### 5. Acompanhar

O **Painel** mostra alertas, consumo e cobertura. O **Histórico** mostra todas as entradas, cortes, ajustes e estornos. Use o filtro para ver só os estornos.

### 6. Desfazer um lançamento

No **Histórico**, clique em **↩ Estornar** ao lado do lançamento. O sistema devolve o valor ao saldo do rolo, marca a linha original como `CANCELADA` e grava uma nova linha de `estorno` com responsável e motivo. O lançamento **não some do histórico** — a auditoria fica preservada.

### Regras rápidas

- Valores aceitam vírgula decimal (`12,5`) e milhar (`1.234,56`).
- O corte não pode ser maior que o saldo do rolo.
- Ao chegar a zero, o rolo passa para `esgotado`.
- A cobertura é `saldo ÷ (consumo de 30 dias ÷ 30)`; sem consumo, aparece `—`.
- Entradas em lote usam a mesma metragem para todos os rolos e aceitam até **100 rolos** por lançamento.
- Lançamentos estornados **não entram** no saldo, no consumo de 30 dias nem nos cortes do dia.
- Não há exclusão pela interface: correções são feitas pela contagem ou pelo estorno.

| Situação | Regra |
|---|---|
| `OK` | saldo ≥ estoque mínimo |
| `BAIXO` | 0 < saldo < mínimo |
| `CRÍTICO` | saldo ≤ 0 |

---

## Mobile e PWA

No celular, use o IP do computador na rede local:

```
http://192.168.0.15:3000/mobile.html
```

No desktop, **Abrir no celular (QR)** gera o código de acesso.

Câmera, service worker e instalação exigem **HTTPS** ou `localhost`:

| Recurso | `http://IP:3000` | `https://` ou `localhost` |
|---|---|---|
| Interface e formulários | ✅ | ✅ |
| Digitar o código do tecido ou do rolo | ✅ | ✅ |
| Escanear QR pela câmera | ❌ | ✅ |
| Instalar como aplicativo | ❌ (Android) | ✅ |
| Cache offline do app shell | ❌ | ✅ |
| Fila offline de cortes e contagens | ✅ | ✅ |

Para testar no Android via USB: `adb reverse tcp:3000 tcp:3000` e abra `http://localhost:3000/mobile.html`. Em produção, use HTTPS com proxy reverso ou túnel seguro.

### Offline de verdade

| Situação | O que acontece |
|---|---|
| Servidor caiu, mas o navegador está aberto | Cortes e contagens vão para a fila do aparelho e são reenviados na sequência ao voltar. |
| Fila com erro de negócio (ex.: corte acima do saldo) | O lançamento fica na fila com o motivo visível; nada é descartado em silêncio. |
| Página recarregada sem conexão | Só é possível com o app shell em cache (HTTPS ou `localhost`). |
| Mesmo lançamento enviado duas vezes | O servidor responde `repetido: true` e não debita de novo. |

O shell funciona offline; os dados ficam no aparelho até a fila conseguir sincronizar.

---

## API

Respostas no formato `{ "ok": true, "data": ... }` ou `{ "ok": false, "erro": "..." }`.

Base local: `http://localhost:3000`. Em produção: `https://SEU-SERVICO.onrender.com` (o `apiBase` de `public/config.js`). O CORS libera as origens de `ORIGENS_PERMITIDAS`.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/health` | Servidor e conexão com o banco |
| `GET` | `/api/dashboard` | Tecidos + resumo (`busca`, `situacao`, `ordem`, `dir`) |
| `GET` | `/api/tecidos` | Lista de tecidos com saldo e indicadores (`?busca=`) |
| `GET` | `/api/tecidos/qr/:codigo` | Ficha do tecido (`TEC:<codigo>` ou código) com rolos e cortes |
| `GET` | `/api/tecidos/:id/rolos` | Rolos de um tecido |
| `POST` | `/api/tecidos` | Cria tecido; opcionalmente os rolos iniciais |
| `PATCH` | `/api/tecidos/:id` | Atualiza `localizacao` e/ou `estoque_minimo_m` |
| `POST` | `/api/tecidos/:id/metros` | Cria rolos novos ou repõe metros em um rolo |
| `POST` | `/api/rolos` | **Legado:** cria um rolo individual |
| `POST` | `/api/rolos/lote` | **Legado:** cria vários rolos de uma vez |
| `GET` | `/api/rolos/:codigo` | Consulta um rolo pelo código |
| `POST` | `/api/movimentacoes/saida` | Registra corte (`codigo_qr`, `metros`, `usuario`, `client_key`) |
| `POST` | `/api/movimentacoes/ajuste` | Registra contagem (`codigo_qr`, `metragem_real`, `usuario`, `client_key`) |
| `POST` | `/api/movimentacoes/:id/estorno` | Desfaz um lançamento (`usuario`, `motivo`) |
| `GET` | `/api/movimentacoes` | Movimentações (`?limit=50`, máximo 100) |
| `GET` | `/api/cortes/resumo` | Totais, série e ranking de cortes (`?dias=30`) |
| `POST` | `/api/qrcode` | Gera vários QR Codes (`textos`, até 100) |
| `GET` | `/api/qrcode/:texto` | Gera um QR Code em PNG (data URL) |

`POST /api/tecidos` aceita `codigo`, `nome`, `estoque_minimo_m` e, opcionalmente, `modo`, `metragem`, `quantidade` e `usuario`.

`POST /api/tecidos/:id/metros`:

- sem `rolo_id` → cria `quantidade` rolos novos, cada um com código interno;
- com `rolo_id` → soma os metros ao rolo existente e mantém o código interno;
- `modo: "metros"` considera a metragem como total (1 rolo); `modo: "rolos"` usa metros por rolo × quantidade;
- grava uma movimentação `entrada` por rolo e retorna `rolos`, `quantidade` e `total_m`;
- a etiqueta impressa é sempre a do tecido (`TEC:<codigo>`), não a do rolo.

A resposta de `GET /api/tecidos/qr/:codigo` inclui `tecido`, `rolos` e `cortes` (`total_m`, `total_lancamentos`, `consumo_30d_m`, `hoje_m` e `ultimos`).

Parâmetros de `/api/dashboard`: `busca` (nome, código ou localização), `situacao` (`ok`, `baixo`, `critico` ou `alerta` para todos abaixo do mínimo), `ordem` (`nome`, `codigo`, `saldo`, `consumo`, `cobertura`) e `dir` (`asc`, `desc`).

---

## Modelo de dados

| Tabela | Conteúdo |
|---|---|
| `tecidos` | Código, nome, estoque mínimo, **localização** |
| `rolos` | Tecido, código interno (48 bits), metragem inicial/atual, status |
| `movimentacoes` | Rolo, tipo (`entrada`/`saida`/`ajuste`/`estorno`), metros, usuário, observação, **`client_key` (idempotência)**, **`cancelada_em`/`cancelada_por` (estorno)**, `estorno_de_id`, data |

A view `vw_saldo_tecidos` (em `sql/view.sql`) concentra `saldo_m`, `rolos_ativos`, `consumo_30d`, `cortado_total_m`, `cobertura_dias`, `ultima_movimentacao` e `situacao`. Assim, desktop e mobile não recalculam regras. Movimentações estornadas ficam fora do consumo e do total.

**Consistência:** saídas, ajustes, entradas e estornos usam transação com `SELECT ... FOR UPDATE`; o rolo é bloqueado antes de validar a chave, então duas reenvios da mesma `client_key` serializam e o segundo devolve `repetido`. Metragens são arredondadas para duas casas e ajustes guardam a diferença.

---

## Solução de problemas

```bash
cd server
npm run db:check
```

| Sintoma | Causa provável | Solução |
|---|---|---|
| `ECONNREFUSED` | PostgreSQL parado ou host/porta errados | `docker compose up -d` (local) ou revise `DATABASE_URL` |
| `28P01` / `28000` | Usuário/senha incorretos | Corrija a `DATABASE_URL` (senha com `@#/:` precisa de `encodeURIComponent`) |
| `SELF_SIGNED_CERT_IN_CHAIN` | TLS não configurado | `DATABASE_SSL=true` |
| `3D000` | Banco inexistente | No Supabase use `postgres`; depois `npm run db:setup` |
| `42P01` (tabela/view ausente) | Estrutura não criada | `npm run db:setup` |
| `42501` (permissão negada) | Usuário sem permissão | Use o usuário `postgres` na connection string da API |
| Porta 3000 ocupada | Outro processo | `PORT=3001 npm start` |
| Celular não acessa | Rede/firewall | Confirme IP, mesma rede e porta liberada |
| Câmera não abre | Página em HTTP | Use HTTPS ou `localhost` |
| QR do desktop não abre no celular | Desktop em `localhost` | Abra o desktop pelo IP da máquina |
| Aviso de lançamento(s) pendente(s) | Servidor fora do ar ou item recusado | Volte o servidor e toque em **Sincronizar**; se for recusado, **Descartar este** |
| Tela antiga no celular | Cache do PWA | Feche e reabra; o cache `v14` é atualizado no próximo acesso |

```bash
curl http://localhost:3000/api/health
# {"ok":true,"data":{"status":"ok","banco":"conectado","versao":"1.4.0"}}
```

---

## Publicar online (GitHub Pages + Render)

O app é dividido em duas partes porque o GitHub Pages **só serve arquivos estáticos**:

```
GitHub Pages  ──(HTTPS + CORS)──►  Render (Express)  ──►  Supabase (PostgreSQL)
public/                             server/                public.*
```

| Parte | Onde | Como |
|---|---|---|
| Frontend (`public/`) | GitHub Pages | workflow `.github/workflows/pages.yml` |
| API (`server/`) | Render | `render.yaml` (Node, `npm install` + `npm start`) |
| Banco | Supabase (PostgreSQL) | `DATABASE_URL` + `DATABASE_SSL=true` no Render |

### 1. Banco no Supabase

1. Crie um projeto em <https://supabase.com> (plano Free).
2. **Project Settings → Database → Connection string → URI**: copie a string.
   - Para o Render, prefira a aba **Connection Pooler** (porta **6543**).
   - Troque `[YOUR-PASSWORD]` pela senha do projeto.
3. Aplique a estrutura — **SQL Editor** (cole `sql/schema.sql`, execute; depois `sql/view.sql`) **ou** da sua máquina:
   ```bash
   cd server
   # Linux/macOS
   DATABASE_URL="postgresql://..." DATABASE_SSL=true npm run db:setup
   ```
   ```powershell
   # PowerShell
   $env:DATABASE_URL='postgresql://...'; $env:DATABASE_SSL='true'; npm run db:setup
   ```
4. Confira: `DATABASE_URL="..." npm run db:check`.

O schema liga **RLS** nas três tabelas sem nenhuma política: a chave `anon` do Supabase não lê nem escreve nada pelo PostgREST. Só a API (conexão com o usuário dono, `postgres`) acessa.

> **Dados antigos do MySQL:** o Schema novo **não importa** o dump do MySQL automaticamente — o banco do Supabase começa vazio. Para levar os dados, exporte `tecidos`, `rolos` e `movimentacoes` para CSV e importe pelo **Table Editor** do Supabase nessa ordem, ou use `pgloader`. Os QRs impressos continuam válidos desde que os códigos `TEX-001`…`TEX-004` e os códigos de rolo sejam preservados; se preferir começar do zero, `npm run feira:reset` recria exatamente esse cenário.

### 2. Backend no Render

1. Suba o repositório no GitHub.
2. Render → **New → Blueprint** → escolha o repositório (o `render.yaml` é lido automaticamente).
3. Preencha `DATABASE_URL` com a connection string do Supabase (a mesma do passo 1).
4. Ajuste `ORIGENS_PERMITIDAS` para a **origem** do Pages, por exemplo `https://usuario.github.io` — sem caminho, porque a origem não inclui `/repositorio` (o padrão `*` funciona, mas deixa a API aberta a qualquer site).
5. Confirme que `https://SEU-SERVICO.onrender.com/api/health` responde `{"ok":true,...}`.
6. Copie a URL do serviço — ela será o `apiBase`.

O plano free do Render hiberna após ~15 min sem acesso; a primeira chamada depois disso demora alguns segundos.

### 3. Frontend no GitHub Pages

1. **Settings → Secrets and variables → Actions → Variables → New repository variable**
   - `API_BASE` = `https://SEU-SERVICO.onrender.com` (sem barra no fim)
2. **Settings → Pages → Source** = **GitHub Actions**.
3. Execute o workflow **Publicar no GitHub Pages** (ou dê push na `main`).
4. O site fica em `https://usuario.github.io/repositorio/` — o desktop em `/` e o mobile em `/mobile.html`.

O workflow injeta `API_BASE` em `public/config.js` antes de publicar. Sem essa variável, o site sobe sem API e as telas mostram erro de conexão.

### Compatibilidade com o GitHub Pages (plano Free)

- **Repositório público.** No plano Free o Pages só publica a partir de repositórios públicos. Segredos ficam fora do repositório (`.gitignore` cobre `server/.env` e `backup/`).
- **Publicação por GitHub Actions.** A opção “Deploy from a branch” só aceita a **raiz** do repositório ou `/docs`; como o frontend vive em `public/`, o caminho é o workflow `.github/workflows/pages.yml`. Actions é gratuito em repositórios públicos.
- **Sem build e sem Jekyll.** O workflow empacota `public/` como está (`actions/upload-pages-artifact`), então não há transformação de arquivos nem `.nojekyll`.
- **Subpasta.** O site fica em `https://usuario.github.io/repositorio/`; todos os caminhos do app e do manifest são relativos.
- **Limites do Free:** site de até 1 GB, 100 GB/mês de tráfego e 10 builds/hora. O app inteiro tem cerca de 1 MB.
- **Cache do CDN.** O Pages pode guardar HTML/CSS por cerca de 10 minutos após um deploy. O service worker busca o shell na rede a cada abertura, então a versão nova entra assim que o cache expira.

### O que já está ajustado no código

- **`public/config.js`** é o único ponto de configuração: `window.TECSOURCE_CONFIG.apiBase` + `window.apiUrl()`. Toda chamada do app (inclusive a fila offline) passa por ele.
- **Caminhos relativos** no `manifest.webmanifest` (`./mobile.html`, `scope: "./"`), para funcionar na subpasta do Pages.
- **CORS** no Express, controlado por `ORIGENS_PERMITIDAS`, com resposta a `OPTIONS`.
- **Service worker** com o shell em network-first, então atualização de HTML/JS nunca mistura versões.
- **PostgreSQL/Supabase**: driver `pg`, `DATABASE_URL` + `DATABASE_SSL`, funções `tecsource_hoje()`/`tecsource_dia()` para o fuso de Brasília (independem do fuso da sessão e do pooler) e RLS ligado nas tabelas.

### Rodar local

Com `apiBase: ''`, o app chama `/api` no mesmo host — é o modo usado no notebook do stand (`npm start` + `http://localhost:3000`). Nada de HTTPS ou CORS no local. O banco pode ser o próprio Supabase (com internet) ou o PostgreSQL do `docker compose up -d`.

> **Antes de publicar:** rode `cd server && npm install` para atualizar o `package-lock.json` com o driver `pg`. O lock antigo ainda referencia o `mysql2`.

---

## Modo feira (exposição ao público)

Roteiro para demonstração com o público interagindo no notebook do stand:

1. **Preparar:** `npm run feira:reset` — recria os **4 tecidos com etiqueta QR impressa** (`TEC:TEX-001` … `TEC:TEX-004`) e ~60 dias de histórico coerente (consumo, cobertura, alerta de estoque baixo no TEX-002). Os QRs impressos continuam válidos.
2. **Subir:** `npm start` e abrir `http://localhost:3000` em tela cheia (**F11**).
3. **Durante:** o público cadastra tecidos, edita localização/mínimo, corta, conta e estorna — nada é apagado, tudo fica auditado no histórico.
4. **Entre visitantes:** `npm run feira:reset` (≈1 s, numa transação) restaura o cenário; o painel volta limpo e coerente, sem derrubar o servidor.
5. **Conferir:** `npm run feira:check` mostra a view do painel, o saldo por rolo e a série de 30 dias.

Detalhes:

- O **guia de 3 passos** fixo no topo das telas orienta quem chega sozinho.
- O cenário é **determinístico**: mesma semente = mesmo banco a cada reset.
- Tecidos criados pelo público no meio do dia **somem no próximo reset** — se quiser conservar algum, anote o código.
- Para zerar tudo (banco vazio): `npm run db:reset`. Para o cenário grande de 14 tecidos: `npm run demo:reset`.
- **Backup antes de qualquer reset:** `pg_dump "$DATABASE_URL" -f backup/tecsource_<data>.sql`. No Supabase, **Database → Backups** também guarda cópias diárias. Para restaurar:
  `psql "$DATABASE_URL" -f backup/tecsource_<data>.sql`.
- **Só conferir sem alterar nada:** `npm run feira:check` é somente leitura — mostra a view, o saldo por rolo, a série de 30 dias e avisa se há datas futuras.

---

## Segurança e limitações

- **Sem autenticação real:** o nome do operador fica no `localStorage`. Em rede interna isso é aceitável; **publicado na internet (GitHub Pages + Render), qualquer pessoa com o link lê e lança movimentações.** Antes de expor publicamente, coloque uma autenticação na frente da API (ou restrinja `ORIGENS_PERMITIDAS` e use o Render apenas na rede do stand).
- **Fila offline é local:** os lançamentos pendentes vivem no aparelho (`localStorage`). Se o aparelho for limpo antes da sincronização, esses lançamentos se perdem.
- **Sem exclusão pela interface:** correções são feitas pela contagem física; erros de lançamento são desfeitos pelo estorno.
- **Sem backup automático no app:** o Supabase faz backups diários no plano Free (retenção curta). Para um dump sob demanda: `pg_dump "$DATABASE_URL" -f backup/tecsource_<data>.sql`.
- **Corte acima do saldo** continua sendo recusado na fila ao sincronizar; o item fica visível para o operador resolver.
- **Um único depósito:** a localização é texto livre, sem estrutura de galpão/prateleira/lote.
- **Lote com metragem única:** para metragens diferentes, faça lançamentos separados.

---

## Próximos passos

- Piloto na rotina real da MAITE Decorações.
- Autenticação e permissões por perfil.
- Endereço estruturado de localização (galpão → corredor → prateleira) e etiqueta com a posição.
- Metragens diferentes no mesmo lote.
- Relatórios por período e exportação CSV/PDF.
- Contagem de conflitos: dois aparelhos ajustando o mesmo rolo no mesmo intervalo.

---

**TecSource v1.4.0** · Uso interno · MAITE Decorações LTDA
