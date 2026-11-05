import pg from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Pool, types } = pg;

/* O driver pg devolve NUMERIC e BIGINT como string (para não perder
   precisão). As colunas do TecSource são DECIMAL(10,2) e contadores,
   que cabem com folga em Number — e o resto do código já trabalha com
   números. Sem isso, `saldo_m + 1` viraria concatenação de texto. */
types.setTypeParser(1700, v => (v === null ? null : Number(v))); /* numeric */
types.setTypeParser(20, v => (v === null ? null : Number(v)));   /* int8    */

/* Fuso das janelas de "hoje", 7 e 30 dias. Fica gravado nas funções
   SQL (sql/schema.sql) para não depender da configuração de sessão do
   servidor — o pooler do Supabase (pgbouncer) não mantém SET por sessão. */
export const FUSO = process.env.DB_TIMEZONE || 'America/Sao_Paulo';

/* Conexão:
   - DATABASE_URL (recomendado, é o que o Supabase entrega) ou variáveis PG*;
   - DATABASE_SSL=true para Supabase/Render (certificado gerenciado). */
const url = process.env.DATABASE_URL || '';
const sslAtivo = String(
    process.env.DATABASE_SSL ?? (url ? 'true' : 'false')
).toLowerCase() === 'true';

const semUrl = {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE || 'tecsource'
};

export const dbConfig = {
    ...(url ? { connectionString: url } : semUrl),
    ssl: sslAtivo ? { rejectUnauthorized: false } : false
};

/* Nome do banco, só para mensagens e para os scripts. */
export const nomeBanco = (() => {
    if (!url) return semUrl.database;
    try {
        return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || 'postgres';
    } catch {
        return 'postgres';
    }
})();

const interno = new Pool({
    ...dbConfig,
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    allowExitOnIdle: true
});

/* Erro de conexão não pode derrubar o processo: o pg emite 'error' no
   pool quando uma conexão ociosa cai (comum em pooler/serverless). */
interno.on('error', err => {
    console.error('[TecSource] conexão ociosa do banco caiu:', err.message);
});

/* O restante do código foi escrito no formato do mysql2:
     const [rows] = await conn.execute(sql, params)
     const [r]    = await conn.execute('INSERT ... RETURNING id')  → r.insertId
   Em vez de reescrever 900 linhas, traduzimos aqui:
   - `?`  → `$1, $2, ...`
   - SELECT → [rows]
   - INSERT/UPDATE/DELETE → [{ affectedRows, insertId, rows }]        */
const paraPostgres = sql => {
    let n = 0;
    return String(sql).replace(/\?/g, () => `$${++n}`);
};

const adaptar = resultado => {
    if (['INSERT', 'UPDATE', 'DELETE'].includes(resultado.command)) {
        return [{
            rows: resultado.rows,
            affectedRows: resultado.rowCount,
            insertId: resultado.rows?.[0]?.id
        }, resultado];
    }
    return [resultado.rows, resultado];
};

const executor = alvo => ({
    query: async (sql, params = []) => adaptar(await alvo.query(paraPostgres(sql), params)),
    execute: async (sql, params = []) => adaptar(await alvo.query(paraPostgres(sql), params))
});

export const pool = Object.assign(executor(interno), {
    /* SQL sem placeholders (DDL de vários comandos) — não passa pela tradução. */
    queryCrua: (sql, params) => (params ? interno.query(sql, params) : interno.query(sql)),
    end: () => interno.end(),
    on: (...args) => interno.on(...args)
});

/* Executa um arquivo .sql inteiro (schema.sql / view.sql).
   Sem parâmetros o pg usa o protocolo simples, que aceita vários comandos. */
export const executarScript = sql => interno.query(sql);

/* Transação atômica: ou executa tudo, ou desfaz tudo */
export async function withTransaction(fn) {
    const cliente = await interno.connect();
    const api = executor(cliente);
    try {
        await cliente.query('BEGIN');
        const resultado = await fn(api);
        await cliente.query('COMMIT');
        return resultado;
    } catch (e) {
        try { await cliente.query('ROLLBACK'); } catch { /* conexão já caiu */ }
        throw e;
    } finally {
        cliente.release();
    }
}

/* Traduz os erros mais comuns de PostgreSQL/Supabase em instruções acionáveis. */
export function mensagemErroBanco(e) {
    const dicas = [];
    switch (e?.code) {
        case 'ECONNREFUSED':
            dicas.push('O PostgreSQL não respondeu nesse host/porta.');
            dicas.push('Se for local, suba o banco com: docker compose up -d');
            dicas.push('Se for Supabase, confira a connection string em DATABASE_URL.');
            break;
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            dicas.push('O host do banco não foi encontrado (DNS).');
            dicas.push('Confira o host em DATABASE_URL — no Supabase ele termina em .supabase.co ou .pooler.supabase.com.');
            break;
        case 'ETIMEDOUT':
        case 'ECONNRESET':
            dicas.push('A conexão com o PostgreSQL caiu ou expirou.');
            dicas.push('No Supabase, prefira a porta 6543 (Connection Pooler) no DATABASE_URL.');
            break;
        case '28P01':
        case '28000':
            dicas.push('Usuário ou senha do PostgreSQL incorretos.');
            dicas.push('No Supabase, use a connection string de Project Settings → Database.');
            dicas.push('Se a senha tiver caracteres especiais (@, #, /, :), codifique com encodeURIComponent.');
            break;
        case '3D000':
            dicas.push(`O banco "${nomeBanco}" não existe.`);
            dicas.push('No Supabase o banco padrão é "postgres"; não crie outro.');
            dicas.push('Depois de ajustar, rode: npm run db:setup');
            break;
        case '42501':
            dicas.push('O usuário do banco não tem permissão para esta operação.');
            dicas.push('Use o usuário "postgres" (dono das tabelas) na connection string da API.');
            break;
        case '42P01':
            dicas.push('Tabela ou view não encontrada: a estrutura ainda não foi criada.');
            dicas.push('Execute: npm run db:setup');
            break;
        case '23505':
            dicas.push('Registro duplicado (código, QR ou chave de idempotência já usados).');
            break;
        case '57P01':
            dicas.push('O servidor encerrou a conexão (manutenção ou reinício). Tente novamente.');
            break;
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
            dicas.push('O certificado TLS do banco não foi aceito.');
            dicas.push('Defina DATABASE_SSL=true para usar o certificado gerenciado do Supabase.');
            break;
        default:
            if (e?.message) dicas.push(`Detalhe: ${e.message}`);
            dicas.push('Confira DATABASE_URL e DATABASE_SSL em server/.env.');
            dicas.push('Para diagnosticar, execute: npm run db:check');
    }
    return dicas.join('\n');
}
