# Acesso pelo celular via USB (`adb reverse`)

Documento de apoio para configurar o acesso ao **TecSource v1.4.0** pelo celular Android
usando cabo USB, sem HTTPS e sem depender da rede Wi-Fi.

> **Resumo para quem for executar:** o objetivo é que o Chrome do celular abra
> `http://localhost:3000/mobile.html` e esse `localhost` caia no PC via `adb reverse`.
> Como o host é `localhost`, o navegador trata a página como **contexto seguro** e libera
> câmera, service worker e instalação do PWA — sem certificado, sem túnel, sem firewall.

---

## 1. Contexto do projeto (o que importa para esta tarefa)

| Item | Valor |
|---|---|
| Servidor | Node.js + Express, `server/src/index.js` |
| Porta | `3000` (`PORT` em `server/.env`) |
| Binding | `app.listen(PORT)` → escuta em todas as interfaces (`0.0.0.0`) |
| Interface mobile | `/mobile.html` (`public/mobile.html`, `mobile.js`, `mobile.css`, `fila.js`) |
| Banco | PostgreSQL (Supabase ou o do `docker compose up -d`) — o servidor **não sobe** se o banco estiver inacessível |
| Service worker | `public/sw.js`, cache `tecsource-v14` |
| Autenticação | **não existe**; o nome do operador fica no `localStorage` do navegador |

Fatos do código que sustentam esta abordagem:

1. `public/mobile.js` só registra o service worker quando
   `location.protocol === 'https:'` **ou** o host é `localhost` / `127.0.0.1`.
2. `public/mobile.js` exibe o aviso de conexão insegura quando
   `!window.isSecureContext`. Em `localhost` esse aviso **não** aparece.
3. `public/app.js` monta a URL do QR "Abrir no celular" a partir de
   `location.href`. Com o desktop aberto em `localhost:3000`, o QR aponta para
   `http://localhost:3000/mobile.html` — que **funciona** no celular quando o
   `adb reverse` está ativo.
4. `public/fila.js` usa `crypto.randomUUID()` para gerar a chave de idempotência;
   em `localhost` (contexto seguro) ele existe. Para acessar pelo IP
   (`http://192.168.x.x`) há um fallback automático, mas a câmera e o PWA continuam
   exigindo `localhost`/HTTPS.

Consequência prática: **nenhuma alteração de código é necessária.** Não adicione HTTPS,
não mude o `listen`, não crie regra de firewall.

---

## 2. Pré-requisitos

- Celular **Android** (5.0+). iPhone não tem equivalente — precisa de HTTPS de verdade.
- Cabo USB **de dados** (cabos só de carga não funcionam).
- Node.js + PostgreSQL já configurados no PC (`docker compose up -d` ou `DATABASE_URL` do Supabase).
- `adb` instalado no PC (nesta máquina ele **não está** instalado e **não há `winget`**).

---

## 3. Passo a passo

### 3.1 Instalar o `adb` (platform-tools) no PC

Baixe o pacote oficial (~8 MB) e extraia em `C:\platform-tools`:

```powershell
Invoke-WebRequest "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile "$env:TEMP\platform-tools.zip"
Expand-Archive "$env:TEMP\platform-tools.zip" -DestinationPath "C:\" -Force
C:\platform-tools\adb.exe version
```

Adicionar ao PATH do usuário (opcional; abrir um terminal novo depois):

```powershell
$p = [Environment]::GetEnvironmentVariable('Path','User')
[Environment]::SetEnvironmentVariable('Path', "$p;C:\platform-tools", 'User')
```

### 3.2 Habilitar a depuração USB no celular

1. **Configurações → Sobre o telefone** → tocar **7 vezes** em *Número da versão*
   (em Xiaomi/Redmi/POCO: *Versão do MIUI* / *Versão do HyperOS*).
2. **Configurações → Sistema → Opções do desenvolvedor** → ativar **Depuração USB**.
3. *Xiaomi/Redmi/POCO:* ativar também **Depuração USB (Configurações de segurança)** —
   exige conta Mi logada e internet.
4. *Samsung:* se o Windows não reconhecer o aparelho, instalar o driver do fabricante.

### 3.3 Conectar e autorizar

1. Conectar o celular ao PC por USB.
2. Na notificação do celular, escolher **Transferência de arquivos (MTP)**.
3. No PC:

```powershell
adb devices
```

- Primeira conexão: aparece `<serial>  unauthorized` → no celular, aceitar
  **"Permitir depuração USB"** (marcar *Sempre permitir a partir deste computador*).
- Rodar de novo: deve aparecer `<serial>  device`.

### 3.4 Subir o sistema

```powershell
cd "C:\Users\Usuario\Documents\GB\tecsource v4\server"
npm start
```

Saída esperada:

```
✅ Banco de dados conectado.
🧵 TecSource rodando na rede local: http://localhost:3000
📱 Interface mobile: http://localhost:3000/mobile.html
```

### 3.5 Criar o túnel USB

Em **outro** terminal (o `npm start` bloqueia o primeiro):

```powershell
adb reverse tcp:3000 tcp:3000
adb reverse --list
```

`--list` deve mostrar algo como `host-XX tcp:3000 tcp:3000`.

Se a `PORT` do `.env` for diferente de `3000`, use o mesmo número nos **dois** lados do
comando e na URL.

### 3.6 Abrir no celular

No Chrome do celular: **`http://localhost:3000/mobile.html`**

Verificações rápidas:

- `http://localhost:3000/api/health` → `{"ok":true,"data":{"status":"ok","banco":"conectado","versao":"1.4.0"}}`
- O aviso de "conexão insegura" **não** deve aparecer.
- O botão de **escanear QR pela câmera** deve abrir a câmera na primeira tentativa
  (o Chrome pede permissão de câmera).
- **Instalar como app:** menu ⋮ → *Instalar aplicativo* / *Adicionar à tela inicial*.

---

## 4. O que funciona neste modo

| Recurso | `http://localhost:3000` via `adb reverse` |
|---|---|
| Interface, painel, corte, contagem, histórico | ✅ |
| Escanear QR pela câmera | ✅ (contexto seguro) |
| Instalar como PWA | ✅ |
| Cache offline do app shell | ✅ |
| Fila offline de cortes e contagens | ✅ (`localStorage`, reenvio ao reconectar) |
| Dados no servidor (painel, saldo) | ❌ (API e banco dependem do PC) |

> A fila guarda os lançamentos feitos sem conexão. Se a página for fechada com o túnel
> USB desconectado, os itens pendentes continuam no `localStorage` e são enviados na
> próxima abertura com rede.

---

## 5. Diagnóstico

| Sintoma | Causa provável | Solução |
|---|---|---|
| `adb: command not found` | platform-tools fora do PATH | usar `C:\platform-tools\adb.exe` ou ajustar o PATH |
| `adb devices` vazio | cabo de carga, porta USB ruim, driver ausente | trocar cabo/porta; `adb kill-server` + `adb start-server`; driver do fabricante |
| `unauthorized` persistente | prompt não aceito no celular | "Revogar autorizações de depuração USB" e reconectar |
| Página não carrega no celular | `adb reverse` não criado ou porta divergente | `adb reverse --list` e recriar com a porta correta |
| Túnel caiu após desconectar o cabo / reiniciar o adb | `adb reverse` não é persistente | rodar `adb reverse tcp:3000 tcp:3000` de novo |
| Câmera não abre | página aberta por IP (`http://192.168.x.x`) em vez de `localhost` | usar exatamente `http://localhost:3000/mobile.html` |
| `ECONNREFUSED` no `npm start` | PostgreSQL parado | `docker compose up -d`; `npm run db:check` |
| Tela antiga no celular | cache do PWA | fechar e reabrir; cache é `tecsource-v14` |
| Aviso "lançamento(s) pendente(s)" no topo | túnel desconectado no meio do corte | reconectar o cabo, recriar o `adb reverse` e tocar em **Sincronizar** |

Comandos úteis:

```powershell
adb reverse --remove-all      # limpa todos os túneis
adb kill-server; adb start-server
```

---

## 6. Uso sem cabo (opcional, Android 11+)

*Opções do desenvolvedor → Depuração sem fio → Emparelhar dispositivo com código*:

```powershell
adb pair 192.168.x.x:PORTA      # usa o código de 6 dígitos mostrado na tela
adb connect 192.168.x.x:PORTA   # porta da tela "Depuração sem fio"
adb reverse tcp:3000 tcp:3000
```

O `adb reverse` continua válido sobre Wi-Fi e a URL no celular segue sendo
`http://localhost:3000/mobile.html`. Vantagem: funciona mesmo quando o roteador tem
**isolamento de clientes** (rede de visitantes, AP separado), cenário em que o acesso
direto por IP falha.

---

## 7. Limitações e cuidados

- **Só Android.** iPhone exige HTTPS real (túnel tipo Cloudflare/ngrok ou certificado local).
- **Cabo conectado:** ao desconectar, o túnel morre e precisa ser recriado.
- **PC ligado e acordado**, com o PostgreSQL e o servidor rodando o tempo todo.
- **Cada celular guarda seu próprio nome de operador** no `localStorage` — configurar uma vez.
- **Sem autenticação no sistema:** mantenha restrito à rede interna / cabo. Não exponha
  publicamente.
- **Firewall do Windows é irrelevante** neste modo: o tráfego passa pelo USB, não pela rede.
  Não é preciso liberar a porta 3000 nem usar o IP `192.168.1.15` da máquina.
- **QR "Abrir no celular" (desktop):** com o desktop em `http://localhost:3000`, o QR aponta
  para `localhost:3000/mobile.html` e funciona via `adb reverse`. O aviso do desktop sobre
  "usar o IP da máquina" refere-se ao acesso por Wi-Fi e pode ser ignorado neste cenário.

---

## 8. Critérios de conclusão

1. `adb devices` lista o aparelho como `device`.
2. `adb reverse --list` mostra `tcp:3000 tcp:3000`.
3. `http://localhost:3000/api/health` responde `ok` no celular.
4. `http://localhost:3000/mobile.html` abre, **sem** aviso de conexão insegura.
5. O leitor de QR abre a câmera e uma leitura de teste abre a ficha do tecido.
6. O app pode ser instalado na tela inicial.
