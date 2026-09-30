const http = require('http');
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
  if (!m) {
    return null;
  }

  let hash = m[1];
  if (/^[A-Za-z2-7]{32}$/.test(hash)) hash = base32ToHex(hash);

  if (!/^([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(hash)) {
    return null;
  }
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

  // Só Dual Áudio: descarta dublado, legendado e áudio não informado
  if (requireDnDual) {
    const a = detectAudio(dn);
    if (!a || a.rank !== 0) return null;
  }

  const info = parseInfo(dn, context, xl, postAudio);
  if (info.audio.rank !== 0) return null;

  return {
    hash,
    source: siteName,
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
// FONTE 1: starckfilmes-v24.com
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
    .filter((c) => c.rank === 0 || c.rank === 3)
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
    if (postAudio && postAudio.rank !== 0) {
      return [];
    }

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
// FONTE 2: starckfilmesnet.com
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
    .filter((c) => c.rank === 0 || c.rank === 3)
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
    .filter((c) => c.rank === 0 || c.rank === 3)
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
    if (postAudio && postAudio.rank !== 0) {
      console.log(`[Comando] Post sem dual áudio ignorado: ${postUrl}`);
      return [];
    }

    const items = [];
    const seen = new Set();

    $('a[href^="magnet:"]').each((_, elem) => {
      const $a = $(elem);
      const context = clean([$a.parent().text(), $a.text(), nearestHeading($, $a)].join(' '));

      const item = makeItem($a.attr('href'), context, postAudio, COMANDO_NAME, true);
      if (!item || seen.has(item.hash)) return;
      seen.add(item.hash);
      items.push(item);
    });

    return items;
  } catch (err) {
    console.error(`[Comando] Erro ao extrair magnets:`, err.message);
    return [];
  }
}

async function getFromComando(titles, meta, imdbId) {
  let candidates = [];
  for (const t of titles) {
    const posts = await searchComando(t);
    candidates = pickComandoCandidates(posts, titles, meta.year);
    if (candidates.length > 0) break;
  }

  for (const postUrl of candidates.slice(0, 3)) {
    console.log(`[Comando] Testando post: ${postUrl}`);
    const items = await extractComandoMagnets(postUrl, imdbId);
    if (items.length > 0) return items;
  }
  return [];
}

// =====================================================================
// Verificação de seeds (scrape UDP nos trackers)
// =====================================================================

// SCRAPE_START
const SEED_CHECK = process.env.SEED_CHECK !== 'false';   // SEED_CHECK=false desliga
const HIDE_DEAD = process.env.HIDE_DEAD !== 'false';    // links com 0 seeds são escondidos (HIDE_DEAD=false mostra)
const SCRAPE_TIMEOUT = 3000;

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.stealth.si:80/announce'
];

function extractTrackers(magnetUrl) {
  const out = [];
  const query = magnetUrl.slice(magnetUrl.indexOf('?') + 1);
  for (const part of query.split('&')) {
    if (part.startsWith('tr=')) out.push(safeDecode(part.slice(3)));
  }
  return out;
}

function udpScrape(trackerUrl, hashHex, timeoutMs = SCRAPE_TIMEOUT) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(trackerUrl);
    } catch (e) {
      return resolve(null);
    }
    if (u.protocol !== 'udp:' || !u.hostname || !u.port) return resolve(null);

    const port = Number(u.port);
    const host = u.hostname;
    const connTx = crypto.randomBytes(4);
    const scrapeTx = crypto.randomBytes(4);
    const socket = dgram.createSocket('udp4');
    let done = false;
    let timer = null;

    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* ignore */ }
      resolve(val);
    };

    timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));

    socket.on('message', (msg) => {
      if (msg.length < 8) return;
      const action = msg.readUInt32BE(0);
      const tx = msg.subarray(4, 8);

      if (action === 0 && tx.equals(connTx) && msg.length >= 16) {
        const connId = msg.subarray(8, 16);
        const act = Buffer.alloc(4);
        act.writeUInt32BE(2, 0);
        const req = Buffer.concat([connId, act, scrapeTx, Buffer.from(hashHex, 'hex')]);
        socket.send(req, port, host, (err) => { if (err) finish(null); });
      } else if (action === 2 && tx.equals(scrapeTx) && msg.length >= 20) {
        finish({ seeders: msg.readUInt32BE(8), leechers: msg.readUInt32BE(16) });
      } else if (action === 3) {
        finish(null);
      }
    });

    // connect request: protocol_id (0x41727101980) + action 0 + transaction_id
    const connReq = Buffer.alloc(16);
    connReq.writeUInt32BE(0x417, 0);
    connReq.writeUInt32BE(0x27101980, 4);
    connReq.writeUInt32BE(0, 8);
    connTx.copy(connReq, 12);
    socket.send(connReq, port, host, (err) => { if (err) finish(null); });
  });
}

const seedCache = new Map();
const SEED_CACHE_TTL = 10 * 60 * 1000;

// Retorna o maior número de seeds encontrado, ou null se nenhum tracker respondeu
async function getSeeders(hash, magnetUrl) {
  if (!hash || hash.length !== 40) return null;

  const cached = seedCache.get(hash);
  if (cached && Date.now() - cached.at < SEED_CACHE_TTL) return cached.seeds;

  const fromMagnet = extractTrackers(magnetUrl).filter((t) => t.startsWith('udp://')).slice(0, 3);
  const list = [...new Set([...fromMagnet, ...DEFAULT_TRACKERS])].slice(0, 6);

  const results = await Promise.all(list.map((t) => udpScrape(t, hash)));
  const ok = results.filter(Boolean);
  const seeds = ok.length ? Math.max(...ok.map((r) => r.seeders)) : null;

  seedCache.set(hash, { seeds, at: Date.now() });
  return seeds;
}
// SCRAPE_END

// =====================================================================
// Fontes: cada uma vira um addon separado, com o nome da própria fonte
// =====================================================================

const SOURCES = [
  { key: 'starck', name: STARCK_NAME, fetch: (titles, meta) => getFromStarck(titles, meta) },
  { key: 'starcknet', name: STARCKNET_NAME, fetch: (titles, meta, imdbId) => getFromStarckNet(titles, meta, imdbId) },
  { key: 'comando', name: COMANDO_NAME, fetch: (titles, meta, imdbId) => getFromComando(titles, meta, imdbId) }
];

function buildManifest(src) {
  return {
    id: `org.netcine.${src.key}`,
    version: '2.0.0',
    name: src.name,
    description: `Links magnet de filmes em Dual Áudio (${src.name})`,
    resources: ['stream'],
    types: ['movie'],
    idPrefixes: ['tt'],
    catalogs: []
  };
}

const manifests = {};
for (const src of SOURCES) manifests[src.key] = buildManifest(src);

// Cache do TMDB (os 3 addons pedem o mesmo filme ao mesmo tempo)
const metaCache = new Map();
function getMeta(imdbId) {
  const c = metaCache.get(imdbId);
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c.promise;
  const promise = getTmdbMovie(imdbId);
  metaCache.set(imdbId, { promise, at: Date.now() });
  promise.then((m) => { if (!m) metaCache.delete(imdbId); });
  return promise;
}

const resultCache = new Map();
const RESULT_CACHE_TTL = 10 * 60 * 1000;

async function handleStream(src, imdbId) {
  console.log(`[${src.name}] Solicitação de stream para ${imdbId}`);

  const cacheKey = `${src.key}:${imdbId}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESULT_CACHE_TTL) return cached.data;

  const meta = await getMeta(imdbId);
  if (!meta) {
    console.log(`[${src.name}] Filme não encontrado no TMDB para o ID: ${imdbId}`);
    return { streams: [] };
  }

  const titles = [meta.title, meta.originalTitle].filter(Boolean);

  let items = [];
  try {
    items = await src.fetch(titles, meta, imdbId);
  } catch (err) {
    console.error(`[${src.name}] Erro inesperado:`, err.message);
  }

  // Remover duplicados por hash
  const unique = [];
  const seenHashes = new Set();
  for (const item of items) {
    if (!seenHashes.has(item.hash)) {
      seenHashes.add(item.hash);
      unique.push(item);
    }
  }

  // Verifica seeds em paralelo e marca no título de cada link
  if (SEED_CHECK) {
    await Promise.all(unique.map(async (item) => {
      try {
        item.seeds = await getSeeders(item.hash, item.stream.externalUrl);
      } catch (e) {
        item.seeds = null;
      }
      const lines = item.stream.title.split('\n');
      if (item.seeds === 0) lines[0] += '  ·  ⚠️ 0 seeds';
      else if (item.seeds > 0) lines[0] += `  ·  🌱 ${item.seeds} seeds`;
      item.stream.title = lines.join('\n');
    }));
  }

  let finalItems = unique;
  if (SEED_CHECK && HIDE_DEAD) finalItems = unique.filter((i) => i.seeds !== 0);

  // Ordenar: sem seeds por último, depois resolução (2160p > 1080p > ...) e mais seeds
  const deadFlag = (i) => (i.seeds === 0 ? 1 : 0);
  finalItems.sort((a, b) => {
    if (deadFlag(a) !== deadFlag(b)) return deadFlag(a) - deadFlag(b);
    if (a.resRank !== b.resRank) return b.resRank - a.resRank;
    return (b.seeds || 0) - (a.seeds || 0);
  });

  // Nome em negrito: Título do filme em PT-BR | qualidade
  const streams = finalItems.map((item) => {
    item.stream.name = `${meta.title}${item.res ? ' | ' + item.res : ''}`;
    return item.stream;
  });

  console.log(`[${src.name}] Retornando ${streams.length} streams para ${imdbId}`);

  const data = { streams };
  if (streams.length > 0) resultCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

// =====================================================================
// Servidor HTTP (protocolo de addon do Stremio / Nuvio)
// =====================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

function sendJson(res, status, obj) {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function landingPage(req) {
  const host = req.headers.host || 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const rows = SOURCES.map((s) => (
    `<p><b>${esc(s.name)}</b><br>`
    + `<a href="stremio://${esc(host)}/${s.key}/manifest.json">Instalar</a> · `
    + `<code>${esc(proto)}://${esc(host)}/${s.key}/manifest.json</code></p>`
  )).join('');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Victor / NetStream</title>'
    + '<body style="font-family:sans-serif;max-width:640px;margin:24px auto;padding:0 16px;word-break:break-all">'
    + '<h2>Victor / NetStream</h2><p>Instale cada fonte como um addon separado:</p>'
    + rows + '</body>';
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/') {
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(landingPage(req));
    }

    const m = pathname.match(/^\/([a-z0-9]+)(\/.*)?$/);
    const src = m && SOURCES.find((s) => s.key === m[1]);
    if (!src) return sendJson(res, 404, { error: 'Not found' });

    const rest = m[2] || '/';

    if (rest === '/manifest.json') return sendJson(res, 200, manifests[src.key]);

    const sm = rest.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
    if (sm) {
      const type = decodeURIComponent(sm[1]);
      const id = decodeURIComponent(sm[2]);
      if (type !== 'movie') return sendJson(res, 200, { streams: [] });
      return sendJson(res, 200, await handleStream(src, id));
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[NetCine] Erro na requisição:', err.message);
    return sendJson(res, 500, { streams: [] });
  }
});

const PORT = process.env.PORT || 7000;

server.listen(PORT, () => {
  console.log(`[NetCine] Addons rodando na porta ${PORT}: ${SOURCES.map((s) => '/' + s.key).join(', ')}`);
});
