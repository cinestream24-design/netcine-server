// Polyfill para garantir compatibilidade do objeto File no Node.js
if (typeof globalThis.File === 'undefined') {
    const { File } = require('node:buffer');
    globalThis.File = File;
}

const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://starckfilmes-v24.com';
const PORT = process.env.PORT || 7000;

// 1. Configuração do Manifest do Addon para Nuvio / Stremio
const builder = new addonBuilder({
    id: 'org.netstream.starkfilmes',
    version: '1.0.0',
    name: 'NetStream Addon',
    description: 'Buscador de streams torrent para Nuvio e Stremio',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
});

// Helper de normalização de texto (remove acentos e pontuações)
function normalizeText(text) {
    if (!text) return '';
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[\:\-\?!\.\,\'\"]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const httpClient = axios.create({
    timeout: 10000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

// Validação flexível do post encontrado
function isTargetPost(targetTitle, postTitle, postUrl) {
    const normTarget = normalizeText(targetTitle);
    const normPostTitle = normalizeText(postTitle);
    
    const slug = postUrl.replace(/\/$/, '').split('/').pop();
    const normSlug = normalizeText(slug.replace(/-/g, ' '));

    const targetWords = normTarget.split(' ').filter(w => w.length > 2);
    const wordsToSearch = targetWords.length > 0 ? targetWords : normTarget.split(' ');

    const titleMatches = wordsToSearch.filter(w => normPostTitle.includes(w)).length;
    const slugMatches = wordsToSearch.filter(w => normSlug.includes(w)).length;

    return (titleMatches / wordsToSearch.length >= 0.4) || (slugMatches / wordsToSearch.length >= 0.4);
}

// Raspador de links Magnet
async function scrapeSite(queryTitle) {
    try {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(normalizeText(queryTitle))}`;
        const searchResponse = await httpClient.get(searchUrl);
        const $ = cheerio.load(searchResponse.data);

        let targetPostUrl = null;

        $('article, div.item, div.post').each((_, element) => {
            const aTag = $(element).find('a[href]').first();
            const href = aTag.attr('href');
            const postTitle = $(element).find('h1, h2, h3').text().trim() || aTag.text().trim();

            if (href && href.includes(BASE_URL)) {
                if (['/categoria/', '/tag/', '/?s=', '/genre/', '/page/'].some(x => href.includes(x))) {
                    return;
                }

                if (isTargetPost(queryTitle, postTitle, href)) {
                    targetPostUrl = href;
                    return false;
                }
            }
        });

        if (!targetPostUrl) return [];

        const postResponse = await httpClient.get(targetPostUrl);
        const $post = cheerio.load(postResponse.data);

        $post('div.related, section.related, .voce-pode-gostar').remove();

        const pageText = $post('body').text().toLowerCase();
        let audioInfo = pageText.includes('dual áudio') || pageText.includes('dual audio') ? 'Dual Áudio' : '';
        if (!audioInfo && pageText.includes('dublado')) audioInfo = 'Dublado';

        const streams = [];

        $post('a[href]').each((idx, elem) => {
            const href = $post(elem).attr('href') || '';
            const dataMagnet = $post(elem).attr('data-magnet') || '';
            const dataLink = $post(elem).attr('data-link') || '';

            let targetLink = '';
            if (href.startsWith('magnet:?')) targetLink = href;
            else if (dataMagnet.startsWith('magnet:?')) targetLink = dataMagnet;
            else if (dataLink.startsWith('magnet:?')) targetLink = dataLink;

            if (!targetLink) return;

            const parentText = $post(elem).parent().text();
            const contextText = `${$post(elem).text()} ${parentText}`;

            const resMatch = contextText.match(/(2160p|1080p|720p|4k|fhd|hd|web\-dl|bluray|hdr)/i);
            const resolution = resMatch ? resMatch[0].toUpperCase() : '1080P';

            const hashMatch = targetLink.match(/btih:([a-zA-Z0-9]+)/i);
            const infoHash = hashMatch ? hashMatch[1] : null;

            if (infoHash) {
                streams.push({
                    name: 'NetStream',
                    title: `${resolution} | ${audioInfo || 'Opção ' + (idx + 1)}`,
                    infoHash: infoHash.toLowerCase(),
                    sources: [targetLink]
                });
            } else {
                streams.push({
                    name: 'NetStream',
                    title: `${resolution} | ${audioInfo || 'Opção ' + (idx + 1)}`,
                    url: targetLink
                });
            }
        });

        return streams;
    } catch (e) {
        console.error('Erro na raspagem:', e.message);
        return [];
    }
}

// 2. Manipulador de Requisição de Streams
builder.defineStreamHandler(async (args) => {
    try {
        let mediaTitle = '';
        
        // Consulta o metadado no Cinemeta pelo ID IMDb (ex: tt0848228)
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${args.id.split(':')[0]}.json`);
        
        if (metaRes.data && metaRes.data.meta) {
            mediaTitle = metaRes.data.meta.name;
        }

        if (!mediaTitle) {
            return { streams: [] };
        }

        const streams = await scrapeSite(mediaTitle);
        return { streams };

    } catch (err) {
        console.error('Erro no StreamHandler:', err.message);
        return { streams: [] };
    }
});

// 3. Servidor Express com integração do Stremio SDK
const app = express();
const addonRouter = getRouter(builder.getInterface());

app.use('/', addonRouter);

app.listen(PORT, () => {
    console.log(`Addon NetStream rodando na porta ${PORT}`);
    console.log(`Manifest disponível em: http://localhost:${PORT}/manifest.json`);
});
