const express = require('express');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3000;

const app = express();

const TMDB_KEY = 'd8e8e85d692358d3b5db2cfd08487457';
const BASE = 'https://eee1.lat';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';


// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});


// ============================================================
// CACHE
// ============================================================

const _streamCache = new Map();
const _m3u8Cache = new Map();
const _segCache = new Map();

const STREAM_TTL = 5 * 60 * 1000;
const M3U8_TTL = 8 * 60 * 1000;
const SEG_MAX = 40;

function _cleanCaches() {
    const now = Date.now();

    for (const [key, value] of _streamCache) {
        if (now - value.ts > STREAM_TTL) {
            _streamCache.delete(key);
        }
    }

    for (const [key, value] of _m3u8Cache) {
        if (now - value.ts > M3U8_TTL) {
            _m3u8Cache.delete(key);
        }
    }

    while (_segCache.size > SEG_MAX) {
        const oldest = _segCache.keys().next().value;

        if (oldest !== undefined) {
            _segCache.delete(oldest);
        } else {
            break;
        }
    }
}

setInterval(_cleanCaches, 2 * 60 * 1000);


// ============================================================
// MANIFEST
// ============================================================

const MANIFEST = {
    id: 'br.netcine.stremio',
    version: '1.1.0',
    name: 'NetCine',
    description: 'Streams HLS do NetCine. Dublado e Legendado.',
    logo: 'https://eee1.lat/favicon.ico',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

app.get('/', (req, res) => {
    res.json({
        name: 'NetCine Addon',
        status: 'online',
        proxy: false
    });
});


// ============================================================
// COOKIES / HTTP
// ============================================================

let _cookies = '';

async function _get(url, extraHeaders = {}) {
    const headers = {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        ...extraHeaders
    };

    if (_cookies) {
        headers['Cookie'] = _cookies;
    }

    const r = await fetch(url, {
        headers,
        redirect: 'follow'
    });

    const sc = r.headers.get('set-cookie');

    if (sc) {
        const match = sc.match(/PHPSESSID=([^;]+)/);

        if (match) {
            _cookies = 'PHPSESSID=' + match[1];
        }
    }

    return r.text();
}

async function _getJson(url) {
    const r = await fetch(url, {
        headers: {
            'User-Agent': UA,
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
        },
        redirect: 'follow'
    });

    if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
    }

    return r.json();
}


// ============================================================
// HOST
// ============================================================

let _host = '';

async function getHost() {
    if (_host) {
        return _host;
    }

    try {
        const r = await fetch(BASE, {
            redirect: 'follow',
            headers: {
                'User-Agent': UA
            }
        });

        _host = r.url.replace(/\/$/, '') + '/';
    } catch (e) {
        console.log('[NetCine] Erro ao descobrir host:', e.message);

        _host = BASE + '/';
    }

    console.log('[NetCine] Host:', _host);

    return _host;
}


// ============================================================
// TMDB
// ============================================================

async function getTmdbInfo(imdbId, tipo) {
    try {
        const url =
            `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}` +
            `?api_key=${TMDB_KEY}` +
            `&external_source=imdb_id` +
            `&language=pt-BR`;

        const d = await _getJson(url);

        const results =
            tipo === 'movie'
                ? (d.movie_results || [])
                : (d.tv_results || []);

        if (!results.length) {
            console.log(
                '[NetCine] TMDB sem resultado para',
                imdbId
            );

            return null;
        }

        const item = results[0];

        return {
            titulo: item.title || item.name || '',
            original:
                item.original_title ||
                item.original_name ||
                '',
            ano: (
                item.release_date ||
                item.first_air_date ||
                ''
            ).slice(0, 4)
        };

    } catch (e) {
        console.log(
            '[NetCine] TMDB erro:',
            e.message
        );

        return null;
    }
}


// ============================================================
// NORMALIZAÇÃO
// ============================================================

function norm(t) {
    return (t || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function similar(a, b) {
    a = norm(a);
    b = norm(b);

    if (!a || !b) {
        return false;
    }

    const sa = a.slice(
        0,
        Math.max(5, a.length - 2)
    );

    const sb = b.slice(
        0,
        Math.max(5, b.length - 2)
    );

    return (
        a.startsWith(sb) ||
        b.startsWith(sa) ||
        a.includes(sb) ||
        b.includes(sa)
    );
}


// ============================================================
// BUSCA NO NETCINE
// ============================================================

async function buscar(host, titulo, ano, isSerie) {
    const q = encodeURIComponent(
        titulo
            .replace(/[:\-—]/g, ' ')
            .trim()
    );

    const url = host + 'search/' + q + '/';

    console.log('[NetCine] Buscando:', url);

    const html = await _get(url, {
        Referer: host
    });

    const blocoRe =
        /<div class="movie[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g;

    let m;

    while ((m = blocoRe.exec(html)) !== null) {
        const bloco = m[1];

        const hrefM = bloco.match(
            /class="imagen"[\s\S]*?<a[^>]+href="([^"]+)"/
        );

        if (!hrefM) {
            continue;
        }

        const href = hrefM[1];

        const resultadoSerie =
            href.includes('/tvshows/');

        if (resultadoSerie !== isSerie) {
            continue;
        }

        if (ano) {
            const anoM = bloco.match(
                /<span class="year">(\d{4})<\/span>/
            );

            if (
                anoM &&
                Math.abs(
                    parseInt(anoM[1], 10) -
                    parseInt(ano, 10)
                ) > 1
            ) {
                continue;
            }
        }

        const h2M = bloco.match(
            /<h2[^>]*>([^<]+)<\/h2>/
        );

        if (h2M) {
            const tituloEncontrado =
                h2M[1]
                    .replace(
                        /\s*(dublado|legendado|hd|4k|1080p|720p)\b.*/i,
                        ''
                    )
                    .trim();

            if (!similar(tituloEncontrado, titulo)) {
                console.log(
                    '[NetCine] Rejeitado:',
                    tituloEncontrado,
                    'vs',
                    titulo
                );

                continue;
            }
        }

        const pageUrl =
            new URL(href, host).href;

        console.log(
            '[NetCine] Encontrado:',
            pageUrl
        );

        return pageUrl;
    }

    console.log(
        '[NetCine] Não encontrado:',
        titulo
    );

    return null;
}


// ============================================================
// PLAYERS
// ============================================================

async function getPlayers(pageUrl, host) {
    const html = await _get(pageUrl, {
        Referer: host
    });

    const players = [];

    const tabRe =
        /<li[^>]*>\s*<a[^>]+href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

    let t;

    while ((t = tabRe.exec(html)) !== null) {
        const tabId = t[1];

        const tabText =
            t[2]
                .replace(/<[^>]+>/g, '')
                .toUpperCase();

        const ifrRe = new RegExp(
            'id="' +
            tabId +
            '"[\\s\\S]*?<iframe[^>]+src="([^"]+)"',
            'i'
        );

        const ifrM = ifrRe.exec(html);

        if (!ifrM) {
            continue;
        }

        let src = ifrM[1]
            .replace(/&amp;/g, '&')
            .trim();

        if (src.startsWith('//')) {
            src = 'https:' + src;
        } else if (!src.startsWith('http')) {
            src = new URL(src, pageUrl).href;
        }

        const lang =
            /DUBLAD|DUB|UDIO|AUDIO/.test(tabText)
                ? 'DUBLADO'
                : 'LEGENDADO';

        console.log(
            '[NetCine] Player:',
            lang,
            src.slice(0, 80)
        );

        players.push({
            lang,
            src
        });
    }

    return players;
}


// ============================================================
// RESOLVE PLAYER
// ============================================================

async function resolvePlayer(iframeUrl) {
    let origin;

    try {
        origin = new URL(iframeUrl).origin;
    } catch {
        return null;
    }

    const qs = Object.fromEntries(
        new URL(iframeUrl).searchParams
    );

    let fetchUrl = iframeUrl;

    if (
        /hlsarchive\.php|nv32\.php/.test(
            iframeUrl
        ) &&
        qs.n &&
        qs.p
    ) {
        fetchUrl =
            `${origin}/media-player/hls/hls.php` +
            `?n=${encodeURIComponent(qs.n)}` +
            `&p=${encodeURIComponent(qs.p)}`;

    } else if (
        /nv32mono\.php|mono\.php/.test(
            iframeUrl
        ) &&
        qs.n &&
        qs.p
    ) {
        fetchUrl =
            `${origin}/media-player/dist/playermono.php` +
            `?n=${encodeURIComponent(qs.n)}` +
            `&p=${encodeURIComponent(qs.p)}`;
    }

    const hlsHeaders = {
        Referer: origin + '/',
        Origin: origin,
        'User-Agent': UA
    };

    console.log(
        '[NetCine] Resolvendo player:',
        fetchUrl.slice(0, 100)
    );

    try {
        const html = await _get(fetchUrl, {
            Referer: origin + '/',
            Origin: origin
        });

        let m3u8 = null;

        // 1. source application/x-mpegURL
        let m =
            html.match(
                /<source[^>]+type="application\/x-mpegURL"[^>]+src="([^"]+)"/i
            ) ||
            html.match(
                /<source[^>]+src="([^"]+)"[^>]+type="application\/x-mpegURL"/i
            );

        if (m) {
            m3u8 = m[1];
        }

        // 2. file/src no JavaScript
        if (!m3u8) {
            const jsM = html.match(
                /(?:file|src)\s*:\s*["']([^"']+(?:\.m3u8|token=)[^"']*)["']/i
            );

            if (jsM) {
                m3u8 = jsM[1];
            }
        }

        // 3. source com token
        if (!m3u8) {
            const tokM = html.match(
                /<source[^>]+src="([^"]+token=[^"]+)"/i
            );

            if (tokM) {
                m3u8 = tokM[1];
            }
        }

        // 4. fallback
        if (!m3u8 && qs.n && qs.p) {
            const fbUrl =
                `${origin}/media-player/dist/playerhls.php` +
                `?n=${encodeURIComponent(qs.n)}` +
                `&p=${encodeURIComponent(qs.p)}`;

            const r = await fetch(fbUrl, {
                headers: hlsHeaders,
                redirect: 'follow'
            });

            const finalUrl = r.url;
            const body = await r.text();

            if (
                body
                    .trim()
                    .startsWith('#EXTM3U')
            ) {
                return {
                    url: finalUrl,
                    headers: hlsHeaders,
                    rawM3u8: body
                };
            }

            if (finalUrl !== fbUrl) {
                m3u8 = finalUrl;
            }
        }

        if (m3u8) {
            if (m3u8.startsWith('//')) {
                m3u8 = 'https:' + m3u8;
            } else if (!m3u8.startsWith('http')) {
                m3u8 = new URL(
                    m3u8,
                    fetchUrl
                ).href;
            }

            const r2 = await fetch(m3u8, {
                headers: hlsHeaders,
                redirect: 'follow'
            });

            const finalUrl = r2.url;
            const body2 = await r2.text();

            console.log(
                '[NetCine] HLS final:',
                finalUrl.slice(0, 100)
            );

            if (
                body2
                    .trim()
                    .startsWith('#EXTM3U')
            ) {
                return {
                    url: finalUrl,
                    headers: hlsHeaders,
                    rawM3u8: body2
                };
            }

            return {
                url: finalUrl,
                headers: hlsHeaders
            };
        }

        console.log(
            '[NetCine] Player não resolvido.'
        );

        console.log(
            '[NetCine] Snippet:',
            html.slice(0, 300)
        );

    } catch (e) {
        console.log(
            '[NetCine] Erro resolve:',
            e.message
        );
    }

    return null;
}


// ============================================================
// PREFETCH SEGMENTOS
// ============================================================

function prefetchSegmentos(segUrls, n = 3) {
    segUrls
        .slice(0, n)
        .forEach(url => {
            if (_segCache.has(url)) {
                return;
            }

            fetch(url, {
                headers: {
                    'User-Agent': UA,
                    Referer:
                        new URL(url).origin + '/'
                },
                redirect: 'follow'
            })
                .then(r => {
                    if (!r.ok) {
                        return null;
                    }

                    return r.buffer();
                })
                .then(buf => {
                    if (buf) {
                        _segCache.set(url, buf);
                    }
                })
                .catch(() => {});
        });
}


// ============================================================
// PROXY INTERNO DE PLAYLIST
// ============================================================

app.get(
    '/proxy/playlist',
    async (req, res) => {
        const { key } = req.query;

        const selfBase =
            req.protocol +
            '://' +
            req.get('host');

        if (
            key &&
            _m3u8Cache.has(key)
        ) {
            const cached =
                _m3u8Cache.get(key);

            const base =
                cached.base.substring(
                    0,
                    cached.base.lastIndexOf('/') + 1
                );

            const segUrls = [];

            const m3u8 =
                cached.text
                    .split('\n')
                    .map(line => {
                        const t =
                            line.trim();

                        if (
                            !t ||
                            t.startsWith('#')
                        ) {
                            return line;
                        }

                        const absUrl =
                            t.startsWith('http')
                                ? t
                                : new URL(
                                      t,
                                      base
                                  ).href;

                        segUrls.push(absUrl);

                        return (
                            `${selfBase}/proxy/seg?url=` +
                            encodeURIComponent(
                                absUrl
                            )
                        );
                    })
                    .join('\n');

            prefetchSegmentos(
                segUrls,
                3
            );

            res.setHeader(
                'Content-Type',
                'application/vnd.apple.mpegurl'
            );

            res.setHeader(
                'Cache-Control',
                'no-cache'
            );

            return res.send(m3u8);
        }

        res
            .status(404)
            .send('playlist não encontrada');
    }
);


// ============================================================
// PROXY INTERNO DE SEGMENTOS
// ============================================================

app.get(
    '/proxy/seg',
    async (req, res) => {
        const { url } = req.query;

        if (!url) {
            return res
                .status(400)
                .send('missing url');
        }

        let decodedUrl;

        try {
            decodedUrl =
                decodeURIComponent(url);
        } catch {
            decodedUrl = url;
        }

        res.setHeader(
            'Content-Type',
            'video/mp2t'
        );

        res.setHeader(
            'Access-Control-Allow-Origin',
            '*'
        );

        res.setHeader(
            'Cache-Control',
            'public, max-age=3600'
        );

        // Cache
        if (
            _segCache.has(decodedUrl)
        ) {
            return res.send(
                _segCache.get(decodedUrl)
            );
        }

        try {
            const segOrigin =
                new URL(decodedUrl).origin;

            const r = await fetch(
                decodedUrl,
                {
                    headers: {
                        'User-Agent': UA,
                        Referer:
                            segOrigin + '/'
                    },
                    redirect: 'follow'
                }
            );

            if (!r.ok) {
                console.log(
                    '[NetCine] Seg erro:',
                    r.status,
                    decodedUrl.slice(0, 100)
                );

                return res
                    .status(r.status)
                    .send('upstream error');
            }

            const buf =
                await r.buffer();

            _segCache.set(
                decodedUrl,
                buf
            );

            res.send(buf);

        } catch (e) {
            console.log(
                '[NetCine] Proxy seg erro:',
                e.message
            );

            res
                .status(500)
                .send('erro');
        }
    }
);


// ============================================================
// EMBEDPLAYER
// ============================================================

const EMBED_BASE =
    'https://embed.embedplayer.site/';

const EMBED_API =
    'https://embed.embedplayer.site/stream';

function withTimeout(
    promise,
    ms
) {
    return Promise.race([
        promise,

        new Promise(
            (_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                'timeout'
                            )
                        ),
                    ms
                )
        )
    ]);
}

async function embedGetUrl(imdbId) {
    const embedUrl =
        EMBED_BASE +
        imdbId +
        '/';

    console.log(
        '[Embed] Buscando:',
        embedUrl
    );

    const html =
        await withTimeout(
            fetch(embedUrl, {
                headers: {
                    'User-Agent': UA,
                    Referer:
                        EMBED_BASE
                },
                redirect: 'follow'
            }).then(r => r.text()),
            6000
        );

    const ids = {};

    const re =
        /class="players_select_items[^"]*"\s+lang="([^"]+)"[\s\S]*?idS="([^"]+)"/g;

    let m;

    while (
        (m = re.exec(html)) !== null
    ) {
        ids[m[1]] = m[2];
    }

    if (!Object.keys(ids).length) {
        console.log(
            '[Embed] Nenhum idS encontrado para',
            imdbId
        );

        return [];
    }

    const streams = [];

    for (
        const [lang, idS]
        of Object.entries(ids)
    ) {
        try {
            const data =
                await withTimeout(
                    fetch(EMBED_API, {
                        method: 'POST',

                        headers: {
                            'Content-Type':
                                'application/x-www-form-urlencoded',
                            'User-Agent': UA,
                            Referer:
                                embedUrl,
                            Origin:
                                'https://embed.embedplayer.site'
                        },

                        body:
                            'idS=' +
                            encodeURIComponent(
                                idS
                            ) +
                            '&ref='

                    }).then(r =>
                        r.json()
                    ),

                    5000
                );

            if (data.break) {
                console.log(
                    '[Embed] break:',
                    lang,
                    data.message
                );

                continue;
            }

            const url =
                data?.resources
                    ?.sources?.[0]?.file ||
                '';

            if (!url) {
                console.log(
                    '[Embed] Sem URL:',
                    lang
                );

                continue;
            }

            console.log(
                '[Embed] OK:',
                lang,
                url.slice(0, 80)
            );

            streams.push({
                lang,
                url,

                title:
                    lang === 'dub'
                        ? '🇧🇷 [EP] Dublado'
                        : '🎬 [EP] Legendado'
            });

        } catch (e) {
            console.log(
                '[Embed] Erro:',
                lang,
                e.message
            );
        }
    }

    return streams;
}


// ============================================================
// STREAM ENDPOINT
// ============================================================

app.get(
    '/stream/:type/:id.json',
    async (req, res) => {

        const {
            type,
            id
        } = req.params;

        const isSerie =
            type === 'series';

        let imdbId = id;
        let season;
        let episode;

        if (isSerie) {
            const p =
                id.split(':');

            imdbId = p[0];
            season = p[1];
            episode = p[2];
        }

        const cacheKey =
            id +
            (
                isSerie
                    ? `_${season}_${episode}`
                    : ''
            );

        // Cache
        if (
            _streamCache.has(
                cacheKey
            )
        ) {
            const cached =
                _streamCache.get(
                    cacheKey
                );

            if (
                Date.now() -
                    cached.ts <
                STREAM_TTL
            ) {
                console.log(
                    '[NetCine] Cache hit:',
                    cacheKey
                );

                return res.json({
                    streams:
                        cached.streams
                });
            }

            _streamCache.delete(
                cacheKey
            );
        }

        console.log(
            `\n[NetCine] ▶ ${type} ${imdbId}` +
            (
                isSerie
                    ? ` S${season}E${episode}`
                    : ''
            )
        );

        try {

            const [
                host,
                info
            ] = await Promise.all([
                getHost(),
                getTmdbInfo(
                    imdbId,
                    isSerie
                        ? 'tv'
                        : 'movie'
                )
            ]);

            if (!info) {
                return res.json({
                    streams: []
                });
            }

            console.log(
                '[NetCine] Título:',
                info.titulo,
                '|',
                info.original,
                '(' +
                    info.ano +
                    ')'
            );

            // Busca pelo título PT
            let pageUrl =
                await buscar(
                    host,
                    info.titulo,
                    info.ano,
                    isSerie
                );

            // Tenta título original
            if (
                !pageUrl &&
                info.original &&
                info.original !==
                    info.titulo
            ) {
                pageUrl =
                    await buscar(
                        host,
                        info.original,
                        info.ano,
                        isSerie
                    );
            }

            if (!pageUrl) {
                return res.json({
                    streams: []
                });
            }

            // Episódio
            let targetUrl =
                pageUrl;

            if (isSerie) {
                targetUrl =
                    await getEpisodeUrl(
                        pageUrl,
                        host,
                        season,
                        episode
                    );

                if (!targetUrl) {
                    return res.json({
                        streams: []
                    });
                }
            }

            const players =
                await getPlayers(
                    targetUrl,
                    host
                );

            console.log(
                '[NetCine] Players encontrados:',
                players.length
            );

            const selfBase =
                req.protocol +
                '://' +
                req.get('host');

            // Resolve todos os players
            const results =
                await Promise.all(
                    players.map(
                        async p => {

                            const resolved =
                                await resolvePlayer(
                                    p.src
                                );

                            if (
                                !resolved?.url
                            ) {
                                return null;
                            }

                            let streamUrl =
                                resolved.url;

                            if (
                                resolved.rawM3u8
                            ) {

                                const key =
                                    Buffer
                                        .from(
                                            streamUrl
                                        )
                                        .toString(
                                            'base64'
                                        )
                                        .replace(
                                            /[^a-zA-Z0-9]/g,
                                            ''
                                        )
                                        .slice(
                                            0,
                                            40
                                        );

                                _m3u8Cache.set(
                                    key,
                                    {
                                        text:
                                            resolved.rawM3u8,
                                        base:
                                            streamUrl,
                                        ts:
                                            Date.now()
                                    }
                                );

                                streamUrl =
                                    `${selfBase}/proxy/playlist?key=${key}`;

                                console.log(
                                    '[NetCine] Proxy interno:',
                                    streamUrl.slice(
                                        0,
                                        100
                                    )
                                );

                            } else {
                                console.log(
                                    '[NetCine] URL direta:',
                                    streamUrl.slice(
                                        0,
                                        100
                                    )
                                );
                            }

                            return {
                                name:
                                    'NetCine',

                                title:
                                    p.lang ===
                                    'DUBLADO'
                                        ? '🇧🇷 PT-BR Dublado'
                                        : '🎬 Legendado',

                                url:
                                    streamUrl,

                                behaviorHints: {
                                    notWebReady:
                                        false
                                }
                            };
                        }
                    )
                );

            const ncStreams =
                results.filter(Boolean);

            console.log(
                '[NetCine] ✓',
                ncStreams.length,
                'stream(s) NetCine'
            );


            // ==================================================
            // EMBEDPLAYER
            // ==================================================

            let epStreams = [];

            try {

                const embedList =
                    await withTimeout(
                        embedGetUrl(
                            imdbId
                        ),
                        12000
                    );

                for (
                    const s
                    of embedList
                ) {

                    let streamUrl =
                        s.url;

                    try {

                        const r =
                            await withTimeout(
                                fetch(
                                    streamUrl,
                                    {
                                        headers: {
                                            'User-Agent':
                                                UA
                                        },
                                        redirect:
                                            'follow'
                                    }
                                ),
                                5000
                            );

                        const body =
                            await r.text();

                        const finalUrl =
                            r.url;

                        if (
                            body
                                .trim()
                                .startsWith(
                                    '#EXTM3U'
                                )
                        ) {

                            const key =
                                Buffer
                                    .from(
                                        finalUrl
                                    )
                                    .toString(
                                        'base64'
                                    )
                                    .replace(
                                        /[^a-zA-Z0-9]/g,
                                        ''
                                    )
                                    .slice(
                                        0,
                                        40
                                    );

                            _m3u8Cache.set(
                                key,
                                {
                                    text:
                                        body,
                                    base:
                                        finalUrl,
                                    ts:
                                        Date.now()
                                }
                            );

                            streamUrl =
                                selfBase +
                                '/proxy/playlist?key=' +
                                key;

                        } else {
                            streamUrl =
                                finalUrl;
                        }

                    } catch (e) {
                        console.log(
                            '[Embed] Resolve:',
                            e.message
                        );
                    }

                    epStreams.push({
                        name:
                            'EmbedPlayer',

                        title:
                            s.title,

                        url:
                            streamUrl,

                        behaviorHints: {
                            notWebReady:
                                false
                        }
                    });
                }

            } catch (e) {
                console.log(
                    '[Embed] Ignorado:',
                    e.message
                );
            }


            // ==================================================
            // RESULTADO
            // ==================================================

            const streams = [
                ...ncStreams,
                ...epStreams
            ];

            console.log(
                '[Total] ✓',
                streams.length,
                'stream(s) retornado(s)'
            );

            _streamCache.set(
                cacheKey,
                {
                    streams,
                    ts: Date.now()
                }
            );

            return res.json({
                streams
            });

        } catch (e) {

            console.error(
                '[NetCine] ERRO GERAL:',
                e.message
            );

            return res.json({
                streams: []
            });
        }
    }
);


// ============================================================
// EPISÓDIO
// ============================================================

async function getEpisodeUrl(
    seriesUrl,
    host,
    s,
    e
) {
    const html =
        await _get(
            seriesUrl,
            {
                Referer: host
            }
        );

    const sn =
        parseInt(s, 10);

    const en =
        parseInt(e, 10);

    const pad =
        n =>
            String(n).padStart(
                2,
                '0'
            );

    const patterns = [
        `${sn} - ${en}`,
        `${sn} - ${pad(en)}`,
        `${sn}x${pad(en)}`,
        `${sn}x${en}`
    ];

    const re =
        /href="([^"]*\/episode\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

    let m;

    while (
        (m = re.exec(html)) !== null
    ) {

        const txt =
            m[2]
                .replace(
                    /<[^>]+>/g,
                    ''
                )
                .trim();

        if (
            patterns.some(
                p => txt.includes(p)
            )
        ) {

            const url =
                new URL(
                    m[1],
                    host
                ).href;

            console.log(
                '[NetCine] Episódio encontrado:',
                url
            );

            return url;
        }
    }

    console.log(
        '[NetCine] Episódio não encontrado S' +
        s +
        'E' +
        e
    );

    return null;
}


// ============================================================
// SERVER
// ============================================================

app.listen(
    PORT,
    () => {
        console.log(
            '========================================'
        );

        console.log(
            'NetCine addon iniciado'
        );

        console.log(
            'Porta:',
            PORT
        );

        console.log(
            'Proxy externo: DESATIVADO'
        );

        console.log(
            '========================================'
        );
    }
);
