# Rastreamento e Controle de Estoque Têxtil via QR Code

## Documentação Executiva e Operacional do Projeto

### 1. Resumo da Demanda e Proposta de Valor

* **Público-Alvo:** Pequenas e Médias Empresas (PMEs) do setor têxtil e confecções.
* **Problema Principal:** Gestão de estoque feita por anotações manuais, papéis e planilhas, gerando divergência entre o estoque físico e a informação disponível. Isso resulta em paradas na mesa de corte, perda de tecidos e compras de emergência desnecessárias.
* **Solução:** Aplicativo mobile focado no chão de fábrica para leitura e geração de QR Codes fixados nos **tecidos** (etiqueta única por modelo), com escolha do rolo na ficha — garantindo atualização instantânea da metragem utilizada e em estoque, mesmo sem sinal de internet.
* **Modelo de Negócio:** Assinatura mensal recorrente (SaaS) combinada com taxa única de implantação/setup.

---

### 2. Funcionalidades Prioritárias (Essenciais)

1. **Leitura e Rastreio por QR Code:** Leitura rápida via câmera para registro de entrada, saída e metragem exata do rolo na mesa de corte. O QR identifica o **tecido**; o rolo é escolhido na ficha, onde aparecem saldo, rolos disponíveis e cortes recentes.
2. **Saldo de Estoque em Tempo Real:** Consulta imediata da quantidade, **localização física** (ex.: `Corredor A · Prateleira 2`) e disponibilidade do tecido.
3. **Alerta de Estoque Mínimo:** Aviso automático no painel quando o saldo do tecido cai abaixo do estoque mínimo configurado, com cobertura estimada em dias — evita interrupções na linha de produção.

---

### 3. Matriz de Riscos e Mitigações

* **Resistência do Operador ao Uso do Celular:**
  * *Risco:* Recusa em abandonar papel e planilhas na rotina de corte.
  * *Mitigação:* Interface ultra-simples com fluxo de um toque e treinamento prático no próprio chão de fábrica.
* **Instabilidade de Sinal de Internet na Fábrica:**
  * *Risco:* Queda de rede travando o registro dos rolos.
  * *Mitigação:* Modo offline para operação contínua com sincronização automática ao restabelecer o sinal.
* **Danificação de Etiquetas QR Code:**
  * *Risco:* Impossibilidade de leitura por rasgos ou sujeira de tinta/óleo.
  * *Mitigação:* Uso de etiquetas térmicas de maior resistência e alternativa de **busca por nome ou código** (o operador digita parte do nome e escolhe o tecido na sugestão, sem precisar decorar código).

---

### 4. Respostas Oficiais para Inscrição da Demanda

#### 1. Qual a modalidade do curso dos integrantes da equipe?
Ensino médio integrado ao técnico.

#### 2. Liste o título dos cursos dos alunos participantes da equipe
Técnico em Informática para a Internet.

#### 3. Qual problema foi resolvido?
O uso de métodos manuais e planilhas analógicas na gestão de matérias-primas do setor têxtil gera divergências crônicas entre o estoque físico e o real, resultando em paradas não planejadas na linha de corte, perdas financeiras por desperdício de tecido e compras desnecessárias de suprimentos.

#### 4. Justificativa do projeto e Objetivos
O projeto justifica-se pela urgência de modernizar os processos operacionais das confecções de pequeno e médio porte, substituindo controles obsoletos por tecnologia acessível. O objetivo central é desenvolver um sistema móvel baseado em QR Code para automatizar a rastreabilidade de rolos de tecido diretamente na mesa de corte, garantindo precisão no inventário, eliminação de perdas materiais e maior eficiência produtiva.

#### 5. Desenvolvimento
O desenvolvimento pautou-se na engenharia de uma aplicação web e mobile centrada no operador. A solução integra leitura ágil por câmera, **fila offline no aparelho** (cortes e contagens feitos sem sinal são guardados localmente e sincronizados sozinhos, em ordem, ao reconectar — sem duplicar lançamentos, graças a uma chave de idempotência gravada no servidor) e fluxos de validação rigorosos, assegurando uma ferramenta robusta e adaptada à rotina industrial. Erros de lançamento podem ser desfeitos por **estorno auditável**: o registro original é marcado como cancelado e uma nova movimentação negativa devolve os metros ao saldo, preservando o histórico completo.