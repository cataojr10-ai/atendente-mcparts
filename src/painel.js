// Painel de atendimento da M&C Parts (conversas, fila, pausa do robo, regras)
// Dados no D1 (binding DB). Senha no segredo PAINEL_SENHA. Endereco: /painel

let pronto = false;
async function preparar(env) {
  if (pronto) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS conversas (tel TEXT PRIMARY KEY, nome TEXT NOT NULL DEFAULT '', ultima TEXT NOT NULL DEFAULT '', ultima_em INTEGER NOT NULL DEFAULT 0, nao_lidas INTEGER NOT NULL DEFAULT 0, aguardando INTEGER NOT NULL DEFAULT 0, motivo TEXT NOT NULL DEFAULT '', pausa_ate INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS mensagens (id INTEGER PRIMARY KEY AUTOINCREMENT, tel TEXT NOT NULL, de TEXT NOT NULL, texto TEXT NOT NULL, em INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS mensagens_tel ON mensagens (tel, id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS bloqueados (tel TEXT PRIMARY KEY, em INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS treinos (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, texto TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1, em INTEGER NOT NULL DEFAULT 0)"),
  ]);
  pronto = true;
}

// Guarda uma mensagem no historico do painel. de: "cliente" | "robo" | "loja"
export async function registrar(env, tel, de, texto, o) {
  if (!env.DB || !tel) return;
  try {
    await preparar(env);
    o = o || {};
    const agora = Date.now();
    const t = String(texto || "").slice(0, 4000);
    if (!t) return;
    const quem = de === "cliente" ? "" : de === "robo" ? "Robô: " : "Você: ";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mensagens (tel, de, texto, em) VALUES (?, ?, ?, ?)").bind(tel, de, t, agora),
      env.DB.prepare(
        "INSERT INTO conversas (tel, nome, ultima, ultima_em, nao_lidas) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(tel) DO UPDATE SET nome = CASE WHEN ?2 <> '' THEN ?2 ELSE nome END, ultima = ?3, ultima_em = ?4, nao_lidas = nao_lidas + ?5"
      ).bind(tel, String(o.nome || "").slice(0, 80), (quem + t).slice(0, 140), agora, de === "cliente" ? 1 : 0),
    ]);
  } catch (e) {
    console.log("painel registrar", e && e.message);
  }
}

// Atualiza a situacao da conversa: { aguardando, motivo, pausa_ate, nao_lidas }
export async function estado(env, tel, c) {
  if (!env.DB || !tel) return;
  try {
    await preparar(env);
    const sets = [];
    const vals = [];
    for (const k of ["aguardando", "motivo", "pausa_ate", "nao_lidas"]) {
      if (c[k] !== undefined) { sets.push(k + " = ?"); vals.push(c[k]); }
    }
    if (!sets.length) return;
    vals.push(tel);
    await env.DB.prepare("UPDATE conversas SET " + sets.join(", ") + " WHERE tel = ?").bind(...vals).run();
  } catch (e) {
    console.log("painel estado", e && e.message);
  }
}

async function lerConfig(env, chave) {
  if (!env.DB) return null;
  try {
    await preparar(env);
    const r = await env.DB.prepare("SELECT valor FROM config WHERE chave = ?").bind(chave).first();
    return r ? r.valor : null;
  } catch (e) {
    console.log("painel config", e && e.message);
    return null;
  }
}
async function gravarConfig(env, chave, valor) {
  await preparar(env);
  if (valor === null) return env.DB.prepare("DELETE FROM config WHERE chave = ?").bind(chave).run();
  return env.DB.prepare("INSERT INTO config (chave, valor) VALUES (?1, ?2) ON CONFLICT(chave) DO UPDATE SET valor = ?2").bind(chave, valor).run();
}

// Regras do atendente: as editadas no painel ou, se nao houver, as padrao do codigo
export async function lerRegras(env, padrao) {
  const r = await lerConfig(env, "regras");
  let regras = r && r.trim() ? r : padrao;
  try {
    if (env.DB) {
      const NL = String.fromCharCode(10);
      const t = await env.DB.prepare("SELECT titulo, texto FROM treinos WHERE ativo = 1 ORDER BY id LIMIT 60").all();
      const itens = t.results || [];
      if (itens.length) {
        regras += NL + NL + "TREINAMENTOS DA LOJA" + NL +
          "Informações extras cadastradas pela loja. Use quando o cliente perguntar sobre o assunto, respondendo curto. As regras acima continuam valendo: preço e disponibilidade de peça só pela consulta de estoque." + NL +
          itens.map((x) => "- " + x.titulo + ": " + x.texto).join(NL);
      }
    }
  } catch (e) {
    console.log("painel treinos", e && e.message);
  }
  return regras;
}
// Lista de bloqueados: o robo nunca responde esses clientes
export async function bloqueado(env, tel) {
  if (!env.DB || !tel) return false;
  try {
    await preparar(env);
    return !!(await env.DB.prepare("SELECT 1 AS x FROM bloqueados WHERE tel = ?").bind(tel).first());
  } catch (e) {
    console.log("painel bloqueado", e && e.message);
    return false;
  }
}
// Chave geral: se o robo esta ligado (padrao: ligado)
export async function roboLigado(env) {
  return (await lerConfig(env, "robo_ligado")) !== "0";
}

function igual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  return d === 0;
}
function json(dados, status) {
  return new Response(JSON.stringify(dados), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function soNumero(v) {
  const t = String(v || "").replace(/[^0-9]/g, "");
  return t.length >= 8 && t.length <= 20 ? t : "";
}

// deps: { enviar(env, tel, texto), pausar(env, tel, segundos), despausar(env, tel), testar(env, msg), regrasPadrao }
export async function painel(request, env, url, deps) {
  const partes = url.pathname.split("/").filter(Boolean); // ["painel", "api", "rota"]
  if (partes.length === 1) {
    return new Response(PAGINA, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
    });
  }
  if (partes[1] !== "api") return new Response("ok");
  if (!env.PAINEL_SENHA) return json({ erro: "O painel ainda não tem senha. Crie o segredo PAINEL_SENHA no Cloudflare." }, 503);
  if (!env.DB) return json({ erro: "Banco de dados do painel não está ligado (binding DB)." }, 503);
  if (!igual(request.headers.get("x-senha") || "", env.PAINEL_SENHA)) {
    await new Promise((r) => setTimeout(r, 1000));
    return json({ erro: "Senha incorreta" }, 401);
  }
  const rota = partes[2] || "";
  const corpo = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  try {
    await preparar(env);
    const agora = Date.now();

    if (rota === "conversas") {
      const r = await env.DB.prepare("SELECT c.tel, c.nome, c.ultima, c.ultima_em, c.nao_lidas, c.aguardando, c.motivo, c.pausa_ate, CASE WHEN b.tel IS NULL THEN 0 ELSE 1 END AS bloqueado FROM conversas c LEFT JOIN bloqueados b ON b.tel = c.tel ORDER BY c.ultima_em DESC LIMIT 200").all();
      return json({ agora, robo_ligado: await roboLigado(env), conversas: r.results || [] });
    }
    if (rota === "mensagens") {
      const tel = soNumero(url.searchParams.get("tel"));
      if (!tel) return json({ erro: "Conversa inválida" }, 400);
      const r = await env.DB.prepare("SELECT id, de, texto, em FROM (SELECT id, de, texto, em FROM mensagens WHERE tel = ? ORDER BY id DESC LIMIT 300) ORDER BY id ASC").bind(tel).all();
      await env.DB.prepare("UPDATE conversas SET nao_lidas = 0 WHERE tel = ? AND nao_lidas > 0").bind(tel).run();
      return json({ mensagens: r.results || [] });
    }
    if (rota === "enviar" && request.method === "POST") {
      const tel = soNumero(corpo.tel);
      const texto = String(corpo.texto || "").trim().slice(0, 4000);
      if (!tel || !texto) return json({ erro: "Escreva a mensagem" }, 400);
      const ok = await deps.enviar(env, tel, texto);
      if (!ok) return json({ erro: "O WhatsApp não aceitou o envio. Confira a conexão na Z-API." }, 502);
      await registrar(env, tel, "loja", texto);
      await deps.pausar(env, tel, 3600);
      await estado(env, tel, { aguardando: 0, motivo: "", pausa_ate: agora + 3600000 });
      return json({ ok: true });
    }
    if (rota === "acao" && request.method === "POST") {
      const tel = soNumero(corpo.tel);
      if (!tel) return json({ erro: "Conversa inválida" }, 400);
      if (corpo.acao === "pausar") {
        await deps.pausar(env, tel, 43200);
        await estado(env, tel, { pausa_ate: agora + 43200000 });
      } else if (corpo.acao === "religar") {
        console.log("religar", tel);
        await deps.despausar(env, tel);
        await estado(env, tel, { aguardando: 0, motivo: "", pausa_ate: 0 });
      } else if (corpo.acao === "bloquear") {
        await env.DB.prepare("INSERT OR IGNORE INTO bloqueados (tel, em) VALUES (?, ?)").bind(tel, agora).run();
        await estado(env, tel, { aguardando: 0, motivo: "" });
      } else if (corpo.acao === "desbloquear") {
        await env.DB.prepare("DELETE FROM bloqueados WHERE tel = ?").bind(tel).run();
      } else {
        return json({ erro: "Ação desconhecida" }, 400);
      }
      return json({ ok: true });
    }
    if (rota === "config") {
      if (request.method === "POST") {
        if (corpo.restaurar) await gravarConfig(env, "regras", null);
        else if (typeof corpo.regras === "string") {
          const txt = corpo.regras.trim();
          if (txt.length < 50) return json({ erro: "As regras ficaram curtas demais. Nada foi salvo." }, 400);
          if (txt.length > 30000) return json({ erro: "As regras ficaram grandes demais (máximo 30 mil letras)." }, 400);
          await gravarConfig(env, "regras", txt);
        }
        if (typeof corpo.robo_ligado === "boolean") await gravarConfig(env, "robo_ligado", corpo.robo_ligado ? "1" : "0");
      }
      const salvas = await lerConfig(env, "regras");
      return json({ regras: salvas && salvas.trim() ? salvas : deps.regrasPadrao, editadas: !!(salvas && salvas.trim()), robo_ligado: await roboLigado(env) });
    }
    if (rota === "treinos") {
      if (request.method === "POST") {
        const id = parseInt(corpo.id, 10) || 0;
        if (corpo.apagar) {
          if (id) await env.DB.prepare("DELETE FROM treinos WHERE id = ?").bind(id).run();
        } else {
          const titulo = String(corpo.titulo || "").trim().slice(0, 80);
          const texto = String(corpo.texto || "").trim();
          if (!titulo) return json({ erro: "Escreva o assunto do treinamento." }, 400);
          if (texto.length < 5) return json({ erro: "Escreva o texto do treinamento." }, 400);
          if (texto.length > 3000) return json({ erro: "Texto grande demais (máximo 3.000 letras). Divida em dois treinamentos." }, 400);
          if (id) {
            if (typeof corpo.ativo === "boolean") await env.DB.prepare("UPDATE treinos SET titulo = ?, texto = ?, ativo = ? WHERE id = ?").bind(titulo, texto, corpo.ativo ? 1 : 0, id).run();
            else await env.DB.prepare("UPDATE treinos SET titulo = ?, texto = ? WHERE id = ?").bind(titulo, texto, id).run();
          } else {
            const q = await env.DB.prepare("SELECT COUNT(*) AS n FROM treinos").first();
            if (q && q.n >= 60) return json({ erro: "Limite de 60 treinamentos. Apague ou junte alguns." }, 400);
            await env.DB.prepare("INSERT INTO treinos (titulo, texto, ativo, em) VALUES (?, ?, 1, ?)").bind(titulo, texto, agora).run();
          }
        }
      }
      const r = await env.DB.prepare("SELECT id, titulo, texto, ativo FROM treinos ORDER BY id").all();
      return json({ treinos: r.results || [] });
    }
    if (rota === "testar" && request.method === "POST") {
      const msg = String(corpo.msg || "").trim().slice(0, 500);
      if (!msg) return json({ erro: "Escreva a mensagem de teste" }, 400);
      const r = await deps.testar(env, msg);
      return json({ texto: r.texto, chamouHumano: !!r.chamouHumano, motivo: r.motivo || "" });
    }
    return json({ erro: "Não encontrado" }, 404);
  } catch (e) {
    console.log("painel erro", e && e.message);
    return json({ erro: "Falha no painel: " + String((e && e.message) || e).slice(0, 200) }, 500);
  }
}

const PAGINA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Painel M&amp;C Parts</title>
<style>
:root{--marca:#0f2a47;--destaque:#1f8f5f;--fundo:#f3f5f8;--linha:#dfe4ea;--texto:#17202b;--suave:#66727f;--alerta:#c62828}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--texto);background:var(--fundo)}
button{font:inherit;cursor:pointer;border:1px solid var(--linha);background:#fff;color:var(--texto);border-radius:8px;padding:8px 12px}
button.forte{background:var(--destaque);border-color:var(--destaque);color:#fff}
button.perigo{color:var(--alerta);border-color:var(--alerta)}
button:disabled{opacity:.5;cursor:default}
input,textarea{font:inherit;border:1px solid var(--linha);border-radius:8px;padding:10px;width:100%;background:#fff;color:var(--texto)}
.login{max-width:340px;margin:12vh auto;background:#fff;border:1px solid var(--linha);border-radius:12px;padding:24px}
.login h1{font-size:20px;margin:0 0 4px}.login p{color:var(--suave);margin:0 0 16px}.login button{width:100%;margin-top:10px}
.erro{color:var(--alerta);min-height:20px;margin-top:8px;font-size:14px}
#app{display:flex;flex-direction:column;height:100%}
.topo{background:var(--marca);color:#fff;display:flex;align-items:center;gap:8px;padding:10px 14px;flex-wrap:wrap}
.topo b{font-size:16px;margin-right:auto}
.topo button{background:transparent;color:#fff;border-color:rgba(255,255,255,.4)}
.topo button.on{background:var(--destaque);border-color:var(--destaque)}
.topo button.off{background:var(--alerta);border-color:var(--alerta)}
.corpo{flex:1;display:flex;min-height:0}
.lista{width:340px;max-width:100%;background:#fff;border-right:1px solid var(--linha);display:flex;flex-direction:column}
.abas{display:flex;gap:6px;padding:10px;border-bottom:1px solid var(--linha)}
.abas button{flex:1;padding:6px}.abas button.sel{background:var(--marca);color:#fff;border-color:var(--marca)}
.itens{overflow:auto;flex:1}
.item{padding:10px 12px;border-bottom:1px solid var(--linha);cursor:pointer}
.item.sel{background:#eaf1f8}
.item .l1{display:flex;gap:6px;align-items:center}.item .nome{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.item .hora{color:var(--suave);font-size:12px}
.item .ult{color:var(--suave);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.selo{font-size:11px;border-radius:10px;padding:1px 8px;white-space:nowrap}
.st-ag{background:#fde7e7;color:var(--alerta);font-weight:600}.st-hu{background:#fff3d6;color:#8a5a00}.st-ro{background:#e3f4ec;color:#176b47}.st-bl{background:#e6e8eb;color:#4a5560}
.num{background:var(--destaque);color:#fff;border-radius:10px;font-size:11px;padding:1px 7px}
.chat{flex:1;display:flex;flex-direction:column;min-width:0}
.cab{background:#fff;border-bottom:1px solid var(--linha);padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cab .quem{margin-right:auto;min-width:0}.cab .quem b{display:block}.cab .quem span{color:var(--suave);font-size:13px}
.voltar{display:none}
.msgs{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.bal{max-width:78%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid var(--linha);align-self:flex-start}
.bal.robo{align-self:flex-end;background:#e8eef6;border-color:#d2ddec}.bal.loja{align-self:flex-end;background:#dcf5e7;border-color:#bfe6d1}
.bal small{display:block;color:var(--suave);font-size:11px;margin-top:3px}
.envio{display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid var(--linha)}
.envio textarea{resize:none;height:44px}
.vazio{margin:auto;color:var(--suave);text-align:center;padding:20px}
.motivo{background:#fde7e7;color:var(--alerta);padding:8px 14px;font-size:14px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:12px}
.caixa{background:#fff;border-radius:12px;padding:18px;width:760px;max-width:100%;max-height:94vh;display:flex;flex-direction:column;gap:10px}
.caixa h2{margin:0;font-size:18px}.caixa p{margin:0;color:var(--suave);font-size:14px}
.caixa textarea{flex:1;min-height:46vh;font-size:14px}
.caixa textarea.curto{flex:none;min-height:0;height:110px}
.botoes{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.teste{border:1px solid var(--linha);border-radius:8px;padding:10px;min-height:30vh;max-height:50vh;overflow:auto;display:flex;flex-direction:column;gap:8px;background:var(--fundo)}
[hidden]{display:none!important}
@media(max-width:760px){.lista{width:100%;border:0}.chat{display:none}.corpo.aberta .lista{display:none}.corpo.aberta .chat{display:flex}.voltar{display:inline-block}.bal{max-width:90%}}
</style></head><body>
<div id="login" class="login">
  <h1>Painel M&amp;C Parts</h1><p>Atendimento do WhatsApp</p>
  <input id="senha" type="password" placeholder="Senha do painel" autocomplete="current-password">
  <button class="forte" id="entrar">Entrar</button><div class="erro" id="erroLogin"></div>
</div>
<div id="app" hidden>
  <div class="topo"><b>M&amp;C Parts · Atendimento</b>
    <button id="chave">Robô</button><button id="bRegras">Regras</button><button id="bTreinos">Treinamentos</button><button id="bTeste">Testar robô</button><button id="bSair">Sair</button></div>
  <div class="corpo" id="corpo">
    <div class="lista"><div class="abas"><button id="aTodas" class="sel">Todas</button><button id="aFila">Aguardando você</button></div><div class="itens" id="itens"></div></div>
    <div class="chat">
      <div class="vazio" id="vazio">Escolha uma conversa na lista.</div>
      <div class="cab" id="cab" hidden><button class="voltar" id="voltar">Voltar</button><div class="quem"><b id="cNome"></b><span id="cTel"></span></div><span class="selo" id="cSelo"></span><button id="bPausa"></button><button id="bBloq"></button></div>
      <div class="motivo" id="cMotivo" hidden></div>
      <div class="msgs" id="msgs" hidden></div>
      <div class="envio" id="envio" hidden><textarea id="texto" placeholder="Escreva para o cliente (Enter envia)"></textarea><button class="forte" id="enviar">Enviar</button></div>
    </div>
  </div>
</div>
<div class="modal" id="mRegras" hidden><div class="caixa">
  <h2>Regras do atendente</h2><p id="infoRegras"></p>
  <textarea id="regras" spellcheck="false"></textarea><div class="erro" id="erroRegras"></div>
  <div class="botoes"><button class="perigo" id="rPadrao">Voltar ao padrão</button><button id="rFechar">Fechar</button><button class="forte" id="rSalvar">Salvar regras</button></div>
</div></div>
<div class="modal" id="mTreinos" hidden><div class="caixa">
  <h2>Treinamentos</h2><p>Ensine o robô sobre a loja, um assunto por treinamento. Vale a partir da próxima mensagem. Preço e estoque continuam vindo do GestãoClick.</p>
  <div class="teste" id="listaTreinos"></div>
  <input id="tTitulo" placeholder="Assunto (ex.: Bairros com entrega)" maxlength="80">
  <textarea id="tTexto" class="curto" placeholder="O que o robô deve saber sobre esse assunto"></textarea>
  <div class="erro" id="erroTreinos"></div>
  <div class="botoes"><button id="trFechar">Fechar</button><button id="trNovo">Limpar campos</button><button class="forte" id="trSalvar">Salvar treinamento</button></div>
</div></div>
<div class="modal" id="mTeste" hidden><div class="caixa">
  <h2>Testar o robô</h2><p>Escreva como se fosse um cliente. Nada é enviado no WhatsApp.</p>
  <div class="teste" id="logTeste"></div>
  <div class="envio" style="padding:0;border:0"><input id="msgTeste" placeholder="Ex.: tela a12"><button class="forte" id="tEnviar">Testar</button></div>
  <div class="botoes"><button id="tFechar">Fechar</button></div>
</div></div>
<script>
var senha = '';
try { senha = localStorage.getItem('painel_senha') || ''; } catch (e) {}
var atual = null, filtro = 'todas', conversas = [], agoraSrv = Date.now(), ultimaMsg = 0, roboOn = true;
function $(id) { return document.getElementById(id); }
function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
async function api(caminho, corpo) {
  var r = await fetch('/painel/api/' + caminho, { method: corpo ? 'POST' : 'GET', headers: { 'x-senha': senha, 'content-type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  var j = await r.json().catch(function () { return {}; });
  if (r.status === 401) { sair(); throw new Error('Senha incorreta'); }
  if (!r.ok) throw new Error(j.erro || ('Erro ' + r.status));
  return j;
}
function sair() { senha = ''; try { localStorage.removeItem('painel_senha'); } catch (e) {} $('app').hidden = true; $('login').hidden = false; }
function fone(t) { if (t.length >= 12 && t.indexOf('55') === 0) { var d = t.slice(2, 4), n = t.slice(4); return '(' + d + ') ' + n.slice(0, n.length - 4) + '-' + n.slice(-4); } return '+' + t; }
function hora(ms) { var d = new Date(ms), h = new Date(); var hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === h.toDateString() ? hm : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm; }
function situacao(c) { if (c.bloqueado) return ['Bloqueado', 'st-bl']; if (c.aguardando) return ['Aguardando você', 'st-ag']; if (c.pausa_ate > agoraSrv) return ['Com atendente', 'st-hu']; return ['Robô', 'st-ro']; }
function pintarChave() { var b = $('chave'); b.textContent = roboOn ? 'Robô ligado' : 'Robô desligado'; b.className = roboOn ? 'on' : 'off'; }
function pintarLista() {
  var box = $('itens'); box.textContent = '';
  var fila = conversas.filter(function (c) { return c.aguardando; });
  $('aFila').textContent = 'Aguardando você' + (fila.length ? ' (' + fila.length + ')' : '');
  var lista = filtro === 'fila' ? fila : conversas;
  if (!lista.length) { box.appendChild(el('div', 'vazio', filtro === 'fila' ? 'Ninguém aguardando.' : 'Nenhuma conversa ainda. Elas aparecem aqui quando um cliente escrever.')); return; }
  lista.forEach(function (c) {
    var it = el('div', 'item' + (c.tel === atual ? ' sel' : ''));
    var l1 = el('div', 'l1'); l1.appendChild(el('span', 'nome', c.nome || fone(c.tel)));
    if (c.nao_lidas && c.tel !== atual) l1.appendChild(el('span', 'num', String(c.nao_lidas)));
    var s = situacao(c); l1.appendChild(el('span', 'selo ' + s[1], s[0])); l1.appendChild(el('span', 'hora', hora(c.ultima_em)));
    it.appendChild(l1); it.appendChild(el('div', 'ult', c.ultima));
    it.onclick = function () { abrir(c.tel); };
    box.appendChild(it);
  });
}
function pintarCab() {
  var c = conversas.filter(function (x) { return x.tel === atual; })[0]; if (!c) return;
  $('cNome').textContent = c.nome || fone(c.tel); $('cTel').textContent = fone(c.tel);
  var s = situacao(c); $('cSelo').textContent = s[0]; $('cSelo').className = 'selo ' + s[1];
  var parado = c.aguardando || c.pausa_ate > agoraSrv;
  $('bPausa').textContent = parado ? 'Religar robô' : 'Pausar robô'; $('bPausa').dataset.acao = parado ? 'religar' : 'pausar'; $('bPausa').hidden = !!c.bloqueado;
  $('bBloq').textContent = c.bloqueado ? 'Desbloquear' : 'Bloquear'; $('bBloq').dataset.acao = c.bloqueado ? 'desbloquear' : 'bloquear'; $('bBloq').className = c.bloqueado ? '' : 'perigo';
  $('cMotivo').hidden = !(c.aguardando && c.motivo); $('cMotivo').textContent = 'Cliente pediu atendente: ' + c.motivo;
}
async function carregarLista() {
  var j = await api('conversas'); conversas = j.conversas; agoraSrv = j.agora; roboOn = j.robo_ligado; pintarChave(); pintarLista(); pintarCab();
}
async function carregarMsgs(forcar) {
  if (!atual) return; var tel = atual;
  var j = await api('mensagens?tel=' + tel); if (tel !== atual) return;
  var m = j.mensagens, ult = m.length ? m[m.length - 1].id : 0;
  if (!forcar && ult === ultimaMsg) return; ultimaMsg = ult;
  var box = $('msgs'), noFim = box.scrollHeight - box.scrollTop - box.clientHeight < 80; box.textContent = '';
  m.forEach(function (x) {
    var b = el('div', 'bal ' + x.de, x.texto);
    b.appendChild(el('small', '', (x.de === 'robo' ? 'Robô · ' : x.de === 'loja' ? 'Você · ' : '') + hora(x.em)));
    box.appendChild(b);
  });
  if (forcar || noFim) box.scrollTop = box.scrollHeight;
}
async function abrir(tel) {
  atual = tel; ultimaMsg = 0;
  ['cab', 'msgs', 'envio'].forEach(function (i) { $(i).hidden = false; }); $('vazio').hidden = true; $('corpo').className = 'corpo aberta';
  pintarLista(); pintarCab(); await carregarMsgs(true);
}
async function mandar() {
  var t = $('texto').value.trim(); if (!t || !atual) return;
  $('enviar').disabled = true;
  try { await api('enviar', { tel: atual, texto: t }); $('texto').value = ''; await carregarMsgs(true); await carregarLista(); }
  catch (e) { alertar(e.message); }
  $('enviar').disabled = false;
}
function alertar(msg) { var b = el('div', 'bal', msg); b.style.borderColor = 'var(--alerta)'; b.style.color = 'var(--alerta)'; b.style.alignSelf = 'center'; $('msgs').appendChild(b); $('msgs').scrollTop = $('msgs').scrollHeight; }
async function entrar() {
  $('erroLogin').textContent = '';
  try { await carregarLista(); try { localStorage.setItem('painel_senha', senha); } catch (e) {} $('login').hidden = true; $('app').hidden = false; }
  catch (e) { $('erroLogin').textContent = e.message; }
}
$('entrar').onclick = function () { senha = $('senha').value; $('senha').value = ''; entrar(); };
$('senha').onkeydown = function (e) { if (e.key === 'Enter') $('entrar').onclick(); };
$('bSair').onclick = sair;
$('aTodas').onclick = function () { filtro = 'todas'; $('aTodas').className = 'sel'; $('aFila').className = ''; pintarLista(); };
$('aFila').onclick = function () { filtro = 'fila'; $('aFila').className = 'sel'; $('aTodas').className = ''; pintarLista(); };
$('voltar').onclick = function () { atual = null; $('corpo').className = 'corpo'; pintarLista(); };
$('enviar').onclick = mandar;
$('texto').onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mandar(); } };
$('bPausa').onclick = async function () { var ac = $('bPausa').dataset.acao; if (ac === 'religar' && !confirm('Devolver este cliente para o robô? Ele volta a responder na próxima mensagem do cliente.')) return; try { await api('acao', { tel: atual, acao: ac }); await carregarLista(); } catch (e) { alertar(e.message); } };
$('bBloq').onclick = async function () {
  var a = $('bBloq').dataset.acao;
  if (a === 'bloquear' && !confirm('O robô nunca mais vai responder este cliente. As mensagens dele continuam aparecendo aqui no painel. Bloquear?')) return;
  try { await api('acao', { tel: atual, acao: a }); await carregarLista(); } catch (e) { alertar(e.message); }
};
$('chave').onclick = async function () {
  if (!confirm(roboOn ? 'Desligar o robô para todos os clientes?' : 'Ligar o robô de novo?')) return;
  try { var j = await api('config', { robo_ligado: !roboOn }); roboOn = j.robo_ligado; pintarChave(); } catch (e) { alert(e.message); }
};
function mostrarRegras(j) { $('regras').value = j.regras; $('infoRegras').textContent = j.editadas ? 'Você está usando regras editadas aqui no painel. Vale a partir da próxima mensagem.' : 'Estas são as regras padrão do robô. Edite e salve para mudar. Vale a partir da próxima mensagem.'; }
$('bRegras').onclick = async function () { $('erroRegras').textContent = ''; try { mostrarRegras(await api('config')); $('mRegras').hidden = false; } catch (e) { alert(e.message); } };
$('rFechar').onclick = function () { $('mRegras').hidden = true; };
$('rSalvar').onclick = async function () { try { mostrarRegras(await api('config', { regras: $('regras').value })); $('erroRegras').textContent = 'Regras salvas.'; } catch (e) { $('erroRegras').textContent = e.message; } };
$('rPadrao').onclick = async function () { if (!confirm('Apagar as regras editadas e voltar ao padrão?')) return; try { mostrarRegras(await api('config', { restaurar: true })); $('erroRegras').textContent = 'Voltou ao padrão.'; } catch (e) { $('erroRegras').textContent = e.message; } };
var treinoId = null;
function limparTreino() { treinoId = null; $('tTitulo').value = ''; $('tTexto').value = ''; $('trSalvar').textContent = 'Salvar treinamento'; }
function pintarTreinos(lista) {
  var box = $('listaTreinos'); box.textContent = '';
  if (!lista.length) { box.appendChild(el('div', 'vazio', 'Nenhum treinamento ainda. Escreva o primeiro abaixo.')); return; }
  lista.forEach(function (t) {
    var b = el('div', 'bal'); b.style.maxWidth = '100%'; b.style.alignSelf = 'stretch'; if (!t.ativo) b.style.opacity = '.55';
    b.appendChild(el('b', '', t.titulo + (t.ativo ? '' : ' (desligado)')));
    b.appendChild(el('div', '', t.texto));
    var l = el('div', 'botoes'); l.style.marginTop = '6px';
    var e1 = el('button', '', 'Editar'); e1.onclick = function () { treinoId = t.id; $('tTitulo').value = t.titulo; $('tTexto').value = t.texto; $('trSalvar').textContent = 'Salvar alteração'; $('tTitulo').focus(); };
    var e2 = el('button', '', t.ativo ? 'Desligar' : 'Ligar'); e2.onclick = function () { salvarTreino({ id: t.id, titulo: t.titulo, texto: t.texto, ativo: !t.ativo }); };
    var e3 = el('button', 'perigo', 'Apagar'); e3.onclick = function () { if (confirm('Apagar este treinamento?')) salvarTreino({ id: t.id, apagar: true }); };
    l.appendChild(e1); l.appendChild(e2); l.appendChild(e3); b.appendChild(l); box.appendChild(b);
  });
}
async function salvarTreino(corpo) {
  $('erroTreinos').textContent = '';
  try { var j = await api('treinos', corpo); pintarTreinos(j.treinos); if (corpo.apagar ? corpo.id === treinoId : corpo.ativo === undefined) limparTreino(); }
  catch (e) { $('erroTreinos').textContent = e.message; }
}
$('bTreinos').onclick = async function () { $('erroTreinos').textContent = ''; try { var j = await api('treinos'); pintarTreinos(j.treinos); $('mTreinos').hidden = false; } catch (e) { alert(e.message); } };
$('trFechar').onclick = function () { $('mTreinos').hidden = true; };
$('trNovo').onclick = limparTreino;
$('trSalvar').onclick = function () { var c = { titulo: $('tTitulo').value, texto: $('tTexto').value }; if (treinoId) c.id = treinoId; salvarTreino(c); };
$('bTeste').onclick = function () { $('mTeste').hidden = false; $('msgTeste').focus(); };
$('tFechar').onclick = function () { $('mTeste').hidden = true; };
async function testar() {
  var t = $('msgTeste').value.trim(); if (!t) return; var log = $('logTeste');
  log.appendChild(el('div', 'bal', t)); $('msgTeste').value = ''; $('tEnviar').disabled = true;
  try { var j = await api('testar', { msg: t }); log.appendChild(el('div', 'bal robo', (j.chamouHumano ? '[passou para atendente: ' + j.motivo + '] ' : '') + j.texto)); }
  catch (e) { log.appendChild(el('div', 'bal', 'Erro: ' + e.message)); }
  $('tEnviar').disabled = false; log.scrollTop = log.scrollHeight;
}
$('tEnviar').onclick = testar;
$('msgTeste').onkeydown = function (e) { if (e.key === 'Enter') testar(); };
setInterval(function () { if (document.hidden || !senha || $('app').hidden) return; carregarLista().then(function () { return carregarMsgs(false); }).catch(function () {}); }, 6000);
if (senha) entrar();
</script></body></html>`;
