const express = require('express');
const fetch   = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const PORT    = process.env.PORT || 3000;

const app      = express();
const TMDB_KEY = 'd8e8e85d692358d3b5db2cfd08487457';
const BASE     = 'https://eee1.lat';
const UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ── Proxy residencial ────────────────────────────────────────
const PROXY_URL   = 'http://Jonatas2002:17102020@191.96.73.63:50100';
const proxyAgent  = new HttpsProxyAgent(PROXY_URL);
console.log('[Proxy] Usando proxy:', '191.96.73.63:50100');

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

const MANIFEST = {
    id: 'br.netcine.stremio', version: '1.0.0',
    name: 'NetCine', description: 'Streams HLS do NetCine. Dublado e Legendado.',
    logo: 'https://eee1.lat/favicon.ico',
    resources: ['stream'], types: ['movie', 'series'],
    idPrefixes: ['tt'], catalogs: []
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));
app.get('/', (req, res) => res.json({ name: 'NetCine Addon', status: 'online' }));

// ── Sessão HTTP com cookies ──────────────────────────────────
let _cookies = '';

async function _get(url, extraHeaders = {}) {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8', ...extraHeaders };
    if (_cookies) headers['Cookie'] = _cookies;
    // Usa proxy apenas para requisições ao eee1.lat (e subdomínios do player)
    const useProxy = url.includes('eee1.lat') || url.includes('embedplayer');
    const r = await fetch(url, { headers, redirect: 'follow', ...(useProxy ? { agent: proxyAgent } : {}) });
    // Salva cookies de sessão
    const sc = r.headers.get('set-cookie');
    if (sc) {
        const m = sc.match(/PHPSESSID=([^;]+)/);
        if (m) _cookies = 'PHPSESSID=' + m[1];
    }
    return r.text();
}

async function _getJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    return r.json();
}

// ── Host atual ───────────────────────────────────────────────
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

// ── TMDB: IMDB ID → título + ano ────────────────────────────
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

// ── Normalização ─────────────────────────────────────────────
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

// ── Busca no site (via regex) ────────────────────────────────
async function buscar(host, titulo, ano, isSerie) {
    const q = encodeURIComponent(titulo.replace(/[:\-—]/g,' ').trim());
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
    console.log('[NetCine] Não encontrado no site:', titulo);
    return null;
}

// ── Extrai players (regex) ───────────────────────────────────
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

// ── Resolve iframe → HLS ─────────────────────────────────────
async function resolvePlayer(iframeUrl) {
    const origin = new URL(iframeUrl).origin;
    const qs     = Object.fromEntries(new URL(iframeUrl).searchParams);
    let fetchUrl = iframeUrl;

    if (/hlsarchive\.php|nv32\.php/.test(iframeUrl) && qs.n && qs.p)
        fetchUrl = `${origin}/media-player/hls/hls.php?n=${qs.n}&p=${qs.p}`;
    else if (/nv32mono\.php|mono\.php/.test(iframeUrl) && qs.n && qs.p)
        fetchUrl = `${origin}/media-player/dist/playermono.php?n=${qs.n}&p=${qs.p}`;

    const headers = { Referer: origin+'/', Origin: origin };
    console.log('[NetCine] Resolvendo player:', fetchUrl.slice(0,70));

    try {
        const html = await _get(fetchUrl, headers);

        let m = html.match(/<source[^>]+type="application\/x-mpegURL"[^>]+src="([^"]+)"/i)
             || html.match(/<source[^>]+src="([^"]+)"[^>]+type="application\/x-mpegURL"/i);
        if (m) { console.log('[NetCine] HLS via source:', m[1].slice(0,60)); return { url: m[1].replace(/&amp;/g,'&'), headers }; }

        const all = [...html.matchAll(/<source[^>]+src="([^"]+)"/gi)];
        if (all.length) { const u = all.at(-1)[1].replace(/&amp;/g,'&'); console.log('[NetCine] HLS via source generico:', u.slice(0,60)); return { url: u, headers }; }

        if (qs.n && qs.p) {
            const fbUrl = `${origin}/media-player/dist/playerhls.php?n=${qs.n}&p=${qs.p}`;
            console.log('[NetCine] Tentando fallback:', fbUrl.slice(0,70));
            const t = await _get(fbUrl, headers);
            if (t.trim().startsWith('#EXTM3U')) return { url: fbUrl, headers };
        }
        console.log('[NetCine] Player não resolvido. HTML snippet:', html.slice(0,200));
    } catch(e) { console.log('[NetCine] Erro resolve:', e.message); }
    return null;
}

// ── Episódio ─────────────────────────────────────────────────
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

// ── Endpoint streams ─────────────────────────────────────────
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const isSerie = type === 'series';
    let imdbId = id, season, episode;
    if (isSerie) { const p = id.split(':'); imdbId=p[0]; season=p[1]; episode=p[2]; }
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

        const results = await Promise.all(players.map(async p => {
            const resolved = await resolvePlayer(p.src);
            if (!resolved?.url) return null;
            const hdrs = { 'User-Agent': UA, ...resolved.headers };
            const hdrStr = Object.entries(hdrs).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
            return {
                name:  'NetCine',
                title: p.lang === 'DUBLADO' ? '[PT-BR] Dublado' : '[LEG] Legendado',
                url:   `${resolved.url}|${hdrStr}`,
                behaviorHints: { notWebReady: true }
            };
        }));

        const streams = results.filter(Boolean);
        console.log('[NetCine] ✓', streams.length, 'stream(s) retornado(s)');
        res.json({ streams });
    } catch(e) {
        console.error('[NetCine] ERRO GERAL:', e.message);
        res.json({ streams: [] });
    }
});

app.listen(PORT, () => console.log('NetCine addon na porta', PORT));
