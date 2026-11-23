// Resumo diario compacto das conversas (para a analise diaria ler so isto, sem abrir conversa por conversa).
// Rota: GET /painel/api/resumo?dia=AAAA-MM-DD (padrao: hoje, horario de Brasilia). Mesma senha do painel.
// Tudo vem das mensagens guardadas no D1; nada aqui muda o atendimento.

const NL = String.fromCharCode(10);
const MAX_CASOS = 15; // casos listados por assunto (a contagem total sempre vem completa)

function norm(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}
function corta(t, n) {
  t = String(t || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function hm(ms) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}
function dataSP(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
// Mesmo horario do robo: seg-sex 9h-18h, sabado 8h30-13h, domingo e dias fechados = fora
function foraDoHorario(ms, fechados) {
  if (fechados.has(dataSP(ms))) return true;
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const pega = (t) => (p.find((x) => x.type === t) || {}).value;
  const dia = pega("weekday");
  const min = (parseInt(pega("hour"), 10) % 24) * 60 + parseInt(pega("minute"), 10);
  if (dia === "Sun") return true;
  if (dia === "Sat") return min < 8 * 60 + 30 || min >= 13 * 60;
  return min < 9 * 60 || min >= 18 * 60;
}

const R_PRECO = /(^|[^A-Z])(VALOR|VALORES|PRECO|PRECOS|QUANTO|QTO|QNTO|ORCAMENTO|CUSTA|TEM)([^A-Z]|$)/;
const R_CAPINHA = /(^|[^A-Z])(CAPINHA|CAPINHAS|CAPA|CAPAS)([^A-Z]|$)/;
const R_PELICULA = /(^|[^A-Z])(PELICULA|PELICULAS|PELI)([^A-Z]|$)/;
const R_COMPROVANTE = /(COMPROVANTE|PAGUEI|PIX)/;
const R_PEDIDO_ROBO = /^PEDIDO ANOTADO/;

export async function resumoDoDia(env, dia) {
  const hojeSP = dataSP(Date.now());
  if (!dia || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) dia = hojeSP;
  const [a, m, d] = dia.split("-").map(Number);
  const ini = Date.UTC(a, m - 1, d, 3, 0, 0); // 00:00 de Brasilia (UTC-3)
  const fim = ini + 86400000;

  const cfg = await env.DB.prepare("SELECT valor FROM config WHERE chave = 'dias_fechados'").first();
  const fechados = new Set(String((cfg && cfg.valor) || "").split(/[^0-9-]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
  const rl = await env.DB.prepare("SELECT valor FROM config WHERE chave = 'robo_ligado'").first();

  const msgs = (await env.DB.prepare("SELECT tel, de, texto, em FROM mensagens WHERE em >= ? AND em < ? ORDER BY tel, id").bind(ini, fim).all()).results || [];
  const conv = {};
  for (const c of (await env.DB.prepare("SELECT c.tel, c.nome, c.aguardando, c.motivo, CASE WHEN b.tel IS NULL THEN 0 ELSE 1 END AS bloqueado FROM conversas c LEFT JOIN bloqueados b ON b.tel = c.tel WHERE c.tel IN (SELECT DISTINCT tel FROM mensagens WHERE em >= ? AND em < ?)").bind(ini, fim).all()).results || []) conv[c.tel] = c;

  const porTel = new Map();
  for (const x of msgs) { if (!porTel.has(x.tel)) porTel.set(x.tel, []); porTel.get(x.tel).push(x); }

  const r = {
    dia,
    loja_fechada_o_dia_todo: foraDoHorario(ini + 12 * 3600000, fechados),
    robo_ligado_agora: !(rl && rl.valor === "0"),
    totais: { conversas: porTel.size, msgs_cliente: 0, msgs_robo: 0, msgs_loja: 0 },
    sem_resposta: { total: 0, bloqueados: 0, casos: [] },
    preco_fora_do_horario: { total: 0, respondidos_com_preco: 0, sem_resposta: 0, casos: [] },
    listas_sem_resposta: { total: 0, casos: [] },
    insistiu_apos_nao_temos: { total: 0, ficou_calado: 0, casos: [] },
    passagens_atendente: { total: 0, pedidos_anotados: 0, por_motivo: [], casos: [] },
    comprovantes: { total: 0, agradecidos: 0 },
    capinha: { total: 0 },
    pelicula: { total: 0 },
    audios: { total: 0, nao_entendidos: 0, transcritos: 0 },
    possiveis_erros: { total: 0, casos: [] },
  };
  const motivos = {};
  const add = (sec, caso) => { sec.total++; if (sec.casos.length < MAX_CASOS) sec.casos.push(caso); };

  for (const [tel, L] of porTel) {
    const fim4 = String(tel).slice(-4);
    const info = conv[tel] || {};
    const bloq = !!info.bloqueado;
    for (let i = 0; i < L.length; i++) {
      const x = L[i];
      const n = norm(x.texto);
      if (x.de === "cliente") r.totais.msgs_cliente++;
      else if (x.de === "robo") r.totais.msgs_robo++;
      else r.totais.msgs_loja++;

      if (x.de === "cliente") {
        // quem respondeu depois (antes da proxima mensagem do cliente)
        let resp = null;
        for (let j = i + 1; j < L.length; j++) { if (L[j].de !== "cliente") { resp = L[j]; break; } if (L[j].em - x.em > 120000) break; } // mensagens seguidas do cliente (ate 2 min): a resposta vale para todas
        const linhas = String(x.texto).split(/\n+/).filter((s) => s.trim()).length;

        if (/^\[(ÁUDIO|AUDIO)/i.test(x.texto)) { r.audios.total++; r.audios.nao_entendidos++; }
        if (R_CAPINHA.test(n)) r.capinha.total++;
        if (R_PELICULA.test(n)) r.pelicula.total++;
        if (R_COMPROVANTE.test(n) || /^\[(DOCUMENTO)/.test(n)) {
          r.comprovantes.total++;
          if (resp && /COMPROVANTE/.test(norm(resp.texto))) r.comprovantes.agradecidos++;
        }
        if (foraDoHorario(x.em, fechados) && (R_PRECO.test(n) || /\d/.test(n)) && !/^\[/.test(x.texto)) {
          const comPreco = !!(resp && /R\$ ?\d/.test(resp.texto));
          r.preco_fora_do_horario.total++;
          if (comPreco) r.preco_fora_do_horario.respondidos_com_preco++;
          else if (!resp) r.preco_fora_do_horario.sem_resposta++;
          if (!comPreco && r.preco_fora_do_horario.casos.length < MAX_CASOS) r.preco_fora_do_horario.casos.push({ tel: fim4, hora: hm(x.em), msg: corta(x.texto, 70), resposta: resp ? corta(resp.texto, 60) : "(nenhuma)" });
        }
        if (linhas >= 3 && !resp) add(r.listas_sem_resposta, { tel: fim4, hora: hm(x.em), linhas, msg: corta(x.texto, 70), bloqueado: bloq });
        // insistiu depois de "nao temos"
        const ant = L[i - 1];
        if (ant && ant.de === "robo" && /NAO TEMOS/.test(norm(ant.texto))) {
          r.insistiu_apos_nao_temos.total++;
          if (!resp) r.insistiu_apos_nao_temos.ficou_calado++;
          if (r.insistiu_apos_nao_temos.casos.length < MAX_CASOS) r.insistiu_apos_nao_temos.casos.push({ tel: fim4, hora: hm(x.em), pediu: corta(L[i - 2] && L[i - 2].de === "cliente" ? L[i - 2].texto : "", 50), insistiu: corta(x.texto, 50), resposta: resp ? corta(resp.texto, 50) : "(nenhuma)" });
        }
      } else if (x.de === "robo") {
        const ok = x.texto.trim() === "Ok" || /^Recebemos sua mensagem! Assim que abrirmos/.test(x.texto) || /^Recebemos seu comprovante/.test(x.texto);
        if (R_PEDIDO_ROBO.test(n)) { r.passagens_atendente.total++; r.passagens_atendente.pedidos_anotados++; motivos["pedido"] = (motivos["pedido"] || 0) + 1; }
        else if (ok) {
          const q = L[i - 1] && L[i - 1].de === "cliente" ? L[i - 1].texto : "";
          const nq = norm(q);
          const cat = /^Recebemos seu comprovante/.test(x.texto) ? "comprovante" : R_PELICULA.test(nq) ? "pelicula" : /^\[(FOTO|IMAGEM|DOCUMENTO|VIDEO|VÍDEO)/.test(nq) ? "foto/documento" : /MARCA|QUALIDADE|DIAMOND|AMBOS|CALIBRA|DIFERENCA/.test(nq) ? "duvida tecnica" : /TROCA|DEFEITO|DEVOL|ERRAD/.test(nq) ? "troca/defeito" : /ABRE|ABERT|FUNCIONA|FERIADO|ATENDE/.test(nq) ? "horario" : "outros";
          motivos[cat] = (motivos[cat] || 0) + 1;
          add(r.passagens_atendente, { tel: fim4, hora: hm(x.em), motivo: cat, cliente: corta(q, 60) });
        }
      }
    }
    // ultima mensagem do dia e do cliente = sem resposta (ignora os ultimos 5 min para nao pegar conversa em andamento)
    const u = L[L.length - 1];
    if (u.de === "cliente" && Date.now() - u.em > 300000) {
      r.sem_resposta.total++;
      if (bloq) r.sem_resposta.bloqueados++;
      if (r.sem_resposta.casos.length < MAX_CASOS) r.sem_resposta.casos.push({ tel: fim4, hora: hm(u.em), msg: corta(u.texto, 70), bloqueado: bloq, aguardando: !!info.aguardando });
    }
    // sinais de erro: robo mandou "aviso de audio" 2x seguidas ou resposta vazia; cliente reclamando do robo
    for (let i = 0; i < L.length; i++) {
      if (L[i].de === "cliente" && /(NAO ENTENDEU|NAO ENTENDI|NAO E ISSO|NAO FOI ISSO|ERRADO|ERRADA|NAO PEDI)/.test(norm(L[i].texto)) && L[i - 1] && L[i - 1].de === "robo") add(r.possiveis_erros, { tel: fim4, hora: hm(L[i].em), cliente: corta(L[i].texto, 60), robo_antes: corta(L[i - 1].texto, 60) });
    }
  }
  r.passagens_atendente.por_motivo = Object.keys(motivos).map((k) => k + ": " + motivos[k]);
  r.audios.transcritos = Math.max(0, msgs.filter((x) => x.de === "cliente" && /^\[(áudio|audio)\]/i.test(x.texto)).length - r.audios.nao_entendidos);
  r.audios.nota = "Áudios transcritos entram como texto normal no histórico; só os não entendidos aparecem marcados.";
  r.nota_erros = "Exceções do servidor (ex.: falha da IA) ainda não são gravadas no banco; só aparecem nos logs do Cloudflare. Aqui vão só sinais vistos nas conversas.";
  return r;
}

// Versao em texto corrido (mais curta ainda para ler): /painel/api/resumo?dia=...&formato=texto
export function resumoEmTexto(r) {
  const o = [];
  o.push("RESUMO " + r.dia + (r.loja_fechada_o_dia_todo ? " (loja fechada)" : "") + " · robô " + (r.robo_ligado_agora ? "ligado" : "DESLIGADO"));
  o.push("Conversas " + r.totais.conversas + " · msgs cliente " + r.totais.msgs_cliente + " · robô " + r.totais.msgs_robo + " · loja " + r.totais.msgs_loja);
  o.push("Sem resposta: " + r.sem_resposta.total + " (bloqueados: " + r.sem_resposta.bloqueados + ")");
  r.sem_resposta.casos.forEach((c) => o.push("  - " + c.hora + " …" + c.tel + (c.bloqueado ? " [bloq]" : "") + " " + c.msg));
  o.push("Preço fora do horário: " + r.preco_fora_do_horario.total + " (com preço: " + r.preco_fora_do_horario.respondidos_com_preco + ", sem resposta: " + r.preco_fora_do_horario.sem_resposta + ")");
  r.preco_fora_do_horario.casos.forEach((c) => o.push("  - " + c.hora + " …" + c.tel + " " + c.msg + " → " + c.resposta));
  o.push("Listas sem resposta: " + r.listas_sem_resposta.total);
  r.listas_sem_resposta.casos.forEach((c) => o.push("  - " + c.hora + " …" + c.tel + " (" + c.linhas + " linhas)" + (c.bloqueado ? " [bloq]" : "")));
  o.push("Insistiu após 'não temos': " + r.insistiu_apos_nao_temos.total + " (calado: " + r.insistiu_apos_nao_temos.ficou_calado + ")");
  r.insistiu_apos_nao_temos.casos.forEach((c) => o.push("  - " + c.hora + " …" + c.tel + " pediu '" + c.pediu + "' insistiu '" + c.insistiu + "' → " + c.resposta));
  o.push("🔴 Atendente: " + r.passagens_atendente.total + " [" + r.passagens_atendente.por_motivo.join(", ") + "]");
  r.passagens_atendente.casos.forEach((c) => o.push("  - " + c.hora + " …" + c.tel + " " + c.motivo + ": " + c.cliente));
  o.push("Comprovantes: " + r.comprovantes.total + " (agradecidos: " + r.comprovantes.agradecidos + ") · capinha: " + r.capinha.total + " · película: " + r.pelicula.total);
  o.push("Áudios não entendidos: " + r.audios.nao_entendidos);
  o.push("Possíveis erros (cliente reclamando): " + r.possiveis_erros.total);
  r.possiveis_erros.casos.forEach((c) => o.push("  - " + c.hora + " …" + c.tel + " cliente '" + c.cliente + "' após robô '" + c.robo_antes + "'"));
  o.push(r.nota_erros);
  return o.join(NL);
}
