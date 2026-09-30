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
  version: '1.2.0',
  name: 'NetCine Addon',
  description: 'Links magnet de filmes em Dual Áudio',
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
  return m ? safeDecode(m[1]) : '';
}

function safeDecode(str) {
  try {
    return decodeURIComponent((str || '').replace(/\+/g, ' '));
  } catch (e) {
    return str || '';
  }
}

function clean(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

// Áudio: dual (0) > dublado (1). Legendado (2) é descartado. Desconhecido = null
function detectAudio(text) {
  const t = normalizeText(text);
  if (/dual/.test(t)) return { rank: 0, label: '🔊 Dual Áudio' };
  if (/dublad|dublagem|nacional/.test(t)) return { rank: 1, label: '🔊 Dublado' };
  if (/legendad|subtitulad|\bleg\b/.test(t)) return { rank: 2, label: '💬 Legendado' };
  return null;
}

// ---------- TMDB: converte o ID do IMDb no título ----------

async function getTmdbMovie(imdbId) {
  try {
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=pt-BR`;
    const res = await axios.get(findUrl, { timeout: 5000 });

    if (res.data.movie_results && res.data.movie_results.length > 0) {
      const movie = res.data.movie_results[0];
      return {
        title: movie.title,
        originalTitle: movie.original_title,
        year: (movie.release_date || '').slice(0, 4)
      };
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

    const byUrl = new Map();

    // Os posts do site ficam todos em /catalog/<slug>/
    $('a[href*="/catalog/"]').each((_, elem) => {
      let href = $(elem).attr('href');
      if (!href) return;
      if (href.startsWith('/')) href = BASE_URL + href;
      if (!href.startsWith(BASE_URL)) return;

      // Cada item da lista mostra o tipo de áudio (Dual Áudio, Dublado, Legendado)
      const $item = $(elem).closest('.item, .sub-item, article, li');
      let audioType = clean($item.find('.footer-audio-type').first().text());
      if (!audioType) {
        // Se o selo tiver outra classe: usa o texto do card, desde que ele seja de um post só
        const hrefs = new Set();
        $item.find('a[href*="/catalog/"]').each((__, a) => hrefs.add($(a).attr('href')));
        if (hrefs.size === 1) audioType = clean($item.text());
      }
      const title = clean($(elem).attr('title') || $(elem).text());

      const prev = byUrl.get(href);
      if (!prev) {
        byUrl.set(href, { url: href, title, audioType });
      } else {
        if (!prev.audioType && audioType) prev.audioType = audioType;
        if (!prev.title && title) prev.title = title;
      }
    });

    const posts = [...byUrl.values()];
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

// O que pode vir depois do título no slug: ano e/ou data (dd-mm-aaaa) e, às vezes, o tipo de áudio
const SLUG_SUFFIX = /^(-\d{4})?(-\d{2}-\d{2}-\d{4})?(-(dual-audio|dublado|legendado|nacional))?$/;

// Lista os posts do filme, sem legendado, com Dual Áudio primeiro
function pickMovieCandidates(posts, titles, year) {
  const titleSlugs = titles.map(slugify).filter(Boolean);

  const isSameMovie = (slug, strict) =>
    titleSlugs.some((t) => {
      if (slug === t) return true;
      if (!slug.startsWith(t + '-')) return false;
      if (strict) return SLUG_SUFFIX.test(slug.slice(t.length));
      return !!year && new RegExp(`-${year}(-|$)`).test(slug);
    });

  const movies = posts.filter((p) => !/temporada/.test(postSlug(p.url)));

  let matches = movies.filter((p) => isSameMovie(postSlug(p.url), true));
  if (matches.length === 0) matches = movies.filter((p) => isSameMovie(postSlug(p.url), false));

  if (matches.length === 0 && posts.length > 0) {
    console.log(`[NetCine] Nenhum slug bateu com ${JSON.stringify(titleSlugs)}. Primeiros resultados: ${posts.slice(0, 5).map((p) => postSlug(p.url)).join(' | ')}`);
  }

  return matches
    .map((p) => {
      const audio = detectAudio(`${p.audioType} ${p.title} ${postSlug(p.url)}`);
      return { url: p.url, rank: audio ? audio.rank : 3 }; // 3 = ainda não sabemos (confere na página)
    })
    .filter((c) => c.rank !== 2) // nada de legendado
    .sort((a, b) => a.rank - b.rank)
    .map((c) => c.url);
}

// ---------- Extração dos magnets ----------

const RES_RANK = { '2160p': 4, '1440p': 3, '1080p': 2, '720p': 1, '480p': 0 };

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(n / (1024 ** 2))} MB`;
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

function parseInfo(dn, context, xl, postAudio) {
  const all = `${dn} ${context}`;

  // Nome do arquivo manda; depois o texto ao redor do link; por fim o áudio do post
  const audio = detectAudio(dn) || detectAudio(context) || postAudio || { rank: 3, label: '🔊 Áudio não informado' };

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

    // O título da página diz o áudio: "... Dual Áudio Download" ou "... Legendado Download"
    const postAudio = detectAudio(clean($('h1').first().text()));
    if (postAudio && postAudio.rank === 2) {
      console.log(`[NetCine] Post legendado ignorado: ${postUrl}`);
      return [];
    }

    $('a[href^="magnet:"]').each((_, elem) => {
      const $a = $(elem);
      // O site deixa espaços (%20) sobrando no fim do nome e dos trackers; limpa antes de usar
      const magnetUrl = $a.attr('href').replace(/(%20|\s)+(?=&|$)/g, '');

      const hash = ((magnetUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/) || [])[1] || magnetUrl).toLowerCase();
      if (seenHashes.has(hash)) return;
      seenHashes.add(hash);

      const dn = clean(safeDecode((magnetUrl.match(/[?&]dn=([^&]+)/) || [])[1] || ''));
      const xl = (magnetUrl.match(/[?&]xl=(\d+)/) || [])[1];
      const context = clean([$a.parent().text(), $a.text(), nearestHeading($, $a)].join(' '));

      const info = parseInfo(dn, context, xl, postAudio);
      if (info.audio.rank === 2) return; // nada de legendado

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

  // Dual Áudio primeiro, depois Dublado; dentro de cada grupo, maior resolução primeiro
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

  console.log(`[NetCine] Título traduzido: "${meta.title}" | Original: "${meta.originalTitle}" | Ano: ${meta.year}`);

  const titles = [meta.title];
  if (meta.originalTitle && meta.originalTitle !== meta.title) titles.push(meta.originalTitle);

  // Busca pelo título normal (o ID do IMDb nunca vai para o site)
  let candidates = [];
  for (const t of titles) {
    const posts = await searchPosts(t);
    candidates = pickMovieCandidates(posts, titles, meta.year);
    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) {
    console.log(`[NetCine] Nenhum post (sem legendado) encontrado para: ${meta.title}`);
    return { streams: [] };
  }

  // Tenta os posts em ordem (Dual Áudio primeiro) e usa o primeiro que tiver links
  for (const postUrl of candidates.slice(0, 3)) {
    console.log(`[NetCine] Testando post: ${postUrl}`);
    const streams = await extractMagnets(postUrl);
    if (streams.length > 0) {
      console.log(`[NetCine] ${streams.length} link(s) magnet retornados`);
      return { streams };
    }
  }

  console.log(`[NetCine] Nenhum link Dual Áudio/Dublado para: ${meta.title}`);
  return { streams: [] };
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
