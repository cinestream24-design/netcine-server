const express = require('express');
const fetch = require('node-fetch');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;

const BASE = 'https://eee1.lat';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let _host = null;
let _cookies = null;

// Agente HTTPS para ignorar erros de certificados SSL inválidos/incompletos
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function getHost() {
    if (_host) {
        return _host;
    }

    try {
        const r = await fetch(BASE, {
            redirect: 'follow',
            headers: {
                'User-Agent': UA
            },
            agent: httpsAgent
        });

        _host = r.url.replace(/\/$/, '') + '/';
    } catch (e) {
        console.log('[NetCine] Erro ao descobrir host:', e.message);
        _host = BASE + '/';
    }

    console.log('[NetCine] Host:', _host);
    return _host;
}

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
        redirect: 'follow',
        agent: httpsAgent
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

// Configuração CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Endpoint do Manifest do Stremio
app.get('/manifest.json', (req, res) => {
    const manifest = {
        id: 'org.netcine.addon',
        version: '1.0.0',
        name: 'NetCine',
        description: 'Addon NetCine para Stremio',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt']
    };
    res.json(manifest);
});

// Endpoint dos Streams
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    console.log(`[NetCine] ▶ ${type} ${id}`);

    try {
        const host = await getHost();
        
        // Exemplo de resposta vazia de streams para manter o addon funcional
        // O seu código original continuará o scraping normalmente a partir daqui
        res.json({ streams: [] });
    } catch (e) {
        console.log(`[NetCine] ERRO GERAL: ${e.message}`);
        res.json({ streams: [] });
    }
});

// Inicialização do Servidor
app.listen(PORT, () => {
    console.log('========================================');
    console.log('NetCine addon iniciado');
    console.log(`Porta: ${PORT}`);
    console.log('Proxy externo: DESATIVADO');
    console.log('========================================');
});
