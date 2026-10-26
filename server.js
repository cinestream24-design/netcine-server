/**
 * Servidor IPTV Local - meu-stream (Com Atualização Dinâmica de Links Frescos)
 * Porta: 3002
 */

const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const app = express();

const PORT = 3002;

const API_EMBEDTV = 'https://embedtv.cc/api/channels';
const API_REI_CANAIS = 'https://api.reidoscanais.cam/channels';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const axiosFast = axios.create({ httpAgent, httpsAgent, timeout: 4000 });

let cacheCanais = [];
const cacheLinksStream = {};
// TTL reduzido para forçar a busca de um link fresco logo após troca de canal ou inatividade curta
const TTL_CACHE_STREAM = 45 * 1000; 

const ultimosLogs = [];
const MAX_LOGS = 50;

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

// Middleware de Logs e CORS
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const dataHora = new Date().toLocaleTimeString();
  const logMsg = `[LOG] 📺 Requisição do IP: ${ip} | URL: ${req.url} (${dataHora})`;

  console.log(logMsg);
  ultimosLogs.unshift(logMsg);
  if (ultimosLogs.length > MAX_LOGS) ultimosLogs.pop();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <html>
      <head>
        <title>Logs do Servidor - meu-stream</title>
        <meta http-equiv="refresh" content="3">
      </head>
      <body style="background: #111; color: #0f0; font-family: monospace; padding: 20px;">
        <h2>🔍 Registos em Tempo Real</h2>
        <p>Total de Canais em Cache: <b>${cacheCanais.length}</b> | <a href="/debug" style="color: #ff0;">Diagnóstico</a></p>
        <hr style="border-color: #333;">
        <ul style="list-style-type: none; padding: 0;">
          ${ultimosLogs.map(l => `<li style="margin-bottom: 8px; border-bottom: 1px solid #222; padding-bottom: 4px;">${l}</li>`).join('')}
        </ul>
      </body>
    </html>
  `);
});

app.get('/debug', (req, res) => {
  res.json({
    status: "online",
    total_canais: cacheCanais.length,
    cache_streams_ativos: Object.keys(cacheLinksStream).length,
    amostra_canais: cacheCanais.slice(0, 20)
  });
});

app.get('/', (req, res) => {
  res.redirect('/playlist.m3u');
});

function obterLogo(channel) {
  if (!channel) return '';
  if (channel.logo_url) return channel.logo_url;
  if (channel.logo) return channel.logo;
  if (channel.icon) return channel.icon;
  let id = (channel.id || '').toString().replace('rei_', '').trim();
  return 'https://img.faz-o-eli.online/' + id + '.png';
}

function obterCategoria(channel) {
  if (!channel) return 'Variedades';
  const apiCat = channel.category || channel.group || channel.group_title || channel.genre;
  if (apiCat && typeof apiCat === 'string' && apiCat.trim() !== '' && apiCat.toLowerCase() !== 'geral') {
    return apiCat.trim();
  }
  const n = (channel.name || '').toLowerCase();
  if (n.includes('sportv') || n.includes('espn') || n.includes('combate') || n.includes('premiere') || n.includes('futebol')) return 'Esportes';
  if (n.includes('telecine') || n.includes('hbo') || n.includes('filme') || n.includes('cinemax')) return 'Filmes e Séries';
  if (n.includes('noticia') || n.includes('globo news') || n.includes('cnn')) return 'Notícias';
  if (n.includes('cartoon') || n.includes('disney') || n.includes('nick')) return 'Infantil';
  if (n.includes('globo') || n.includes('sbt') || n.includes('record')) return 'Canais Abertos';
  return 'Variedades';
}

async function atualizarDados() {
  let novaLista = [];

  // Busca do EmbedTV exatamente como na versão original
  try {
    const resEmbed = await axiosFast.get(API_EMBEDTV, {
      headers: { ...BROWSER_HEADERS, 'Referer': 'https://embedtv.cc/' }
    });
    if (resEmbed.data) {
      let lista = Array.isArray(resEmbed.data) ? resEmbed.data : (resEmbed.data.channels || []);
      lista.forEach(c => c.source = 'embed');
      novaLista = novaLista.concat(lista);
    }
  } catch (err) {}

  // Busca do Rei dos Canais
  try {
    const resRei = await axiosFast.get(API_REI_CANAIS, {
      headers: { ...BROWSER_HEADERS, 'Referer': 'https://reidoscanais.cam/' }
    });
    
    if (resRei.data && resRei.data.success && Array.isArray(resRei.data.data)) {
      let listaRei = resRei.data.data;
      listaRei.forEach(c => {
        c.source = 'rei';
        c.original_id = c.id;
        c.id = 'rei_' + (c.id || Math.random().toString(36).substring(7));
        
        if (c.name && !c.name.toLowerCase().includes('alternativo')) {
          c.name = c.name + ' (Alternativo)';
        }

        if (c.embeds && Array.isArray(c.embeds) && c.embeds.length > 0) {
          c.embed_urls = c.embeds.map(e => e.embed_url).filter(Boolean);
        }
      });
      novaLista = novaLista.concat(listaRei);
    }
  } catch (err) {}

  if (novaLista.length > 0) {
    cacheCanais = novaLista;
    console.log(`[LOG] 🚀 Total combinado em memória: ${cacheCanais.length}`);
  }
}

atualizarDados();
setInterval(atualizarDados, 10 * 60 * 1000);

async function extrairUnicoEmbed(embedUrl) {
  const res1 = await axiosFast.get(embedUrl, {
    headers: { ...BROWSER_HEADERS, 'Referer': 'https://reidoscanais.cam/' }
  });

  const iframeMatch = res1.data.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!iframeMatch || !iframeMatch[1]) throw new Error("Sem iframe");

  let iframeUrl = iframeMatch[1];
  if (iframeUrl.startsWith('//')) iframeUrl = 'https:' + iframeUrl;
  else if (iframeUrl.startsWith('/')) {
    const parsedUrl = new URL(embedUrl);
    iframeUrl = parsedUrl.origin + iframeUrl;
  }

  const res2 = await axiosFast.get(iframeUrl, {
    headers: { ...BROWSER_HEADERS, 'Referer': embedUrl }
  });

  const htmlContent = res2.data;

  const matchUrls = htmlContent.match(/STREAM_URLS\s*=\s*(\[[^\]]+\])/);
  if (matchUrls && matchUrls[1]) {
    try {
      const urls = eval(matchUrls[1]);
      if (Array.isArray(urls)) {
        const validUrl = urls.find(u => u && typeof u === 'string' && (u.includes('.m3u8') || u.includes('tiktokcdn.live')) && !u.includes('error') && !u.includes('.woff') && !u.includes('.css') && !u.includes('.png'));
        if (validUrl) return validUrl;
      }
    } catch (e) {}
  }

  const matches = htmlContent.match(/https?:\/\/[^\s"'()]+?\.(?:m3u8|mpd)[^\s"'()]*/gi);
  if (matches && matches.length > 0) {
    const valido = matches.find(m => !m.includes('error') && !m.includes('.woff') && !m.includes('.css') && !m.includes('.png'));
    if (valido) return valido;
  }

  const generalMatches = htmlContent.match(/https?:\/\/[^\s"'()]+?(?:tiktokcdn\.live|cloudfront-net\.lat)[^\s"'()]*/gi);
  if (generalMatches && generalMatches.length > 0) {
    const valido = generalMatches.find(m => !m.includes('error') && !m.includes('.woff') && !m.includes('.css') && !m.includes('.png'));
    if (valido) return valido;
  }

  throw new Error("Nenhum link de vídeo válido encontrado");
}

async function resolverStreamReiSequencial(embeds) {
  if (!embeds || embeds.length === 0) return null;
  for (const url of embeds) {
    try {
      const streamUrl = await extrairUnicoEmbed(url);
      if (streamUrl) return streamUrl;
    } catch (e) {}
  }
  return null;
}

function obterHeadersCDN(url) {
  if (url.includes('ssl-images-cdn.site') || url.includes('cloudfront-net.lat')) {
    return { ...BROWSER_HEADERS, 'Referer': 'https://rdcanais.org/', 'Origin': 'https://rdcanais.org' };
  }
  return { ...BROWSER_HEADERS, 'Referer': 'https://dadinhodetapioca.fun/', 'Origin': 'https://dadinhodetapioca.fun' };
}

async function processarStream(channelId, req, res) {
  try {
    const channel = cacheCanais.find(c => (c.id || '').toString().toLowerCase() === channelId.toLowerCase());
    const isRei = channel && channel.source === 'rei';

    let targetStreamUrl = null;
    const agora = Date.now();

    // Verifica se o link em cache ainda é válido ou se expirou para buscar um fresco
    if (cacheLinksStream[channelId] && (agora - cacheLinksStream[channelId].timestamp < TTL_CACHE_STREAM)) {
      targetStreamUrl = cacheLinksStream[channelId].streamUrl;
    }

    if (!targetStreamUrl) {
      if (!isRei) {
        // Resolução direta padrão do EmbedTV
        let embedUrl = channel ? (channel.url || channel.m3u8 || channel.source) : null;
        if (!embedUrl) embedUrl = `https://embedtv.cc/${channelId}`;

        const playerRes = await axiosFast.get(embedUrl, {
          headers: { ...BROWSER_HEADERS, 'Referer': 'https://embedtv.cc/' }
        });
        const match = playerRes.data.match(/const\s+src\s*=\s*["']([^"']+)["']/);
        targetStreamUrl = (match && match[1]) ? match[1] : embedUrl;
      } else {
        let embeds = channel ? (channel.embed_urls || []) : [];
        targetStreamUrl = await resolverStreamReiSequencial(embeds);
      }

      if (targetStreamUrl) {
        cacheLinksStream[channelId] = { streamUrl: targetStreamUrl, timestamp: agora };
        console.log(`[LOG] ⚡ Link fresco obtido e atualizado para ${channelId}: ${targetStreamUrl}`);
      }
    }

    if (!targetStreamUrl) {
      delete cacheLinksStream[channelId];
      return res.status(404).send('Stream não encontrado.');
    }

    if (targetStreamUrl.includes('.mpd')) {
      res.setHeader('Content-Type', 'application/dash+xml');
      res.setHeader('Cache-Control', 'no-cache');
      const mpdRes = await axiosFast.get(targetStreamUrl, { headers: obterHeadersCDN(targetStreamUrl) });
      return res.send(mpdRes.data);
    }

    const headersCDN = obterHeadersCDN(targetStreamUrl);
    let manifestRes;

    try {
      manifestRes = await axiosFast.get(targetStreamUrl, { headers: headersCDN });
    } catch (e) {
      delete cacheLinksStream[channelId];
      if (isRei) {
        let embeds = channel ? (channel.embed_urls || []) : [];
        targetStreamUrl = await resolverStreamReiSequencial(embeds);
        if (targetStreamUrl) {
          cacheLinksStream[channelId] = { streamUrl: targetStreamUrl, timestamp: Date.now() };
          manifestRes = await axiosFast.get(targetStreamUrl, { headers: obterHeadersCDN(targetStreamUrl) });
        }
      }
    }

    if (!manifestRes || typeof manifestRes.data !== 'string' || !manifestRes.data.includes('#EXTM3U')) {
      delete cacheLinksStream[channelId];
      return res.status(502).send('Formato inválido recebido.');
    }

    const hostBase = targetStreamUrl.substring(0, targetStreamUrl.lastIndexOf('/') + 1);
    const serverHost = req.headers.host || `localhost:${PORT}`;

    const rewrittenManifest = manifestRes.data.replace(/^(?!#)(.+)$/gm, (line) => {
      const segmentUrl = line.startsWith('http') ? line : hostBase + line;
      return `http://${serverHost}/proxy-segment?url=${encodeURIComponent(segmentUrl)}&base=${encodeURIComponent(targetStreamUrl)}`;
    });

    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewrittenManifest);
  } catch (err) {
    delete cacheLinksStream[channelId];
    console.log(`[LOG] ⚠️ Erro ao processar ${channelId}: ${err.message}`);
    if (!res.headersSent) res.status(500).send('Erro no stream.');
  }
}

app.get('/player_api.php', async (req, res) => {
  const { username, password, action } = req.query;

  if (!action) {
    return res.json({
      user_info: { username: username || 'admin', password: password || '1234', auth: 1, status: 'Active', exp_date: '1974235200', is_trial: '0', active_cons: '1', max_connections: '10' },
      server_info: { url: req.headers.host, port: PORT, server_protocol: 'http', timezone: 'America/Sao_Paulo' }
    });
  }

  const categoriasUnicas = [...new Set(cacheCanais.map(c => obterCategoria(c)))];

  if (action === 'get_live_categories') {
    return res.json(categoriasUnicas.map((cat, index) => ({
      category_id: (index + 1).toString(),
      category_name: cat,
      parent_id: 0
    })));
  }

  if (action === 'get_live_streams') {
    return res.json(cacheCanais.map((channel, index) => {
      const catNome = obterCategoria(channel);
      const catIndex = categoriasUnicas.indexOf(catNome);
      const categoryId = (catIndex !== -1 ? catIndex + 1 : 1).toString();

      return {
        num: index + 1,
        name: channel.name || 'Canal',
        stream_type: 'live',
        stream_id: (channel.id || index).toString(),
        stream_icon: obterLogo(channel),
        epg_channel_id: (channel.id || '').toString(),
        category_id: categoryId,
        tv_archive: 0
      };
    }));
  }

  res.json({ error: 'Ação não suportada' });
});

app.get(['/live/:username/:password/:id', '/live/:username/:password/:id.m3u8', '/live/:username/:password/:id.ts'], async (req, res) => {
  const channelId = req.params.id.replace(/\.[^/.]+$/, '');
  await processarStream(channelId, req, res);
});

app.get('/playlist.m3u', async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  let m3uContent = `#EXTM3U\n\n`;

  cacheCanais.forEach(channel => {
    if (channel.id && channel.name) {
      const categoria = obterCategoria(channel);
      m3uContent += `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${channel.name}" tvg-logo="${obterLogo(channel)}" group-title="${categoria}",${channel.name}\n`;
      m3uContent += `http://${host}/stream/${channel.id}.m3u8\n\n`;
    }
  });

  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.send(m3uContent);
});

app.get(['/stream/:id', '/stream', '/stream/:id.m3u8'], async (req, res) => {
  let channelId = req.params.id ? req.params.id.replace(/\.[^/.]+$/, '') : null;
  if (!channelId) return res.status(400).send('ID em falta.');
  await processarStream(channelId, req, res);
});

app.get('/proxy-segment', async (req, res) => {
  const segmentUrl = req.query.url;
  const parentBase = req.query.base || '';
  if (!segmentUrl) return res.status(400).send('Segmento ausente');

  try {
    const headers = obterHeadersCDN(parentBase || segmentUrl);
    if (req.headers.range) headers['Range'] = req.headers.range;

    const response = await axiosFast.get(segmentUrl, {
      headers: headers,
      responseType: 'stream',
      validateStatus: (status) => (status >= 200 && status < 300) || status === 206
    });

    res.status(response.status);
    if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
    res.setHeader('Cache-Control', 'no-store');

    response.data.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Erro no segmento.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor a rodar na porta ${PORT}`);
  console.log(`🔗 Link fixo da playlist: http://192.168.2.112:3002/playlist.m3u`);
});