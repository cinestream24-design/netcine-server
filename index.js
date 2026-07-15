const express = require('express');
const fetch   = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const PORT = process.env.PORT || 3000;

const app      = express();
const TMDB_KEY = 'd8e8e85d692358d3b5db2cfd08487457';
const BASE     = 'https://eee1.lat';
const UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ── Proxy residencial ─────────────────────────────────────────
const PROXY_URL  = 'http://Jonatas2002:17102020@191.96.73.63:50100';
const proxyAgent = new HttpsProxyAgent(PROXY_URL);
console.log('[Proxy] Usando proxy:', '191.96.73.63:50100');

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
    id: 'br.netcine.stremio', version: '1.1.0',
    name: 'NetCine', description: 'Streams HLS do NetCine. Dublado e Legendado.',
    logo: 'https://eee1.lat/favicon.ico',
    resources: ['stream'], types: ['movie', 'series'],
    idPrefixes: ['tt'], catalogs: []
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
        const lang = /DUBLAD|DUB|UDIO|AUDIO/.test(tabText) ? 'DUBLADO' : 'LEGENDADO';
        console.log('[NetCine] Player:', lang, src.slice(0,60));
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
        const base   = cached.base.substring(0, cached.base.lastIndexOf('/') + 1);
        const segUrls = [];

        const m3u8 = cached.text.split('\n').map(line => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return line;
            const absUrl = t.startsWith('http') ? t : base + t;
            segUrls.push(absUrl);
            return `${selfBase}/proxy/seg?url=${encodeURIComponent(absUrl)}`;
        }).join('\n');

        // Prefetch dos primeiros 3 segmentos
        prefetchSegmentos(segUrls, 3);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(m3u8);
    }

    res.status(404).send('playlist não encontrada');
});

// ── Proxy: segmento .ts ───────────────────────────────────────
app.get('/proxy/seg', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('missing url');
    const decodedUrl = decodeURIComponent(url);

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Serve do cache se disponível
    if (_segCache.has(decodedUrl)) {
        return res.send(_segCache.get(decodedUrl));
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
        res.send(buf);
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

async function embedGetUrl(imdbId) {
    const embedUrl = EMBED_BASE + imdbId + '/';
    console.log('[Embed] Buscando:', embedUrl);

    const html = await withTimeout(
        fetch(embedUrl, {
            headers: { 'User-Agent': UA, Referer: 'https://embed.embedplayer.site/' },
            redirect: 'follow'
        }).then(r => r.text()),
        6000
    );

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
                const key = Buffer.from(streamUrl).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,40);
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

        // EmbedPlayer: roda com timeout, não bloqueia se falhar
        let epStreams = [];
        try {
            const selfBase = req.protocol + '://' + req.get('host');
            const embedList = await withTimeout(embedGetUrl(imdbId), 12000);
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
                        const key = Buffer.from(finalUrl)
                            .toString('base64')
                            .replace(/[^a-zA-Z0-9]/g, '')
                            .slice(0, 40);
                        _m3u8Cache.set(key, { text: body, base: finalUrl, ts: Date.now() });
                        streamUrl = selfBase + '/proxy/playlist?key=' + key;
                    } else {
                        streamUrl = finalUrl;
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
