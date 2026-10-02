Const http = require('http');
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');

// DNS da Cloudflare usado SOMENTE nas requisições do Comando Torrents
const cfResolver = new dns.Resolver();
cfResolver.setServers(['1.1.1.1', '1.0.0.1']);

function cloudflareLookup(hostname, options, callback) {
  cfResolver.resolve4(hostname, (err, addresses) => {
    if (err || !addresses || !addresses.length) {
      return dns.lookup(hostname, options, callback);
    }
    if (options && options.all) {
      return callback(null, addresses.map((a) => ({ address: a, family: 4 })));
    }
    callback(null, addresses[0], 4);
  });
}

const comandoAgent = new https.Agent({ lookup: cloudflareLookup });

// Sites de onde os links são puxados (configuráveis via variáveis de ambiente no Railway)
const STARCK_URL = (process.env.STARCK_URL || 'https://starckfilmes-v24.com').replace(/\/+$/, '');
const STARCKNET_URL = (process.env.STARCKNET_URL || 'https://starckfilmesnet.com').replace(/\/+$/, '');
const COMANDO_URL = (process.env.COMANDO_URL || 'https://comando1.com').replace(/\/+$/, '');
const FLECHA_URL = (process.env.FLECHA_URL || 'https://flecha.lat').replace(/\/+$/, '');

// Defina TMDB_API_KEY nas variáveis de ambiente do Railway
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
if (!TMDB_API_KEY) {
  console.warn('[NetCine] ATENÇÃO: TMDB_API_KEY não definida nas variáveis de ambiente!');
}

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
};

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

function postSlug(url) {
  const m = (url || '').match(/\/catalog\/([^/?#]+)/) || (url || '').match(/\/([^/?#]+)\/?$/);
  return m ? safeDecode(m[1]) : '';
}

// Áudio: dual (0) > dublado (1). Legendado (2) é descartado. Desconhecido = null
function detectAudio(text) {
  const t = normalizeText(text);
  if (/dual/.test(t)) return { rank: 0, label: '🔊 Dual Áudio' };
  if (/dublad|dublagem|nacional|\bdub\b/.test(t)) return { rank: 1, label: '🔊 Dublado' };
  if (/legendad|subtitulad|\bleg\b/.test(t)) return { rank: 2, label: '💬 Legendado' };
  return null;
}

// ---------- TMDB ----------

async function getTmdbMedia(id, type = 'movie') {
  try {
    const endpoint = type === 'series' ? 'tv' : 'movie';
    const findUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=pt-BR`;
    const res = await axios.get(findUrl, { timeout: 5000 });

    const results = res.data[`${endpoint}_results`];
    if (results && results.length > 0) {
      const media = results[0];
      return {
        title: media.title || media.name,
        originalTitle: media.original_title || media.original_name,
        year: (media.release_date || media.first_air_date || '').slice(0, 4)
      };
    }
  } catch (err) {
    console.error(`[NetCine] Erro TMDB (${id}):`, err.message);
  }
  return null;
}

// ---------- Magnet: valida e reconstrói o link ----------

function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) return '';
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function normalizeMagnet(raw) {
  const href = (raw || '').trim();
  const m = href.match(/xt=urn:btih:([A-Za-z0-9]+)/i);
  if (!m) return null;

  let hash = m[1];
  if (/^[A-Za-z2-7]{32}$/.test(hash)) hash = base32ToHex(hash);
  if (!/^([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(hash)) return null;
  hash = hash.toLowerCase();

  let dn = '';
  const trackers = [];
  const query = href.slice(href.indexOf('?') + 1);
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toLowerCase();
    const value = clean(safeDecode(part.slice(eq + 1)));
    if (!value) continue;
    if (key === 'dn') dn = value;
    if (key === 'tr') {
      const t = value.replace(/\/anunciar$/i, '/announce');
      if (!trackers.includes(t)) trackers.push(t);
    }
  }

  return `magnet:?xt=urn:btih:${hash}`
    + (dn ? `&dn=${encodeURIComponent(dn)}` : '')
    + trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
}

// ---------- Informações do link ----------

const RES_RANK = { '2160p': 4, '1440p': 3, '1080p': 2, '720p': 1, '480p': 0 };

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(n / (1024 ** 2))} MB`;
}

function parseInfo(dn, context, xl, postAudio) {
  const all = `${dn} ${context}`;
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

function buildTitle(info, dn, siteName) {
  const tech = [info.res, info.source, info.codec, info.hdr].filter(Boolean).join(' · ');
  const extra = [info.size ? `💾 ${info.size}` : '', info.channels ? `🔈 ${info.channels}` : ''].filter(Boolean).join('  ');

  return [
    info.audio.label,
    tech ? `🎬 ${tech}` : '',
    extra,
    siteName ? `🌐 ${siteName}` : '',
    dn ? `📄 ${dn}` : ''
  ].filter(Boolean).join('\n');
}

function makeItem(rawMagnet, context, postAudio, siteName, requireDnDual = false) {
  const magnetUrl = normalizeMagnet(rawMagnet);
  if (!magnetUrl) return null;

  const hash = (magnetUrl.match(/xt=urn:btih:([a-f0-9]+)/) || [])[1];
  const dn = clean(safeDecode((magnetUrl.match(/[?&]dn=([^&]+)/) || [])[1] || ''));
  const xl = ((rawMagnet || '').match(/[?&](?:amp;)?xl=(\d+)/) || [])[1];

  if (requireDnDual) {
    const a = detectAudio(dn);
    if (!a || a.rank > 1) return null;
  }

  const info = parseInfo(dn, context, xl, postAudio);
  if (info.audio.rank > 1) return null;

  let sizeBytes = Number(xl) || 0;
  if (!sizeBytes) {
    const sm = `${dn} ${context}`.match(/(\d+(?:[.,]\d+)?)\s*(GB|MB)/i);
    if (sm) sizeBytes = parseFloat(sm[1].replace(',', '.')) * (sm[2].toUpperCase() === 'GB' ? 1024 ** 3 : 1024 ** 2);
  }

  return {
    hash,
    source: siteName,
    sizeBytes,
    res: info.res,
    audioRank: info.audio.rank,
    resRank: RES_RANK[info.res] !== undefined ? RES_RANK[info.res] : -1,
    stream: {
      name: info.res || '',
      title: buildTitle(info, dn, siteName),
      externalUrl: magnetUrl
    }
  };
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

// =====================================================================
// FONTE 1: Starck Filmes
// =====================================================================

const STARCK_NAME = 'Starck Filmes';

async function searchStarck(queryTitle) {
  const term = (queryTitle || '').trim();
  if (!term) return [];

  const searchUrl = `${STARCK_URL}/?s=${encodeURIComponent(term)}`;
  console.log(`[Starck] Pesquisando: ${searchUrl}`);

  try {
    const { data: html } = await axios.get(searchUrl, { timeout: 10000, headers: HTTP_HEADERS });
    const $ = cheerio.load(html);
    const byUrl = new Map();

    $('a[href*="/catalog/"]').each((_, elem) => {
      let href = $(elem).attr('href');
      if (!href) return;
      if (href.startsWith('/')) href = STARCK_URL + href;
      if (!href.startsWith(STARCK_URL)) return;

      const $item = $(elem).closest('.item, .sub-item, article, li');
      let audioType = clean($item.find('.footer-audio-type').first().text());
      if (!audioType) {
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
    console.log(`[Starck] ${posts.length} posts encontrados para "${term}"`);
    return posts;
  } catch (err) {
    console.error(`[Starck] Erro na busca HTTP:`, err.message);
    return [];
  }
}

const SLUG_SUFFIX = /^(-\d{4})?(-\d{2}-\d{2}-\d{4})?(-(dual-audio|dublado|legendado|nacional))?$/;

function pickStarckCandidates(posts, titles, year) {
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

  return matches
    .map((p) => {
      const audio = detectAudio(`${p.audioType} ${p.title} ${postSlug(p.url)}`);
      return { url: p.url, rank: audio ? audio.rank : 3 };
    })
    .filter((c) => c.rank <= 1 || c.rank === 3)
    .sort((a, b) => a.rank - b.rank)
    .map((c) => c.url);
}

async function extractStarckMagnets(postUrl) {
  const items = [];
  const seen = new Set();

  try {
    const { data: html } = await axios.get(postUrl, { timeout: 10000, headers: HTTP_HEADERS });
    const $ = cheerio.load(html);

    const postAudio = detectAudio(clean($('h1').first().text()));
    if (postAudio && postAudio.rank === 2) return [];

    $('a[href^="magnet:"]').each((_, elem) => {
      const $a = $(elem);
      const context = clean([$a.parent().text(), $a.text(), nearestHeading($, $a)].join(' '));

      const item = makeItem($a.attr('href'), context, postAudio, STARCK_NAME);
      if (!item || seen.has(item.hash)) return;
      seen.add(item.hash);
      items.push(item);
    });
  } catch (err) {
    console.error(`[Starck] Erro ao extrair magnets:`, err.message);
  }
  return items;
}

async function getFromStarck(titles, meta) {
  let candidates = [];
  for (const t of titles) {
    const posts = await searchStarck(t);
    candidates = pickStarckCandidates(posts, titles, meta.year);
    if (candidates.length > 0) break;
  }

  for (const postUrl of candidates.slice(0, 3)) {
    console.log(`[Starck] Testando post: ${postUrl}`);
    const items = await extractStarckMagnets(postUrl);
    if (items.length > 0) return items;
  }
  return [];
}

// =====================================================================
// FONTE 2: StarckFilmesNet
// =====================================================================

const STARCKNET_NAME = 'StarckFilmesNet';

function parseStarckNetSearch(html) {
  const $ = cheerio.load(html);
  const byUrl = new Map();

  $('a.o-card').each((_, elem) => {
    const url = $(elem).attr('href');
    if (!url || byUrl.has(url)) return;
    const title = clean($(elem).find('.o-card-titulo').first().text());
    const meta = clean($(elem).find('.o-card-meta').first().text());
    const year = (meta.match(/\b(?:19|20)\d{2}\b/) || [])[0] || '';
    byUrl.set(url, { url, title, meta, year });
  });

  return [...byUrl.values()];
}

function pickStarckNetCandidates(posts, titles, year) {
  const titleSlugs = titles.map(slugify).filter(Boolean);

  return posts
    .filter((p) => !/temporada/.test(normalizeText(p.title)) && !/temporada/.test(p.url))
    .filter((p) => titleSlugs.includes(slugify(p.title)))
    .filter((p) => !year || !p.year || Math.abs(Number(p.year) - Number(year)) <= 1)
    .map((p) => {
      const audio = detectAudio(p.meta);
      return { url: p.url, rank: audio ? audio.rank : 3 };
    })
    .filter((c) => c.rank <= 1 || c.rank === 3)
    .sort((a, b) => a.rank - b.rank)
    .map((c) => c.url);
}

function parseStarckNetPost(html, imdbId) {
  const pageImdb = (html.match(/imdb\.com\/title\/(tt\d+)/) || [])[1];
  if (pageImdb && imdbId && pageImdb !== imdbId) return { items: [], mismatch: pageImdb };

  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  const add = (item) => {
    if (!item || seen.has(item.hash)) return;
    seen.add(item.hash);
    items.push(item);
  };

  $('.o-lista').each((_, group) => {
    const groupName = clean($(group).find('.o-grupo-nome').first().text());
    const groupAudio = detectAudio(groupName);

    $(group).find('.o-arquivo').each((__, file) => {
      const $file = $(file);
      const magnet = $file.find('a[href^="magnet:"]').first().attr('href');
      if (!magnet) return;

      const quality = clean($file.find('.o-q').first().text());
      const size = clean($file.find('.o-arquivo-info b').first().text());
      const source = clean($file.find('.o-arquivo-info small').text());
      const context = clean(`${groupName} ${quality} ${source} ${size}`);

      add(makeItem(magnet, context, groupAudio, STARCKNET_NAME));
    });
  });

  // Plano B: se o layout mudar, pega qualquer magnet da página
  if (items.length === 0 && $('.o-lista').length === 0) {
    $('a[href^="magnet:"]').each((_, a) => {
      const context = clean($(a).parent().text());
      add(makeItem($(a).attr('href'), context, null, STARCKNET_NAME));
    });
  }

  return { items, mismatch: null };
}

async function getFromStarckNet(titles, meta, imdbId) {
  let candidates = [];
  for (const t of titles) {
    const term = (t || '').trim();
    if (!term) continue;
    const searchUrl = `${STARCKNET_URL}/?s=${encodeURIComponent(term)}`;
    console.log(`[StarckNet] Pesquisando: ${searchUrl}`);

    try {
      const { data: html } = await axios.get(searchUrl, { timeout: 10000, headers: HTTP_HEADERS });
      const posts = parseStarckNetSearch(html);
      console.log(`[StarckNet] ${posts.length} posts encontrados para "${term}"`);
      candidates = pickStarckNetCandidates(posts, titles, meta.year);
    } catch (err) {
      console.error(`[StarckNet] Erro na busca HTTP:`, err.message);
    }
    if (candidates.length > 0) break;
  }

  for (const postUrl of candidates.slice(0, 3)) {
    console.log(`[StarckNet] Testando post: ${postUrl}`);
    try {
      const { data: html } = await axios.get(postUrl, { timeout: 10000, headers: HTTP_HEADERS });
      const { items, mismatch } = parseStarckNetPost(html, imdbId);
      if (mismatch) {
        console.log(`[StarckNet] Post ignorado (IMDb ${mismatch} não é ${imdbId}): ${postUrl}`);
        continue;
      }
      if (items.length > 0) return items;
    } catch (err) {
      console.error(`[StarckNet] Erro ao abrir o post:`, err.message);
    }
  }
  return [];
}

// =====================================================================
// FONTE 3: Comando Torrents
// =====================================================================

const COMANDO_NAME = 'Comando Torrents';

async function searchComando(queryTitle) {
  const term = (queryTitle || '').trim();
  if (!term) return [];

  const searchUrl = `${COMANDO_URL}/?s=${encodeURIComponent(term)}`;
  console.log(`[Comando] Pesquisando: ${searchUrl}`);

  try {
    const { data: html } = await axios.get(searchUrl, { timeout: 10000, headers: HTTP_HEADERS, httpsAgent: comandoAgent });
    const $ = cheerio.load(html);
    const byUrl = new Map();

    $('article a[href], .post-title a[href], .entry-title a[href], h2 a[href]').each((_, elem) => {
      let href = $(elem).attr('href');
      if (!href) return;
      if (href.startsWith('/')) href = COMANDO_URL + href;
      if (!href.startsWith(COMANDO_URL) || href.includes('/?s=')) return;

      const $item = $(elem).closest('article, .post, .entry');
      const title = clean($(elem).text() || $item.find('h2, .entry-title').text());
      const metaText = clean($item.text());

      if (!byUrl.has(href)) {
        byUrl.set(href, { url: href, title, metaText });
      }
    });

    const posts = [...byUrl.values()];
    console.log(`[Comando] ${posts.length} posts encontrados para "${term}"`);
    return posts;
  } catch (err) {
    console.error(`[Comando] Erro na busca HTTP:`, err.message);
    return [];
  }
}

function pickComandoCandidates(posts, titles, year) {
  const titleSlugs = titles.map(slugify).filter(Boolean);

  return posts
    .filter((p) => !/temporada/.test(normalizeText(p.title)) && !/temporada/.test(p.url))
    .filter((p) => {
      const pSlug = slugify(p.title) || postSlug(p.url);
      return titleSlugs.some((t) => pSlug.includes(t));
    })
    .filter((p) => {
      if (!year) return true;
      const yMatch = p.metaText.match(/\b(19|20)\d{2}\b/);
      return !yMatch || Math.abs(Number(yMatch[0]) - Number(year)) <= 1;
    })
    .map((p) => {
      const audio = detectAudio(`${p.title} ${p.metaText}`);
      return { url: p.url, rank: audio ? audio.rank : 3 };
    })
    .filter((c) => c.rank <= 1 || c.rank === 3)
    .sort((a, b) => a.rank - b.rank)
    .map((c) => c.url);
}

async function extractComandoMagnets(postUrl, imdbId) {
  try {
    const { data: html } = await axios.get(postUrl, { timeout: 10000, headers: HTTP_HEADERS, httpsAgent: comandoAgent });

    const pageImdb = (html.match(/imdb\.com\/title\/(tt\d+)/) || [])[1];
    if (pageImdb && imdbId && pageImdb !== imdbId) {
      console.log(`[Comando] Post ignorado (IMDb ${pageImdb} não é ${imdbId}): ${postUrl}`);
      return [];
    }

    const $ = cheerio.load(html);
    const postAudio = detectAudio(clean($('h1').text() + ' ' + $('title').text()));
    if (postAudio && postAudio.rank === 2) {
      console.log(`[Comando] Post legendado ignorado: ${postUrl}`);
      return [];
    }

    const items = [];
    const seen = new Set();

    $('a[href^="magnet:"]').each((_, elem) => {
      const $a = $(elem);
      const context = clean([$a.parent().text(), $a.text(), nearestHeading($, $a)].join(' '));

      const item = makeItem($a.attr('href'), context, postAud