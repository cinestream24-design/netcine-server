const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const manifest = {
  id: 'org.netcine.stremio.addon',
  version: '1.0.0',
  name: 'NetCine / NetStream',
  description: 'Provedor de streams de filmes e séries via Starck Filmes',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);
const BASE_URL = 'https://starckfilmes-v24.com';

function normalizeText(text) {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\:\-\?!\.\,\'\"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getTmdbMeta(type, imdbId) {
  try {
    const tmdbApiKey = 'd8e8e85d692358d3b5db2cfd08487457';
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id&language=pt-BR`;
    const res = await axios.get(findUrl, { timeout: 5000 });
    
    if (type === 'movie' && res.data.movie_results?.length > 0) {
      const movie = res.data.movie_results[0];
      return {
        title: movie.title,
        originalTitle: movie.original_title,
        year: movie.release_date ? movie.release_date.split('-')[0] : ''
      };
    } else if (type === 'series' && res.data.tv_results?.length > 0) {
      const tv = res.data.tv_results[0];
      return {
        title: tv.name,
        originalTitle: tv.original_name,
        year: tv.first_air_date ? tv.first_air_date.split('-')[0] : ''
      };
    }
  } catch (err) {
    console.error(`[NetCine] Erro TMDB (${imdbId}):`, err.message);
  }
  return null;
}

async function searchPostUrl(queryTitle, season) {
  try {
    let searchTerm = normalizeText(queryTitle);
    if (season) {
      searchTerm += ` ${season} temporada`;
    }

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchTerm)}`;
    const { data: html } = await axios.get(searchUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(html);
    let targetUrl = null;

    $('article, div').each((_, elem) => {
      if (targetUrl) return;
      const aTag = $(elem).find('a').first();
      const href = aTag.attr('href');
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

function extractInfoHash(magnetUri) {
  const match = magnetUri.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

function parseMagnetLink(rawUrl) {
  if (!rawUrl) return null;
  if (rawUrl.startsWith('magnet:?')) return rawUrl;
  
  // Decodifica magnet oculto em parâmetros de protetores de link
  if (rawUrl.includes('magnet%3A%3F') || rawUrl.includes('magnet:?')) {
    const match = rawUrl.match(/(magnet:\?[^&"'<]+)/i) || rawUrl.match(/(magnet%3A%3F[^&"'<]+)/i);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

async function extractMagnets(postUrl, title, season, episode) {
  try {
    const { data: html } = await axios.get(postUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $= cheerio.load(html);$('.related, .recomenda, .voce-pode-gostar, .popular').remove();

    const streams = [];

    $('a').each((i, elem) => {
      const rawHref = $(elem).attr('href') || $(elem).attr('data-magnet') \vert{}\vert{}$(elem).attr('data-link');
      const magnet = parseMagnetLink(rawHref);

      if (magnet) {
        const parentText = $(elem).parent().text() || '';
        const context = `${$(elem).text()} ${parentText}`.toLowerCase();

        // Filtro de Episódio para Séries
        if (episode) {
          const epFormatted = episode.toString().padStart(2, '0');
          const epRegex = new RegExp(`(e${epFormatted}|ep${epFormatted}|episodio\\s*${episode}|ep\\s*${episode})`, 'i');
          if (!epRegex.test(context) && !context.includes('temporada completa')) {
            return;
          }
        }

        let quality = '720p';
        if (context.includes('4k') || context.includes('2160p')) quality = '4K';
        else if (context.includes('1080p') || context.includes('full hd')) quality = '1080p';

        let audio = 'Dublado';
        if (context.includes('dual') || context.includes('dual audio')) audio = 'Dual Áudio';
        else if (context.includes('legendado')) audio = 'Legendado';

        const infoHash = extractInfoHash(magnet);

        streams.push({
          name: 'NetCine / Starck',
          title: `${title}${episode ? ` (S${season}E${episode})` : ''}\nQualidade: ${quality} | Áudio: ${audio}`,
          infoHash: infoHash || undefined,
          url: magnet
        });
      }
    });

    return streams;
  } catch (err) {
    console.error(`[NetCine] Erro ao extrair magnets:`, err.message);
    return [];
  }
}

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[NetCine] Solicitação de stream para ${type} ID: ${id}`);
  
  const parts = id.split(':');
  const imdbId = parts[0];
  const season = parts[1] || null;
  const episode = parts[2] || null;

  const meta = await getTmdbMeta(type, imdbId);
  if (!meta) {
    return { streams: [] };
  }

  let postUrl = await searchPostUrl(meta.title, season);

  if (!postUrl && meta.originalTitle && meta.originalTitle !== meta.title) {
    postUrl = await searchPostUrl(meta.originalTitle, season);
  }

  if (!postUrl) {
    return { streams: [] };
  }

  const streams = await extractMagnets(postUrl, meta.title, season, episode);
  return { streams };
});

const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), { port: PORT })
  .then(() => {
    console.log(`[NetCine Addon] Servidor rodando em http://localhost:${PORT}/manifest.json`);
  })
  .catch((err) => {
    console.error('[NetCine Addon] Erro ao iniciar servidor:', err);
  });
