const express = require('express');
const fetch = require('node-fetch');

const app = express();

const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_KEY;

const TMDB_BASE = 'https://api.themoviedb.org/3';
const LANGUAGE = 'pt-BR';
const REGION = 'BR';

if (!TMDB_KEY) {
    console.error('ERRO: TMDB_KEY não configurada.');
}

// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, OPTIONS'
    );

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

// ============================================================
// CONFIGURAÇÃO DOS STREAMINGS (EXPANDIDA)
// ============================================================

const PROVIDERS = [
    {
        id: 'netflix',
        name: 'Netflix',
        tmdbId: 8
    },
    {
        id: 'prime',
        name: 'Prime Video',
        tmdbId: 119
    },
    {
        id: 'disney',
        name: 'Disney+',
        tmdbId: 337
    },
    {
        id: 'max',
        name: 'Max',
        tmdbId: 1899
    },
    {
        id: 'apple',
        name: 'Apple TV+',
        tmdbId: 350
    },
    {
        id: 'paramount',
        name: 'Paramount+',
        tmdbId: 531
    },
    {
        id: 'globoplay',
        name: 'Globoplay',
        tmdbId: 307
    },
    {
        id: 'crunchyroll',
        name: 'Crunchyroll',
        tmdbId: 521
    },
    {
        id: 'telecine',
        name: 'Telecine',
        tmdbId: 190
    },
    {
        id: 'agoratv',
        name: 'Agora TV',
        tmdbId: 278
    },
    {
        id: 'now',
        name: 'NOW',
        tmdbId: 1446
    },
    {
        id: 'clarotv',
        name: 'Claro TV+',
        tmdbId: 1801
    },
    {
        id: 'vivoplay',
        name: 'Vivo Play',
        tmdbId: 1449
    },
    {
        id: 'plutotv',
        name: 'Pluto TV',
        tmdbId: 34
    },
    {
        id: 'plex',
        name: 'Plex',
        tmdbId: 1191
    },
    {
        id: 'roku',
        name: 'Roku Channel',
        tmdbId: 1963
    },
    {
        id: 'hulu',
        name: 'Hulu',
        tmdbId: 1481
    },
    {
        id: 'filmrise',
        name: 'FilmRise',
        tmdbId: 1873
    }
];

// ============================================================
// GÊNEROS DE FILMES
// ============================================================

const MOVIE_GENRES = [
    ['all', 'Todos os gêneros'],
    ['28', 'Ação'],
    ['12', 'Aventura'],
    ['16', 'Animação'],
    ['35', 'Comédia'],
    ['80', 'Crime'],
    ['99', 'Documentário'],
    ['18', 'Drama'],
    ['10751', 'Família'],
    ['14', 'Fantasia'],
    ['36', 'História'],
    ['27', 'Terror'],
    ['10402', 'Música'],
    ['9648', 'Mistério'],
    ['10749', 'Romance'],
    ['878', 'Ficção científica'],
    ['10770', 'Cinema TV'],
    ['53', 'Thriller'],
    ['10752', 'Guerra'],
    ['37', 'Faroeste']
];

// ============================================================
// GÊNEROS DE SÉRIES
// ============================================================

const SERIES_GENRES = [
    ['all', 'Todos os gêneros'],
    ['10759', 'Ação e aventura'],
    ['16', 'Animação'],
    ['35', 'Comédia'],
    ['80', 'Crime'],
    ['99', 'Documentário'],
    ['18', 'Drama'],
    ['10751', 'Família'],
    ['10762', 'Infantil'],
    ['9648', 'Mistério'],
    ['10763', 'Notícias'],
    ['10764', 'Reality'],
    ['10765', 'Ficção científica e fantasia'],
    ['10766', 'Novela'],
    ['10767', 'Talk show'],
    ['10768', 'Guerra e política'],
    ['37', 'Faroeste']
];

// ============================================================
// ANOS
// ============================================================

const CURRENT_YEAR = new Date().getFullYear();

const YEARS = [];

for (let year = CURRENT_YEAR; year >= 2000; year--) {
    YEARS.push(String(year));
}

// ============================================================
// TIPOS PRINCIPAIS
// ============================================================

const CATEGORIES = [
    {
        id: 'movies',
        name: 'Filmes',
        type: 'movie'
    },
    {
        id: 'series',
        name: 'Séries',
        type: 'series'
    },
    {
        id: 'anime',
        name: 'Animes',
        type: 'series'
    },
    {
        id: 'kids',
        name: 'Desenhos Infantis',
        type: 'series'
    },
    {
        id: 'doramas',
        name: 'Doramas',
        type: 'series'
    }
];

// ============================================================
// FUNÇÃO PARA TRANSFORMAR OPTIONS EM STRINGS
//
// IMPORTANTE:
// O Nuvio/Stremio espera:
// options: ["Ação", "Comédia"]
//
// E NÃO:
// options: [{ id: "28", name: "Ação" }]
// ============================================================

function optionsFrom(list) {
    return list.map(item => item[1]);
}

// ============================================================
// MANIFEST
// ============================================================

const catalogs = [];

for (const provider of PROVIDERS) {

    for (const category of CATEGORIES) {

        const genres =
            category.id === 'movies'
                ? MOVIE_GENRES
                : SERIES_GENRES;

        catalogs.push({
            id: `${provider.id}_${category.id}`,
            type: category.type,
            name: `${provider.name} • ${category.name}`,
            extra: [
                {
                    name: 'genre',
                    isRequired: false,
                    options: optionsFrom(genres),
                    optionsLimit: 1
                },
                {
                    name: 'year',
                    isRequired: false,
                    options: YEARS,
                    optionsLimit: 1
                },
                {
                    name: 'search',
                    isRequired: false
                },
                {
                    name: 'skip',
                    isRequired: false
                }
            ]
        });

    }
}

const MANIFEST = {
    id: 'br.netcine.catalog',
    version: '2.5.0',
    name: 'NetCine',
    description:
        'Catálogo brasileiro de filmes, séries, animes, desenhos infantis e doramas organizado por serviço de streaming.',
    logo:
        'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1.png',

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
// MANIFEST
// ============================================================

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// ============================================================
// HOME / STATUS
// ============================================================

app.get('/', (req, res) => {

    res.json({
        name: 'NetCine',
        version: '2.5.0',
        status: 'online',
        mode: 'catalog-only',
        region: REGION,
        catalogs: catalogs.length,
        providers: PROVIDERS.map(p => p.name),
        categories: CATEGORIES.map(c => c.name)
    });

});

// ============================================================
// CACHE
// ============================================================

const cache = new Map();

const CACHE_TTL = 10 * 60 * 1000;

function getCache(key) {

    const item = cache.get(key);

    if (!item) {
        return null;
    }

    if (Date.now() - item.timestamp > CACHE_TTL) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function setCache(key, data) {

    cache.set(key, {
        data,
        timestamp: Date.now()
    });

}

// ============================================================
// TMDB REQUEST
// ============================================================

async function tmdb(path, params = {}) {

    if (!TMDB_KEY) {
        throw new Error('TMDB_KEY não configurada');
    }

    const query = new URLSearchParams({
        api_key: TMDB_KEY,
        language: LANGUAGE,
        watch_region: REGION,
        include_adult: 'false',
        ...params
    });

    const url =
        `${TMDB_BASE}${path}?${query.toString()}`;

    const cached = getCache(url);

    if (cached) {
        return cached;
    }

    const response = await fetch(url, {
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        const text = await response.text();

        throw new Error(
            `TMDB HTTP ${response.status}: ${text}`
        );
    }

    const data = await response.json();

    setCache(url, data);

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
// LOCALIZAR PROVIDER
// ============================================================

function getProvider(providerId) {

    return PROVIDERS.find(
        provider => provider.id === providerId
    );

}

// ============================================================
// LOCALIZAR CATEGORIA
// ============================================================

function getCategory(categoryId) {

    return CATEGORIES.find(
        category => category.id === categoryId
    );

}

// ============================================================
// CONVERTER ITEM TMDB PARA META
// ============================================================

function toMeta(item, type, provider, category) {

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

    const year =
        releaseDate
            ? releaseDate.substring(0, 4)
            : '';

    const genres =
        Array.isArray(item.genre_ids)
            ? item.genre_ids
            : [];

    return {

        id: `tmdb:${item.id}`,

        type,

        name:
            title ||
            originalTitle ||
            'Sem título',

        poster:
            image(item.poster_path, 'w500'),

        background:
            image(item.backdrop_path, 'w1280'),

        description:
            item.overview || '',

        releaseInfo:
            year,

        imdbRating:
            typeof item.vote_average === 'number'
                ? Number(item.vote_average.toFixed(1))
                : undefined,

        genres,

        posterShape: 'poster',

        behaviorHints: {
            defaultVideoId:
                `tmdb:${item.id}`
        },

        netcineProvider:
            provider.id,

        netcineProviderName:
            provider.name,

        netcineCategory:
            category.id,

        netcineCategoryName:
            category.name

    };

}

// ============================================================
// FILTRAGEM ESPECIAL
// ============================================================

function applyCategoryFilters(params, category) {

    // --------------------------------------------------------
    // ANIMES
    // --------------------------------------------------------

    if (category.id === 'anime') {

        // Animação + Japão
        params.with_genres = '16';
        params.with_original_language = 'ja';

    }

    // --------------------------------------------------------
    // DESENHOS INFANTIS
    // --------------------------------------------------------

    else if (category.id === 'kids') {

        // Animação + Família
        params.with_genres = '16,10751';

    }

    // --------------------------------------------------------
    // DORAMAS
    // --------------------------------------------------------

    else if (category.id === 'doramas') {

        // Drama + países asiáticos
        params.with_genres = '18';

        params.with_origin_country =
            'KR|JP|CN|TW';

    }

}

// ============================================================
// GÊNERO
// ============================================================

function getGenreId(category, genreName) {

    if (!genreName) {
        return null;
    }

    if (
        genreName === 'Todos os gêneros' ||
        genreName === 'all'
    ) {
        return null;
    }

    const genres =
        category.id === 'movies'
            ? MOVIE_GENRES
            : SERIES_GENRES;

    const found =
        genres.find(
            genre => genre[1] === genreName
        );

    return found
        ? found[0]
        : null;

}

// ============================================================
// CATÁLOGO
// ============================================================

async function catalogHandler(req, res) {

    try {

        const {
            type,
            id
        } = req.params;

        const catalogId = id;

        // ----------------------------------------------------
        // IDENTIFICAR CATÁLOGO
        // ----------------------------------------------------

        const catalog = catalogs.find(
            c => c.id === catalogId
        );

        if (!catalog) {

            return res.json({
                metas: []
            });

        }

        // ----------------------------------------------------
        // PROVIDER
        // ----------------------------------------------------

        const parts =
            catalogId.split('_');

        const categoryId =
            parts[parts.length - 1];

        const providerId =
            catalogId.substring(
                0,
                catalogId.length -
                categoryId.length -
                1
            );

        const provider =
            getProvider(providerId);

        const category =
            getCategory(categoryId);

        if (!provider || !category) {

            return res.json({
                metas: []
            });

        }

        // ----------------------------------------------------
        // PAGINAÇÃO
        // ----------------------------------------------------

        const skip =
            Math.max(
                0,
                parseInt(
                    req.query.skip || '0',
                    10
                ) || 0
            );

        const page =
            Math.floor(skip / 20) + 1;

        // ----------------------------------------------------
        // FILTROS
        // ----------------------------------------------------

        const genre =
            req.query.genre || '';

        const year =
            req.query.year || '';

        const search =
            req.query.search || '';

        // ----------------------------------------------------
        // BUSCA
        // ----------------------------------------------------

        if (search.trim()) {

            const searchPath =
                category.type === 'movie'
                    ? '/search/movie'
                    : '/search/tv';

            const searchData =
                await tmdb(
                    searchPath,
                    {
                        query: search.trim(),
                        page: String(page),
                        region: REGION
                    }
                );

            let results =
                searchData.results || [];

            // ------------------------------------------------
            // FILTRO POR ANO
            // ------------------------------------------------

            if (year) {

                results =
                    results.filter(item => {

                        const date =
                            category.type === 'movie'
                                ? item.release_date
                                : item.first_air_date;

                        return date &&
                            date.startsWith(year);

                    });

            }

            const metas =
                results.map(item =>
                    toMeta(
                        item,
                        category.type,
                        provider,
                        category
                    )
                );

            return res.json({
                metas
            });

        }

        // ----------------------------------------------------
        // DISCOVER
        // ----------------------------------------------------

        const path =
            category.type === 'movie'
                ? '/discover/movie'
                : '/discover/tv';

        const params = {

            page: String(page),

            watch_region: REGION,

            with_watch_providers:
                String(provider.tmdbId),

            with_watch_monetization_types:
                'flatrate',

            include_adult:
                'false'

        };

        // ----------------------------------------------------
        // MAIS RECENTES PRIMEIRO
        // ----------------------------------------------------

        if (category.type === 'movie') {

            params.sort_by =
                'primary_release_date.desc';

        } else {

            params.sort_by =
                'first_air_date.desc';

        }

        // ----------------------------------------------------
        // ANO
        // ----------------------------------------------------

        if (year) {

            if (category.type === 'movie') {

                params.primary_release_year =
                    year;

            } else {

                params.first_air_date_year =
                    year;

            }

        }

        // ----------------------------------------------------
        // GÊNERO
        // ----------------------------------------------------

        const genreId =
            getGenreId(
                category,
                genre
            );

        if (genreId) {

            params.with_genres =
                genreId;

        }

        // ----------------------------------------------------
        // FILTROS ESPECIAIS
        // ----------------------------------------------------

        applyCategoryFilters(
            params,
            category
        );

        // ----------------------------------------------------
        // CORREÇÃO DE GÊNERO
        //
        // Se o usuário escolheu gênero, ele tem prioridade
        // sobre os filtros especiais apenas quando necessário.
        // ----------------------------------------------------

        if (
            genreId &&
            category.id === 'anime'
        ) {

            params.with_genres =
                `16,${genreId}`;

        }

        // ----------------------------------------------------
        // CONSULTA
        // ----------------------------------------------------

        const data =
            await tmdb(
                path,
                params
            );

        let results =
            data.results || [];

        // ----------------------------------------------------
        // FILTRO DE SEGURANÇA
        // ----------------------------------------------------

        results =
            results.filter(item => {

                const date =
                    category.type === 'movie'
                        ? item.release_date
                        : item.first_air_date;

                return Boolean(date);

            });

        // ----------------------------------------------------
        // METAS
        // ----------------------------------------------------

        const metas =
            results.map(item =>
                toMeta(
                    item,
                    category.type,
                    provider,
                    category
                )
            );

        // ----------------------------------------------------
        // RESPOSTA
        // ----------------------------------------------------

        return res.json({
            metas
        });

    } catch (error) {

        console.error(
            '[NetCine 2.5]',
            error.message
        );

        return res.status(200).json({
            metas: []
        });

    }

}

// ============================================================
// ROTAS DE CATÁLOGO
// ============================================================

app.get(
    '/catalog/:type/:id.json',
    catalogHandler
);

app.get(
    '/catalog/:type/:id/:extra.json',
    (req, res, next) => {

        const extra =
            req.params.extra || '';

        const query =
            new URLSearchParams(extra);

        for (const [key, value] of query.entries()) {

            req.query[key] = value;

        }

        next();

    },
    catalogHandler
);

// ============================================================
// TAMBÉM ACEITAR QUERY STRING
//
// /catalog/movie/netflix_movies.json?year=2026
// ============================================================

app.get(
    '/catalog/:type/:id',
    catalogHandler
);

// ============================================================
// LIMPEZA DE CACHE
// ============================================================

setInterval(() => {

    const now = Date.now();

    for (
        const [key, value]
        of cache.entries()
    ) {

        if (
            now - value.timestamp >
            CACHE_TTL
        ) {

            cache.delete(key);

        }

    }

}, 5 * 60 * 1000);

// ============================================================
// ERROS
// ============================================================

process.on(
    'uncaughtException',
    error => {

        console.error(
            '[NetCine] Uncaught Exception:',
            error
        );

    }
);

process.on(
    'unhandledRejection',
    error => {

        console.error(
            '[NetCine] Unhandled Rejection:',
            error
        );

    }
);

// ============================================================
// SERVER
// ============================================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '========================================'
        );

        console.log(
            'NetCine Catálogo 2.5.0'
        );

        console.log(
            '========================================'
        );

        console.log(
            'Porta:',
            PORT
        );

        console.log(
            'Região:',
            REGION
        );

        console.log(
            'Modo: SOMENTE CATÁLOGO'
        );

        console.log(
            'Catálogos:',
            catalogs.length
        );

        console.log(
            'Provedores:',
            PROVIDERS
                .map(p => p.name)
                .join(', ')
        );

        console.log(
            'Categorias:',
            CATEGORIES
                .map(c => c.name)
                .join(', ')
        );

        console.log(
            'TMDB_KEY:',
            TMDB_KEY
                ? 'CONFIGURADA'
                : 'NÃO CONFIGURADA'
        );

        console.log(
            '========================================'
        );

    }
);
