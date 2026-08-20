const express = require('express');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3000;
const app = express();

const TMDB_KEY = process.env.TMDB_KEY || 'd8e8e85d692358d3b5db2cfd08487457';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const LANGUAGE = 'pt-BR';
const REGION = 'BR';

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
// CATÁLOGOS
// ============================================================

const PROVIDERS = [
    {
        id: 'netflix',
        name: 'Netflix',
        tmdbId: 8,
        logo: 'https://image.tmdb.org/t/p/original/t2yyOv40HZeVlLjYsCsPHnWLk4W.jpg'
    },
    {
        id: 'disney_plus',
        name: 'Disney+',
        tmdbId: 337,
        logo: 'https://image.tmdb.org/t/p/original/7rwgEs15tFwyR9NPQ5vpzxTj19Q.jpg'
    },
    {
        id: 'prime_video',
        name: 'Prime Video',
        tmdbId: 119,
        logo: 'https://image.tmdb.org/t/p/original/emthp39XA2YScoYL1p0sdbAH2WA.jpg'
    },
    {
        id: 'max',
        name: 'Max',
        tmdbId: 1899,
        logo: 'https://image.tmdb.org/t/p/original/6AK8H0dHnX6cV3aK1mQmFJYQf8H.jpg'
    },
    {
        id: 'apple_tv_plus',
        name: 'Apple TV+',
        tmdbId: 350,
        logo: 'https://image.tmdb.org/t/p/original/peURlLlr8jggOwK53fJ5wdQl05y.jpg'
    },
    {
        id: 'paramount_plus',
        name: 'Paramount+',
        tmdbId: 531,
        logo: 'https://image.tmdb.org/t/p/original/xbhHHa1YgtpwhC8lb1NQ3ACVcLd.jpg'
    },
    {
        id: 'globoplay',
        name: 'Globoplay',
        tmdbId: 307,
        logo: 'https://image.tmdb.org/t/p/original/7fT8r6D1qjK3xT8l2K3yX9w1s0A.jpg'
    }
];

const GENRES = {
    movie: [
        ['all', 'Todos'],
        ['28', 'Ação'],
        ['12', 'Aventura'],
        ['16', 'Animação'],
        ['35', 'Comédia'],
        ['80', 'Crime'],
        ['99', 'Documentário'],
        ['18', 'Drama'],
        ['10751', 'Família'],
        ['14', 'Fantasia'],
        ['27', 'Terror'],
        ['878', 'Ficção científica'],
        ['53', 'Thriller']
    ],
    series: [
        ['all', 'Todos'],
        ['10759', 'Ação e aventura'],
        ['16', 'Animação'],
        ['35', 'Comédia'],
        ['80', 'Crime'],
        ['99', 'Documentário'],
        ['18', 'Drama'],
        ['10751', 'Família'],
        ['10762', 'Infantil'],
        ['9648', 'Mistério'],
        ['10765', 'Ficção científica e fantasia'],
        ['10768', 'Guerra e política']
    ]
};

const SORTS = [
    ['popular', 'Populares'],
    ['top_rated', 'Mais bem avaliados'],
    ['now_playing', 'Em cartaz'],
    ['airing_today', 'Hoje']
];

const manifestCatalogs = [];

for (const provider of PROVIDERS) {
    for (const type of ['movie', 'series']) {
        manifestCatalogs.push({
            id: `${provider.id}_${type}`,
            type,
            name: `${provider.name} • ${type === 'movie' ? 'Filmes' : 'Séries'}`,
            extra: [
                {
                    name: 'genre',
                    isRequired: false,
                    options: GENRES[type].map(([id, name]) => ({
                        id,
                        name
                    }))
                },
                {
                    name: 'skip',
                    isRequired: false
                }
            ]
        });
    }
}

// ============================================================
// MANIFEST — SOMENTE CATÁLOGO
// ============================================================

const MANIFEST = {
    id: 'br.netcine.catalog',
    version: '2.0.0',
    name: 'NetCine Catálogo',
    description: 'Catálogo organizado por serviços de streaming. Somente catálogo e metadados.',
    logo: PROVIDERS[0].logo,
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs: manifestCatalogs
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

app.get('/', (req, res) => {
    res.json({
        name: 'NetCine Catálogo',
        status: 'online',
        mode: 'catalog-only',
        resources: ['catalog']
    });
});

// ============================================================
// TMDB
// ============================================================

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function tmdb(path, params = {}) {
    const query = new URLSearchParams({
        api_key: TMDB_KEY,
        language: LANGUAGE,
        watch_region: REGION,
        ...params
    });

    const url = `${TMDB_BASE}${path}?${query.toString()}`;
    const key = url;

    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.data;
    }

    const response = await fetch(url, {
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`TMDB HTTP ${response.status}`);
    }

    const data = await response.json();
    cache.set(key, { data, ts: Date.now() });

    return data;
}

function image(path, size = 'w500') {
    return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

function toMeta(item, type, provider) {
    const title = type === 'movie'
        ? item.title
        : item.name;

    const originalTitle = type === 'movie'
        ? item.original_title
        : item.original_name;

    const date = type === 'movie'
        ? item.release_date
        : item.first_air_date;

    const imdbId = item.external_ids?.imdb_id || null;

    return {
        id: `tmdb:${item.id}`,
        type,
        name: title || originalTitle || 'Sem título',
        poster: image(item.poster_path),
        background: image(item.backdrop_path, 'w1280'),
        description: item.overview || '',
        releaseInfo: date ? date.slice(0, 4) : '',
        imdbRating: typeof item.vote_average === 'number'
            ? Number(item.vote_average.toFixed(1))
            : undefined,
        genres: Array.isArray(item.genre_ids) ? item.genre_ids : [],
        posterShape: 'poster',
        behaviorHints: {
            defaultVideoId: `tmdb:${item.id}`
        },
        // Campo extra para o organizador identificar o provedor.
        netcineProvider: provider.id,
        netcineProviderName: provider.name
    };
}

function getProvider(req) {
    const { provider } = req.params;
    return PROVIDERS.find(p => p.id === provider);
}

// ============================================================
// CATALOG ENDPOINT
//
// Formato:
// /catalog/:type/:provider.json
// /catalog/:type/:provider/:extra.json
// ============================================================

async function catalogHandler(req, res) {
    const { type, provider } = req.params;
    const providerInfo = getProvider(req);

    if (!providerInfo || !['movie', 'series'].includes(type)) {
        return res.status(404).json({ metas: [] });
    }

    const skip = Math.max(0, parseInt(req.query.skip || '0', 10) || 0);
    const genre = req.query.genre || 'all';

    const params = {
        with_watch_providers: String(providerInfo.tmdbId),
        watch_region: REGION,
        with_watch_monetization_types: 'flatrate',
        page: String(Math.floor(skip / 20) + 1),
        sort_by: 'popularity.desc'
    };

    if (genre !== 'all') {
        params.with_genres = genre;
    }

    try {
        const path = type === 'movie'
            ? '/discover/movie'
            : '/discover/tv';

        const data = await tmdb(path, params);

        const metas = (data.results || []).map(item =>
            toMeta(item, type, providerInfo)
        );

        res.json({
            metas
        });
    } catch (error) {
        console.error('[NetCine Catalog] TMDB:', error.message);
        res.status(200).json({ metas: [] });
    }
}

// Rotas para o formato padrão do ecossistema de addons.
app.get('/catalog/:type/:provider.json', catalogHandler);
app.get('/catalog/:type/:provider/:extra.json', catalogHandler);

// Também aceita a forma:
// /catalog/:type/:provider/:id.json
app.get('/catalog/:type/:provider/:id.json', catalogHandler);

// ============================================================
// LIMPEZA DO CACHE
// ============================================================

setInterval(() => {
    const now = Date.now();

    for (const [key, value] of cache) {
        if (now - value.ts > CACHE_TTL) {
            cache.delete(key);
        }
    }
}, 5 * 60 * 1000);

// ============================================================
// SERVER
// ============================================================

app.listen(PORT, () => {
    console.log('========================================');
    console.log('NetCine Catálogo iniciado');
    console.log('Porta:', PORT);
    console.log('Modo: SOMENTE CATÁLOGO');
    console.log('Serviços:', PROVIDERS.map(p => p.name).join(', '));
    console.log('========================================');
});
