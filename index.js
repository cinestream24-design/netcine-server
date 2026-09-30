// Busca metadados no TMDB usando o ID do IMDb
async function getTmdbMeta(type, imdbId) {
  try {
    const tmdbApiKey = 'd8e8e85d692358d3b5db2cfd08487457';
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id&language=pt-BR`;
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

// Pesquisa no site o post do filme/série
async function searchPostUrl(queryTitle) {
  try {
    const searchTerm = normalizeText(queryTitle);
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchTerm)}`;
    
    console.log(`[NetCine] Pesquisando no site: ${searchUrl}`);

    const { data: html } = await axios.get(searchUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(html);
    let targetUrl = null;

    // Procura o primeiro artigo/link de resultado válido
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

// Handler de streams atualizado com fallback de títulos
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

  // Tentativa 1: Título PT-BR + Temporada
  let searchQuery = season ? `${meta.title} ${season} temporada` : meta.title;
  let postUrl = await searchPostUrl(searchQuery);

  // Tentativa 2: Só o Título PT-BR
  if (!postUrl && season) {
    postUrl = await searchPostUrl(meta.title);
  }

  // Tentativa 3: Título Original + Temporada
  if (!postUrl && meta.originalTitle && meta.originalTitle !== meta.title) {
    searchQuery = season ? `${meta.originalTitle} ${season} temporada` : meta.originalTitle;
    postUrl = await searchPostUrl(searchQuery);
  }

  // Tentativa 4: Só o Título Original
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
