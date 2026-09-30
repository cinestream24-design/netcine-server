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

// 1. Manifest: este addon atende só FILMES (as séries do site vêm em pacote completo)
const manifest = {
  id: 'org.netcine.addon',
  version: '1.1.0',
  name: 'NetCine Addon',
  description: 'Links magnet de filmes em português',
  resources: ['stream'],
  types: ['movie'],
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

async function getTmdbMovie(imdbId) {
  try {
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=pt-BR`;
    const res = await axios.get(findUrl, { timeout: 5000 });

    if (res.data.movie_results && res.data.movie_results.length > 0) {
      const movie = res.data.movie_results[0];
      return { title: movie.title, originalTitle: movie.original_title };
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

// Escolhe o post do filme (mesmo título, ignorando posts de temporada de série)
function pickMovie(posts, titles) {
  const titleSlugs = titles.map(slugify).filter(Boolean);

  const found = posts.find((p) => {
    const s = postSlug(p.url);
    if (/temporada/.test(s)) return false;
    return titleSlugs.some((t) => s === t || s.startsWith(t + '-'));
  });

  if (!found && posts.length > 0) {
    console.log(`[NetCine] Nenhum slug bateu com ${JSON.stringify(titleSlugs)}. Primeiros resultados: ${posts.slice(0, 5).map((p) => postSlug(p.url)).join(' | ')}`);
  }
  return found ? found.url : null;
}

// ---------- Extração dos magnets ----------

const RES_RANK = { '2160p': 4, '1440p': 3, '1080p': 2, '720p': 1, '480p': 0 };

function clean(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(n / (1024 ** 2))} MB`;
}

// Detecta o áudio: dual > dublado > legendado
function detectAudio(text) {
  const t = normalizeText(text);
  if (/dual/.test(t)) return { rank: 0, label: '🔊 Dual Áudio' };
  if (/dublad|dublagem|nacional/.test(t)) return { rank: 1, label: '🔊 Dublado' };
  if (/legendad|subtitulad|\bleg\b/.test(t)) return { rank: 2, label: '💬 Legendado' };
  return null;
}

function nearestHeading($, $a) {
  let $node = $a;
  for (let i = 0; i < 4 && $node.length; i++) {
    const h = clean($node.prevAll('h2,h3,h4').first().text());
    if (h) return h;
    $node = $node.parent();
  }
  return '';
}

function parseInfo(dn, context, xl) {
  const all = `${dn} ${context}`;

  // O nome do arquivo (dn) manda; se não disser o áudio, usa o texto ao redor
  const audio = detectAudio(dn) || detectAudio(context) || { rank: 3, label: '🔊 Áudio não informado' };

  let res = (all.match(/\b(2160p|4k|1440p|1080p|720p|480p)\b/i) || [])[1] || '';
  res = res.toLowerCase() === '4k' ? '2160p' : res.toLowerCase();

  let source = (all.match(/\b(WEB[-. ]?DL|WEB[-. ]?Rip|Blu[-. ]?Ray|BDRip|BRRip|REMUX|HDRip|HDTV|DVDRip|HDTS|HDCAM|CAM)\b/i) || [])[1] || '';
  source = source.toUpperCase().replace(/[. ]/g, '-').replace('WEBDL', 'WEB-DL').replace('WEBRIP', 'WEBRip').replace('BLURAY', 'BluRay');

  let codec = (all.match(/\b(x265|HEVC|H\.?265|x264|H\.?264|AV1)\b/i) || [])[1] || '';
  codec = codec.replace(/^h\.?265$/i, 'H.265').replace(/^h\.?264$/i, 'H.264').replace(/^hevc$/i, 'HEVC');

  const hdr = (all.match(/\b(HDR10\+?|HDR|Dolby[ .]?Vision)\b/i) || [])[1] || '';
  const channels = (dn.match(/\b(7\.1|5\.1|2\.0)\b/) || [])[1] || '';

  let size = formatBytes(xl);
  if (!size) {
    const m = all.match(/(\d+(?:[.,]\d+)?)\s*(GB|MB)/i);
    if (m) size = `${m[1].replace(',', '.')} ${m[2].toUpperCase()}`;
  }

  return { audio, res, source, codec, hdr, channels, size };
}

function buildTitle(info, dn) {
  const tech = [info.res, info.source, info.codec, info.hdr].filter(Boolean).join(' · ');
  const extra = [info.size ? `💾 ${info.size}` : '', info.channels ? `🔈 ${info.channels}` : ''].filter(Boolean).join('  ');

  return [
    info.audio.label,
    tech ? `🎬 ${tech}` : '',
    extra,
    dn ? `📄 ${dn}` : ''
  ].filter(Boolean).join('\n');
}

async function extractMagnets(postUrl) {
  const items = [];
  const seenHashes = new Set();

  try {
    const { data: html } = await axios.get(postUrl, { timeout: 10000, headers: HTTP_HEADERS });
    const $ = cheerio.load(html);

    $('a[href^="magnet:"]').each((_, elem) => {
      const $a = $(elem);
      const magnetUrl = $a.attr('href');

      const hash = ((magnetUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/) || [])[1] || magnetUrl).toLowerCase();
      if (seenHashes.has(hash)) return;
      seenHashes.add(hash);

      const dn = clean(safeDecode((magnetUrl.match(/[?&]dn=([^&]+)/) || [])[1] || ''));
      const xl = (magnetUrl.match(/[?&]xl=(\d+)/) || [])[1];
      const context = clean([$a.parent().text(), $a.text(), nearestHeading($, $a)].join(' '));

      const info = parseInfo(dn, context, xl);

      items.push({
        audioRank: info.audio.rank,
        resRank: RES_RANK[info.res] !== undefined ? RES_RANK[info.res] : -1,
        stream: {
          name: `NetCine${info.res ? ' ' + info.res : ''}`,
          title: buildTitle(info, dn),
          externalUrl: magnetUrl
        }
      });
    });
  } catch (err) {
    console.error(`[NetCine] Erro ao extrair magnets:`, err.message);
  }

  // Dual Áudio primeiro, depois Dublado, Legendado; dentro de cada grupo, maior resolução primeiro
  items.sort((a, b) => a.audioRank - b.audioRank || b.resRank - a.resRank);
  return items.map((i) => i.stream);
}

// 3. Handler principal do Stremio / Nuvio
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[NetCine] Solicitação de stream para ${type} ID: ${id}`);

  // Séries não são atendidas por este addon
  if (type !== 'movie') {
    return { streams: [] };
  }

  const imdbId = id.split(':')[0];

  const meta = await getTmdbMovie(imdbId);
  if (!meta) {
    console.log(`[NetCine] Metadados não encontrados no TMDB para ID ${imdbId}`);
    return { streams: [] };
  }

  console.log(`[NetCine] Título traduzido: "${meta.title}" | Original: "${meta.originalTitle}"`);

  const titles = [meta.title];
  if (meta.originalTitle && meta.originalTitle !== meta.title) titles.push(meta.originalTitle);

  // Busca pelo título normal (o ID do IMDb nunca vai para o site)
  let postUrl = null;
  for (const t of titles) {
    const posts = await searchPosts(t);
    postUrl = pickMovie(posts, titles);
    if (postUrl) break;
  }

  if (!postUrl) {
    console.log(`[NetCine] Nenhum post encontrado para: ${meta.title}`);
    return { streams: [] };
  }

  console.log(`[NetCine] Post encontrado: ${postUrl}`);
  const streams = await extractMagnets(postUrl);
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
