# TecSource — Análise de funcionamento (v1.4.0)

Documento de referência sobre a arquitetura, os fluxos e as decisões de interface das versões v1.3.0 e v1.4.0.

---

## 1. Visão geral

O TecSource controla o estoque de tecidos da MAITE Decorações. O problema descrito no `MVP` é a divergência entre o estoque do sistema e o físico: cortes sem registro imediato geram saldo irreal, faltas e compras de emergência.

A solução é registrar a baixa no momento do corte: o operador escaneia o QR fixado no **tecido**, escolhe o rolo na ficha e informa os metros; o saldo é atualizado na hora. Um único backend Express + PostgreSQL (Supabase) atende duas interfaces:

- **Desktop** (`/index.html`) — gestão, cadastro, corte, contagem e histórico.
- **Mobile/PWA** (`/mobile.html`) — operação de chão de fábrica, com leitor em tela cheia.

Não há build: frontend em HTML/CSS/JS puro.

---

## 2. O que cada versão resolveu

### 2.1 v1.3.0 — clareza da interface

A análise das telas apontou funções duplicadas e caminhos concorrentes para a mesma tarefa. As mudanças abaixo eliminam essa ambiguidade.

| Problema identificado | Decisão na v1.3.0 |
|---|---|
| QR preso ao rolo: cada rolo exigia etiqueta própria e o tecido não tinha visão consolidada | **QR único por tecido** (`TEC:<codigo>`); ao escanear, abre a ficha com metragem, rolos e cortes |
| Corte sem saber o que existe no tecido | Na ficha, o operador vê os rolos e escolhe onde registrar o corte ou a contagem |
| “Entrada de rolo” repetia o fluxo de “＋ Metros” | Uma única entrada: **Painel → ＋ Estoque**, com *Novo(s) rolo(s)* ou *Repor em rolo* |
| Lista de tecidos aparecia no Painel, em Cadastros e na aba mobile “Tecidos” | Uma única lista no Painel, com busca, filtro, ordenação e ação |
| Alternadores “Em metros / Em rolos” aninhados em cada formulário | Um modelo só: **metros por rolo × quantidade de rolos** |
| Quatro KPIs, dois deles contando a mesma coisa | Três KPIs: **Estoque total**, **Cortado (30d)** e **Alertas**; tecidos/rolos viram legenda |
| Coluna “Cortado total” sem uso operacional | Removida; ficaram consumo 30d, cobertura, situação e ação |
| Nomes longos e inconsistentes | “Saída / Corte” → **Corte**; “Contagem Física” → **Contagem**; “Cadastros” → **Novo tecido** |
| Alertas fáceis de ignorar | Banner vermelho com ícone, contagem de críticos/baixos e atalho para filtrar; KPI destacado |
| Funções sem explicação para novos operadores | Botões **?** contextuais + guia **Como usar** + dica de primeira visita |
| Arquivos SQL legados recriando a mesma view | `consulta.sql` e `upgrade_consulta.sql` removidos; `schema.sql` é a fonte única |

O resultado é uma interface com **uma ação principal por tela**, textos curtos e o mesmo vocabulário no desktop e no mobile.

### 2.2 v1.4.0 — confiabilidade para o dia a dia

| Risco real na operação | Solução na v1.4.0 |
|---|---|
| Rede cai no meio do corte e o lançamento se perde | Fila offline (`public/fila.js`): `localStorage`, reenvio sequencial no `online`, aviso fixo com sincronizar/descartar |
| Mesmo corte enviado duas vezes (reconexão, duplo clique, duas abas) | `movimentacoes.client_key` única; reenvio devolve `repetido: true` e não debita de novo |
| Operador precisa decorar o código do tecido | Busca por nome, código e **localização**; sugestões aparecem debaixo do campo de QR |
| Não há como desfazer um corte errado | **Estorno auditável**: `cancelada_em`/`cancelada_por` na linha original + linha `estorno` com metros negativos |
| Apresentação começa com o banco vazio | `npm run demo:reset` recria 14 tecidos, 20 rolos e ~60 dias de cortes coerentes |
| “Hoje” desloca de dia quando o banco roda em UTC | Funções `tecsource_hoje()`/`tecsource_dia()` calculam em `America/Sao_Paulo`, sem depender do fuso da sessão (o pooler do Supabase não mantém `SET`) |
| Série diária não batia com o total do período | Janela de 30 dias em **dias de calendário** (`tecsource_dia(29)`) na view, na ficha e no resumo |
| Código de rolo de 32 bits colidia em bases grandes | 48 bits (12 hex) com até 5 tentativas de reuso |

---

## 3. Arquitetura

```
Navegador (desktop ou mobile)
        │  fetch JSON
        ▼
Express (server/src/index.js)
  ├── rotas /api/*
  ├── regras transacionais
  └── geração de QR Code (qrcode)
        │  pg (node-postgres)
        ▼
PostgreSQL / Supabase
  ├── tecidos
  ├── rolos
  ├── movimentacoes
  ├── funções tecsource_hoje() / tecsource_dia()
  └── view vw_saldo_tecidos
```

### Princípios

1. **Registro no momento do corte** — o fluxo precisa ser rápido para não atrapalhar a produção.
2. **Uma API para as duas interfaces** — mesmos endpoints e mesmas regras.
3. **Consistência transacional** — `BEGIN`/`COMMIT`/`ROLLBACK` e `SELECT ... FOR UPDATE`.
4. **Indicadores no banco** — a view concentra saldo, consumo, cobertura, situação e cortado total.
5. **QR gerado no backend** — um por tecido, sem dependência de serviço externo.
6. **Identificação simples** — nome do operador no `localStorage`, gravado nas movimentações.

---

## 4. Modelo de dados

| Tabela | Campos principais |
|---|---|
| `tecidos` | `id`, `codigo` (único), `nome`, `estoque_minimo_m`, `localizacao`, `criado_em` |
| `rolos` | `id`, `tecido_id`, `codigo_qr` (único, interno, 48 bits), `metragem_inicial`, `metragem_atual`, `status`, `criado_em` |
| `movimentacoes` | `rolo_id`, `tipo` (`entrada`/`saida`/`ajuste`/`estorno`), `metros`, `usuario`, `observacao`, `client_key` (única), `cancelada_em`, `cancelada_por`, `estorno_de_id`, `criado_em` |

A view `vw_saldo_tecidos` (em `sql/view.sql`, criada **depois** das colunas novas pelo `db:setup`) agrega por tecido:

- `saldo_m` — soma da metragem atual dos rolos ativos;
- `rolos_ativos` — rolos ativos com saldo > 0;
- `consumo_30d` — saídas **não canceladas** dos últimos 30 dias de calendário;
- `cortado_total_m` — todas as saídas não canceladas acumuladas (mantido para relatórios, não exibido na tabela);
- `cobertura_dias` — `saldo / (consumo_30d / 30)`;
- `ultima_movimentacao`;
- `situacao` — `ok`, `baixo` ou `critico`.

| Situação | Condição |
|---|---|
| `OK` | saldo ≥ mínimo |
| `BAIXO` | 0 < saldo < mínimo |
| `CRÍTICO` | saldo ≤ 0 |

O QR impresso identifica o tecido com o texto `TEC:<codigo>`. O campo `rolos.codigo_qr` continua existindo como **código interno** do rolo e é aceito na busca para compatibilidade com etiquetas antigas (`ROL-…`).

---

## 5. Fluxos principais

### 5.1 Cadastro de tecido

`POST /api/tecidos` valida código, nome e mínimo (padrão 10 m), grava o tecido e, se houver metragem, cria os rolos iniciais na mesma transação:

- `modo: "metros"` → a metragem é o total e gera 1 rolo;
- `modo: "rolos"` → a metragem é por rolo e `quantidade` (1 a 100) define o número de rolos.

A resposta inclui `codigo`, `nome`, `rolos`, `quantidade`, `metragem` e `total_m`; a interface gera **uma etiqueta do tecido** com o texto `TEC:<codigo>`.

### 5.2 Entrada em tecido existente

`POST /api/tecidos/:id/metros`:

- **sem `rolo_id`** → cria `quantidade` rolos novos, cada um com `codigo_qr` interno;
- **com `rolo_id`** → soma a metragem ao rolo escolhido, atualizando `metragem_inicial` e `metragem_atual`, mantendo o mesmo código interno.

Tudo em transação, com uma movimentação `entrada` por rolo. Esse é o único caminho de entrada na interface. Nenhuma etiqueta nova é gerada: a etiqueta é sempre a do tecido.

### 5.3 Corte

Fluxo da interface: escanear o QR do tecido → `GET /api/tecidos/qr/:codigo` → ficha com saldo, rolos e cortes → escolher o rolo → preencher metros → `POST /api/movimentacoes/saida`.

No endpoint, `POST /api/movimentacoes/saida`:

1. abre transação;
2. bloqueia o rolo com `SELECT ... FOR UPDATE`;
3. se houver `client_key`, procura lançamento já gravado com essa chave — achou, devolve `repetido: true` e **não grava de novo**;
4. valida existência, status e saldo;
5. desconta os metros;
6. marca `esgotado` se o saldo chegar a zero;
7. grava a movimentação `saida`;
8. confirma.

O `FOR UPDATE` serializa cortes simultâneos e evita saldo negativo. Bloquear o rolo **antes** da checagem de chave é o que faz dois envios da mesma `client_key` serializarem em vez de duplicar.

### 5.4 Contagem

`POST /api/movimentacoes/ajuste` grava a diferença entre o saldo e a metragem real como `ajuste`. Diferença zero não gera registro (e, portanto, não há o que ser repetido).

### 5.5 Metragem cortada

Os cortes já ficam em `movimentacoes`. A v1.3.0 expõe esses dados de forma enxuta:

- KPI **Cortado (30d)**;
- painel **Metragem cortada** com hoje, 7 e 30 dias e os mais cortados;
- `GET /api/cortes/resumo?dias=30`;
- atualização a cada 30 s e após cada corte.

### 5.6 Estorno

`POST /api/movimentacoes/:id/estorno` desfaz um lançamento sem apagar nada:

1. abre transação e bloqueia a movimentação (`FOR UPDATE`);
2. recusa estorno de estorno e de movimentação já estornada;
3. devolve ao rolo o valor da movimentação (saída soma, entrada/ajuste subtrai), sem deixar saldo negativo;
4. marca a linha original com `cancelada_em` e `cancelada_por`;
5. insere uma movimentação `estorno` com **metros negativos** apontando para `estorno_de_id`;
6. confirma.

Lançamentos cancelados continuam em `GET /api/movimentacoes` (com o selo `CANCELADA` na interface), mas são excluídos de saldo, consumo 30d, cortado total e ranking.

### 5.7 Fila offline

`public/fila.js` é compartilhado pelas duas interfaces e expõe `window.TecFila`:

- `enviar(url, corpo, { rotulo })` tenta enviar; sem conexão, grava no `localStorage` e devolve `{ pendente: true }`;
- falha de **rede** enfileira; falha de **regra de negócio** é lançada na hora (o operador precisa ver o erro);
- `sincronizar()` reenvia **em ordem** e para no primeiro problema — assim cortes não são aplicados fora de sequência;
- item recusado fica na fila com o motivo visível; o operador pode tentar de novo ou descartar **só aquele**;
- o aviso fixo (`#tf-banner`) mostra pendências e dispara `tecfila:sincronizado` para recarregar painel e histórico;
- em `localStorage` bloqueado (modo privado), a fila cai para memória da sessão.

O campo `client_key` gerado no aparelho é o que transforma o reenvio em operação segura: mesmo que o envio tenha sido gravado e a resposta perdida, o servidor responde `repetido: true` e o saldo não cai duas vezes.

---

## 6. Interface

### Desktop

- **Painel:** 3 KPIs, banner de alertas com ação de filtro, metragem cortada e lista única de tecidos com saldo, mínimo, consumo, cobertura e **localização**.
- **Busca:** campo acima da lista filtra por nome, código ou localização; abaixo do campo de QR, sugestões de tecidos aparecem enquanto o operador digita.
- **Corte:** leitor do QR do tecido, ficha com metragem/rolos/cortes, seleção do rolo e confirmação da metragem.
- **Contagem:** leitura do QR do tecido, seleção do rolo e ajuste pela metragem real.
- **Novo tecido:** cadastro com localização, estoque inicial opcional e etiqueta QR única do tecido.
- **Ficha do tecido:** abre pelo nome na tabela; mostra rolos, cortes recentes e permite editar a localização (**📍 Editar localização**).
- **Histórico:** movimentações com filtro por tipo (incluindo `estorno`); lançamentos estornados aparecem com selo **CANCELADA** e os estornos com selo próprio; a coluna **Ação** traz o botão **↩ Estornar**.

### Mobile

- Navegação inferior com quatro abas: **Painel, Ler QR, Tecido, Histórico**.
- A aba **Ler QR** é um hub de três estados na mesma tela, sem overlay: **leitura** (leitor + busca por nome/código) → **ficha inline** do tecido → **lançamento** no rolo escolhido com **← Voltar à ficha**. O QR abre a ficha; cada rolo oferece **✂ Cortar** ou **📏 Contar**; estoque, localização e etiqueta também vivem ali. O card do Painel abre a mesma ficha (＋ Estoque permanece como atalho do card).
- KPIs em grade de duas colunas (três colunas em telas ≥ 720 px), com o cartão de estoque em destaque.
- Cartões de tecido com saldo, mínimo, consumo, cobertura, **localização** e **＋ Estoque**.
- Leitor de QR em overlay, impressão/cópia do código `TEC:<codigo>` e botão **← Voltar à ficha** no formulário.
- Cartões de movimentação com botão **Estornar** e selos `CANCELADA`/`estorno`.

### Ajuda

- **Botões ?** ao lado dos títulos abrem um tooltip curto e específico.
- **Como usar** resume o fluxo, incluindo estorno e busca por nome.
- **Dica de boas-vindas** aparece uma vez, controlada por `tecsource_dica_v1_4`.
- O mobile usa delegação de eventos em `[data-tip]`, então os botões criados dinamicamente também funcionam.
- Falha de rede mostra o banner da fila (**Sincronizar** / **Descartar este**) em vez de erro genérico.

---

## 7. Robustez

Já resolvido:

- transações e bloqueio pessimista nas operações de saldo;
- `client_key` única: reenvios nunca duplicam lançamento;
- estorno auditável, sem exclusão de dados;
- fila offline com reenvio ordenado e falha visível;
- arredondamento para duas casas antes de validar e gravar;
- limite compatível com `DECIMAL(10,2)`;
- entrada numérica com vírgula e milhar pt-BR;
- escape de textos do banco antes de injetar HTML;
- erros de banco sem detalhes internos na resposta;
- botões bloqueados durante o envio;
- ordenação por lista branca, sem SQL interpolado do usuário;
- requisições do painel com descarte de resposta obsoleta (corrida de busca);
- `SET time_zone` na conexão para “hoje” e janelas de 30 dias coerentes;
- encerramento gracioso do servidor (fecha o pool de conexões);
- fallback da fila para memória quando `localStorage` está bloqueado.

Limitações conhecidas:

- sem autenticação real;
- sem exclusão pela interface (corrige-se por contagem ou estorno);
- fila offline é local: se o aparelho for limpo antes da sincronização, os itens se perdem;
- sem backup automático;
- um único depósito (localização é texto livre);
- lote com metragem única (até 100 rolos);
- contagem concorrente do mesmo rolo em dois aparelhos não detecta conflito (o último ajuste vale).

---

## 8. Pontos de atenção técnica

1. **Repor em rolo altera `metragem_inicial`.** O histórico de entradas fica em `movimentacoes`. Se for necessário preservar a metragem original, o ideal é um campo separado de “metragem reposta”.
2. **A view precisa ser atualizada em bancos existentes.** `npm run db:setup` recria `vw_saldo_tecidos` com `DROP`/`CREATE` (para garantir `security_invoker`) sem apagar dados. A estrutura está dividida em `sql/schema.sql` (funções, tabelas, índices e RLS) e `sql/view.sql` (view, executada por último porque usa `tecsource_dia()`).
3. **A série diária é calculada no servidor** e preenche dias sem corte com zero.
4. **Impressão** usa `#printArea` e `window.print()` para a etiqueta única do tecido, com `page-break-inside: avoid`.
5. **Service worker** está em `tecsource-v14` (inclui `config.js` e `fila.js` no pré-cache); a ativação remove caches antigos. O shell do app (`mobile.html/css/js`, `config.js`, `fila.js`) é **network-first com fallback de cache só offline** — assim HTML e JS nunca ficam de versões diferentes; os demais estáticos usam cache-first com revalidação em segundo plano. O servidor envia `Cache-Control: no-cache` nos arquivos do shell.
6. **Rotas `POST /api/rolos` e `/api/rolos/lote`** continuam disponíveis por compatibilidade, mas não são usadas pela interface.
7. **`crypto.randomUUID()` exige contexto seguro.** Em `http://192.168.x.x` o navegador não o expõe; `fila.js` tem um fallback baseado em `Date.now()` + aleatório, suficiente para idempotência (não para criptografia).
8. **O rolo é bloqueado antes da checagem de `client_key`.** Se a ordem for invertida, dois reenvios simultâneos passam pela checagem ao mesmo tempo e duplicam.
9. **Deploy é dividido.** O GitHub Pages só serve arquivos estáticos, então o frontend (`public/`) vive lá e a API (`server/`) vive no Render (`render.yaml`). O elo é `public/config.js`: `apiBase` vazio chama a API no mesmo host (uso local no stand), `apiBase` com URL do Render aponta para a API remota. Todas as chamadas — inclusive o reenvio da fila offline — passam por `window.apiUrl()`. O Express responde CORS conforme `ORIGENS_PERMITIDAS`.
10. **Banco é PostgreSQL (Supabase).** O driver é `pg`. `src/db.js` centraliza a conexão (`DATABASE_URL` + `DATABASE_SSL`), converte `numeric`/`bigint` em `Number`, traduz `?` em `$n` e mantém o formato de retorno que o restante do código já usava (`[rows]` / `insertId` / `affectedRows`). As datas usam funções SQL (`tecsource_hoje`/`tecsource_dia`) em vez de `CURDATE()` para não depender do fuso da sessão. RLS fica ligado nas três tabelas, então a chave `anon` do Supabase não acessa os dados.
11. **Publicar sem autenticação expõe os dados.** O app não tem login; na internet qualquer visitante lê e lança movimentações. Restrinja `ORIGENS_PERMITIDAS` ou coloque autenticação antes de abrir o link.

---

## 9. Como validar

1. `cd server && npm run db:setup` e `npm start` (ou `npm run demo:reset` para o cenário de demonstração — **apaga as tabelas**; ou `npm run feira:reset` para o cenário da feira: os 4 QRs impressos `TEX-001`…`TEX-004` + histórico, trocado em transação sem derrubar o servidor; `npm run feira:check` valida a coerência).
2. Abrir o desktop e conferir os 3 KPIs e a lista única.
3. Em **Novo tecido**, cadastrar com localização (`Corredor A · Prateleira 2`), 2 rolos × 20 m; conferir **1 etiqueta do tecido** (`TEC:<codigo>`), saldo de 40 m e a localização na linha do painel.
4. No **Painel**, usar **＋ Estoque**:
   - *Novo(s) rolo(s)* → `quantidade` rolos criados, sem etiqueta nova;
   - *Repor em rolo* → saldo do rolo escolhido atualizado, mesmo código interno.
5. Em **Ler QR**, escanear o QR do tecido (ou digitar parte do nome e escolher na sugestão), tocar em **✂ Cortar** no rolo, registrar uma saída e conferir o saldo e o KPI **Cortado (30d)**.
6. Na mesma ficha, tocar em **📏 Contar** em outro rolo, ajustar a metragem e conferir o ajuste no **Histórico**.
7. Na ficha do tecido, alterar a localização pelo botão **📍 Editar localização** e conferir a atualização no painel.
8. No **Histórico**, estornar uma saída: conferir o selo **CANCELADA** na linha original, o selo `estorno` com metros negativos, o saldo devolvido e o KPI **Cortado (30d)** reduzido.
9. **Teste de fila (offline):** com DevTools aberto, simule offline em **Network**, registre um corte — o banner mostra o item pendente e o saldo do servidor não muda. Volte a online e toque em **Sincronizar**: a fila drena em ordem e o saldo cai.
10. **Teste de idempotência:** recarregue com a fila pendente (com o servidor ainda parado) — o item não duplica; ou reenvie o mesmo `client_key` via `curl` e confira `{ "repetido": true }`.
11. Repetir o fluxo no mobile e testar os botões **?** e o guia **Como usar**.
12. Recarregar o mobile e confirmar que o service worker atualizou o cache para `v14`.
13. `curl http://localhost:3000/api/health` deve reportar `"versao":"1.4.0"`.

---

## 10. Próximos passos

- Piloto na rotina real da MAITE Decorações.
- Autenticação e permissões por perfil.
- Endereço estruturado de localização (galpão → corredor → prateleira) e etiqueta com a posição.
- Metragens diferentes no mesmo lote e separação por lote/fornecedor.
- Relatórios por período e exportação.
- Alertas ativos (e-mail/WhatsApp) para estoque mínimo.
- Contagem de conflitos: dois aparelhos ajustando o mesmo rolo no mesmo intervalo.
- Testes automatizados das regras transacionais (saída, ajuste, estorno, idempotência).
