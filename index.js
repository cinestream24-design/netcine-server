const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const dns = require('dns');

// 1. Configura DNS 1.1.1.1 (Cloudflare) globalmente no Node.js
try {
    dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
    console.log('[NetCine] DNS definido para 1.1.1.1 (Cloudflare)');
} catch (e) {
    console.log('[NetCine] Aviso ao definir DNS:', e.message);
}

// Previne quedas por exceções não tratadas
process.on('uncaughtException', (err) => console.error('[NetCine] Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('[NetCine] Unhandled Rejection:', reason));

const app = express();
const PORT = process.env.PORT || 8080;

const BASE = 'https://eee1.lat';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let _host = null;
let _cookies = null;

// Agentes HTTP/HTTPS configurados com o DNS 1.1.1.1
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    lookup: dns.lookup
});

const httpAgent = new http.Agent({
    lookup: dns.lookup
});

const client = axios.create({
    httpsAgent,
    httpAgent,
    timeout: 15000,
    headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    }
});

// Busca metadados do filme/série no Cinemeta pelo ID do IMDB
async function getMetaFromImdb(id, type) {
    try {
        const imdbId = id.split(':')[0];
        const res = await client.get(`https://v3-cinemeta.strem.fun/meta/${type}/${imdbId}.json`);
        return res.data?.meta || null;
    } catch (e) {
        console.log('[NetCine] Erro ao converter ID IMDB via Cinemeta:', e.message);
        return null;
    }
}

// Descobre o domínio principal
async function getHost() {
    if (_host) return _host;
    try {
        const r = await client.get(BASE, { maxRedirects: 5 });
        _host = r.request?.res?.responseUrl || BASE;
        _host = _host.replace(/\/$/, '') + '/';
    } catch (e) {
        console.log('[NetCine] Erro ao descobrir host:', e.message);
        _host = BASE + '/';
    }
    return _host;
}

// Helper para requisições com cookies
async function _get(url) {
    const headers = { 'Referer': BASE };
    if (_cookies) headers['Cookie'] = _cookies;

    const r = await client.get(url, { headers });

    const sc = r.headers['set-cookie'];
    if (sc && Array.isArray(sc)) {
        const session = sc.find(cookie => cookie.includes('PHPSESSID'));
        if (session) {
            const match = session.match(/PHPSESSID=([^;]+)/);
            if (match) _cookies = 'PHPSESSID=' + match[1];
        }
    }
    return r.data;
}

// Configuração CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

// Healthcheck
app.get('/', (req, res) => {
    res.send('NetCine Addon está ativo!');
});

// Manifest do Stremio
app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.netcine.addon',
        version: '1.0.0',
        name: 'NetCine',
        description: 'Addon NetCine para Stremio (com resolução DNS 1.1.1.1)',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt']
    });
});

// PROXY DE PLAYLIST (.m3u8)
app.get('/proxy/playlist', async (req, res) => {
    const { key, url: rawUrl } = req.query;
    let targetUrl = '';

    if (key) {
        targetUrl = Buffer.from(key, 'base64').toString('utf-8');
    } else if (rawUrl) {
        targetUrl = decodeURIComponent(rawUrl);
    }

    if (!targetUrl) return res.status(400).send('URL inválida');

    try {
        const hostHeader = req.get('host');
        const protocol = req.protocol;
        const serverHost = `${protocol}://${hostHeader}`;

        const response = await client.get(targetUrl, {
            headers: {
                'User-Agent': UA,
                'Referer': BASE
            }
        });

        const m3u8Data = response.data;
        if (typeof m3u8Data !== 'string') {
            return res.status(500).send('Resposta HLS inválida');
        }

        const lines = m3u8Data.split(/\r?\n/);
        const rewrittenLines = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                return line;
            }
            try {
                const fullSegmentUrl = new URL(trimmed, targetUrl).href;
                return `${serverHost}/proxy/seg?url=${encodeURIComponent(fullSegmentUrl)}`;
            } catch (e) {
                return line;
            }
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenLines.join('\n'));
    } catch (e) {
        console.log('[NetCine] Erro ao carregar playlist m3u8:', e.message);
        res.status(500).send('Erro ao buscar a playlist');
    }
});

// PROXY DE SEGMENTOS (.ts)
app.get('/proxy/seg', async (req, res) => {
    const { url: segmentUrl } = req.query;
    if (!segmentUrl) return res.status(400).send('URL de segmento não fornecida');

    try {
        const target = decodeURIComponent(segmentUrl);
        const response = await client.get(target, {
            responseType: 'stream',
            headers: {
                'User-Agent': UA,
                'Referer': BASE
            }
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send('Erro no segmento');
    }
});

// ENDPOINT DE STREAMS DO STREMIO
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    console.log(`[NetCine] ▶ ${type} ${id}`);

    const streams = [];

    try {
        const meta = await getMetaFromImdb(id, type);
        if (!meta || !meta.name) {
            console.log(`[NetCine] Título não encontrado para ${id}`);
            return res.json({ streams: [] });
        }

        const title = meta.name;
        const host = await getHost();

        let season = null, episode = null;
        if (type === 'series' && id.includes(':')) {
            const parts = id.split(':');
            season = parts[1];
            episode = parts[2];
            console.log(`[NetCine] Série ${id} -> Temp ${season} Ep ${episode}`);
        }

        const searchUrl = `${host}search/${encodeURIComponent(title)}/`;
        console.log(`[NetCine] Buscando: ${searchUrl}`);

        const searchHtml = await _get(searchUrl);
        const $ = cheerio.load(searchHtml);

        let pageLink = $('article a, .item a, .result a, .post-title a').first().attr('href');

        if (pageLink) {
            let fullLink = pageLink.startsWith('http') ? pageLink : new URL(pageLink, host).href;

            if (type === 'series' && season && episode) {
                const epSuffix = `season-${season}-episode-${episode}`;
                const altSuffix = `temp-${season}-ep-${episode}`;

                const pageHtml = await _get(fullLink);
                const $page = cheerio.load(pageHtml);

                const epLink = $page(`a[href*="${epSuffix}"], a[href*="${altSuffix}"], a[href*="s${season}e${episode}"]`).first().attr('href');
                if (epLink) {
                    fullLink = epLink.startsWith('http') ? epLink : new URL(epLink, host).href;
                }
            }

            console.log(`[NetCine] Página encontrada: ${fullLink}`);
            const itemHtml = await _get(fullLink);
            const $item = cheerio.load(itemHtml);

            const playerUrls = [];
            $item('iframe, a.player-option, .embed-selector option').each((i, el) => {
                const src = $item(el).attr('src') \vert{}\vert{}$item(el).attr('data-src') || $item(el).attr('value') \vert{}\vert{}$item(el).attr('href');
                if (src && !src.includes('facebook') && !src.includes('google') && !src.includes('disqus')) {
                    const fullSrc = src.startsWith('//') ? `https:${src}` : (src.startsWith('http') ? src : new URL(src, host).href);
                    playerUrls.push(fullSrc);
                }
            });

            console.log(`[NetCine] Players encontrados: ${playerUrls.length}`);

            const hostHeader = req.get('host');
            const protocol = req.protocol;
            const serverHost = `${protocol}://${hostHeader}`;

            for (let i = 0; i < playerUrls.length; i++) {
                const playerUrl = playerUrls[i];
                try {
                    console.log(`[NetCine] Resolvendo player: ${playerUrl}`);
                    const playerHtml = await _get(playerUrl);

                    const m3u8Match = playerHtml.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|php\?token=[^\s"'<>]+))/i) ||
                                      playerHtml.match(/source\s*:\s*["']([^"']+)["']/i) ||
                                      playerHtml.match(/file\s*:\s*["']([^"']+)["']/i);

                    let videoUrl = m3u8Match ? m3u8Match[1] : null;

                    if (!videoUrl && playerUrl.includes('hls')) {
                        videoUrl = playerUrl;
                    }

                    if (videoUrl) {
                        const encodedKey = Buffer.from(videoUrl).toString('base64');
                        const proxyUrl = `${serverHost}/proxy/playlist?key=${encodedKey}`;

                        console.log(`[NetCine] HLS final: ${videoUrl}`);
                        console.log(`[NetCine] Proxy URL: ${proxyUrl}`);

                        const label = playerUrl.toLowerCase().includes('dub') ? 'DUBLADO' : (playerUrl.toLowerCase().includes('leg') ? 'LEGENDADO' : `Player ${i + 1}`);

                        streams.push({
                            name: 'NetCine',
                            title: `${title} - ${label}`,
                            url: proxyUrl
                        });
                    }
                } catch (err) {
                    console.log(`[NetCine] Erro no player ${i + 1}: ${err.message}`);
                }
            }
        }
    } catch (e) {
        console.log(`[NetCine] ERRO GERAL: ${e.message}`);
    }

    console.log(`[NetCine] ✔ ${streams.length} stream(s) retornado(s)`);
    res.json({ streams });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('NetCine addon iniciado');
    console.log(`Porta: ${PORT}`);
    console.log('DNS Customizado: 1.1.1.1');
    console.log('========================================');
});
