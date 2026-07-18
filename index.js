const express = require('express');
const fetch   = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const crypto  = require('crypto');
const PORT = process.env.PORT || 3000;

// Gera chave de cache a partir de hash de verdade — evita colisão entre URLs
// quase idênticas (ex: "...DUB-BAIXO.php" vs "...LEG-BAIXO.php" só divergem no
// final, e um truncamento de base64 cru podia gerar a MESMA chave pras duas).
function cacheKeyFor(url) {
    return crypto.createHash('sha1').update(url).digest('hex');
}

// ── Playwright: resolve players que só entregam o link real via JS ──
// (usado quando a API/HTML não expõe o master.txt diretamente — ex: embedplayer2.xyz)
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* opcional */ }
let _browserPromise = null;
async function getBrowser() {
    if (!chromium) throw new Error('playwright não instalado');
    if (!_browserPromise) {
        _browserPromise = chromium.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }).catch(e => { _browserPromise = null; throw e; });
    }
    return _browserPromise;
}

// Abre pageUrl num navegador real e captura a 1ª requisição de rede que bater no padrão
// (por padrão, qualquer master.txt/m3u8) — funciona mesmo se o JS mudar amanhã,
// porque a gente não lê o código, só observa o que ele realmente pede pra rede.
async function resolveViaPlaywright(pageUrl, matchPattern = /master\.txt(\?|$)|\.m3u8(\?|$)/i, timeoutMs = 15000, clickSelectors = []) {
    let browser;
    try { browser = await getBrowser(); }
    catch (e) { console.log('[Playwright] Indisponível:', e.message); return null; }

    const context = await browser.newContext({ userAgent: UA });
    const page    = await context.newPage();
    let found     = null;

    page.on('request', req => {
        const u = req.url();
        if (!found && matchPattern.test(u)) found = u;
    });

    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

        // Alguns players (ex: Clappr com poster) só carregam o stream depois
        // de um clique manual — tenta clicar no botão de play, se existir.
        for (const sel of clickSelectors) {
            try {
                await page.click(sel, { timeout: 2500 });
                console.log('[Playwright] Cliquei em:', sel);
                break;
            } catch { /* seletor não achado, tenta o próximo */ }
        }

        const start = Date.now();
        while (!found && Date.now() - start < timeoutMs) await page.waitForTimeout(300);
    } catch (e) {
        console.log('[Playwright] Erro navegando', pageUrl, '-', e.message);
    } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
    }

    console.log(found ? `[Playwright] Achou: ${found.slice(0, 100)}` : `[Playwright] Nada encontrado em ${pageUrl.slice(0,80)}`);
    return found;
}

const app      = express();
const TMDB_KEY = 'd8e8e85d692358d3b5db2cfd08487457';
const BASE     = 'https://eee1.lat';
const UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ── Proxy residencial ─────────────────────────────────────────
const PROXY_URL  = process.env.PROXY_URL || '';
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
if (!PROXY_URL) console.warn('[Proxy] PROXY_URL não definido — requisições sairão sem proxy residencial');
if (PROXY_URL) console.log('[Proxy] Usando proxy residencial (via PROXY_URL)');

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// ── Caches ────────────────────────────────────────────────────
const _streamCache = new Map();   // imdbId → { streams, ts }
const _m3u8Cache   = new Map();   // key     → { text, base, ts }
const _segCache    = new Map();   // url     → Buffer

const STREAM_TTL = 5 * 60 * 1000;   // 5 min
const M3U8_TTL   = 8 * 60 * 1000;   // 8 min
const SEG_MAX    = 40;               // max segmentos em memória

function _cleanCaches() {
    const now = Date.now();
    for (const [k, v] of _streamCache) if (now - v.ts > STREAM_TTL) _streamCache.delete(k);
    for (const [k, v] of _m3u8Cache)   if (now - v.ts > M3U8_TTL)   _m3u8Cache.delete(k);
    if (_segCache.size > SEG_MAX) {
        const oldest = [..._segCache.keys()].slice(0, 10);
        oldest.forEach(k => _segCache.delete(k));
    }
}
setInterval(_cleanCaches, 2 * 60 * 1000);

// ── Manifest ──────────────────────────────────────────────────
const MANIFEST = {
    id: 'br.netcine.stremio', version: '1.2.0',
    name: 'NetCine', description: 'Streams HLS do NetCine. Dublado e Legendado. + TV ao vivo.',
    logo: 'https://eee1.lat/favicon.ico',
    resources: ['stream', 'catalog', 'meta'],
    types: ['movie', 'series', 'tv'],
    idPrefixes: ['tt', 'tv_'],
    catalogs: [
        { type: 'tv', id: 'embedcanais_tv', name: 'TV ao vivo',
          extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }] }
    ]
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));
app.get('/', (req, res) => res.json({ name: 'NetCine Addon', status: 'online' }));

// ── Sessão HTTP com cookies ───────────────────────────────────
let _cookies = '';

async function _get(url, extraHeaders = {}) {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8', ...extraHeaders };
    if (_cookies) headers['Cookie'] = _cookies;
    const useProxy = url.includes('eee1.lat') || url.includes('embedplayer') || url.includes('my-pictures');
    const r = await fetch(url, { headers, redirect: 'follow', ...(useProxy ? { agent: proxyAgent } : {}) });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = sc.match(/PHPSESSID=([^;]+)/); if (m) _cookies = 'PHPSESSID=' + m[1]; }
    return r.text();
}

async function _getJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    return r.json();
}

// ── Host atual ────────────────────────────────────────────────
let _host = '';
async function getHost() {
    if (_host) return _host;
    try {
        const r = await fetch(BASE, { redirect: 'follow', headers: { 'User-Agent': UA }, agent: proxyAgent });
        _host = r.url.replace(/\/$/, '') + '/';
    } catch { _host = BASE + '/'; }
    console.log('[NetCine] Host:', _host);
    return _host;
}

// ── TMDB: IMDB ID → título + ano ─────────────────────────────
async function getTmdbInfo(imdbId, tipo) {
    try {
        const d = await _getJson(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=pt-BR`);
        const results = tipo === 'movie' ? (d.movie_results||[]) : (d.tv_results||[]);
        if (!results.length) { console.log('[NetCine] TMDB sem resultado para', imdbId); return null; }
        const item = results[0];
        return {
            titulo:   item.title || item.name || '',
            original: item.original_title || item.original_name || '',
            ano:      (item.release_date || item.first_air_date || '').slice(0, 4)
        };
    } catch(e) { console.log('[NetCine] TMDB erro:', e.message); return null; }
}

// ── Normalização ──────────────────────────────────────────────
function norm(t) {
    return (t||'').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
        .replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
}
function similar(a, b) {
    a = norm(a); b = norm(b);
    if (!a||!b) return false;
    const s = b.slice(0, Math.max(5, b.length-2));
    return a.startsWith(s) || b.startsWith(norm(a).slice(0, Math.max(5, a.length-2)));
}

// ── Busca no site ─────────────────────────────────────────────
async function buscar(host, titulo, ano, isSerie) {
    const q   = encodeURIComponent(titulo.replace(/[:\-—]/g,' ').trim());
    const url = host + 'search/' + q + '/';
    console.log('[NetCine] Buscando:', url);
    const html = await _get(url, { Referer: host });

    const blocoRe = /<div class="movie[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g;
    let m;
    while ((m = blocoRe.exec(html)) !== null) {
        const b = m[1];
        const hrefM = b.match(/class="imagen"[\s\S]*?<a[^>]+href="([^"]+)"/);
        if (!hrefM) continue;
        const href = hrefM[1];
        if ((href.includes('/tvshows/')) !== isSerie) continue;
        if (ano) {
            const anoM = b.match(/<span class="year">(\d{4})<\/span>/);
            if (anoM && Math.abs(parseInt(anoM[1]) - parseInt(ano)) > 1) continue;
        }
        const h2M = b.match(/<h2[^>]*>([^<]+)<\/h2>/);
        if (h2M) {
            const tp = h2M[1].replace(/\s*(dublado|legendado|hd|4k|1080p|720p)\b.*/i,'').trim();
            if (!similar(tp, titulo)) { console.log('[NetCine] Rejeitado:', tp, 'vs', titulo); continue; }
        }
        const pageUrl = new URL(href, host).href;
        console.log('[NetCine] Encontrado:', pageUrl);
        return pageUrl;
    }
    console.log('[NetCine] Não encontrado:', titulo);
    return null;
}

// ── Extrai players ────────────────────────────────────────────
async function getPlayers(pageUrl, host) {
    const html = await _get(pageUrl, { Referer: host });
    const players = [];
    const tabRe = /<li[^>]*>\s*<a[^>]+href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let t;
    while ((t = tabRe.exec(html)) !== null) {
        const tabId   = t[1];
        const tabText = t[2].replace(/<[^>]+>/g,'').toUpperCase();
        const ifrRe   = new RegExp('id="'+tabId+'"[\\s\\S]*?<iframe[^>]+src="([^"]+)"','i');
        const ifrM    = ifrRe.exec(html);
        if (!ifrM) continue;
        let src = ifrM[1].replace(/&amp;/g,'&').trim();
        if (src.startsWith('//')) src = 'https:' + src;
        else if (!src.startsWith('http')) src = new URL(src, pageUrl).href;
        // "Áudio Original" é LEGENDADO (inglês + legenda), não Dublado — mesmo contendo
        // a palavra "áudio". Só marca DUBLADO se disser isso explicitamente E não houver
        // sinal de legendado/original junto (evita o falso positivo de "UDIO" em "ÁUDIO").
        const dizLegendado = /LEGEND|ORIGINAL|\bSUB\b|SUBTITLE/.test(tabText);
        const dizDublado   = /DUBLAD|\bDUB\b/.test(tabText);
        const lang = (dizDublado && !dizLegendado) ? 'DUBLADO' : 'LEGENDADO';
        console.log('[NetCine] Player:', lang, '(aba: "'+tabText.slice(0,40)+'")', src.slice(0,60));
        players.push({ lang, src });
    }
    return players;
}

// ── Resolve iframe → m3u8 ────────────────────────────────────
async function resolvePlayer(iframeUrl) {
    const origin = new URL(iframeUrl).origin;
    const qs     = Object.fromEntries(new URL(iframeUrl).searchParams);
    let fetchUrl = iframeUrl;

    if (/hlsarchive\.php|nv32\.php/.test(iframeUrl) && qs.n && qs.p)
        fetchUrl = `${origin}/media-player/hls/hls.php?n=${qs.n}&p=${qs.p}`;
    else if (/nv32mono\.php|mono\.php/.test(iframeUrl) && qs.n && qs.p)
        fetchUrl = `${origin}/media-player/dist/playermono.php?n=${qs.n}&p=${qs.p}`;

    const hlsHeaders = { Referer: origin+'/', Origin: origin, 'User-Agent': UA };
    console.log('[NetCine] Resolvendo player:', fetchUrl.slice(0,70));

    try {
        const html = await _get(fetchUrl, { Referer: origin+'/', Origin: origin });

        let m3u8 = null;

        // 1. <source type="application/x-mpegURL">
        let m = html.match(/<source[^>]+type="application\/x-mpegURL"[^>]+src="([^"]+)"/i)
             || html.match(/<source[^>]+src="([^"]+)"[^>]+type="application\/x-mpegURL"/i);
        if (m) m3u8 = m[1];

        // 2. Variável JS: file:"..." ou src:"..."
        if (!m3u8) {
            const jsM = html.match(/(?:file|src)\s*:\s*["']([^"']+(?:\.m3u8|token=)[^"']*)["']/i);
            if (jsM) m3u8 = jsM[1];
        }

        // 3. <source src="...php?token=...">
        if (!m3u8) {
            const tokM = html.match(/<source[^>]+src="([^"]+token=[^"]+)"/i);
            if (tokM) m3u8 = tokM[1];
        }

        // 4. Fallback: segue redirect do playerhls.php
        if (!m3u8 && qs.n && qs.p) {
            const fbUrl = `${origin}/media-player/dist/playerhls.php?n=${qs.n}&p=${qs.p}`;
            const r = await fetch(fbUrl, { headers: hlsHeaders, redirect: 'follow', agent: proxyAgent });
            const finalUrl = r.url;
            const body = await r.text();
            if (body.trim().startsWith('#EXTM3U'))
                return { url: finalUrl, headers: hlsHeaders, rawM3u8: body };
            if (finalUrl !== fbUrl) m3u8 = finalUrl;
        }

        if (m3u8) {
            if (m3u8.startsWith('//')) m3u8 = 'https:' + m3u8;
            else if (!m3u8.startsWith('http')) m3u8 = new URL(m3u8, fetchUrl).href;
            const r2 = await fetch(m3u8, { headers: hlsHeaders, redirect: 'follow', agent: proxyAgent });
            const finalUrl = r2.url;
            const body2 = await r2.text();
            console.log('[NetCine] HLS final:', finalUrl.slice(0,80));
            if (body2.trim().startsWith('#EXTM3U'))
                return { url: finalUrl, headers: hlsHeaders, rawM3u8: body2 };
            return { url: finalUrl, headers: hlsHeaders };
        }

        console.log('[NetCine] Player não resolvido. Snippet:', html.slice(0,200));
    } catch(e) { console.log('[NetCine] Erro resolve:', e.message); }
    return null;
}

// ── Reescreve um m3u8 pra tudo (segmentos, áudio, variantes) passar pelo proxy ──
async function buildProxiedM3U8(text, baseUrl, selfBase, segAcc = null, depth = 0) {
    const base   = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    const origin = new URL(baseUrl).origin;
    const resolve = t => {
        if (t.startsWith('http')) return t;
        if (t.startsWith('/'))    return origin + t;   // root-relative (ex: /m3/xxx)
        return base + t;                                // relativo à pasta do playlist
    };

    const lines = text.split('\n');
    const out = await Promise.all(lines.map(async line => {
        const t = line.trim();
        if (!t) return line;

        // Tags com URI="..." — mas nem toda tag com URI é um playlist de texto!
        // EXT-X-MEDIA (áudio/legenda) É texto → proxy recursivo como playlist.
        // EXT-X-MAP (init segment fMP4) e EXT-X-KEY (chave de criptografia) são
        // BINÁRIOS — se forem tratados como texto aqui, os bytes ficam corrompidos.
        const uriMatch  = t.match(/URI="([^"]+)"/);
        const isBinaryTag = /^#EXT-X-(MAP|KEY|SESSION-KEY)\b/i.test(t);

        if (t.startsWith('#') && uriMatch && isBinaryTag) {
            const abs = resolve(uriMatch[1]);
            return line.replace(uriMatch[1], `${selfBase}/proxy/seg?url=${encodeURIComponent(abs)}`);
        }
        if (t.startsWith('#') && uriMatch && depth < 3) {
            const abs = resolve(uriMatch[1]);
            const key = await fetchAndCacheSubPlaylist(abs, selfBase, depth + 1);
            if (key) return line.replace(uriMatch[1], `${selfBase}/proxy/playlist?key=${key}`);
            return line;
        }
        if (t.startsWith('#')) return line;

        const abs = resolve(t);
        // Se a linha aponta pra outro .m3u8 (variante de bitrate), também precisa
        // ser proxied como playlist, não como segmento de vídeo.
        if (/\.m3u8(\?|$)/i.test(abs) && depth < 3) {
            const key = await fetchAndCacheSubPlaylist(abs, selfBase, depth + 1);
            if (key) return `${selfBase}/proxy/playlist?key=${key}`;
        }
        if (segAcc) segAcc.push(abs);
        return `${selfBase}/proxy/seg?url=${encodeURIComponent(abs)}`;
    }));

    return out.join('\n');
}

async function fetchAndCacheSubPlaylist(absUrl, selfBase, depth) {
    try {
        const r = await withTimeout(fetch(absUrl, { headers: { 'User-Agent': UA }, agent: proxyAgent }), 8000);
        const body = await r.text();
        const rewritten = await buildProxiedM3U8(body, absUrl, selfBase, null, depth);
        const key = cacheKeyFor(absUrl) + '_' + depth;
        _m3u8Cache.set(key, { text: rewritten, base: absUrl, ts: Date.now(), preRendered: true });
        return key;
    } catch (e) {
        console.log('[Proxy] Falha sub-playlist:', absUrl.slice(0, 80), '-', e.message);
        return null;
    }
}

// ── Prefetch dos primeiros N segmentos ───────────────────────
function prefetchSegmentos(segUrls, n = 3) {
    segUrls.slice(0, n).forEach(url => {
        if (_segCache.has(url)) return;
        fetch(url, {
            headers: { 'User-Agent': UA, Referer: new URL(url).origin + '/' },
            redirect: 'follow', agent: proxyAgent
        }).then(r => {
            if (!r.ok) return;
            return r.buffer();
        }).then(buf => {
            if (buf) _segCache.set(url, buf);
        }).catch(() => {});
    });
}

// ── Proxy: playlist m3u8 ─────────────────────────────────────
app.get('/proxy/playlist', async (req, res) => {
    const { key } = req.query;
    const selfBase = req.protocol + '://' + req.get('host');

    if (key && _m3u8Cache.has(key)) {
        const cached = _m3u8Cache.get(key);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');

        if (cached.preRendered) return res.send(cached.text);

        const segUrls = [];
        const m3u8 = await buildProxiedM3U8(cached.text, cached.base, selfBase, segUrls);
        prefetchSegmentos(segUrls, 3);
        return res.send(m3u8);
    }

    res.status(404).send('playlist não encontrada');
});

// ── Proxy: segmento (vídeo, áudio, init fMP4, legenda, chave) ──
function contentTypeFor(url) {
    const u = url.split('?')[0].toLowerCase();
    if (u.endsWith('.m3u8'))         return 'application/vnd.apple.mpegurl';
    if (u.endsWith('.mp4') || u.endsWith('.m4s') || u.endsWith('.m4v'))
                                       return 'video/mp4';
    if (u.endsWith('.m4a'))          return 'audio/mp4';
    if (u.endsWith('.vtt'))          return 'text/vtt';
    if (u.endsWith('.key') || u.endsWith('.bin')) return 'application/octet-stream';
    return 'video/mp2t'; // .ts e fallback
}

app.get('/proxy/seg', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('missing url');
    const decodedUrl = decodeURIComponent(url);
    const ctype       = contentTypeFor(decodedUrl);
    const rangeHeader = req.headers.range; // ex: "bytes=0-1023"

    res.setHeader('Content-Type', ctype);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes'); // ExoPlayer costuma exigir isso pra aceitar seek

    const sendWithRange = (buf) => {
        if (!rangeHeader) return res.send(buf);
        const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!m) return res.send(buf);
        const total = buf.length;
        let start = m[1] ? parseInt(m[1]) : 0;
        let end   = m[2] ? parseInt(m[2]) : total - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end) return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', end - start + 1);
        return res.send(buf.slice(start, end + 1));
    };

    // Serve do cache se disponível
    if (_segCache.has(decodedUrl)) {
        return sendWithRange(_segCache.get(decodedUrl));
    }

    try {
        const segOrigin = new URL(decodedUrl).origin;
        const r = await fetch(decodedUrl, {
            headers: { 'User-Agent': UA, Referer: segOrigin + '/' },
            redirect: 'follow', agent: proxyAgent
        });
        if (!r.ok) {
            console.log('[NetCine] Seg erro %d:', r.status, decodedUrl.slice(0,80));
            return res.status(r.status).send('upstream error');
        }
        // Buffer + serve + salva no cache
        const buf = await r.buffer();
        _segCache.set(decodedUrl, buf);
        sendWithRange(buf);
    } catch(e) {
        console.log('[NetCine] Proxy seg erro:', e.message);
        res.status(500).send('erro');
    }
});


// ── EmbedPlayer: fonte secundária via GStream API ────────────
const EMBED_BASE = 'https://embed.embedplayer.site/';
const EMBED_API  = 'https://embed.embedplayer.site/stream';

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
}

async function embedGetUrl(imdbId, tituloEsperado, tituloOriginal) {
    const embedUrl = EMBED_BASE + imdbId + '/';
    console.log('[Embed] Buscando:', embedUrl);

    const html = await withTimeout(
        fetch(embedUrl, {
            headers: { 'User-Agent': UA, Referer: 'https://embed.embedplayer.site/' },
            redirect: 'follow'
        }).then(r => r.text()),
        6000
    );

    // Confere se o título da página bate com o filme/série que a gente pediu —
    // evita confiar cegamente na URL por ID caso o site devolva conteúdo errado/genérico
    // pra um ID que não existe de fato no catálogo dele.
    if (tituloEsperado) {
        const tituloPagina =
            (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]) ||
            (html.match(/<title>([^<]+)<\/title>/i)?.[1]) || '';

        if (tituloPagina) {
            const bate = similar(tituloPagina, tituloEsperado) ||
                         (tituloOriginal && similar(tituloPagina, tituloOriginal));
            if (!bate) {
                console.log('[Embed] Título não bate ("' + tituloPagina.slice(0,60) + '" vs "' + tituloEsperado + '") — ignorando fonte');
                return [];
            }
        }
    }

    // Extrai idS de cada idioma
    const ids  = {};
    const re   = /class="players_select_items[^"]*"\s+lang="([^"]+)"[\s\S]*?idS="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) ids[m[1]] = m[2];

    if (!Object.keys(ids).length) {
        console.log('[Embed] Nenhum idS encontrado para', imdbId);
        return [];
    }

    // Chama API GStream para cada idioma com timeout individual
    const streams = [];
    for (const [lang, idS] of Object.entries(ids)) {
        try {
            const data = await withTimeout(
                fetch(EMBED_API, {
                    method:  'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent':   UA,
                        'Referer':      embedUrl,
                        'Origin':       'https://embed.embedplayer.site'
                    },
                    body: 'idS=' + encodeURIComponent(idS) + '&ref='
                }).then(r => r.json()),
                5000
            );

            if (data.break) { console.log('[Embed] break lang=' + lang + ':', data.message); continue; }

            const url = data?.resources?.sources?.[0]?.file || '';
            if (!url) { console.log('[Embed] Sem URL para lang=' + lang); continue; }

            console.log('[Embed] OK lang=' + lang + ':', url.slice(0, 80));
            streams.push({
                lang,
                url,
                title: lang === 'dub' ? '\uD83C\uDDE7\uD83C\uDDF7 [EP] Dublado' : '\uD83C\uDFAC [EP] Legendado'
            });
        } catch (e) {
            console.log('[Embed] Erro lang=' + lang + ':', e.message);
        }
    }
    return streams;
}

// ── Endpoint streams ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
// ── TV ao vivo (embedcanaisdetv.xyz) ────────────────────────────
// ══════════════════════════════════════════════════════════════
const CANAIS_BASE = 'https://embedcanaisdetv.xyz/e/index.php?canal=';

const TV_CHANNELS = [
    { id: 'tv_amazonprimevideo', slug: 'amazonprimevideo', name: 'Amazon Prime', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/amazonprimevideo.png' },
    { id: 'tv_amazonprimevideo02', slug: 'amazonprimevideo02', name: 'Amazon Prime 02', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/amazonprimevideo.png' },
    { id: 'tv_amazonprimevideo03', slug: 'amazonprimevideo03', name: 'Amazon Prime 03', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/amazonprimevideo.png' },
    { id: 'tv_amazonprimevideo04', slug: 'amazonprimevideo04', name: 'Amazon Prime 04', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/amazonprimevideo.png' },
    { id: 'tv_amazonprimevideo05', slug: 'amazonprimevideo05', name: 'Amazon Prime 05', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/amazonprimevideo.png' },
    { id: 'tv_appletv01', slug: 'appletv01', name: 'Apple TV 01', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/appletv1.png' },
    { id: 'tv_appletv02', slug: 'appletv02', name: 'Apple TV 02', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/appletv1.png' },
    { id: 'tv_bandsports', slug: 'bandsports', name: 'Band Sports', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/bandsports.png' },
    { id: 'tv_canaloff', slug: 'canaloff', name: 'Canal Off', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/canaloff.png' },
    { id: 'tv_cazetv', slug: 'cazetv', name: 'CazéTV', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/cazetv.png' },
    { id: 'tv_combate', slug: 'combate', name: 'Combate', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/combate.png' },
    { id: 'tv_dazn', slug: 'dazn', name: 'DAZN', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/dazn.png' },
    { id: 'tv_disneyplus', slug: 'disneyplus', name: 'Disney+', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/disneyplus.png' },
    { id: 'tv_disneyplus02', slug: 'disneyplus02', name: 'Disney+ 02', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/disneyplus.png' },
    { id: 'tv_disneyplus03', slug: 'disneyplus03', name: 'Disney+ 03', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/disneyplus.png' },
    { id: 'tv_disneyplus04', slug: 'disneyplus04', name: 'Disney+ 04', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/disneyplus.png' },
    { id: 'tv_disneyplus05', slug: 'disneyplus05', name: 'Disney+ 05', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/disneyplus.png' },
    { id: 'tv_disneyplus06', slug: 'disneyplus06', name: 'Disney+ 06', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/disneyplus.png' },
    { id: 'tv_espn', slug: 'espn', name: 'ESPN', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/espn.png' },
    { id: 'tv_espn2', slug: 'espn2', name: 'ESPN 2', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/espn.png' },
    { id: 'tv_espn3', slug: 'espn3', name: 'ESPN 3', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/espn.png' },
    { id: 'tv_espn4', slug: 'espn4', name: 'ESPN 4', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/espn.png' },
    { id: 'tv_espn5', slug: 'espn5', name: 'ESPN 5', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/espn.png' },
    { id: 'tv_espn6', slug: 'espn6', name: 'ESPN 6', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/espn.png' },
    { id: 'tv_getv', slug: 'getv', name: 'GE TV', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/getv.png' },
    { id: 'tv_max', slug: 'max', name: 'Max', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/max.png' },
    { id: 'tv_max02', slug: 'max02', name: 'Max 02', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/max.png' },
    { id: 'tv_max03', slug: 'max03', name: 'Max 03', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/max.png' },
    { id: 'tv_max04', slug: 'max04', name: 'Max 04', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/max.png' },
    { id: 'tv_max05', slug: 'max05', name: 'Max 05', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/max.png' },
    { id: 'tv_max06', slug: 'max06', name: 'Max 06', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/max.png' },
    { id: 'tv_nossofutebol', slug: 'nossofutebol', name: 'Nosso Futebol', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/nossofutebol.png' },
    { id: 'tv_nsports', slug: 'nsports', name: 'N Sports', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/nsports.png' },
    { id: 'tv_paramountplus', slug: 'paramountplus', name: 'Paramount +', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/paramountplus.png' },
    { id: 'tv_paramountplus02', slug: 'paramountplus02', name: 'Paramount + 02', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/paramountplus.png' },
    { id: 'tv_premiereclubes', slug: 'premiereclubes', name: 'Premiere Clubes', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_premiere2', slug: 'premiere2', name: 'Premiere 2', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_premiere3', slug: 'premiere3', name: 'Premiere 3', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_premiere4', slug: 'premiere4', name: 'Premiere 4', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_premiere5', slug: 'premiere5', name: 'Premiere 5', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_premiere6', slug: 'premiere6', name: 'Premiere 6', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_premiere7', slug: 'premiere7', name: 'Premiere 7', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_premiere8', slug: 'premiere8', name: 'Premiere 8', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/premiere.png' },
    { id: 'tv_sportv', slug: 'sportv', name: 'SporTV', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/sportv.png' },
    { id: 'tv_sportv2', slug: 'sportv2', name: 'SporTV 2', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/sportv2.png' },
    { id: 'tv_sportv3', slug: 'sportv3', name: 'SporTV 3', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/sportv3.png' },
    { id: 'tv_tnt', slug: 'tnt', name: 'TNT', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/tnt.png' },
    { id: 'tv_xsports', slug: 'xsports', name: 'Xsports', category: 'Esportes', logo: 'https://1.embedcanaisdetv.com/images/xsports.png' },
    { id: 'tv_casadopatrao01', slug: 'casadopatrao01', name: 'Casa do Patrao 01', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_casadopatrao02', slug: 'casadopatrao02', name: 'Casa do Patrao 02', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_casadopatrao03', slug: 'casadopatrao03', name: 'Casa do Patrao 03', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_casadopatrao04', slug: 'casadopatrao04', name: 'Casa do Patrao 04', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_casadopatrao05', slug: 'casadopatrao05', name: 'Casa do Patrao 05', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_casadopatrao06', slug: 'casadopatrao06', name: 'Casa do Patrao 06', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_casadopatrao07', slug: 'casadopatrao07', name: 'Casa do Patrao 07', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_casadopatrao08', slug: 'casadopatrao08', name: 'Casa do Patrao 08', category: 'Reality Show', logo: 'https://1.embedcanaisdetv.com/images/casadopatrao.jpg' },
    { id: 'tv_aee', slug: 'aee', name: 'A&E', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/aee.png' },
    { id: 'tv_amc', slug: 'amc', name: 'AMC', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/amc.png' },
    { id: 'tv_axn', slug: 'axn', name: 'AXN', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/axn.png' },
    { id: 'tv_cinemax', slug: 'cinemax', name: 'Cinemax', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/cinemax.png' },
    { id: 'tv_globoplaynovelas', slug: 'globoplaynovelas', name: 'Globoplay Novelas', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/globoplaynovelas.png' },
    { id: 'tv_hbo', slug: 'hbo', name: 'HBO', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hbo.png' },
    { id: 'tv_hbo2', slug: 'hbo2', name: 'HBO 2', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hbo2.png' },
    { id: 'tv_hbofamily', slug: 'hbofamily', name: 'HBO Family', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hbofamily.png' },
    { id: 'tv_hbomundi', slug: 'hbomundi', name: 'HBO Mundi', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hbomundi.png' },
    { id: 'tv_hboplus', slug: 'hboplus', name: 'HBO Plus', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hboplus.png' },
    { id: 'tv_hbopop', slug: 'hbopop', name: 'HBO Pop', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hbopop.png' },
    { id: 'tv_hbosignature', slug: 'hbosignature', name: 'HBO Signature', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hbosignature.png' },
    { id: 'tv_hboxtreme', slug: 'hboxtreme', name: 'HBO Xtreme', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/hboxtreme.png' },
    { id: 'tv_megapix', slug: 'megapix', name: 'Megapix', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/megapix.png' },
    { id: 'tv_paramountnetwork', slug: 'paramountnetwork', name: 'Paramount Network', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/paramountnetwork.png' },
    { id: 'tv_sonychannel', slug: 'sonychannel', name: 'Sony Channel', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/sonychannel.png' },
    { id: 'tv_space', slug: 'space', name: 'Space', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/space.png' },
    { id: 'tv_studiouniversal', slug: 'studiouniversal', name: 'Studio Universal', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/studiouniversal.png' },
    { id: 'tv_tcaction', slug: 'tcaction', name: 'Telecine Action', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tcaction.png' },
    { id: 'tv_tccult', slug: 'tccult', name: 'Telecine Cult', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tccult.png' },
    { id: 'tv_tcfun', slug: 'tcfun', name: 'Telecine Fun', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tcfun.png' },
    { id: 'tv_tcpipoca', slug: 'tcpipoca', name: 'Telecine Pipoca', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tcpipoca.png' },
    { id: 'tv_tcpremium', slug: 'tcpremium', name: 'Telecine Premium', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tcpremium.png' },
    { id: 'tv_tctouch', slug: 'tctouch', name: 'Telecine Touch', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tctouch.png' },
    { id: 'tv_tnt', slug: 'tnt', name: 'TNT', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tnt.png' },
    { id: 'tv_tntnovelas', slug: 'tntnovelas', name: 'TNT Novelas', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tntnovelas.png' },
    { id: 'tv_tntseries', slug: 'tntseries', name: 'TNT Series', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/tntseries.png' },
    { id: 'tv_universaltv', slug: 'universaltv', name: 'Universal TV', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/universaltv.png' },
    { id: 'tv_warner', slug: 'warner', name: 'Warner Channel', category: 'Filmes e Séries', logo: 'https://1.embedcanaisdetv.com/images/warnertv.png' },
    { id: 'tv_bandsp', slug: 'bandsp', name: 'Band SP', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/bandsp.png' },
    { id: 'tv_globodf', slug: 'globodf', name: 'Globo DF', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/globo.webp' },
    { id: 'tv_globoes', slug: 'globoes', name: 'Globo Espírito Santo', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/globo.webp' },
    { id: 'tv_globomg', slug: 'globomg', name: 'Globo Minas', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/globo.webp' },
    { id: 'tv_globorj', slug: 'globorj', name: 'Globo Rio', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/globo.webp' },
    { id: 'tv_globors', slug: 'globors', name: 'Globo Porto Alegre', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/globo.webp' },
    { id: 'tv_globosp', slug: 'globosp', name: 'Globo São Paulo', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/globo.webp' },
    { id: 'tv_recorddf', slug: 'recorddf', name: 'Record DF', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/record.png' },
    { id: 'tv_recordes', slug: 'recordes', name: 'Record Espírito Santo', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/record.png' },
    { id: 'tv_recordmg', slug: 'recordmg', name: 'Record Minas', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/record.png' },
    { id: 'tv_recordrj', slug: 'recordrj', name: 'Record Rio', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/record.png' },
    { id: 'tv_recordsp', slug: 'recordsp', name: 'Record São Paulo', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/record.png' },
    { id: 'tv_redetv', slug: 'redetv', name: 'RedeTV!', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/redetv.png' },
    { id: 'tv_sbtrj', slug: 'sbtrj', name: 'SBT Rio', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/sbtsp.png' },
    { id: 'tv_sbtsp', slug: 'sbtsp', name: 'SBT São Paulo', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/sbtsp.png' },
    { id: 'tv_tvcultura', slug: 'tvcultura', name: 'TV Cultura', category: 'Canais Abertos', logo: 'https://1.embedcanaisdetv.com/images/tvcultura.png' },
    { id: 'tv_adultswim', slug: 'adultswim', name: 'Adult Swim', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/adultswim.png' },
    { id: 'tv_animalplanet', slug: 'animalplanet', name: 'Animal Planet', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/animalplanet.png' },
    { id: 'tv_comedycentral', slug: 'comedycentral', name: 'Comedy Central', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/comedycentral.png' },
    { id: 'tv_discoverychannel', slug: 'discoverychannel', name: 'Discovery Channel', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/discoverychannel.png' },
    { id: 'tv_discoveryhh', slug: 'discoveryhh', name: 'Discovery Home & Health', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/discoveryhh.png' },
    { id: 'tv_discoveryid', slug: 'discoveryid', name: 'Investigation Discovery', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/discoveryid.png' },
    { id: 'tv_discoveryscience', slug: 'discoveryscience', name: 'Discovery Science', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/discoveryscience.png' },
    { id: 'tv_discoverytheater', slug: 'discoverytheater', name: 'Discovery Theater', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/discoverytheater.png' },
    { id: 'tv_discoveryturbo', slug: 'discoveryturbo', name: 'Discovery Turbo', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/discoveryturbo.png' },
    { id: 'tv_discoveryworld', slug: 'discoveryworld', name: 'Discovery World', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/discoveryworld.png' },
    { id: 'tv_foodnetwork', slug: 'foodnetwork', name: 'Food Network', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/foodnetwork.png' },
    { id: 'tv_gnt', slug: 'gnt', name: 'GNT', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/gnt.png' },
    { id: 'tv_hgtv', slug: 'hgtv', name: 'HGTV', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/hgtv.png' },
    { id: 'tv_history', slug: 'history', name: 'History', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/history.png' },
    { id: 'tv_history2', slug: 'history2', name: 'History 2', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/history2.png' },
    { id: 'tv_mtv', slug: 'mtv', name: 'MTV', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/mtv.png' },
    { id: 'tv_multishow', slug: 'multishow', name: 'Multishow', category: 'Variedades', logo: 'https://1.embedcanaisdetv.com/images/multishow.png' },
    { id: 'tv_bandnews', slug: 'bandnews', name: 'BandNews', category: 'Notícias', logo: 'https://1.embedcanaisdetv.com/images/bandnews.png' },
    { id: 'tv_cnnbrasil', slug: 'cnnbrasil', name: 'CNN Brasil', category: 'Notícias', logo: 'https://1.embedcanaisdetv.com/images/cnnbrasil.png' },
    { id: 'tv_globonews', slug: 'globonews', name: 'GloboNews', category: 'Notícias', logo: 'https://1.embedcanaisdetv.com/images/globonews.png' },
    { id: 'tv_jovempannews', slug: 'jovempannews', name: 'Jovem Pan News', category: 'Notícias', logo: 'https://1.embedcanaisdetv.com/images/jovempannews.png' },
    { id: 'tv_recordnews', slug: 'recordnews', name: 'Record News', category: 'Notícias', logo: 'https://1.embedcanaisdetv.com/images/recordnews.png' },
    { id: 'tv_cartoonito', slug: 'cartoonito', name: 'Cartoonito', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/cartoonito.png' },
    { id: 'tv_cartoonnetwork', slug: 'cartoonnetwork', name: 'Cartoon Network', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/cartoonnetwork.png' },
    { id: 'tv_discoverykids', slug: 'discoverykids', name: 'Discovery Kids', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/discoverykids.png' },
    { id: 'tv_dreamworks', slug: 'dreamworks', name: 'DreamWorks', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/dreamworks.png' },
    { id: 'tv_gloob', slug: 'gloob', name: 'Gloob', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/gloob.png' },
    { id: 'tv_gloobinho', slug: 'gloobinho', name: 'Gloobinho', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/gloobinho.png' },
    { id: 'tv_nickelodeon', slug: 'nickelodeon', name: 'Nickelodeon', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/nickelodeon.png' },
    { id: 'tv_nickjr', slug: 'nickjr', name: 'Nick Jr.', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/nickjr.png' },
    { id: 'tv_tooncast', slug: 'tooncast', name: 'Tooncast', category: 'Infantil', logo: 'https://1.embedcanaisdetv.com/images/tooncast.png' },
];

function findCanal(id) {
    return TV_CHANNELS.find(c => c.id === id);
}

// Resolve o stream de um canal: primeiro acha o iframe real (costuma estar em
// outro domínio, ex: 1607embcanais.xyz), depois tenta m3u8 direto nele, e só
// por último cai no navegador headless (Playwright) capturando a rede de verdade.
async function resolveCanalStream(canal) {
    const outerUrl = CANAIS_BASE + canal.slug;
    let targetUrl = outerUrl;

    // 0. Busca a página externa e procura um iframe apontando pro player real
    //    (o embed em si costuma estar embutido noutro domínio)
    try {
        const r0    = await withTimeout(fetch(outerUrl, { headers: { 'User-Agent': UA } }), 7000);
        const html0 = await r0.text();
        const iframeM = html0.match(/<iframe[^>]+src="([^"]+)"/i);
        if (iframeM) {
            targetUrl = iframeM[1].startsWith('http') ? iframeM[1] : new URL(iframeM[1], outerUrl).href;
            console.log('[TV] Iframe interno achado:', targetUrl);
        }
    } catch (e) {
        console.log('[TV] Falha buscando iframe externo:', canal.slug, '-', e.message);
    }

    // 1. Tenta achar m3u8 direto no HTML da página alvo (interna, se achou iframe)
    try {
        const r    = await withTimeout(fetch(targetUrl, { headers: { 'User-Agent': UA, Referer: outerUrl } }), 7000);
        const html = await r.text();
        const m = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
        if (m) return { url: m[0], referer: targetUrl };
    } catch (e) {
        console.log('[TV] Falha no fetch direto:', canal.slug, '-', e.message);
    }

    // 2. Fallback: navegador headless capturando a requisição real de rede
    const master = await withTimeout(
        resolveViaPlaywright(
            targetUrl,
            /master\.txt(\?|$)|\.m3u8(\?|$)/i,
            18000,
            ['.play-wrapper[data-poster]', '.play-wrapper', '[data-poster]', '#player video', 'video']
        ),
        20000
    ).catch(() => null);
    if (master) return { url: master, referer: targetUrl };

    return null;
}

// ── Catálogo de canais de TV ────────────────────────────────────
app.get('/catalog/tv/:catalogId.json', (req, res) => {
    const { genre, search } = req.query;
    let list = TV_CHANNELS;

    if (genre)  list = list.filter(c => c.category === genre);
    if (search) {
        const q = search.toLowerCase();
        list = list.filter(c => c.name.toLowerCase().includes(q));
    }

    const metas = list.map(c => ({
        id: c.id, type: 'tv', name: c.name,
        poster: c.logo, posterShape: 'square', genres: [c.category]
    }));
    res.json({ metas });
});

// ── Meta de um canal específico ─────────────────────────────────
app.get('/meta/tv/:id.json', (req, res) => {
    const id = req.params.id.replace('.json', '');
    const canal = findCanal(id);
    if (!canal) return res.status(404).json({ err: 'not found' });

    res.json({
        meta: {
            id: canal.id, type: 'tv', name: canal.name,
            poster: canal.logo, background: canal.logo,
            genres: [canal.category], description: 'Canal ao vivo — ' + canal.category
        }
    });
});

// ── Stream de um canal de TV ─────────────────────────────────────
app.get('/stream/tv/:id.json', async (req, res) => {
    const id = req.params.id.replace('.json', '');
    const canal = findCanal(id);
    if (!canal) return res.json({ streams: [] });

    console.log('[TV] Buscando stream:', canal.name, '(' + canal.slug + ')');

    try {
        const selfBase = req.protocol + '://' + req.get('host');
        const resolved = await resolveCanalStream(canal);
        if (!resolved) {
            console.log('[TV] Não encontrado:', canal.slug);
            return res.json({ streams: [] });
        }

        const r    = await withTimeout(fetch(resolved.url, { headers: { 'User-Agent': UA, Referer: resolved.referer } }), 8000);
        const body = await r.text();
        let streamUrl = resolved.url;

        if (body.trim().startsWith('#EXTM3U')) {
            const key = cacheKeyFor(resolved.url);
            _m3u8Cache.set(key, { text: body, base: resolved.url, ts: Date.now() });
            streamUrl = selfBase + '/proxy/playlist?key=' + key;
        }

        console.log('[TV] ✓ stream encontrado:', canal.slug);
        res.json({
            streams: [{
                name: 'TV ao vivo',
                title: canal.name + ' (' + canal.category + ')',
                url: streamUrl,
                behaviorHints: { notWebReady: false }
            }]
        });
    } catch (e) {
        console.log('[TV] Erro:', canal.slug, '-', e.message);
        res.json({ streams: [] });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const isSerie = type === 'series';
    let imdbId = id, season, episode;
    if (isSerie) { const p = id.split(':'); imdbId=p[0]; season=p[1]; episode=p[2]; }

    const cacheKey = id + (isSerie ? `_${season}_${episode}` : '');
    if (_streamCache.has(cacheKey)) {
        const cached = _streamCache.get(cacheKey);
        if (Date.now() - cached.ts < STREAM_TTL) {
            console.log('[NetCine] Cache hit:', cacheKey);
            return res.json({ streams: cached.streams });
        }
        _streamCache.delete(cacheKey);
    }

    console.log(`\n[NetCine] ▶ ${type} ${imdbId}${isSerie?' S'+season+'E'+episode:''}`);

    try {
        const [host, info] = await Promise.all([getHost(), getTmdbInfo(imdbId, isSerie?'tv':'movie')]);
        if (!info) return res.json({ streams: [] });
        console.log('[NetCine] Título:', info.titulo, '|', info.original, '('+info.ano+')');

        let pageUrl = await buscar(host, info.titulo, info.ano, isSerie);
        if (!pageUrl && info.original && info.original !== info.titulo)
            pageUrl = await buscar(host, info.original, info.ano, isSerie);
        if (!pageUrl) return res.json({ streams: [] });

        let targetUrl = pageUrl;
        if (isSerie) {
            targetUrl = await getEpisodeUrl(pageUrl, host, season, episode);
            if (!targetUrl) return res.json({ streams: [] });
        }

        const players = await getPlayers(targetUrl, host);
        console.log('[NetCine] Players encontrados:', players.length);

        const selfBase = req.protocol + '://' + req.get('host');

        const results = await Promise.all(players.map(async p => {
            const resolved = await resolvePlayer(p.src);
            if (!resolved?.url) return null;

            let streamUrl = resolved.url;

            if (resolved.rawM3u8) {
                const key = cacheKeyFor(streamUrl);
                _m3u8Cache.set(key, { text: resolved.rawM3u8, base: streamUrl, ts: Date.now() });
                streamUrl = `${selfBase}/proxy/playlist?key=${key}`;
                console.log('[NetCine] Proxy URL:', streamUrl.slice(0,80));
            } else {
                console.log('[NetCine] URL direta:', streamUrl.slice(0,80));
            }

            return {
                name:  'NetCine',
                title: p.lang === 'DUBLADO' ? '🇧🇷 PT-BR Dublado' : '🎬 Legendado',
                url:   streamUrl,
                behaviorHints: { notWebReady: false }
            };
        }));

        const ncStreams = results.filter(Boolean);
        console.log('[NetCine] ✓', ncStreams.length, 'stream(s) NetCine');

        // EmbedPlayer: roda com timeout, não bloqueia se falhar.
        // Desativado pra séries por enquanto — o site precisa de um formato de URL
        // específico por episódio que ainda não confirmamos; buscar só por imdbId
        // sempre devolveria o mesmo episódio (errado) pra qualquer S/E pedido.
        let epStreams = [];
        if (isSerie) {
            console.log('[Embed] Pulado (séries ainda não suportadas nesta fonte)');
        } else {
        try {
            const selfBase = req.protocol + '://' + req.get('host');
            const embedList = await withTimeout(embedGetUrl(imdbId, info.titulo, info.original), 12000);
            for (const s of embedList) {
                let streamUrl = s.url;
                try {
                    const r    = await withTimeout(
                        fetch(streamUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' }),
                        5000
                    );
                    const body     = await r.text();
                    const finalUrl = r.url;
                    if (body.trim().startsWith('#EXTM3U')) {
                        const key = cacheKeyFor(finalUrl);
                        _m3u8Cache.set(key, { text: body, base: finalUrl, ts: Date.now() });
                        streamUrl = selfBase + '/proxy/playlist?key=' + key;
                    } else {
                        // Não é m3u8 direto — provavelmente página com JS ofuscado (packer/eval).
                        // Deixa o navegador headless rodar o JS de verdade e capturamos o
                        // master.txt que ele mesmo pede pra rede, sem depender de decodificar o packer.
                        console.log('[Embed] Não é m3u8 direto, tentando Playwright:', finalUrl.slice(0, 80));
                        const master = await withTimeout(resolveViaPlaywright(finalUrl), 18000).catch(() => null);
                        if (master) {
                            try {
                                const mr = await withTimeout(
                                    fetch(master, { headers: { 'User-Agent': UA, Referer: finalUrl } }),
                                    6000
                                );
                                const mt = await mr.text();
                                if (mt.trim().startsWith('#EXTM3U')) {
                                    const key = cacheKeyFor(master);
                                    _m3u8Cache.set(key, { text: mt, base: master, ts: Date.now() });
                                    streamUrl = selfBase + '/proxy/playlist?key=' + key;
                                } else {
                                    streamUrl = master;
                                }
                            } catch (_) {
                                streamUrl = master;
                            }
                        } else {
                            streamUrl = finalUrl; // não achou nada melhor, mantém como estava
                        }
                    }
                } catch (_) {}
                epStreams.push({
                    name:  'EmbedPlayer',
                    title: s.title,
                    url:   streamUrl,
                    behaviorHints: { notWebReady: false }
                });
            }
        } catch (e) {
            console.log('[Embed] Ignorado:', e.message);
        }
        }

        const streams = [...ncStreams, ...epStreams];
        console.log('[Total] ✓', streams.length, 'stream(s) retornado(s)');

        _streamCache.set(cacheKey, { streams, ts: Date.now() });
        res.json({ streams });
    } catch(e) {
        console.error('[NetCine] ERRO GERAL:', e.message);
        res.json({ streams: [] });
    }
});

// ── Episódio ──────────────────────────────────────────────────
async function getEpisodeUrl(seriesUrl, host, s, e) {
    const html = await _get(seriesUrl, { Referer: host });
    const sn = parseInt(s), en = parseInt(e);
    const pad = n => String(n).padStart(2,'0');
    const pats = [`${sn} - ${en}`,`${sn} - ${pad(en)}`,`${sn}x${pad(en)}`,`${sn}x${en}`];
    const re = /href="([^"]*\/episode\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const txt = m[2].replace(/<[^>]+>/g,'').trim();
        if (pats.some(p => txt.includes(p))) {
            const url = new URL(m[1], host).href;
            console.log('[NetCine] Episódio encontrado:', url);
            return url;
        }
    }
    console.log('[NetCine] Episódio não encontrado S'+s+'E'+e);
    return null;
}


app.listen(PORT, () => console.log('NetCine addon na porta', PORT));
