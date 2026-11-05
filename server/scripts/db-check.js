import { pool, nomeBanco, mensagemErroBanco } from '../src/db.js';

const banco = nomeBanco;

try {
    const [versao] = await pool.query('SELECT version() AS versao');
    console.log(`✅ PostgreSQL acessível: ${String(versao[0].versao).split(',')[0]}`);
    console.log(`   Banco: ${banco}`);

    const [objetos] = await pool.query(`
        SELECT table_name AS nome, 'tabela' AS tipo
          FROM information_schema.tables
         WHERE table_schema = 'public'
        UNION ALL
        SELECT table_name, 'view'
          FROM information_schema.views
         WHERE table_schema = 'public'
    `);

    const existentes = new Set(objetos.map(o => o.nome));
    const faltando = ['tecidos', 'rolos', 'movimentacoes'].filter(t => !existentes.has(t));
    const temView = existentes.has('vw_saldo_tecidos');

    if (!faltando.length && temView) {
        await pool.query('SELECT * FROM vw_saldo_tecidos LIMIT 1');

        const [c] = await pool.query(`
            SELECT
              (SELECT COUNT(*) FROM tecidos)       AS tecidos,
              (SELECT COUNT(*) FROM rolos)         AS rolos,
              (SELECT COUNT(*) FROM movimentacoes) AS movimentacoes
        `);

        const [rls] = await pool.query(`
            SELECT relname AS tabela, relrowsecurity AS rls
              FROM pg_class
             WHERE relname IN ('tecidos', 'rolos', 'movimentacoes')
             ORDER BY relname
        `);
        const semRls = rls.filter(r => !r.rls).map(r => r.tabela);

        console.log('✅ Banco: 3 tabelas + view OK.');
        console.log(`   Tecidos: ${c[0].tecidos} · Rolos: ${c[0].rolos} · Movimentações: ${c[0].movimentacoes}`);
        if (semRls.length) {
            console.log(`⚠  RLS desligado em: ${semRls.join(', ')}. Rode npm run db:setup para religar.`);
        } else {
            console.log('✅ RLS ligado (a chave anon do Supabase não acessa as tabelas).');
        }
        console.log('\nTudo pronto. Inicie o servidor com: npm start');
    } else {
        if (faltando.length) console.error(`\n⚠  Tabelas ausentes em "${banco}": ${faltando.join(', ')}.`);
        if (!temView) console.error(`⚠  View ausente em "${banco}": vw_saldo_tecidos.`);
        console.error('   Corrija com: npm run db:setup');
        process.exitCode = 1;
    }
} catch (e) {
    console.error('\n❌ Não foi possível conectar ao banco de dados.');
    console.error(mensagemErroBanco(e));
    process.exitCode = 1;
} finally {
    await pool.end().catch(() => { });
}
