/* feira-check — valida a coerência do cenário carregado no banco.
   Uso:  npm run feira:check                  (banco do DATABASE_URL)
   Confere: view do painel, saldo por rolo (entradas + ajustes − cortes
   == metragem_atual), série de 30 dias, total do período e datas futuras. */
import { pool, nomeBanco } from '../src/db.js';

const db = nomeBanco;

try {
    const [v] = await pool.query(
        'SELECT codigo, nome, saldo_m, rolos_ativos, consumo_30d, cobertura_dias, situacao FROM vw_saldo_tecidos ORDER BY codigo'
    );
    console.log(`VIEW (${db}):`);
    console.table(v);

    const [coh] = await pool.query(
        `SELECT r.codigo_qr,
                ROUND(SUM(CASE WHEN m.tipo = 'entrada' THEN m.metros
                               WHEN m.tipo = 'ajuste' THEN m.metros
                               WHEN m.tipo = 'saida' THEN -m.metros
                               ELSE 0 END)::numeric, 2) AS calculado,
                r.metragem_atual
           FROM movimentacoes m
           JOIN rolos r ON r.id = m.rolo_id
          WHERE m.cancelada_em IS NULL
          GROUP BY r.id, r.codigo_qr, r.metragem_atual`
    );
    console.log('COERENCIA por rolo (calculado == metragem_atual):');
    console.table(coh);
    const coerente = coh.every(l => Number(l.calculado) === Number(l.metragem_atual));

    const [serie] = await pool.query(
        `SELECT to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d,
                COUNT(*) AS n, ROUND(SUM(metros), 1) AS m
           FROM movimentacoes
          WHERE tipo = 'saida' AND cancelada_em IS NULL
            AND criado_em >= tecsource_dia(29)
          GROUP BY 1 ORDER BY 1`
    );
    console.log(`DIAS COM CORTE na janela 30d: ${serie.length} de 30`);
    console.table(serie);

    const [tot] = await pool.query(
        `SELECT ROUND(SUM(metros), 1) AS periodo
           FROM movimentacoes
          WHERE tipo = 'saida' AND cancelada_em IS NULL
            AND criado_em >= tecsource_dia(29)`
    );
    console.log('TOTAL 30d:', tot[0].periodo);

    const [tipos] = await pool.query(
        'SELECT tipo, COUNT(*) AS n, ROUND(SUM(metros), 1) AS total FROM movimentacoes GROUP BY tipo ORDER BY tipo'
    );
    console.table(tipos);

    const [futuro] = await pool.query(
        'SELECT COUNT(*) AS n FROM movimentacoes WHERE criado_em > now()'
    );
    console.log('Movimentações no futuro:', futuro[0].n);

    console.log('\nCoerência por rolo:', coerente ? 'OK' : 'FALHOU');
    if (!coerente) process.exitCode = 1;
} catch (e) {
    console.error('❌ Falha ao conferir o cenário:', e.message);
    process.exitCode = 1;
} finally {
    await pool.end().catch(() => { });
}
