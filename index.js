const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const dns = require('dns');

// 1. Força o Node.js a usar o DNS 1.1.1.1 (Cloudflare)
dns.setServers(['1.1.1.1', '1.0.0.1']);

const app = express();
const PORT = process.env.PORT || 8080;

const BASE = 'https://eee1.lat';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let _host = null;
let _cookies = null;

// Agente HTTPS para ignorar erros de certificados SSL inválidos
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

// Instância Axios pré-configurada
const client = axios.create({
    httpsAgent,
    timeout: 15000,
    headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    }
});

// Converter ID IMDB em nome de filme/série via Cinemeta
async function getMetaFromImdb(id, type) {
    try {
        const imdbId = id.split(':')[0];
        const res = await client.get(`https://v3-cinemeta.strem.fun/meta/${type}/${imdbId}.json`);
        return res.data?.meta?.name || null;
    } catch (e) {
        console.log('[NetCine] Erro ao converter ID IMDB via Cinemeta:', e.message);
        return null;
    }
}

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

async function _get(url) {
    const headers = {};
    if (_cookies) {
        headers['Cookie'] = _cookies;
    }

    const r = await client.get(url, { headers });

    const sc = r.headers['set-cookie'];
    if (sc && Array.isArray(sc)) {
        const session = sc.find(cookie => cookie.includes('PHPSESSID'));
        if (session) {
            const match = session.match(/PHPSESSID=([^;]+)/);
            if (match) {
                _cookies = 'PHPSESSID=' + match[1];
            }
        }
    }

    return r.data;
}

// Configuração CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Rota padrão / Healthcheck
app.get('/', (req, res) => {
    res.send('NetCine Addon está ativo!');
});

// Manifest do Stremio
app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.netcine.addon',
        version: '1.0.0',
        name: 'NetCine',
        description: 'Addon NetCine para Stremio',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt']
    });
});

// Endpoint de Streams
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    console.log(`[NetCine] ▶ ${type} ${id}`);

    const streams = [];

    try {
        const title = await getMetaFromImdb(id, type);
        
        if (!title) {
            console.log(`[NetCine] Não foi possível obter o título para ${id}`);
            return res.json({ streams: [] });
        }

        console.log(`[NetCine] Título localizado: ${title}`);
        const host = await getHost();

        const searchUrl = `${host}search/${encodeURIComponent(title)}/`;
        console.log(`[NetCine] Buscando no site: ${searchUrl}`);

        const searchHtml = await _get(searchUrl);
        const $ = cheerio.load(searchHtml);

        const pageLink = $('article a, .item a, .result a').first().attr('href');

        if (pageLink) {
            const fullLink = pageLink.startsWith('http') ? pageLink : new URL(pageLink, host).href;
            console.log(`[NetCine] Página encontrada: ${fullLink}`);

            const pageHtml = await _get(fullLink);
            const $page = cheerio.load(pageHtml);

            $page('iframe').each((i, el) => {
                const iframeSrc = $page(el).attr('src') \vert{}\vert{}$page(el).attr('data-src');
                
                if (iframeSrc && !iframeSrc.includes('facebook') && !iframeSrc.includes('google')) {
                    streams.push({
                        name: 'NetCine',
                        title: `${title} - Player ${i + 1}`,
                        externalUrl: iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc
                    });
                }
            });
        }
    } catch (e) {
        console.log(`[NetCine] ERRO GERAL: ${e.message}`);
    }

    res.json({ streams });
});

// Inicialização do Servidor
app.listen(PORT, () => {
    console.log('========================================');
    console.log('NetCine addon iniciado');
    console.log(`Porta: ${PORT}`);
    console.log('DNS Customizado: 1.1.1.1');
    console.log('========================================');
});