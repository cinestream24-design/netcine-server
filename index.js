const express = require('express');

const app = express();

const PORT = process.env.PORT || 8080;

const TMDB_KEY = process.env.TMDB_KEY;

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

const LANGUAGE = 'pt-BR';
const REGION = 'BR';


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
        ['53', 'Thriller'],
        ['10749', 'Romance'],
        ['36', 'História'],
        ['9648', 'Mistério'],
        ['10752', 'Guerra'],
        ['37', 'Faroeste']
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
        ['10768', 'Guerra e política'],
        ['10763', 'Notícias'],
        ['10764', 'Reality'],
        ['10766', 'Novela'],
        ['10767', 'Talk show']
    ]
};


// ============================================================
// CACHE
// ============================================================

const cache = new Map();

const CACHE_TTL = 10 * 60 * 1000;

const MAX_CACHE_ITEMS = 500;


// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

function cleanCache() {

    const now = Date.now();

    for (const [key, value] of cache) {

        if (now - value.time > CACHE_TTL) {
            cache.delete(key);
        }
    }

    while (cache.size > MAX_CACHE_ITEMS) {

        const firstKey = cache.keys().next().value;

        if (!firstKey) break;

        cache.delete(firstKey);
    }
}


setInterval(cleanCache, 5 * 60 * 1000);


// ============================================================
// TMDB
// ============================================================

async function tmdb(path, params = {}) {

    if (!TMDB_KEY) {
        throw new Error('TMDB_KEY não configurada');
    }

    const query = new URLSearchParams();

    query.set('api_key', TMDB_KEY);
    query.set('language', LANGUAGE);
    query.set('watch_region', REGION);

    for (const [key, value] of Object.entries(params)) {

        if (
            value !== undefined &&
            value !== null &&
            value !== ''
        ) {
            query.set(key, String(value));
        }
    }

    const url =
        `${TMDB_BASE}${path}?${query.toString()}`;

    const cached = cache.get(url);

    if (
        cached &&
        Date.now() - cached.time < CACHE_TTL
    ) {
        return cached.data;
    }

    const response = await fetch(url, {
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {

        throw new Error(
            `TMDB HTTP ${response.status}`
        );
    }

    const data = await response.json();

    cache.set(url, {
        time: Date.now(),
        data
    });

    return data;
}


// ============================================================
// IMAGENS
// ============================================================

function poster(path) {

    if (!path) {
        return null;
    }

    return `${IMAGE_BASE}/w500${path}`;
}


function background(path) {

    if (!path) {
        return null;
    }

    return `${IMAGE_BASE}/w1280${path}`;
}


// ============================================================
// METADATA
// ============================================================

function convertItem(item, type, provider = null) {

    const isMovie = type === 'movie';

    const title = isMovie
        ? item.title
        : item.name;

    const originalTitle = isMovie
        ? item.original_title
        : item.original_name;

    const releaseDate = isMovie
        ? item.release_date
        : item.first_air_date;

    const meta = {

        id: `tmdb:${item.id}`,

        type,

        name:
            title ||
            originalTitle ||
            'Sem título',

        poster:
            poster(item.poster_path),

        background:
            background(item.backdrop_path),

        description:
            item.overview || '',

        releaseInfo:
            releaseDate
                ? releaseDate.substring(0, 4)
                : '',

        posterShape:
            'poster',

        behaviorHints: {
            defaultVideoId:
                `tmdb:${item.id}`
        }
    };


    if (
        typeof item.vote_average === 'number'
    ) {

        meta.imdbRating =
            Number(
                item.vote_average.toFixed(1)
            );
    }


    if (
        Array.isArray(item.genre_ids)
    ) {

        meta.genres =
            item.genre_ids;
    }


    if (provider) {

        meta.netcineProvider =
            provider.id;

        meta.netcineProviderName =
            provider.name;
    }


    return meta;
}


// ============================================================
// CONFIGURAÇÃO DOS TIPOS DE CATÁLOGO
// ============================================================

const CATALOG_TYPES = [

    {
        id: 'popular',
        name: '🔥 Populares',
        sort: 'popularity.desc'
    },

    {
        id: 'top',
        name: '⭐ Mais bem avaliados',
        sort: 'vote_average.desc',
        extra: {
            'vote_count.gte': 100
        }
    },

    {
        id: 'trending',
        name: '📈 Em alta',
        sort: 'popularity.desc',
        extra: {
            'vote_count.gte': 10
        }
    },

    {
        id: 'recent',
        name: '🆕 Recentes',
        sort: 'primary_release_date.desc'
    },

    {
        id: 'featured',
        name: '🎬 Destaques',
        sort: 'vote_average.desc',
        extra: {
            'vote_count.gte': 50
        }
    }
];


// ============================================================
// MANIFEST CATALOGS
// ============================================================

const catalogs = [];


// ------------------------------------------------------------
// CATÁLOGOS POR SERVIÇO
// ------------------------------------------------------------

for (const provider of PROVIDERS) {

    for (const type of ['movie', 'series']) {

        const typeName =
            type === 'movie'
                ? 'Filmes'
                : 'Séries';


        // Catálogo principal
        catalogs.push({

            id:
                `${provider.id}_${type}`,

            type,

            name:
                `${provider.name} • ${typeName}`,

            extra: [

                {
                    name: 'genre',

                    isRequired: false,

                    options:
                        GENRES[type].map(
                            item => item[0]
                        )
                },

                {
                    name: 'skip',

                    isRequired: false
                }
            ]
        });


        // Categorias
        for (
            const category
            of CATALOG_TYPES
        ) {

            catalogs.push({

                id:
                    `${provider.id}_${type}_${category.id}`,

                type,

                name:
                    `${provider.name} • ${category.name}`,

                extra: [

                    {
                        name: 'genre',

                        isRequired: false,

                        options:
                            GENRES[type].map(
                                item => item[0]
                            )
                    },

                    {
                        name: 'skip',

                        isRequired: false
                    }
                ]
            });
        }
    }
}


// ============================================================
// CATÁLOGOS GERAIS
// ============================================================

catalogs.push({

    id: 'all_movies',

    type: 'movie',

    name: '🔥 Filmes • Populares',

    extra: [
        {
            name: 'genre',
            isRequired: false,
            options:
                GENRES.movie.map(
                    item => item[0]
                )
        },
        {
            name: 'skip',
            isRequired: false
        }
    ]
});


catalogs.push({

    id: 'all_series',

    type: 'series',

    name: '🔥 Séries • Populares',

    extra: [
        {
            name: 'genre',
            isRequired: false,
            options:
                GENRES.series.map(
                    item => item[0]
                )
        },
        {
            name: 'skip',
            isRequired: false
        }
    ]
});


// ============================================================
// MANIFEST
// ============================================================

const MANIFEST = {

    id: 'br.netcine.catalog',

    version: '2.3.0',

    name: 'NetCine',

    description:
        'Catálogo completo de filmes e séries organizado por serviços de streaming.',

    logo:
        PROVIDERS[0].logo,

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
// MANIFEST.JSON
// ============================================================

app.get('/manifest.json', (req, res) => {

    res.setHeader(
        'Content-Type',
        'application/json; charset=utf-8'
    );

    res.json(MANIFEST);
});


// ============================================================
// HOME / STATUS
// ============================================================

app.get('/', (req, res) => {

    res.json({

        name: 'NetCine',

        version: '2.3.0',

        status: 'online',

        mode: 'catalog-only',

        region: REGION,

        tmdb:
            TMDB_KEY
                ? 'configured'
                : 'missing',

        providers:
            PROVIDERS.length,

        catalogs:
            catalogs.length,

        resources: [
            'catalog'
        ]
    });
});


// ============================================================
// LOCALIZAR SERVIÇO
// ============================================================

function findProvider(id) {

    return PROVIDERS.find(
        provider =>
            provider.id === id
    );
}


// ============================================================
// IDENTIFICAR CATEGORIA
// ============================================================

function findCategory(id) {

    return CATALOG_TYPES.find(
        category =>
            category.id === id
    );
}


// ============================================================
// DESCOBRIR CONFIGURAÇÃO PELO ID
// ============================================================

function parseCatalogId(catalogId) {

    if (!catalogId) {
        return null;
    }


    // --------------------------------------------------------
    // Catálogos gerais
    // --------------------------------------------------------

    if (catalogId === 'all_movies') {

        return {
            type: 'movie',
            provider: null,
            category: null
        };
    }


    if (catalogId === 'all_series') {

        return {
            type: 'series',
            provider: null,
            category: null
        };
    }


    // --------------------------------------------------------
    // Serviço
    // --------------------------------------------------------

    for (const provider of PROVIDERS) {

        const movieBase =
            `${provider.id}_movie`;

        const seriesBase =
            `${provider.id}_series`;


        if (catalogId === movieBase) {

            return {
                type: 'movie',
                provider,
                category: null
            };
        }


        if (catalogId === seriesBase) {

            return {
                type: 'series',
                provider,
                category: null
            };
        }


        for (
            const category
            of CATALOG_TYPES
        ) {

            if (
                catalogId ===
                `${provider.id}_movie_${category.id}`
            ) {

                return {
                    type: 'movie',
                    provider,
                    category
                };
            }


            if (
                catalogId ===
                `${provider.id}_series_${category.id}`
            ) {

                return {
                    type: 'series',
                    provider,
                    category
                };
            }
        }
    }


    return null;
}


// ============================================================
// MONTAR PARÂMETROS DISCOVER
// ============================================================

function buildDiscoverParams(
    type,
    provider,
    category,
    genre,
    page
) {

    const params = {

        page,

        sort_by:
            category?.sort ||
            'popularity.desc'
    };


    // --------------------------------------------------------
    // Serviço de streaming
    // --------------------------------------------------------

    if (provider) {

        params.with_watch_providers =
            provider.tmdbId;

        params.watch_region =
            REGION;

        params.with_watch_monetization_types =
            'flatrate';
    }


    // --------------------------------------------------------
    // Gênero
    // --------------------------------------------------------

    if (
        genre &&
        genre !== 'all'
    ) {

        params.with_genres =
            genre;
    }


    // --------------------------------------------------------
    // Categoria "Mais bem avaliados"
    // --------------------------------------------------------

    if (
        category?.extra
    ) {

        Object.assign(
            params,
            category.extra
        );
    }


    // --------------------------------------------------------
    // Recentes
    // --------------------------------------------------------

    if (
        category?.id === 'recent'
    ) {

        const now =
            new Date();

        const currentYear =
            now.getUTCFullYear();

        const currentMonth =
            String(
                now.getUTCMonth() + 1
            ).padStart(2, '0');

        const currentDay =
            String(
                now.getUTCDate()
            ).padStart(2, '0');


        const today =
            `${currentYear}-${currentMonth}-${currentDay}`;


        if (type === 'movie') {

            params['primary_release_date.lte'] =
                today;
        }
        else {

            params['first_air_date.lte'] =
                today;
        }


        params['vote_count.gte'] =
            5;
    }


    return params;
}


// ============================================================
// HANDLER PRINCIPAL
// ============================================================

async function catalogHandler(req, res) {

    const catalogId =
        req.params.catalogId ||
        req.params.provider;


    const type =
        req.params.type;


    let config =
        parseCatalogId(
            catalogId
        );


    // --------------------------------------------------------
    // Compatibilidade com rota antiga
    // /catalog/movie/netflix.json
    // --------------------------------------------------------

    if (!config) {

        const provider =
            findProvider(
                req.params.provider
            );


        if (
            provider &&
            ['movie', 'series']
                .includes(type)
        ) {

            config = {

                type,

                provider,

                category: null
            };
        }
    }


    if (!config) {

        return res.json({
            metas: []
        });
    }


    const requestedType =
        config.type;


    let skip =
        parseInt(
            req.query.skip || '0',
            10
        );


    if (
        Number.isNaN(skip) ||
        skip < 0
    ) {

        skip = 0;
    }


    const genre =
        req.query.genre ||
        'all';


    const page =
        Math.floor(skip / 20) + 1;


    const params =
        buildDiscoverParams(
            requestedType,
            config.provider,
            config.category,
            genre,
            page
        );


    try {

        const endpoint =
            requestedType === 'movie'
                ? '/discover/movie'
                : '/discover/tv';


        const data =
            await tmdb(
                endpoint,
                params
            );


        let results =
            Array.isArray(
                data.results
            )
                ? data.results
                : [];


        // ----------------------------------------------------
        // Remover itens sem poster
        // ----------------------------------------------------

        results =
            results.filter(
                item =>
                    item.poster_path
            );


        // ----------------------------------------------------
        // Converter para formato Nuvio/Stremio
        // ----------------------------------------------------

        const metas =
            results.map(
                item =>
                    convertItem(
                        item,
                        requestedType,
                        config.provider
                    )
            );


        res.json({
            metas
        });


    } catch (error) {

        console.error(
            '[NetCine Catalog]',
            error.message
        );


        res.status(200).json({
            metas: []
        });
    }
}


// ============================================================
// ROTAS
// ============================================================


// ------------------------------------------------------------
// NOVO FORMATO
// /catalog/movie/netflix_movie_popular.json
// ------------------------------------------------------------

app.get(
    '/catalog/:type/:catalogId.json',
    catalogHandler
);


// ------------------------------------------------------------
// Formato com extra
// ------------------------------------------------------------

app.get(
    '/catalog/:type/:catalogId/:extra.json',
    catalogHandler
);


// ------------------------------------------------------------
// Compatibilidade
// ------------------------------------------------------------

app.get(
    '/catalog/:type/:provider/:extra/:id.json',
    catalogHandler
);


// ============================================================
// ERROS
// ============================================================

app.use(
    (err, req, res, next) => {

        console.error(
            '[NetCine Server]',
            err
        );

        res.status(200).json({
            metas: []
        });
    }
);


// ============================================================
// SERVIDOR
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            '========================================'
        );

        console.log(
            'NetCine Catálogo 2.3.0'
        );

        console.log(
            '========================================'
        );

        console.log(
            'Porta:',
            PORT
        );

        console.log(
            'Modo:',
            'SOMENTE CATÁLOGO'
        );

        console.log(
            'Região:',
            REGION
        );

        console.log(
            'TMDB_KEY:',
            TMDB_KEY
                ? 'CONFIGURADA'
                : 'AUSENTE'
        );

        console.log(
            'Serviços:',
            PROVIDERS.length
        );

        console.log(
            'Catálogos:',
            catalogs.length
        );

        console.log(
            '========================================'
        );
    }
);