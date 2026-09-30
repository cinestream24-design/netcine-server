const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://starckfilmes-v24.com';

// Defina TMDB_API_KEY nas variáveis de ambiente e depois remova o fallback abaixo
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'd8e8e85d692358d3b5db2cfd08487457';

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
};

// 1. Definição do Manifest do Stremio
const manifest = {
  id: 'org.netcine.addon',
  version: '1.0.0',
  name: 'NetCine Addon',
  description: 'Procura de conteúdos e torrents em português',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

// 2. Instância do builder
const builder = new addonBuilder(manifest);

// ---------- Utilidades ----------

function normalizeText(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function slugify(str) {
  return normalizeText(str).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function postSlug(url) {
  const m = (url || '').match(/\/catalog\/([^/?#]+)/);
  return m ? m[1] : '';
}

function safeDecode(str) {
  try {
    return decodeURIComponent((str || '').replace(/\+/g, ' '));
  } catch (e) {
    return str || '';
  }
}

// ---------- TMDB: converte o ID do IMDb no título ----------

async function getTmdbMeta(type, imdbId) {
  try {
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=pt-BR`;
    const res = await axios.get(findUrl, { timeout: 5000 });

    if (type === 'movie' && res.data.movie_results && res.data.movie_results.length > 0) {
      const movie = res.data.movie_results[0];
      return { title: movie.title, originalTitle: movie.original_title };
    } else if (type === 'series' && res.data.tv_results && res.data.tv_results.length > 0) {
      const tv = res.data.tv_results[0];
      return { title: tv.name, originalTitle: tv.original_name };
    }
  } catch (err) {
    console.error(`[NetCine] Erro TMDB (${imdbId}):`, err.message);
  }
  return null;
}

// ---------- Busca no site (pelo título normal) ----------

async function searchPosts(queryTitle) {
  const term = (queryTitle || '').trim();
  if (!term) return [];

  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(term)}`;
  console.log(`[NetCine] Pesquisando no site: ${searchUrl}`);

  try {
    const { data: html } = await axios.get(searchUrl, { timeout: 10000, headers: HTTP_HEADERS });
    const $ = cheerio.load(html);

    const seen = new Set();
    const posts = [];

    // Os posts do site ficam todos em /catalog/<slug>/
    $('a[href*="/catalog/"]').each((_, elem) => {
      let href = $(elem).attr('href');
      if (!href) return;
      if (href.startsWith('/')) href = BASE_URL + href;
      if (!href.startsWith(BASE_URL)) return;
      if (seen.has(href)) return;
      seen.add(href);

      const title = ($(elem).attr('title') || $(elem).text() || '').trim();
      posts.push({ url: href, title });
    });

    console.log(`[NetCine] ${posts.length} posts encontrados para "${term}"`);
    if (posts.length === 0) {
      console.log(`[NetCine] HTML recebido (${html.length} chars): ${html.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    return posts;
  } catch (err) {
    console.error(`[NetCine] Erro na busca HTTP:`, err.message);
    return [];
  }
}

// Escolhe o post certo (mesmo título e, para série, a temporada certa)
function pickPost(posts, titles, season) {
  const titleSlugs = titles.map(slugify).filter(Boolean);

  const candidates = posts.filter((p) => {
    const s = postSlug(p.url);
    return titleSlugs.some((t) => s === t || s.startsWith(t + '-'));
  });

  if (season) {
    const re = new RegExp(`(^|-)${parseInt(season, 10)}-temporada`);
    const found = candidates.find((p) => re.test(postSlug(p.url)));
    return found ? found.url : null;
  }

  const movie = candidates.find((p) => !/temporada/.test(postSlug(p.url)));
  return movie ? movie.url : null;
}

// ---------- Extração dos magnets ----------

// Descobre quais episódios o link cobre: "EPISÓDIOS 01 AO 03:" -> [1,3], "EPISÓDIO 04:" -> [4,4]
function parseEpisodeRange(label, dn) {
  let m = (label || '').match(/EPIS[OÓó]DIOS?\s*(\d+)(?:\s*(?:AO?|AT[ÉEé]|-)\s*(\d+))?/i);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    return [Math.min(a, b), Math.max(a, b)];
  }

  m = (dn || '').match(/S\d+E(\d+(?:-\d+)*)/i);
  if (m) {
    const nums = m[1].split('-').map((n) => parseInt(n, 10));
    return [Math.min(...nums), Math.max(...nums)];
  }

  return null;
}

async function extractMagnets(postUrl, season, episode) {
  const streams = [];
  try {
    const { data: html } = await axios.get(postUrl, { timeout: 10000, headers: HTTP_HEADERS });
    const $ = cheerio.load(html);

    $('a[href^="magnet:"]').each((index, elem) => {
      const $a = $(elem);
      const magnetUrl = $a.attr('href');
      const $p = $a.closest('p');

      const dn = safeDecode((magnetUrl.match(/[?&]dn=([^&]+)/) || [])[1] || '');
      let label = ($p.find('strong').first().text() || '').replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
      if (!label) label = $a.parent().text().replace(/\s+/g, ' ').trim();
      const quality = $a.text().replace(/\s+/g, ' ').trim();
      const version = $p.prevAll('h3').first().text().replace(/\s+/g, ' ').trim();

      const ep = episode ? parseInt(episode, 10) : null;
      const range = season && episode ? parseEpisodeRange(label, dn) : null;

      // Série: só mostra o episódio pedido (ou pacotes que o incluem)
      if (range && (ep < range[0] || ep > range[1])) return;

      const isPack = !!range && range[1] > range[0];
      const line1 = [label || `Opção ${index + 1}`, quality].filter(Boolean).join(' · ');

      // 1) Torrent direto: o player abre o arquivo do episódio escolhido dentro do pacote
      const hashMatch = magnetUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/);
      if (hashMatch && hashMatch[1].length === 40) {
        const infoHash = hashMatch[1].toLowerCase();
        const trackers = [...magnetUrl.matchAll(/[?&]tr=([^&]+)/g)]
          .map((m) => safeDecode(m[1]).replace(/\/anunciar$/i, '/announce'));

        const torrentStream = {
          name: 'NetCine',
          title: isPack
            ? `▶ Ep ${ep} do pacote (${label})\n${[quality, version].filter(Boolean).join(' · ')}`
            : `▶ ${[line1, version].filter(Boolean).join('\n')}`,
          infoHash,
          sources: trackers.map((t) => `tracker:${t}`).concat([`dht:${infoHash}`])
        };
        // Assume que os arquivos do pacote estão em ordem (ep 1, ep 2, ep 3...)
        if (isPack) torrentStream.fileIdx = ep - range[0];
        streams.push(torrentStream);
      }

      // 2) Link magnet para abrir no app de torrent (mostra todos os arquivos do pacote)
      streams.push({
        name: 'NetCine',
        title: `🧲 Abrir magnet: ${[line1, version].filter(Boolean).join('\n')}`,
        externalUrl: magnetUrl
      });
    });
  } catch (err) {
    console.error(`[NetCine] Erro ao extrair magnets:`, err.message);
  }
  return streams;
}

// 3. Handler principal do Stremio / Nuvio
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[NetCine] Solicitação de stream para ${type} ID: ${id}`);

  const parts = id.split(':');
  const imdbId = parts[0];
  const season = parts[1] ? parts[1] : null;
  const episode = parts[2] ? parts[2] : null;

  const meta = await getTmdbMeta(type, imdbId);
  if (!meta) {
    console.log(`[NetCine] Metadados não encontrados no TMDB para ID ${imdbId}`);
    return { streams: [] };
  }

  console.log(`[NetCine] Título traduzido: "${meta.title}" | Original: "${meta.originalTitle}"`);

  const titles = [meta.title];
  if (meta.originalTitle && meta.originalTitle !== meta.title) titles.push(meta.originalTitle);

  // 1) Busca pelo título normal
  let postUrl = null;
  for (const t of titles) {
    const posts = await searchPosts(t);
    postUrl = pickPost(posts, titles, season);
    if (postUrl) break;
  }

  // 2) Série sem a temporada na lista: tenta "Título N temporada"
  if (!postUrl && season) {
    for (const t of titles) {
      const posts = await searchPosts(`${t} ${season} temporada`);
      postUrl = pickPost(posts, titles, season);
      if (postUrl) break;
    }
  }

  if (!postUrl) {
    console.log(`[NetCine] Nenhum post encontrado para: ${meta.title}${season ? ' temporada ' + season : ''}`);
    return { streams: [] };
  }

  console.log(`[NetCine] Post encontrado: ${postUrl}`);
  const streams = await extractMagnets(postUrl, season, episode);
  console.log(`[NetCine] ${streams.length} link(s) magnet retornados`);
  return { streams };
});

// Tratamento global de exceções para evitar crashes
process.on('uncaughtException', (err) => {
  console.error('[NetCine Erro Não Tratado]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[NetCine Rejeição Não Tratada]:', reason);
});

// 4. Inicializa o servidor HTTP na porta dinâmica do ambiente
const PORT = process.env.PORT || 8080;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`[NetCine Addon] Servidor rodando na porta ${PORT}`);
