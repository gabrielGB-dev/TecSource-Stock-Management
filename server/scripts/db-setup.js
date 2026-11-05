import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    pool, withTransaction, nomeBanco, mensagemErroBanco, executarScript
} from '../src/db.js';

const raizProjeto = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const banco = nomeBanco;

const arquivoEnv = path.join(raizProjeto, 'server', '.env');
if (!fs.existsSync(arquivoEnv)) {
    console.log('ℹ  server/.env não encontrado; usando DATABASE_URL do ambiente.');
    console.log('   Para configurar: cp server/.env.example server/.env\n');
}

const comDemo = process.argv.includes('--demo');
const comFeira = process.argv.includes('--feira');
const resetar = process.argv.includes('--reset');
const confirmado = process.env.CONFIRMAR_RESET === '1' || process.argv.includes('--yes');

if (resetar && !confirmado) {
    console.error('⚠  O comando db:reset APAGA todas as tabelas e os dados.');
    console.error('   No Supabase o banco em si é preservado (não é possível dropá-lo).');
    console.error('   Para confirmar, execute:');
    console.error(`   CONFIRMAR_RESET=1 npm run db:reset`);
    console.error('   Ou use npm run demo:reset para recriar com dados de demonstração.');
    process.exit(1);
}

/* Cenário de demonstração (usado por inserirDemo, no fim do arquivo). */
const OPERADORES = ['Ana Paula', 'Carlos Menezes', 'Juliana Reis', 'Marcos Silva'];
const DIAS_HISTORICO = 60;

/* Cada tecido define os rolos como [metros iniciais, saldo final].
   O gerador distribui a diferença em cortes ao longo dos dias. */
const CENARIO = [
    { codigo: 'TEX-101', nome: 'Linho Off-White', minimo: 20, local: 'Corredor A · Prateleira 1', rolos: [[45, 32], [30, 26]] },
    { codigo: 'TEX-102', nome: 'Veludo Bordô', minimo: 15, local: 'Corredor A · Prateleira 2', rolos: [[25, 9]] },
    { codigo: 'TEX-103', nome: 'Seda Marfim', minimo: 10, local: 'Corredor B · Prateleira 1', rolos: [[18, 0]] },
    { codigo: 'TEX-104', nome: 'Juta Natural', minimo: 25, local: 'Corredor B · Prateleira 3', rolos: [[40, 10], [20, 8]] },
    { codigo: 'TEX-105', nome: 'Sarja Azul Marinho', minimo: 30, local: 'Corredor C · Prateleira 1', rolos: [[60, 48], [60, 44]] },
    { codigo: 'TEX-106', nome: 'Tricoline Branca', minimo: 40, local: 'Corredor C · Prateleira 2', rolos: [[100, 35]] },
    { codigo: 'TEX-107', nome: 'Oxford Cinza', minimo: 20, local: 'Corredor C · Prateleira 3', rolos: [[35, 30], [35, 28]] },
    { codigo: 'TEX-108', nome: 'Cetim Nude', minimo: 12, local: 'Corredor D · Prateleira 1', rolos: [[20, 0]] },
    { codigo: 'TEX-109', nome: 'Organza Cristal', minimo: 10, local: 'Corredor D · Prateleira 2', rolos: [[25, 21]] },
    { codigo: 'TEX-110', nome: 'Tafetá Rosa', minimo: 15, local: 'Corredor D · Prateleira 3', rolos: [[30, 12]] },
    { codigo: 'TEX-111', nome: 'Gorgurão Preto', minimo: 20, local: 'Corredor E · Prateleira 1', rolos: [[50, 41], [50, 33]] },
    { codigo: 'TEX-112', nome: 'Chiffon Verde Água', minimo: 8, local: 'Corredor E · Prateleira 2', rolos: [[16, 7]] },
    { codigo: 'TEX-113', nome: 'Brim Caqui', minimo: 25, local: 'Corredor F · Prateleira 1', rolos: [[70, 58], [70, 52]] },
    { codigo: 'TEX-114', nome: 'Lã Cinza Mescla', minimo: 18, local: 'Corredor F · Prateleira 2', rolos: [[40, 36]] }
];

/* Cenário da feira (npm run feira:reset):
   os 4 tecidos com etiqueta QR já impressas (TEX-001..TEX-004), com os
   mesmos códigos de rolo que estão no banco, saldos finais exatos e
   ~60 dias de histórico — o painel começa "vivo" (consumo, cobertura,
   alerta de estoque baixo no TEX-002).
   Aceita rolo como [inicial, final] ou [codigo_qr, inicial, final]. */
const CENARIO_FEIRA = [
    { codigo: 'TEX-001', nome: 'Linho Off-White', minimo: 10, local: 'Corredor A · Prateleira 1', rolos: [['ROL-0ED0E1A3', 30, 20], ['ROL-2F1F33C2F8C0', 30, 20]] },
    { codigo: 'TEX-002', nome: 'Linho Bege White', minimo: 10, local: 'Corredor A · Prateleira 2', rolos: [['ROL-4F38FB85', 50, 5]] },
    { codigo: 'TEX-003', nome: 'Veludo Dark Olive', minimo: 10, local: 'Corredor B · Prateleira 1', rolos: [['ROL-6E7FD4041F22', 55, 30]] },
    { codigo: 'TEX-004', nome: 'Veludo Deep Black', minimo: 10, local: 'Corredor B · Prateleira 2', rolos: [['ROL-A97B8205EEC7', 45, 30]] }
];

try {
    console.log(`Conectando ao PostgreSQL — banco "${banco}"...`);
    await pool.query('SELECT 1');
    console.log(`✅ Banco "${banco}" acessível.`);

    if (resetar) {
        /* No Supabase não é possível apagar o database: apagamos os objetos. */
        await executarScript(`
            DROP VIEW  IF EXISTS vw_saldo_tecidos;
            DROP TABLE IF EXISTS movimentacoes, rolos, tecidos CASCADE;
        `);
        console.log('🗑  Tabelas e view apagadas (o banco foi preservado).');
    }

    const arquivoSchema = path.join(raizProjeto, 'sql', 'schema.sql');
    const arquivoView = path.join(raizProjeto, 'sql', 'view.sql');

    await executarScript(fs.readFileSync(arquivoSchema, 'utf8'));
    console.log('✅ Tabelas, índices, funções de data e RLS verificados.');

    await executarScript(fs.readFileSync(arquivoView, 'utf8'));
    console.log('✅ View vw_saldo_tecidos criada/atualizada.');

    if (comFeira) {
        /* Apaga o que o público criou/restou e recria o cenário da feira
           numa única transação: quem estiver usando o painel enxerga a
           troca de uma vez, nunca um banco meio vazio. */
        const resumo = await withTransaction(conn => inserirCenario(conn, CENARIO_FEIRA, {
            semente: 20261104,
            ajusteEm: ['TEX-003', 'TEX-004'],
            limpar: true,
            corte: [0.5, 6]
        }));
        console.log('✅ Cenário da feira restaurado (4 tecidos com QR impresso).');
        console.log(`   ${resumo.tecidos} tecidos · ${resumo.rolos} rolos · ${resumo.movimentacoes} movimentações`);
        console.log(`   Histórico de cortes: ${resumo.dias} dias · saldo total: ${resumo.total} m`);
        console.log('   QRs válidos: TEC:TEX-001 · TEC:TEX-002 · TEC:TEX-003 · TEC:TEX-004');
    } else if (comDemo) {
        const [tecidos] = await pool.query('SELECT COUNT(*) AS n FROM tecidos');
        if (Number(tecidos[0].n) > 0) {
            console.log('ℹ  Já existem tecidos cadastrados; dados de demonstração não foram inseridos.');
            console.log('   Para recriar o cenário do zero: npm run demo:reset');
        } else {
            const resumo = await withTransaction(conn => inserirCenario(conn, CENARIO, {
                semente: 20261030,
                ajusteEm: ['TEX-105', 'TEX-110']
            }));
            console.log('✅ Dados de demonstração inseridos.');
            console.log(`   ${resumo.tecidos} tecidos · ${resumo.rolos} rolos · ${resumo.movimentacoes} movimentações`);
            console.log(`   Histórico de cortes: ${resumo.dias} dias · saldo total: ${resumo.total} m`);
        }
    }

    const [totais] = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM tecidos)       AS tecidos,
          (SELECT COUNT(*) FROM rolos)         AS rolos,
          (SELECT COUNT(*) FROM movimentacoes) AS movimentacoes
    `);

    console.log('\n────────────────────────────────────────────');
    console.log('Setup concluído com sucesso.');
    console.log(`Banco: ${banco}`);
    console.log(`Tecidos: ${totais[0].tecidos} · Rolos: ${totais[0].rolos} · Movimentações: ${totais[0].movimentacoes}`);
    console.log('\nPróximo passo:');
    console.log('  npm start');
    console.log('  Abra http://localhost:3000');
    console.log('────────────────────────────────────────────');
} catch (e) {
    console.error('\n❌ Não foi possível preparar o banco de dados.');
    if (e?.detail) console.error(`PostgreSQL: ${e.detail}`);
    else if (e?.message) console.error(`Detalhe: ${e.message}`);
    console.error(mensagemErroBanco(e));
    if (e?.code === '42601' || e?.code === '42P01') {
        console.error('O arquivo sql/schema.sql ou sql/view.sql parece inválido. Restaure-o a partir do projeto.');
    }
    process.exitCode = 1;
} finally {
    await pool.end().catch(() => { });
}

/* ============================================================
   Gerador de cenário (demonstração e feira)
   ------------------------------------------------------------
   Gerador determinístico (mesma semente = mesmo cenário) com
   ~60 dias de cortes espalhados no tempo, para que o painel,
   a série diária e o ranking tenham o que mostrar.

   Cada rolo declara [inicial, final] (ou [codigo_qr, inicial,
   final]) e a contabilidade fecha exatamente:
   entradas + ajustes − cortes = saldo final do rolo.
   ============================================================ */

function geradorAleatorio(semente) {
    let a = semente >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* Divide a metragem consumida em cortes de `minimo` a `maximo` m.
   A soma dos cortes fecha exatamente o total (sem sobra de arredondamento). */
function dividirEmCortes(total, rnd, [minimo, maximo] = [0.5, 15]) {
    if (total <= 0) return [];
    const partes = [];
    let restante = +total.toFixed(2);
    while (restante > 0.4) {
        const limite = Math.min(maximo, restante);
        const valor = +Math.min(limite, Math.max(minimo, +(minimo + rnd() * (maximo - minimo)).toFixed(1))).toFixed(1);
        const parte = +Math.min(valor, restante).toFixed(2);
        if (parte <= 0) break;
        partes.push(parte);
        restante = +(restante - parte).toFixed(2);
    }
    if (restante > 0) {
        if (!partes.length) partes.push(+restante.toFixed(2));
        else partes[partes.length - 1] = +(partes[partes.length - 1] + restante).toFixed(2);
    }
    return partes;
}

async function inserirCenario(conn, cenario, { semente, ajusteEm = [], limpar = false, corte = [0.5, 15] } = {}) {
    const rnd = geradorAleatorio(semente);
    const agora = Date.now();
    const dia = ms => new Date(ms);

    /* Data de movimentação entre dias atrás [min, max], em horário comercial.
       Se o horário cair no futuro (execução de manhã), usa alguns minutos
       atrás — assim "cortado hoje" já aparece no painel. */
    const dataEntre = (diasMin, diasMax) => {
        const dias = diasMin + Math.floor(rnd() * (diasMax - diasMin + 1));
        const hora = 8 + Math.floor(rnd() * 9);
        const minuto = Math.floor(rnd() * 60);
        const d = new Date(agora - dias * 86400000);
        d.setHours(hora, minuto, 0, 0);
        if (d.getTime() > agora) return new Date(agora - (5 + Math.floor(rnd() * 50)) * 60000);
        return d;
    };

    let totalRolos = 0;
    let totalMov = 0;
    let totalSaldo = 0;
    let ordemAjuste = 0;

    /* Limpeza do cenário da feira (mesma transação do insert). */
    if (limpar) {
        await conn.query('DELETE FROM movimentacoes');
        await conn.query('DELETE FROM rolos');
        await conn.query('DELETE FROM tecidos');
    }

    for (const tecido of cenario) {
        const [t] = await conn.query(
            'INSERT INTO tecidos (codigo, nome, estoque_minimo_m, localizacao) VALUES (?,?,?,?) RETURNING id',
            [tecido.codigo, tecido.nome, tecido.minimo, tecido.local]
        );

        for (const [indice, roloDef] of tecido.rolos.entries()) {
            const [codigoRolo, inicial, saldo] = typeof roloDef[0] === 'string'
                ? roloDef
                : [null, roloDef[0], roloDef[1]];
            const sufixo = String(indice + 1).padStart(2, '0');
            const codigo = codigoRolo || `ROL-${tecido.codigo.replace('TEX-', '')}${sufixo}`;
            const status = saldo > 0 ? 'ativo' : 'esgotado';
            const [r] = await conn.query(
                `INSERT INTO rolos (tecido_id, codigo_qr, metragem_inicial, metragem_atual, status)
                 VALUES (?,?,?,?,?) RETURNING id`,
                [t.insertId, codigo, inicial, saldo, status]
            );
            totalRolos++;
            totalSaldo += saldo;

            /* Ajuste de contagem no primeiro rolo dos tecidos indicados. */
            const ajuste = (indice === 0 && ajusteEm.includes(tecido.codigo))
                ? (ordemAjuste++ % 2 === 0 ? -1.5 : 0.8)
                : 0;

            /* Reposição no meio do histórico (só quando o saldo final comporta). */
            const reposicao = (saldo >= 15 && rnd() < 0.45)
                ? +(5 + rnd() * 15).toFixed(2)
                : 0;

            /* Contabilidade: inicial + reposição + ajuste − cortes = saldo final. */
            const consumo = Math.max(0, +(inicial + reposicao + ajuste - saldo).toFixed(2));

            const movs = [{
                tipo: 'entrada', metros: inicial, obs: 'Entrada inicial de estoque',
                quando: dia(agora - (DIAS_HISTORICO + 5) * 86400000)
            }];
            if (reposicao) movs.push({
                tipo: 'entrada', metros: reposicao, obs: 'Reposição de metragem no rolo',
                quando: dataEntre(3, 23)
            });
            if (ajuste) movs.push({
                tipo: 'ajuste', metros: ajuste, obs: 'Contagem física',
                quando: dataEntre(2, 20)
            });

            /* ~60% do consumo cai nos últimos 30 dias (janela do painel);
               o resto fica entre 30 e 60 dias para a série ter histórico. */
            const recente = +(consumo * (0.55 + rnd() * 0.15)).toFixed(2);
            const antigo = +(consumo - recente).toFixed(2);
            for (const metros of dividirEmCortes(antigo, rnd, corte))
                movs.push({ tipo: 'saida', metros, obs: null, quando: dataEntre(30, DIAS_HISTORICO - 1) });
            for (const metros of dividirEmCortes(recente, rnd, corte))
                movs.push({ tipo: 'saida', metros, obs: null, quando: dataEntre(0, 29) });

            movs.sort((a, b) => a.quando - b.quando);

            /* Com 60% de chance, o corte mais recente do rolo cai "hoje":
               o painel abre com "Cortado hoje" já vivo (só muda a data). */
            const ultimoCorte = movs.findLastIndex(m => m.tipo === 'saida');
            if (ultimoCorte >= 0 && rnd() < 0.6) movs[ultimoCorte].quando = dataEntre(0, 0);

            for (const mov of movs) {
                await conn.query(
                    `INSERT INTO movimentacoes (rolo_id, tipo, metros, usuario, observacao, criado_em)
                     VALUES (?,?,?,?,?,?)`,
                    [r.insertId, mov.tipo, mov.metros,
                    OPERADORES[Math.floor(rnd() * OPERADORES.length)], mov.obs, mov.quando]
                );
                totalMov++;
            }
        }
    }

    return {
        tecidos: cenario.length,
        rolos: totalRolos,
        movimentacoes: totalMov,
        dias: DIAS_HISTORICO,
        total: +totalSaldo.toFixed(2)
    };
}
