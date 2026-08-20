const express = require('express');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 8080;
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
// SERVIÇOS DE STREAMING
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

// ============================================================
// GÊNEROS
// ============================================================

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

// ============================================================
// MANIFEST
// SOMENTE CATÁLOGO
// ============================================================

const catalogs = [];

for (const provider of PROVIDERS) {
    catalogs.push({
        id: `${provider.id}_movie`,
        type: 'movie',
        name: `${provider.name} • Filmes`,
        extra: [
            {
                name: 'genre',
                isRequired: false,
                options: GENRES.movie.map(item => item[1])
            },
            {
                name: 'skip',
                isRequired: false
            }
        ]
    });

    catalogs.push({
        id: `${provider.id}_series`,
        type: 'series',
        name: `${provider.name} • Séries`,
        extra: [
            {
                name: 'genre',
                isRequired: false,
                options: GENRES.series.map(item => item[1])
            },
            {
                name: 'skip',
                isRequired: false
            }
        ]
    });
}

const MANIFEST = {
    id: 'br.netcine.catalog',
    version: '2.1.2',
    name: 'NetCine',
    description: 'Catálogo de filmes e séries organizado por serviços de streaming.',
    logo: PROVIDERS[0].logo,

    resources: [
        'catalog'
    ],

    types: [
        'movie',
        'series'
    ],

    catalogs
};

// ============================================================
// ROTAS BÁSICAS
// ============================================================

app.get('/', (req, res) => {
    res.json({
        name: 'NetCine',
        status: 'online',
        mode: 'catalog-only',
        resources: ['catalog'],
        region: REGION,
        providers: PROVIDERS.map(provider => provider.name)
    });
});

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// ============================================================
// CACHE TMDB
// ============================================================

const cache = new Map();

const CACHE_TTL = 10 * 60 * 1000;

async function tmdb(path, params = {}) {

    const query = new URLSearchParams({
        api_key: TMDB_KEY,
        language: LANGUAGE,
        ...params
    });

    const url = `${TMDB_BASE}${path}?${query.toString()}`;

    const cached = cache.get(url);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
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

    cache.set(url, {
        data,
        timestamp: Date.now()
    });

    return data;
}

// ============================================================
// IMAGENS
// ============================================================

function image(path, size = 'w500') {

    if (!path) {
        return null;
    }

    return `https://image.tmdb.org/t/p/${size}${path}`;
}

// ============================================================
// GÊNERO
// Converte o nome recebido pelo Nuvio para o ID do TMDB
// ============================================================

function getGenreId(type, value) {

    if (!value) {
        return 'all';
    }

    const normalized = String(value)
        .trim()
        .toLowerCase();

    const genres = GENRES[type] || [];

    const found = genres.find(item =>
        item[0].toLowerCase() === normalized ||
        item[1].toLowerCase() === normalized
    );

    return found ? found[0] : 'all';
}

// ============================================================
// METADADOS
// ============================================================

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

    return {
        id: `tmdb:${item.id}`,

        type,

        name: title || originalTitle || 'Sem título',

        poster: image(item.poster_path, 'w500'),

        background: image(item.backdrop_path, 'w1280'),

        description: item.overview || '',

        releaseInfo: date
            ? date.substring(0, 4)
            : '',

        imdbRating:
            typeof item.vote_average === 'number'
                ? Number(item.vote_average.toFixed(1))
                : undefined,

        genres: Array.isArray(item.genre_ids)
            ? item.genre_ids
            : [],

        posterShape: 'poster',

        behaviorHints: {
            defaultVideoId: `tmdb:${item.id}`
        },

        netcineProvider: provider.id,

        netcineProviderName: provider.name
    };
}

// ============================================================
// PROVIDER
// ============================================================

function getProvider(providerId) {

    return PROVIDERS.find(
        provider => provider.id === providerId
    );
}

// ============================================================
// CATÁLOGO
// ============================================================

async function catalogHandler(req, res) {

    const type = req.params.type;
    const providerId = req.params.provider;

    const provider = getProvider(providerId);

    if (
        !provider ||
        (type !== 'movie' && type !== 'series')
    ) {
        return res.json({
            metas: []
        });
    }

    const skip = Math.max(
        0,
        parseInt(req.query.skip || '0', 10) || 0
    );

    const requestedGenre =
        req.query.genre || 'all';

    const genre = getGenreId(
        type,
        requestedGenre
    );

    const page =
        Math.floor(skip / 20) + 1;

    const params = {

        watch_region: REGION,

        with_watch_providers:
            String(provider.tmdbId),

        with_watch_monetization_types:
            'flatrate',

        sort_by:
            'popularity.desc',

        page:
            String(page)
    };

    if (genre !== 'all') {
        params.with_genres = genre;
    }

    try {

        const path =
            type === 'movie'
                ? '/discover/movie'
                : '/discover/tv';

        const data = await tmdb(
            path,
            params
        );

        const results =
            Array.isArray(data.results)
                ? data.results
                : [];

        const metas =
            results.map(item =>
                toMeta(
                    item,
                    type,
                    provider
                )
            );

        return res.json({
            metas
        });

    } catch (error) {

        console.error(
            '[NetCine] Erro TMDB:',
            error.message
        );

        return res.json({
            metas: []
        });
    }
}

// ============================================================
// ROTAS DE CATÁLOGO
// ============================================================

app.get(
    '/catalog/:type/:provider.json',
    catalogHandler
);

app.get(
    '/catalog/:type/:provider/:extra.json',
    catalogHandler
);

// ============================================================
// LIMPEZA DO CACHE
// ============================================================

setInterval(() => {

    const now = Date.now();

    for (const [key, value] of cache.entries()) {

        if (
            now - value.timestamp >
            CACHE_TTL
        ) {
            cache.delete(key);
        }
    }

}, 5 * 60 * 1000);

// ============================================================
// SERVIDOR
// ============================================================

app.listen(PORT, () => {

    console.log('========================================');
    console.log('NetCine Catálogo iniciado');
    console.log('Porta:', PORT);
    console.log('Modo: SOMENTE CATÁLOGO');
    console.log('Região:', REGION);
    console.log(
        'TMDB_KEY:',
        TMDB_KEY ? 'CONFIGURADA' : 'AUSENTE'
    );
    console.log(
        'Serviços:',
        PROVIDERS
            .map(provider => provider.name)
            .join(', ')
    );
    console.log('========================================');

});