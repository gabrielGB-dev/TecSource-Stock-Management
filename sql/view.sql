-- ============================================================
-- TecSource — view de consulta do painel (PostgreSQL / Supabase)
--
-- Executada pelo `npm run db:setup` depois de sql/schema.sql.
-- Também pode ser colada no SQL Editor do Supabase depois do schema.
--
-- Concentra saldo, rolos ativos, consumo 30d, cortado total,
-- cobertura (dias), última movimentação e situação, para que
-- desktop e mobile não recalcullem regras.
--
-- Movimentações canceladas (estornadas) continuam na tabela para
-- auditoria, mas NÃO entram em consumo nem em cortado total.
--
-- DROP + CREATE (e não CREATE OR REPLACE) para garantir a opção
-- security_invoker em bancos que já tinham a view de uma versão
-- anterior. Nada depende da view, então a troca é segura.
-- ============================================================

DROP VIEW IF EXISTS vw_saldo_tecidos;

CREATE VIEW vw_saldo_tecidos
WITH (security_invoker = true)
AS
SELECT
    t.id,
    t.codigo,
    t.nome,
    t.estoque_minimo_m,
    t.localizacao,
    COALESCE(s.saldo_m, 0)         AS saldo_m,
    COALESCE(s.rolos_ativos, 0)    AS rolos_ativos,
    COALESCE(c.consumo_30d, 0)     AS consumo_30d,
    COALESCE(k.cortado_total_m, 0) AS cortado_total_m,
    CASE WHEN COALESCE(c.consumo_30d, 0) > 0
         THEN ROUND(COALESCE(s.saldo_m, 0) / (c.consumo_30d / 30), 1)
         ELSE NULL
    END                            AS cobertura_dias,
    u.ultima_movimentacao,
    CASE
        WHEN COALESCE(s.saldo_m, 0) <= 0 THEN 'critico'
        WHEN COALESCE(s.saldo_m, 0) < t.estoque_minimo_m THEN 'baixo'
        ELSE 'ok'
    END                            AS situacao
FROM tecidos t
LEFT JOIN (
    SELECT tecido_id,
           SUM(metragem_atual) AS saldo_m,
           COUNT(*) FILTER (WHERE metragem_atual > 0) AS rolos_ativos
      FROM rolos
     WHERE status = 'ativo'
     GROUP BY tecido_id
) s ON s.tecido_id = t.id
LEFT JOIN (
    SELECT r.tecido_id, SUM(m.metros) AS consumo_30d
      FROM movimentacoes m
      JOIN rolos r ON r.id = m.rolo_id
     WHERE m.tipo = 'saida'
       AND m.cancelada_em IS NULL
       AND m.criado_em >= tecsource_dia(29)
     GROUP BY r.tecido_id
) c ON c.tecido_id = t.id
LEFT JOIN (
    SELECT r.tecido_id, SUM(m.metros) AS cortado_total_m
      FROM movimentacoes m
      JOIN rolos r ON r.id = m.rolo_id
     WHERE m.tipo = 'saida'
       AND m.cancelada_em IS NULL
     GROUP BY r.tecido_id
) k ON k.tecido_id = t.id
LEFT JOIN (
    SELECT r.tecido_id, MAX(m.criado_em) AS ultima_movimentacao
      FROM movimentacoes m
      JOIN rolos r ON r.id = m.rolo_id
     GROUP BY r.tecido_id
) u ON u.tecido_id = t.id;
