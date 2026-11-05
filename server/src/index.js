import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { pool, withTransaction, mensagemErroBanco } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/* Versão única: lida do package.json (evita divergir do README e do /health) */
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSAO = PKG.version;

const app = express();

/* CORS: no GitHub Pages o frontend roda em outro domínio e chama esta API
   no Render. ORIGENS_PERMITIDAS aceita lista separada por vírgula
   (ex.: "https://usuario.github.io"); ausente = libera todas as origens.
   Sem cookies/credenciais, então "*" é seguro aqui. */
const ORIGENS = String(process.env.ORIGENS_PERMITIDAS || '*')
    .split(',').map(o => o.trim()).filter(Boolean);
const liberaTodas = ORIGENS.includes('*');

app.use((req, res, next) => {
    const origem = req.headers.origin;
    if (liberaTodas || (origem && ORIGENS.includes(origem))) {
        res.setHeader('Access-Control-Allow-Origin', liberaTodas ? '*' : origem);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());

/* Arquivos do shell (HTML/JS/CSS do app): sempre revalidar.
   Sem isso o cache heurístico do navegador podia servir um JS antigo
   junto com um HTML novo e o fluxo da ficha quebrava com "null.classList". */
const SEM_CACHE = new Set([
    'index.html', 'mobile.html', 'style.css', 'mobile.css',
    'app.js', 'mobile.js', 'config.js', 'fila.js', 'sw.js', 'manifest.webmanifest'
]);
app.use(express.static(path.join(__dirname, '..', '..', 'public'), {
    setHeaders(res, arquivo) {
        if (SEM_CACHE.has(path.basename(arquivo))) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

const ok = (res, data) => res.json({ ok: true, data });

/* Erro de banco/conexão → mensagem amigável + log no servidor (não vaza detalhes internos).
   Erros de negócio (Error puro, sem `code`) mantêm a mensagem original.
   `err.httpStatus` permite que uma regra de negócio responda 404 etc. */
const fail = (res, err, code = 400) => {
    const status = Number.isInteger(err?.httpStatus) ? err.httpStatus : code;
    if (typeof err?.code === 'string') {
        console.error('[TecSource] erro interno:', err.detail || err.message || err.code);
        return res.status(500).json({ ok: false, erro: 'Erro interno no servidor.' });
    }
    if (status >= 500) console.error('[TecSource]', err);
    return res.status(status).json({
        ok: false,
        erro: status >= 500 ? 'Erro interno no servidor.' : (err?.message || 'Erro interno.')
    });
};

/* Erro de negócio com status HTTP próprio (ex.: 404) */
const erro = (mensagem, httpStatus = 400) => {
    const e = new Error(mensagem);
    e.httpStatus = httpStatus;
    return e;
};

/* Limite das colunas DECIMAL(10,2) do schema */
const DECIMAL_MAX = 99999999.99;

/* Valor numérico vindo do corpo da requisição: '' | null | undefined → NaN.
   Evita que campo vazio vire 0 (ex.: contagem física apagando o saldo do rolo).
   Aceita vírgula decimal ("3,5") e separador de milhar pt-BR ("1.234,56"). */
const num = v => {
    if (v === '' || v === null || v === undefined || typeof v === 'boolean') return NaN;
    if (typeof v !== 'string') return Number(v);
    const s = v.trim();
    if (s.includes(',') && s.includes('.')) {
        /* ambos os separadores: vírgula é a decimal se vier por último (pt-BR) */
        return Number(s.lastIndexOf(',') > s.lastIndexOf('.')
            ? s.replace(/\./g, '').replace(',', '.')
            : s.replace(/,/g, ''));
    }
    return Number(s.replace(',', '.'));
};

/* ============ REGRAS DE NEGÓCIO (transacionais) ============ */

/* Chave de idempotência enviada pelo cliente (fila offline).
   O mesmo lançamento reenviado devolve o resultado anterior em vez de
   debitar duas vezes. Vazio → NULL (lançamentos sem proteção). */
const chaveCliente = valor => {
    const s = String(valor ?? '').trim();
    return s ? s.slice(0, 64) : null;
};

/* Se a chave já foi usada, devolve a resposta equivalente à original. */
async function respostaIdempotente(conn, client_key, tipo) {
    if (!client_key) return null;
    const [rows] = await conn.execute(
        'SELECT id, rolo_id, metros FROM movimentacoes WHERE client_key = ? LIMIT 1',
        [client_key]
    );
    if (!rows.length) return null;
    const [rolo] = await conn.execute(
        'SELECT metragem_atual FROM rolos WHERE id = ?', [rows[0].rolo_id]
    );
    const atual = rolo.length ? Number(rolo[0].metragem_atual) : 0;
    return {
        repetido: true,
        rolo_id: rows[0].rolo_id,
        metros: Number(rows[0].metros),
        metragem_atual: atual,
        ...(tipo === 'ajuste' ? { diferenca: Number(rows[0].metros) } : {})
    };
}

async function registrarSaida({ codigo_qr, metros, usuario, observacao, client_key }) {
    return withTransaction(async conn => {
        /* Bloqueia o rolo primeiro: dois envios da mesma chave serializam aqui
           e o segundo encontra a movimentação já gravada. */
        const [rows] = await conn.execute(
            'SELECT * FROM rolos WHERE codigo_qr = ? FOR UPDATE', [codigo_qr]);
        const rolo = rows[0];
        if (!rolo) throw new Error(`Rolo não encontrado (${codigo_qr}).`);
        if (rolo.status === 'esgotado') throw new Error(`Rolo ${codigo_qr} já esgotado.`);

        const repetida = await respostaIdempotente(conn, client_key, 'saida');
        if (repetida) return repetida;

        /* DECIMAL(10,2) grava 2 casas: arredonda antes de validar/gravar */
        const metros2 = +Number(metros).toFixed(2);
        if (!Number.isFinite(metros2) || !(metros2 > 0))
            throw new Error('Informe metragem maior que zero.');
        if (metros2 > DECIMAL_MAX)
            throw new Error(`Metragem acima do permitido (máx. ${DECIMAL_MAX} m).`);
        const atual = Number(rolo.metragem_atual);
        if (metros2 > atual)
            throw new Error(`Saldo insuficiente no rolo: disponível ${atual} m.`);

        const nova = +(atual - metros2).toFixed(2);
        await conn.execute(
            'UPDATE rolos SET metragem_atual = ?, status = ? WHERE id = ?',
            [nova, nova <= 0 ? 'esgotado' : 'ativo', rolo.id]);
        await conn.execute(
            `INSERT INTO movimentacoes (rolo_id, tipo, metros, usuario, observacao, client_key)
             VALUES (?,?,?,?,?,?)`,
            [rolo.id, 'saida', metros2, usuario || null, observacao || null, client_key]);
        return { rolo_id: rolo.id, metragem_atual: nova, metros: metros2 };
    });
}

async function registrarAjuste({ codigo_qr, metragem_real, usuario, client_key }) {
    return withTransaction(async conn => {
        const [rows] = await conn.execute(
            'SELECT * FROM rolos WHERE codigo_qr = ? FOR UPDATE', [codigo_qr]);
        const rolo = rows[0];
        if (!rolo) throw new Error(`Rolo não encontrado (${codigo_qr}).`);

        const repetida = await respostaIdempotente(conn, client_key, 'ajuste');
        if (repetida) return repetida;

        if (!Number.isFinite(metragem_real))
            throw new Error('Informe a metragem real contada.');
        if (metragem_real < 0) throw new Error('Metragem real não pode ser negativa.');
        if (metragem_real > DECIMAL_MAX)
            throw new Error(`Metragem acima do permitido (máx. ${DECIMAL_MAX} m).`);

        const real = +metragem_real.toFixed(2);
        const diff = +(real - Number(rolo.metragem_atual)).toFixed(2);
        await conn.execute(
            'UPDATE rolos SET metragem_atual = ?, status = ? WHERE id = ?',
            [real, real <= 0 ? 'esgotado' : 'ativo', rolo.id]);
        if (diff !== 0)
            await conn.execute(
                `INSERT INTO movimentacoes (rolo_id, tipo, metros, usuario, observacao, client_key)
                 VALUES (?,?,?,?,?,?)`,
                [rolo.id, 'ajuste', diff, usuario || null, 'Contagem física', client_key]);
        return { rolo_id: rolo.id, metragem_atual: real, diferenca: diff };
    });
}

/* Desfaz um lançamento, preservando o histórico:
   - a movimentação original é marcada como cancelada (sai dos indicadores);
   - o saldo do rolo é devolvido ao estado anterior;
   - uma linha de `estorno` registra quem desfez e por quê. */
async function registrarEstorno({ movimentacao_id, usuario, motivo }) {
    return withTransaction(async conn => {
        const [movRows] = await conn.execute(
            'SELECT * FROM movimentacoes WHERE id = ? FOR UPDATE', [movimentacao_id]);
        const mov = movRows[0];
        if (!mov) throw erro('Movimentação não encontrada.', 404);
        if (mov.tipo === 'estorno') throw new Error('Não é possível estornar um estorno.');
        if (mov.cancelada_em) throw new Error('Esta movimentação já foi estornada.');

        const [roloRows] = await conn.execute(
            'SELECT * FROM rolos WHERE id = ? FOR UPDATE', [mov.rolo_id]);
        const rolo = roloRows[0];
        if (!rolo) throw erro('Rolo não encontrado.', 404);

        const metrosMov = Number(mov.metros);
        const atual = Number(rolo.metragem_atual);
        let nova;
        if (mov.tipo === 'saida') nova = +(atual + metrosMov).toFixed(2);
        else nova = +(atual - metrosMov).toFixed(2);

        if (nova < 0)
            throw new Error('Saldo insuficiente para desfazer: o material já foi consumido.');

        await conn.execute(
            'UPDATE rolos SET metragem_atual = ?, status = ? WHERE id = ?',
            [nova, nova <= 0 ? 'esgotado' : 'ativo', rolo.id]);
        await conn.execute(
            'UPDATE movimentacoes SET cancelada_em = NOW(), cancelada_por = ? WHERE id = ?',
            [usuario || null, mov.id]);
        const [estorno] = await conn.execute(
            `INSERT INTO movimentacoes
               (rolo_id, tipo, metros, usuario, observacao, estorno_de_id)
             VALUES (?, 'estorno', ?, ?, ?, ?)
             RETURNING id`,
            [rolo.id, -metrosMov, usuario || null,
                motivo || `Estorno do lançamento #${mov.id}`, mov.id]);

        return {
            estorno_id: estorno.insertId,
            movimentacao_id: mov.id,
            tipo_original: mov.tipo,
            metros_estornados: metrosMov,
            metragem_atual: nova
        };
    });
}

/* Soma metros a um tecido já cadastrado.
   - sem `rolo_id`: cria `quantidade` rolos novos (um código interno por rolo);
   - com `rolo_id`: repõe metragem no rolo informado (apenas 1 rolo).
   Em ambos os casos grava movimentações de `entrada`, mantendo a auditoria. */
async function adicionarMetrosTecido({ tecido_id, metros, usuario, observacao, rolo_id, quantidade = 1 }) {
    return withTransaction(async conn => {
        const [tecRows] = await conn.execute(
            'SELECT * FROM tecidos WHERE id = ? FOR UPDATE', [tecido_id]);
        const tecido = tecRows[0];
        if (!tecido) throw erro('Tecido não encontrado.', 404);

        const metros2 = +Number(metros).toFixed(2);
        if (!Number.isFinite(metros2) || !(metros2 > 0))
            throw new Error('Informe metragem maior que zero.');
        if (metros2 > DECIMAL_MAX)
            throw new Error(`Metragem acima do permitido (máx. ${DECIMAL_MAX} m).`);

        const qtd = Number(quantidade);
        if (!Number.isInteger(qtd) || qtd < 1 || qtd > MAX_ROLOS_LOTE)
            throw new Error(`Quantidade de rolos inválida (entre 1 e ${MAX_ROLOS_LOTE}).`);

        if (rolo_id) {
            if (qtd !== 1)
                throw new Error('A reposição em um rolo existente aceita apenas 1 rolo.');
            const [rows] = await conn.execute(
                'SELECT * FROM rolos WHERE id = ? AND tecido_id = ? FOR UPDATE',
                [rolo_id, tecido_id]);
            const rolo = rows[0];
            if (!rolo) throw erro('Rolo não encontrado para este tecido.', 404);

            const atual = Number(rolo.metragem_atual);
            const nova = +(atual + metros2).toFixed(2);
            const inicial = +(Number(rolo.metragem_inicial) + metros2).toFixed(2);
            if (nova > DECIMAL_MAX)
                throw new Error(`Saldo do rolo acima do permitido (máx. ${DECIMAL_MAX} m).`);

            await conn.execute(
                'UPDATE rolos SET metragem_inicial = ?, metragem_atual = ?, status = ? WHERE id = ?',
                [inicial, nova, 'ativo', rolo.id]);
            await conn.execute(
                'INSERT INTO movimentacoes (rolo_id, tipo, metros, usuario, observacao) VALUES (?,?,?,?,?)',
                [rolo.id, 'entrada', metros2, usuario || null,
                    observacao || 'Reposição de metragem no rolo']);

            return {
                modo: 'rolo',
                tecido: { id: tecido.id, codigo: tecido.codigo, nome: tecido.nome },
                quantidade: 1,
                metros: metros2,
                total_m: metros2,
                codigo_qr: rolo.codigo_qr,
                metragem_atual: nova,
                metragem_inicial: inicial
            };
        }

        const rolos = await inserirRolos(conn, {
            tecido_id, metros: metros2, quantidade: qtd, usuario, observacao
        });

        return {
            modo: 'novo',
            tecido: { id: tecido.id, codigo: tecido.codigo, nome: tecido.nome },
            quantidade: qtd,
            metros: metros2,
            total_m: +(metros2 * qtd).toFixed(2),
            rolos,
            ...(qtd === 1 ? {
                codigo_qr: rolos[0].codigo_qr,
                metragem_atual: rolos[0].metragem_atual,
                metragem_inicial: rolos[0].metragem_inicial
            } : {})
        };
    });
}

/* Quantidade máxima de rolos por lançamento (evita lotes acidentais gigantes) */
const MAX_ROLOS_LOTE = 100;

/* Normaliza a quantidade de rolos: vazio → 1 */
const quantidadeRolos = v => {
    if (v === '' || v === null || v === undefined) return 1;
    return Number(v);
};

/* Cria N rolos iguais (mesma metragem) dentro de uma transação já aberta.
   Cada rolo recebe seu próprio código interno e sua movimentação de entrada. */
const TENTATIVAS_CODIGO = 5;

/* Código interno do rolo: 48 bits (12 hex). Antes eram 32 bits, o que
   tornava a colisão provável em bases grandes e derrubava o lote inteiro
   com um erro opaco. Aqui a colisão é detectada e o código é refeito. */
async function criarRolo(conn, { tecido_id, metros, usuario, observacao, entradaEmLote }) {
    for (let tentativa = 1; tentativa <= TENTATIVAS_CODIGO; tentativa++) {
        const codigo_qr = 'ROL-' + crypto.randomBytes(6).toString('hex').toUpperCase();
        try {
            const [r] = await conn.execute(
                'INSERT INTO rolos (tecido_id, codigo_qr, metragem_inicial, metragem_atual) VALUES (?,?,?,?) RETURNING id',
                [tecido_id, codigo_qr, metros, metros]);
            await conn.execute(
                'INSERT INTO movimentacoes (rolo_id, tipo, metros, usuario, observacao) VALUES (?,?,?,?,?)',
                [r.insertId, 'entrada', metros, usuario || null,
                    observacao || (entradaEmLote ? 'Entrada em lote' : 'Entrada de rolo')]);
            return {
                id: r.insertId,
                codigo_qr,
                metragem_inicial: metros,
                metragem_atual: metros,
                status: 'ativo'
            };
        } catch (e) {
            if (e?.code === '23505' && tentativa < TENTATIVAS_CODIGO) continue;
            throw e;
        }
    }
    throw new Error('Não foi possível gerar um código único para o rolo. Tente novamente.');
}

async function inserirRolos(conn, { tecido_id, metros, quantidade, usuario, observacao }) {
    const rolos = [];
    for (let i = 0; i < quantidade; i++) {
        rolos.push(await criarRolo(conn, {
            tecido_id, metros, usuario, observacao,
            entradaEmLote: quantidade > 1
        }));
    }
    return rolos;
}

/* ============ ROTAS ============ */

/* Diagnóstico rápido (útil para saber se o servidor e o banco estão OK) */
app.get('/api/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        ok(res, { status: 'ok', banco: 'conectado', versao: VERSAO });
    } catch {
        res.status(503).json({ ok: false, erro: 'Banco de dados indisponível.' });
    }
});

/* QR Code gerado no Backend (offline, sem CDN) */
app.post('/api/qrcode', async (req, res) => {
    const textos = Array.isArray(req.body?.textos) ? req.body.textos : [];
    if (!textos.length) return fail(res, new Error('Informe os códigos para gerar os QR Codes.'));
    if (textos.length > MAX_ROLOS_LOTE)
        return fail(res, new Error(`Máximo de ${MAX_ROLOS_LOTE} QR Codes por requisição.`));
    try {
        const urls = await Promise.all(textos.map(t =>
            QRCode.toDataURL(String(t).slice(0, 120), { width: 240, margin: 1 })));
        ok(res, urls);
    } catch (e) { fail(res, e, 500); }
});

app.get('/api/qrcode/:texto', async (req, res) => {
    try {
        const url = await QRCode.toDataURL(req.params.texto, { width: 240, margin: 1 });
        ok(res, url);
    } catch (e) { fail(res, e, 500); }
});

/* CONSULTA APERFEIÇOADA: busca + filtro + ordenação (SQL) + resumo global (KPIs) */
app.get('/api/dashboard', async (req, res) => {
    try {
        const busca = String(req.query.busca || '').trim();
        const situacao = String(req.query.situacao || '').trim();

        // Lista branca de ordenação (segurança)
        const ORDENACAO = {
            nome: 'nome', codigo: 'codigo', saldo: 'saldo_m',
            consumo: 'consumo_30d', cortado: 'cortado_total_m', cobertura: 'cobertura_dias'
        };
        const chave = Object.prototype.hasOwnProperty.call(ORDENACAO, req.query.ordem)
            ? req.query.ordem : 'nome';
        const ordem = ORDENACAO[chave];
        const dir = String(req.query.dir ?? '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

        const clauses = [];
        const params = [];
        if (busca) {
            clauses.push('(nome ILIKE ? OR codigo ILIKE ? OR localizacao ILIKE ?)');
            params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
        }
        if (situacao === 'alerta') {
            clauses.push("situacao <> 'ok'");
        } else if (['ok', 'baixo', 'critico'].includes(situacao)) {
            clauses.push('situacao = ?');
            params.push(situacao);
        }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

        const [itens] = await pool.query(
            `SELECT * FROM vw_saldo_tecidos ${where} ORDER BY ${ordem} ${dir}, nome ASC`,
            params
        );

        const [resumoRows] = await pool.query(
            `SELECT COUNT(*)                                AS total_tecidos,
              COALESCE(SUM(saldo_m), 0)              AS total_m,
              COALESCE(SUM(rolos_ativos), 0)         AS total_rolos,
              COUNT(*) FILTER (WHERE situacao <> 'ok')      AS total_alertas,
              COUNT(*) FILTER (WHERE situacao = 'critico')  AS total_criticos,
              COUNT(*) FILTER (WHERE situacao = 'baixo')    AS total_baixos,
              COALESCE(SUM(consumo_30d), 0)          AS total_cortado_30d,
              COALESCE(SUM(cortado_total_m), 0)      AS total_cortado,
              string_agg(nome, ', ' ORDER BY nome)
                FILTER (WHERE situacao <> 'ok')      AS alertas_nomes
       FROM vw_saldo_tecidos`
        );
        const r = resumoRows[0];

        /* Metragem cortada hoje (faixa de datas para usar o índice) */
        const [[hoje]] = await pool.query(
            `SELECT COALESCE(SUM(metros), 0) AS total_m
               FROM movimentacoes
              WHERE tipo = 'saida'
                AND cancelada_em IS NULL
                AND criado_em >= tecsource_dia(0)
                AND criado_em < tecsource_dia(-1)`
        );

        ok(res, {
            itens: itens.map(t => ({
                ...t,
                saldo_m: Number(t.saldo_m),
                estoque_minimo_m: Number(t.estoque_minimo_m),
                consumo_30d: Number(t.consumo_30d),
                cortado_total_m: Number(t.cortado_total_m),
                cobertura_dias: t.cobertura_dias === null ? null : Number(t.cobertura_dias)
            })),
            resumo: {
                total_tecidos: Number(r.total_tecidos),
                total_m: Number(r.total_m),
                total_rolos: Number(r.total_rolos),
                total_alertas: Number(r.total_alertas),
                total_criticos: Number(r.total_criticos),
                total_baixos: Number(r.total_baixos),
                total_cortado_30d: Number(r.total_cortado_30d),
                total_cortado: Number(r.total_cortado),
                total_cortado_hoje: Number(hoje.total_m),
                alertas_nomes: r.alertas_nomes || ''
            }
        });
    } catch (e) { fail(res, e, 500); }
});

/* TECIDOS (lista com saldo consolidado: usada no painel, cadastros e seletores) */
const mapTecidoResumo = t => ({
    ...t,
    estoque_minimo_m: Number(t.estoque_minimo_m),
    saldo_m: Number(t.saldo_m),
    rolos_ativos: Number(t.rolos_ativos),
    consumo_30d: Number(t.consumo_30d),
    cortado_total_m: Number(t.cortado_total_m),
    cobertura_dias: t.cobertura_dias === null ? null : Number(t.cobertura_dias)
});

app.get('/api/tecidos', async (req, res) => {
    const busca = String(req.query.busca || '').trim();
    const where = busca ? 'WHERE nome ILIKE ? OR codigo ILIKE ? OR localizacao ILIKE ?' : '';
    const params = busca ? [`%${busca}%`, `%${busca}%`, `%${busca}%`] : [];
    try {
        const [rows] = await pool.query(
            `SELECT id, codigo, nome, estoque_minimo_m, localizacao, saldo_m, rolos_ativos,
                    consumo_30d, cortado_total_m, cobertura_dias, ultima_movimentacao, situacao
               FROM vw_saldo_tecidos ${where} ORDER BY nome`,
            params
        );
        ok(res, rows.map(mapTecidoResumo));
    } catch (e) { fail(res, e, 500); }
});

/* Ficha do tecido a partir do QR (TEC:<codigo>) ou do código digitado.
   Retorna os dados do tecido, seus rolos e o resumo dos cortes. */
app.get('/api/tecidos/qr/:codigo', async (req, res) => {
    const codigo = String(req.params.codigo || '').trim().replace(/^TEC:/i, '');
    if (!codigo) return fail(res, new Error('QR do tecido inválido.'));
    try {
        const [tecRows] = await pool.execute(
            'SELECT * FROM vw_saldo_tecidos WHERE codigo = ? LIMIT 1', [codigo]);
        const tecido = tecRows[0];
        if (!tecido) return fail(res, erro('Tecido não encontrado para este QR.', 404));

        const [rolos] = await pool.execute(
            `SELECT id, codigo_qr, metragem_inicial, metragem_atual, status, criado_em
               FROM rolos WHERE tecido_id = ?
              ORDER BY (status = 'ativo') DESC, criado_em ASC`,
            [tecido.id]
        );

        const [[resumo]] = await pool.execute(
            `SELECT COUNT(*) AS total_lancamentos,
                    COALESCE(SUM(m.metros), 0) AS total_m,
                    COALESCE(SUM(CASE WHEN m.criado_em >= tecsource_dia(29)
                                      THEN m.metros ELSE 0 END), 0) AS consumo_30d_m,
                    COALESCE(SUM(CASE WHEN m.criado_em >= tecsource_dia(0)
                                      AND m.criado_em < tecsource_dia(-1)
                                      THEN m.metros ELSE 0 END), 0) AS hoje_m
               FROM movimentacoes m
               JOIN rolos r ON r.id = m.rolo_id
              WHERE r.tecido_id = ? AND m.tipo = 'saida' AND m.cancelada_em IS NULL`,
            [tecido.id]
        );

        const [ultimos] = await pool.execute(
            `SELECT m.metros, m.usuario, m.criado_em, r.codigo_qr
               FROM movimentacoes m
               JOIN rolos r ON r.id = m.rolo_id
              WHERE r.tecido_id = ? AND m.tipo = 'saida' AND m.cancelada_em IS NULL
              ORDER BY m.criado_em DESC
              LIMIT 8`,
            [tecido.id]
        );

        ok(res, {
            tecido: mapTecidoResumo(tecido),
            rolos: rolos.map(r => ({
                ...r,
                metragem_inicial: Number(r.metragem_inicial),
                metragem_atual: Number(r.metragem_atual)
            })),
            cortes: {
                total_m: Number(resumo.total_m),
                total_lancamentos: Number(resumo.total_lancamentos),
                consumo_30d_m: Number(resumo.consumo_30d_m),
                hoje_m: Number(resumo.hoje_m),
                ultimos: ultimos.map(m => ({ ...m, metros: Number(m.metros) }))
            }
        });
    } catch (e) { fail(res, e, 500); }
});

/* Rolos de um tecido (para repor metros em um rolo existente) */
app.get('/api/tecidos/:id/rolos', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, new Error('Tecido inválido.'));
    try {
        const [tec] = await pool.execute('SELECT id FROM tecidos WHERE id = ?', [id]);
        if (!tec.length) return fail(res, erro('Tecido não encontrado.', 404));
        const [rows] = await pool.execute(
            `SELECT id, codigo_qr, metragem_inicial, metragem_atual, status, criado_em
               FROM rolos WHERE tecido_id = ?
              ORDER BY (status = 'ativo') DESC, criado_em DESC`,
            [id]
        );
        ok(res, rows.map(r => ({
            ...r,
            metragem_inicial: Number(r.metragem_inicial),
            metragem_atual: Number(r.metragem_atual)
        })));
    } catch (e) { fail(res, e, 500); }
});

/* Soma metros a um tecido já cadastrado (novo rolo ou reposição em rolo existente) */
app.post('/api/tecidos/:id/metros', async (req, res) => {
    const tecido_id = Number(req.params.id);
    const b = req.body || {};
    if (!Number.isInteger(tecido_id) || tecido_id <= 0)
        return fail(res, new Error('Tecido inválido.'));
    const rolo_id = (b.rolo_id === undefined || b.rolo_id === null || String(b.rolo_id).trim() === '')
        ? null : Number(b.rolo_id);
    if (rolo_id !== null && (!Number.isInteger(rolo_id) || rolo_id <= 0))
        return fail(res, new Error('Rolo inválido.'));
    try {
        ok(res, await adicionarMetrosTecido({
            tecido_id,
            rolo_id,
            quantidade: b.modo === 'metros' ? 1 : quantidadeRolos(b.quantidade),
            metros: num(b.metros),
            usuario: b.usuario == null ? null : String(b.usuario).slice(0, 100),
            observacao: b.observacao == null ? null : String(b.observacao).slice(0, 255)
        }));
    } catch (e) { fail(res, e); }
});

app.post('/api/tecidos', async (req, res) => {
    const b = req.body || {};
    const cod = String(b.codigo ?? '').trim();
    const nom = String(b.nome ?? '').trim();
    const rawMin = b.estoque_minimo_m;
    /* vazio → 10 (padrão); preenchido mas inválido → erro explícito */
    const estoque_minimo_m = (rawMin === undefined || rawMin === null || String(rawMin).trim() === '')
        ? 10 : num(rawMin);
    if (!cod || !nom) return fail(res, new Error('Informe código e nome.'));
    if (!Number.isFinite(estoque_minimo_m))
        return fail(res, new Error('Estoque mínimo inválido.'));
    const minFinal = +estoque_minimo_m.toFixed(2);
    if (minFinal < 0) return fail(res, new Error('Estoque mínimo não pode ser negativo.'));
    if (minFinal > DECIMAL_MAX)
        return fail(res, new Error(`Estoque mínimo acima do permitido (máx. ${DECIMAL_MAX}).`));

    /* Metragem/quantidade são opcionais: permitem já criar os rolos iniciais
       junto com o tecido, na mesma transação.
       modo = 'metros' → a metragem informada é o total (1 rolo);
       modo = 'rolos'  → a metragem é por rolo e a quantidade é o número de rolos. */
    const temMetragem = !(b.metragem === undefined || b.metragem === null || String(b.metragem).trim() === '');
    const modo = b.modo === 'metros' ? 'metros' : 'rolos';
    let metros2 = null;
    let quantidade = 1;
    if (temMetragem) {
        const metros = num(b.metragem);
        if (!Number.isFinite(metros) || !(metros > 0))
            return fail(res, new Error('Informe a metragem (maior que zero).'));
        metros2 = +metros.toFixed(2);
        if (!(metros2 > 0))
            return fail(res, new Error('Informe a metragem (maior que zero).'));
        if (metros2 > DECIMAL_MAX)
            return fail(res, new Error(`Metragem acima do permitido (máx. ${DECIMAL_MAX} m).`));
        quantidade = modo === 'metros' ? 1 : quantidadeRolos(b.quantidade);
        if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > MAX_ROLOS_LOTE)
            return fail(res, new Error(`Quantidade de rolos deve ser entre 1 e ${MAX_ROLOS_LOTE}.`));
    }
    const usuario = b.usuario == null ? null : String(b.usuario).slice(0, 100);
    const localizacao = b.localizacao == null ? null
        : (String(b.localizacao).trim().slice(0, 60) || null);

    try {
        const resultado = await withTransaction(async conn => {
            const [r] = await conn.execute(
                'INSERT INTO tecidos (codigo, nome, estoque_minimo_m, localizacao) VALUES (?,?,?,?) RETURNING id',
                [cod.slice(0, 30), nom.slice(0, 120), minFinal, localizacao]);

            let rolos = [];
            if (temMetragem) {
                rolos = await inserirRolos(conn, {
                    tecido_id: r.insertId,
                    metros: metros2,
                    quantidade,
                    usuario,
                    observacao: 'Entrada inicial no cadastro do tecido'
                });
            }

            const [rows] = await conn.execute('SELECT * FROM tecidos WHERE id = ?', [r.insertId]);
            return {
                ...rows[0],
                ...(temMetragem ? {
                    modo,
                    metragem: metros2,
                    quantidade,
                    total_m: +(metros2 * quantidade).toFixed(2),
                    rolos
                } : { rolos: [] })
            };
        });
        ok(res, resultado);
    } catch (e) {
        if (e.code === '23505') return fail(res, new Error('Já existe tecido com esse código.'));
        fail(res, e);
    }
});

/* Ajustes do tecido: localização física e estoque mínimo.
   Não altera saldo — saldo só muda por entrada, corte, contagem ou estorno. */
app.patch('/api/tecidos/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, new Error('Tecido inválido.'));
    const b = req.body || {};
    const campos = [];
    const params = [];

    if (b.localizacao !== undefined) {
        const local = b.localizacao == null ? null : (String(b.localizacao).trim().slice(0, 60) || null);
        campos.push('localizacao = ?');
        params.push(local);
    }
    if (b.estoque_minimo_m !== undefined) {
        const min = num(b.estoque_minimo_m);
        if (!Number.isFinite(min) || min < 0)
            return fail(res, new Error('Estoque mínimo inválido.'));
        campos.push('estoque_minimo_m = ?');
        params.push(+min.toFixed(2));
    }
    if (!campos.length)
        return fail(res, new Error('Informe a localização ou o estoque mínimo.'));

    try {
        params.push(id);
        const [r] = await pool.execute(
            `UPDATE tecidos SET ${campos.join(', ')} WHERE id = ?`, params);
        if (!r.affectedRows) return fail(res, erro('Tecido não encontrado.', 404));
        const [rows] = await pool.execute(
            'SELECT * FROM vw_saldo_tecidos WHERE id = ?', [id]);
        ok(res, mapTecidoResumo(rows[0]));
    } catch (e) { fail(res, e); }
});

/* ROLOS (entrada + código interno) */
app.post('/api/rolos', async (req, res) => {
    const b = req.body || {};
    const tecido_id = num(b.tecido_id);
    const metros = num(b.metragem);
    const usuario = b.usuario == null ? null : String(b.usuario).slice(0, 100);
    if (!Number.isInteger(tecido_id) || tecido_id <= 0 || !Number.isFinite(metros) || !(metros > 0))
        return fail(res, new Error('Tecido e metragem válida são obrigatórios.'));
    const metros2 = +metros.toFixed(2);
    if (!(metros2 > 0)) return fail(res, new Error('Informe metragem maior que zero.'));
    if (metros2 > DECIMAL_MAX)
        return fail(res, new Error(`Metragem acima do permitido (máx. ${DECIMAL_MAX} m).`));
    try {
        const rolo = await withTransaction(async conn => {
            const [tec] = await conn.execute('SELECT id FROM tecidos WHERE id = ?', [tecido_id]);
            if (!tec.length) throw erro('Tecido informado não existe.', 404);
            return criarRolo(conn, { tecido_id, metros: metros2, usuario });
        });
        ok(res, rolo);
    } catch (e) {
        if (['23503', '23502'].includes(e.code))
            return fail(res, new Error('Tecido informado não existe.'));
        fail(res, e);
    }
});

/* Entrada em lote: N rolos com a mesma metragem (um código interno por rolo) */
app.post('/api/rolos/lote', async (req, res) => {
    const b = req.body || {};
    const tecido_id = num(b.tecido_id);
    const metros = num(b.metragem);
    const modo = b.modo === 'metros' ? 'metros' : 'rolos';
    const quantidade = modo === 'metros' ? 1 : quantidadeRolos(b.quantidade);
    const usuario = b.usuario == null ? null : String(b.usuario).slice(0, 100);
    const observacao = b.observacao == null ? null : String(b.observacao).slice(0, 255);

    if (!Number.isInteger(tecido_id) || tecido_id <= 0 || !Number.isFinite(metros) || !(metros > 0))
        return fail(res, new Error('Tecido e metragem válida são obrigatórios.'));
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > MAX_ROLOS_LOTE)
        return fail(res, new Error(`Quantidade de rolos deve ser entre 1 e ${MAX_ROLOS_LOTE}.`));
    const metros2 = +metros.toFixed(2);
    if (!(metros2 > 0)) return fail(res, new Error('Informe metragem maior que zero.'));
    if (metros2 > DECIMAL_MAX)
        return fail(res, new Error(`Metragem acima do permitido (máx. ${DECIMAL_MAX} m).`));

    try {
        const lote = await withTransaction(async conn => {
            const [tecRows] = await conn.execute(
                'SELECT id, codigo, nome FROM tecidos WHERE id = ?', [tecido_id]);
            const tecido = tecRows[0];
            if (!tecido) throw erro('Tecido informado não existe.', 404);
            const rolos = await inserirRolos(conn, {
                tecido_id, metros: metros2, quantidade, usuario, observacao
            });
            return {
                tecido,
                modo,
                quantidade,
                metragem: metros2,
                total_m: +(metros2 * quantidade).toFixed(2),
                rolos
            };
        });
        ok(res, lote);
    } catch (e) { fail(res, e); }
});

app.get('/api/rolos/:codigo', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT r.*, t.nome AS tecido_nome, t.codigo AS tecido_codigo
       FROM rolos r JOIN tecidos t ON t.id = r.tecido_id
       WHERE r.codigo_qr = ?`,
            [String(req.params.codigo).toUpperCase().trim()]);
        if (!rows.length) return fail(res, new Error('Rolo não encontrado.'), 404);
        const r = rows[0];
        ok(res, {
            ...r, metragem_atual: Number(r.metragem_atual),
            tecidos: { nome: r.tecido_nome, codigo: r.tecido_codigo }
        });
    } catch (e) { fail(res, e, 500); }
});

/* CORTES — contabilização automática da metragem cortada */
app.get('/api/cortes/resumo', async (req, res) => {
    const parsed = parseInt(req.query.dias, 10);
    const dias = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 30, 365);
    try {
        const [[periodo]] = await pool.query(
            `SELECT COALESCE(SUM(metros), 0) AS total_m, COUNT(*) AS lancamentos
               FROM movimentacoes
              WHERE tipo = 'saida' AND cancelada_em IS NULL
                AND criado_em >= tecsource_dia(?)`,
            [dias - 1]
        );
        const [[hoje]] = await pool.query(
            `SELECT COALESCE(SUM(metros), 0) AS total_m, COUNT(*) AS lancamentos
               FROM movimentacoes
              WHERE tipo = 'saida' AND cancelada_em IS NULL
                AND criado_em >= tecsource_dia(0) AND criado_em < tecsource_dia(-1)`
        );
        const [[semana]] = await pool.query(
            `SELECT COALESCE(SUM(metros), 0) AS total_m
               FROM movimentacoes
              WHERE tipo = 'saida' AND cancelada_em IS NULL
                AND criado_em >= tecsource_dia(6)`
        );
        const [serieRows] = await pool.query(
            `SELECT to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
                    SUM(metros) AS metros
               FROM movimentacoes
              WHERE tipo = 'saida' AND cancelada_em IS NULL
                AND criado_em >= tecsource_dia(?)
              GROUP BY 1
              ORDER BY 1`,
            [dias - 1]
        );
        const [tecidos] = await pool.query(
            `SELECT t.id, t.codigo, t.nome,
                    SUM(m.metros) AS total_m, COUNT(*) AS cortes
               FROM movimentacoes m
               JOIN rolos r ON r.id = m.rolo_id
               JOIN tecidos t ON t.id = r.tecido_id
              WHERE m.tipo = 'saida' AND m.cancelada_em IS NULL
                AND m.criado_em >= tecsource_dia(?)
              GROUP BY t.id, t.codigo, t.nome
              ORDER BY total_m DESC
              LIMIT 5`,
            [dias - 1]
        );
        const [operadores] = await pool.query(
            `SELECT COALESCE(NULLIF(m.usuario, ''), 'Não informado') AS usuario,
                    SUM(m.metros) AS total_m, COUNT(*) AS cortes
               FROM movimentacoes m
              WHERE m.tipo = 'saida' AND m.cancelada_em IS NULL
                AND m.criado_em >= tecsource_dia(?)
              GROUP BY 1
              ORDER BY total_m DESC
              LIMIT 5`,
            [dias - 1]
        );
        const [ultimos] = await pool.query(
            `SELECT m.id, m.metros, m.usuario, m.criado_em,
                    r.codigo_qr, t.nome AS tecido_nome, t.codigo AS tecido_codigo
               FROM movimentacoes m
               JOIN rolos r ON r.id = m.rolo_id
               JOIN tecidos t ON t.id = r.tecido_id
              WHERE m.tipo = 'saida' AND m.cancelada_em IS NULL
              ORDER BY m.criado_em DESC, m.id DESC
              LIMIT 10`
        );

        const chaveDia = valor => {
            if (typeof valor === 'string') return valor.slice(0, 10);
            const d = new Date(valor);
            const p = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        };
        const porDia = new Map(serieRows.map(r => [chaveDia(r.dia), Number(r.metros)]));
        const serie = [];
        for (let i = dias - 1; i >= 0; i--) {
            const d = new Date();
            d.setHours(12, 0, 0, 0);
            d.setDate(d.getDate() - i);
            serie.push({ dia: chaveDia(d), metros: +(porDia.get(chaveDia(d)) || 0).toFixed(2) });
        }

        ok(res, {
            dias,
            totais: {
                periodo_m: Number(periodo.total_m),
                lancamentos: Number(periodo.lancamentos),
                hoje_m: Number(hoje.total_m),
                hoje_lancamentos: Number(hoje.lancamentos),
                sete_dias_m: Number(semana.total_m)
            },
            serie,
            tecidos: tecidos.map(t => ({ ...t, total_m: Number(t.total_m), cortes: Number(t.cortes) })),
            operadores: operadores.map(o => ({ ...o, total_m: Number(o.total_m), cortes: Number(o.cortes) })),
            ultimos: ultimos.map(m => ({ ...m, metros: Number(m.metros) }))
        });
    } catch (e) { fail(res, e, 500); }
});

/* MOVIMENTAÇÕES */
app.post('/api/movimentacoes/saida', async (req, res) => {
    const { codigo_qr, metros, usuario, observacao, client_key } = req.body || {};
    try {
        ok(res, await registrarSaida({
            codigo_qr: String(codigo_qr ?? '').toUpperCase().trim(),
            metros: num(metros),
            usuario: usuario == null ? null : String(usuario).slice(0, 100),
            observacao: observacao == null ? null : String(observacao).slice(0, 255),
            client_key: chaveCliente(client_key)
        }));
    } catch (e) { fail(res, e); }
});

app.post('/api/movimentacoes/ajuste', async (req, res) => {
    const { codigo_qr, metragem_real, usuario, client_key } = req.body || {};
    try {
        ok(res, await registrarAjuste({
            codigo_qr: String(codigo_qr ?? '').toUpperCase().trim(),
            metragem_real: num(metragem_real),
            usuario: usuario == null ? null : String(usuario).slice(0, 100),
            client_key: chaveCliente(client_key)
        }));
    } catch (e) { fail(res, e); }
});

/* Desfazer lançamento (estorno auditável) */
app.post('/api/movimentacoes/:id/estorno', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, new Error('Movimentação inválida.'));
    const b = req.body || {};
    try {
        ok(res, await registrarEstorno({
            movimentacao_id: id,
            usuario: b.usuario == null ? null : String(b.usuario).slice(0, 100),
            motivo: b.motivo == null ? null : String(b.motivo).slice(0, 255)
        }));
    } catch (e) { fail(res, e); }
});

app.get('/api/movimentacoes', async (req, res) => {
    const parsed = parseInt(req.query.limit, 10);
    const limit = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 30, 100);
    try {
        const [rows] = await pool.query(
            `SELECT m.*, r.codigo_qr, t.nome AS tecido_nome
       FROM movimentacoes m
       JOIN rolos r ON r.id = m.rolo_id
       JOIN tecidos t ON t.id = r.tecido_id
       ORDER BY m.criado_em DESC, m.id DESC
       LIMIT ${limit}`);
        ok(res, rows.map(m => ({
            ...m, metros: Number(m.metros),
            rolos: { codigo_qr: m.codigo_qr, tecidos: { nome: m.tecido_nome } }
        })));
    } catch (e) { fail(res, e, 500); }
});

/* Corpo JSON inválido → resposta JSON padronizada (em vez de HTML do Express) */
app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed')
        return res.status(400).json({ ok: false, erro: 'JSON inválido no corpo da requisição.' });
    if (err?.type === 'entity.too.large')
        return res.status(413).json({ ok: false, erro: 'Corpo da requisição muito grande.' });
    next(err);
});

/* Rotas de API inexistentes → JSON (evita que o frontend receba HTML) */
app.use('/api', (_req, res) =>
    res.status(404).json({ ok: false, erro: 'Rota não encontrada.' }));

/* Última linha de defesa: qualquer erro não tratado vira JSON (não expõe stack trace) */
app.use((err, _req, res, _next) => {
    console.error('[TecSource] erro não tratado:', err);
    res.status(500).json({ ok: false, erro: 'Erro interno no servidor.' });
});

/* Falha cedo (com instruções claras) se o banco não estiver acessível. */
try {
    await pool.query('SELECT 1');
    console.log('✅ Banco de dados conectado.');
} catch (e) {
    console.error('\n❌ Não foi possível conectar ao banco de dados.');
    if (e?.message) console.error(`PostgreSQL: ${e.message}`);
    console.error(mensagemErroBanco(e));
    console.error('\nDiagnóstico: npm run db:check');
    console.error('Preparar banco: npm run db:setup');
    process.exit(1);
}

const PORT = process.env.PORT || 3000;
const servidor = app.listen(PORT, () => {
    console.log(`🧵 TecSource v${VERSAO} rodando na rede local: http://localhost:${PORT}`);
    console.log(`📱 Interface mobile: http://localhost:${PORT}/mobile.html`);
});

/* Encerramento limpo: devolve as conexões ao pool antes de sair. */
const encerrar = sinal => {
    console.log(`\n[TecSource] ${sinal} recebido; encerrando...`);
    servidor.close(async () => {
        try { await pool.end(); } catch { /* pool já fechado */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => encerrar('SIGINT'));
process.on('SIGTERM', () => encerrar('SIGTERM'));