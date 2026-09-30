const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://starckfilmes-v24.com';

// Defina TMDB_API_KEY nas variáveis de ambiente e depois remova o fallback abaixo
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'd8e8e85d692358d3b5db2cfd08487457';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

// Função auxiliar para limpar e normalizar textos de busca
function normalizeText(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Busca o nome do filme/série na API do TMDB usando o ID do IMDb
async function getTmdbMeta(type, imdbId) {
  try {
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=pt-BR`;
    const res = await axios.get(findUrl, { timeout: 5000 });

    if (type === 'movie' && res.data.movie_results && res.data.movie_results.length > 0) {
      const movie = res.data.movie_results[0];
      return {
        title: movie.title,
        originalTitle: movie.original_title
      };
    } else if (type === 'series' && res.data.tv_results && res.data.tv_results.length > 0) {
      const tv = res.data.tv_results[0];
      return {
        title: tv.name,
        originalTitle: tv.original_name
      };
    }
  } catch (err) {
    console.error(`[NetCine] Erro TMDB (${imdbId}):`, err.message);
  }
  return null;
}

// Pesquisa no site pelo post do filme/série
async function searchPostUrl(queryTitle) {
  try {
    const searchTerm = normalizeText(queryTitle);
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchTerm)}`;

    console.log(`[NetCine] Pesquisando no site: ${searchUrl}`);

    const { data: html } = await axios.get(searchUrl, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT }
    });

    const $ = cheerio.load(html);
    let targetUrl = null;

    $('article a, .item-single a, h2 a').each((_, elem) => {
      if (targetUrl) return;
      const href = $(elem).attr('href');
      if (href && href.includes(BASE_URL) && !href.includes('/categoria/') && !href.includes('/tag/') && !href.includes('/?s=')) {
        targetUrl = href;
      }
    });

    return targetUrl;
  } catch (err) {
    console.error(`[NetCine] Erro na busca HTTP:`, err.message);
    return null;
  }
}

// Extrai links magnet/torrent da página encontrada
async function extractMagnets(postUrl, title, season, episode) {
  const streams = [];
  try {
    const { data: html } = await axios.get(postUrl, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT }
    });

    const $ = cheerio.load(html);

    $('a[href^="magnet:"]').each((index, elem) => {
      const magnetUrl = $(elem).attr('href');
      const linkText = $(elem).text().trim() || $(elem).parent().text().trim();

      // Filtro para episódios se for série
      if (season && episode) {
        const epRegex = new RegExp(`E?0?${episode}\\b|ep?\\s*0?${episode}\\b`, 'i');
        if (linkText && !epRegex.test(linkText) && !magnetUrl.includes(`E0${episode}`) && !magnetUrl.includes(`E${episode}`)) {
          return;
        }
      }

      streams.push({
        title: `NetCine - ${linkText || 'Opção ' + (index + 1)}`,
        url: magnetUrl
      });
    });

  } catch (err) {
    console.error(`[NetCine] Erro ao extrair magnets:`, err.message);
  }
  return streams;
}

// 3. Handler principal de busca do Stremio
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

  // Fallbacks de pesquisa
  let searchQuery = season ? `${meta.title} ${season} temporada` : meta.title;
  let postUrl = await searchPostUrl(searchQuery);

  if (!postUrl && season) {
    postUrl = await searchPostUrl(meta.title);
  }

  if (!postUrl && meta.originalTitle && meta.originalTitle !== meta.title) {
    searchQuery = season ? `${meta.originalTitle} ${season} temporada` : meta.originalTitle;
    postUrl = await searchPostUrl(searchQuery);
  }

  if (!postUrl && meta.originalTitle && meta.originalTitle !== meta.title) {
    postUrl = await searchPostUrl(meta.originalTitle);
  }

  if (!postUrl) {
    console.log(`[NetCine] Nenhum post encontrado para: ${meta.title}`);
    return { streams: [] };
  }

  console.log(`[NetCine] Post encontrado: ${postUrl}`);
  const streams = await extractMagnets(postUrl, meta.title, season, episode);
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
