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

async function extractMagnets(postUrl) {
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

      const line1 = [label, quality].filter(Boolean).join(' · ') || `Opção ${index + 1}`;

      streams.push({
        name: 'NetCine',
        title: [line1, version, dn].filter(Boolean).join('\n'),
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
