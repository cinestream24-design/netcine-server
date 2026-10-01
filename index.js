const http = require('http');
const url = require('url');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 7000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Lista de Canais de TV ao Vivo
const CANAIS_TV = [
  {
    id: 'live_axn',
    name: 'AXN',
    type: 'tv',
    poster: 'https://images.pt.sftcdn.net/images/t_app-icon-m/p/4f4e2422-9218-11e6-9218-0242ac120002/2165037190/axn-logo.png',
    description: 'Canal de séries, filmes de ação e entretenimento ao vivo.',
    streamUrl: 'https://bolodechocolate.fit/play/axn.html'
  }
];

// Helper para enviar respostas JSON com suporte a CORS
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Manifesto do Addon para Nuvio / Stremio
function buildManifest() {
  return {
    id: 'org.cinestream.netcine',
    version: '2.2.0',
    name: 'NetCine + TV Ao Vivo',
    description: 'Filmes em Torrent e Canais de TV ao Vivo em HD',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'tv'],
    idPrefixes: ['tt', 'live_'],
    catalogs: [
      {
        type: 'tv',
        id: 'tv_ao_vivo',
        name: '📺 TV Ao Vivo'
      }
    ],
    behaviorHints: {
      configurable: false
    }
  };
}

// Busca Dinâmica de Torrents para Filmes (Comando Torrents / Starck)
async function getMovieStreams(imdbId) {
  const streams = [];

  try {
    let searchTitle = imdbId;

    // 1. Converte o ID IMDb no título em Português/Original via TMDB
    if (TMDB_API_KEY) {
      try {
        const tmdbRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
          params: {
            api_key: TMDB_API_KEY,
            external_source: 'imdb_id',
            language: 'pt-BR'
          },
          timeout: 4000
        });

        const movie = tmdbRes.data?.movie_results?.[0];
        if (movie) {
          searchTitle = movie.title || movie.original_title;
        }
      } catch (e) {
        console.error('Erro na consulta TMDB:', e.message);
      }
    }

    // 2. Procura o filme no site de torrents
    const searchUrl = `https://comandotorrents.org/?s=${encodeURIComponent(searchTitle)}`;
    const { data: html } = await axios.get(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 5000
    });

    const $ = cheerio.load(html);
    const moviePageUrl = $('article header h2 a').first().attr('href');

    // 3. Extrai os links magnet da página do filme
    if (moviePageUrl) {
      const { data: pageHtml } = await axios.get(moviePageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
      });

      const $page = cheerio.load(pageHtml);

      $page('a[href^="magnet:"]').each((_, el) => {
        const magnet = $page(el).attr('href');
        const parentText = $page(el).parent().text().trim() \vert{}\vert{}$page(el).text().trim();

        if (magnet) {
          let quality = '1080p Full HD';
          if (parentText.includes('4K') || parentText.includes('2160p')) quality = '4K Ultra HD';
          else if (parentText.includes('720p')) quality = '720p HD';

          streams.push({
            name: 'NetCine',
            title: `🎬 ${searchTitle}\n🔊 Dual Áudio | ${quality}\n🧲 Torrent Direct`,
            url: magnet
          });
        }
      });
    }

  } catch (err) {
    console.error('Erro na busca de torrents:', err.message);
  }

  return streams;
}

// Servidor Principal
const server = http.createServer(async (req, res) => {
  // Trata requisições OPTIONS (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;

  // Página Inicial
  if (path === '/' || path === '/configure') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html lang="pt">
      <head>
        <meta charset="UTF-8">
        <title>NetCine Server - Nuvio</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0d0e12; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
          .card { background: #16181e; padding: 2.5rem; border-radius: 12px; text-align: center; max-width: 480px; width: 90%; box-shadow: 0 8px 24px rgba(0,0,0,0.6); border: 1px solid #282b36; }
          h1 { color: #e50914; margin-bottom: 0.5rem; }
          p { color: #8c92a4; margin-bottom: 1.5rem; font-size: 0.95rem; }
          input { width: 100%; padding: 0.8rem; border-radius: 6px; border: 1px solid #282b36; background: #0d0e12; color: #fff; margin-bottom: 1rem; box-sizing: border-box; text-align: center; }
          button { background: #e50914; color: #fff; border: none; padding: 0.8rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; transition: 0.2s; }
          button:hover { background: #ff0f1a; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>NetCine + TV</h1>
          <p>Servidor ativo! Copie o link abaixo para instalar no Nuvio ou Stremio.</p>
          <input type="text" readonly value="http://${req.headers.host}/manifest.json" id="manifestUrl">
          <button onclick="navigator.clipboard.writeText(document.getElementById('manifestUrl').value); alert('Link do manifesto copiado!');">Copiar Link do Manifesto</button>
        </div>
      </body>
      </html>
    `);
    return;
  }

  // Manifesto
  if (path === '/manifest.json') {
    return sendJson(res, 200, buildManifest());
  }

  // Catálogo de TV Ao Vivo
  if (path === '/catalog/tv/tv_ao_vivo.json') {
    const metas = CANAIS_TV.map(c => ({
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: c.poster,
      description: c.description
    }));
    return sendJson(res, 200, { metas });
  }

  // Metadados do Canal de TV
  const metaMatch = path.match(/^\/meta\/tv\/([^/]+)\.json$/);
  if (metaMatch) {
    const channelId = decodeURIComponent(metaMatch[1]);
    const channel = CANAIS_TV.find(c => c.id === channelId);

    if (!channel) {
      return sendJson(res, 404, { error: 'Canal não encontrado' });
    }

    return sendJson(res, 200, {
      meta: {
        id: channel.id,
        type: 'tv',
        name: channel.name,
        poster: channel.poster,
        description: channel.description
      }
    });
  }

  // Streams (Filmes e TV)
  const streamMatch = path.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
  if (streamMatch) {
    const type = decodeURIComponent(streamMatch[1]);
    const id = decodeURIComponent(streamMatch[2]);

    // Transmissão de TV Ao Vivo
    if (type === 'tv') {
      const channel = CANAIS_TV.find(c => c.id === id);
      if (!channel) {
        return sendJson(res, 200, { streams: [] });
      }

      return sendJson(res, 200, {
        streams: [
          {
            title: `📺 ${channel.name}\n🌐 Transmissão Ao Vivo (HD)`,
            externalUrl: channel.streamUrl
          }
        ]
      });
    }

    // Transmissão de Filmes (Torrent)
    if (type === 'movie') {
      const streams = await getMovieStreams(id);
      return sendJson(res, 200, { streams });
    }
  }

  return sendJson(res, 404, { error: 'Rota não encontrada' });
});

server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(` NetCine Server + TV Ao Vivo`);
  console.log(` Servidor rodando na porta: ${PORT}`);
  console.log(` Manifesto: http://localhost:${PORT}/manifest.json`);
  console.log(`=================================`);
});
