const express = require('express');

const app = express();

const PORT = process.env.PORT || 8080;

const TMDB_KEY =
    process.env.TMDB_KEY ||
    'd8e8e85d692358d3b5db2cfd08487457';

const TMDB_BASE =
    'https://api.themoviedb.org/3';

const LANGUAGE = 'pt-BR';
const REGION = 'BR';

const PAGE_SIZE = 20;
const CACHE_TTL = 10 * 60 * 1000;

// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {

    res.setHeader(
        'Access-Control-Allow-Origin',
        '*'
    );

    res.setHeader(
        'Access-Control-Allow-Headers',
        '*'
    );

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
// STREAMINGS DO BRASIL
// ============================================================

const PROVIDERS = [

    {
        id: 'netflix',
        name: 'Netflix',
        tmdbId: 8,
        logo:
            'https://image.tmdb.org/t/p/original/t2yyOv40HZeVlLjYsCsPHnWLk4W.jpg'
    },

    {
        id: 'disney_plus',
        name: 'Disney+',
        tmdbId: 337,
        logo:
            'https://image.tmdb.org/t/p/original/7rwgEs15tFwyR9NPQ5vpzxTj19Q.jpg'
    },

    {
        id: 'prime_video',
        name: 'Prime Video',
        tmdbId: 119,
        logo:
            'https://image.tmdb.org/t/p/original/emthp39XA2YScoYL1p0sdbAH2WA.jpg'
    },

    {
        id: 'max',
        name: 'Max',
        tmdbId: 1899,
        logo:
            'https://image.tmdb.org/t/p/original/6AK8H0dHnX6cV3aK1mQmFJYQf8H.jpg'
    },

    {
        id: 'apple_tv_plus',
        name: 'Apple TV+',
        tmdbId: 350,
        logo:
            'https://image.tmdb.org/t/p/original/peURlLlr8jggOwK53fJ5wdQl05y.jpg'
    },

    {
        id: 'paramount_plus',
        name: 'Paramount+',
        tmdbId: 531,
        logo:
            'https://image.tmdb.org/t/p/original/xbhHHa1YgtpwhC8lb1NQ3ACVcLd.jpg'
    },

    {
        id: 'globoplay',
        name: 'Globoplay',
        tmdbId: 307,
        logo:
            'https://image.tmdb.org/t/p/original/7fT8r6D1qjK3xT8l2K3yX9w1s0A.jpg'
    }

];

// ============================================================
// GÊNEROS
// ============================================================

const MOVIE_GENRES = [
    'Action',
    'Adventure',
    'Animation',
    'Comedy',
    'Crime',
    'Documentary',
    'Drama',
    'Family',
    'Fantasy',
    'History',
    'Horror',
    'Music',
    'Mystery',
    'Romance',
    'Science Fiction',
    'TV Movie',
    'Thriller',
    'War',
    'Western'
];

const SERIES_GENRES = [
    'Action & Adventure',
    'Animation',
    'Comedy',
    'Crime',
    'Documentary',
    'Drama',
    'Family',
    'Kids',
    'Mystery',
    'News',
    'Reality',
    'Sci-Fi & Fantasy',
    'Soap',
    'Talk',
    'War & Politics',
    'Western'
];

// ============================================================
// MANIFEST
//
// Estrutura baseada no manifest oficial do Nuvio Catalog.
// ============================================================

const catalogs = [];

for (const provider of PROVIDERS) {

    catalogs.push({

        type: 'movie',

        id:
            `${provider.id}_movies`,

        name:
            `${provider.name} Filmes`,

        extra: [

            {
                name: 'skip',
                isRequired: false
            },

            {
                name: 'genre',
                isRequired: false,
                options: MOVIE_GENRES,
                optionsLimit: 1
            }

        ]

    });

    catalogs.push({

        type: 'series',

        id:
            `${provider.id}_series`,

        name:
            `${provider.name} Séries`,

        extra: [

            {
                name: 'skip',
                isRequired: false
            },

            {
                name: 'genre',
                isRequired: false,
                options: SERIES_GENRES,
                optionsLimit: 1
            }

        ]

    });

}

const MANIFEST = {

    id:
        'br.netcine.catalog',

    version:
        '3.0.0',

    name:
        'NetCine',

    description:
        'Catálogo brasileiro de filmes e séries organizado por serviço de streaming.',

    logo:
        PROVIDERS[0].logo,

    resources: [

        'catalog',

        {
            name: 'meta',

            types: [
                'movie',
                'series'
            ],

            idPrefixes: [
                'tt',
                'tmdb:'
            ]
        }

    ],

    types: [
        'movie',
        'series'
    ],

    catalogs,

    behaviorHints: {

        configurable: false,

        adult: false,

        p2p: false

    }

};

// ============================================================
// CACHE
// ============================================================

const cache = new Map();

async function tmdb(path, params = {}) {

    const query =
        new URLSearchParams({

            api_key:
                TMDB_KEY,

            language:
                LANGUAGE,

            ...params

        });

    const url =
        `${TMDB_BASE}${path}?${query.toString()}`;

    const cached =
        cache.get(url);

    if (
        cached &&
        Date.now() - cached.timestamp <
        CACHE_TTL
    ) {

        return cached.data;

    }

    const response =
        await fetch(url, {

            headers: {
                Accept:
                    'application/json'
            }

        });

    if (!response.ok) {

        throw new Error(
            `TMDB HTTP ${response.status}`
        );

    }

    const data =
        await response.json();

    cache.set(
        url,
        {
            data,
            timestamp:
                Date.now()
        }
    );

    return data;

}

// ============================================================
// IMAGENS
// ============================================================

function image(
    path,
    size = 'w500'
) {

    if (!path) {
        return null;
    }

    return (
        `https://image.tmdb.org/t/p/${size}${path}`
    );

}

// ============================================================
// PROVIDER
// ============================================================

function getProvider(
    id
) {

    return PROVIDERS.find(
        provider =>
            provider.id === id
    );

}

// ============================================================
// TIPO
// ============================================================

function validType(
    type
) {

    return (
        type === 'movie' ||
        type === 'series'
    );

}

// ============================================================
// ID TMDB
// ============================================================

function getTmdbId(
    id
) {

    if (!id) {
        return null;
    }

    const value =
        decodeURIComponent(
            String(id)
        );

    if (
        value.startsWith('tmdb:')
    ) {

        return value.substring(
            5
        );

    }

    if (
        /^\d+$/.test(value)
    ) {

        return value;

    }

    if (
        value.startsWith('tt')
    ) {

        return value;

    }

    return null;

}

// ============================================================
// SKIP
// ============================================================

function getSkip(
    req
) {

    const value =
        parseInt(
            req.query.skip || '0',
            10
        );

    if (
        Number.isFinite(value) &&
        value >= 0
    ) {

        return value;

    }

    return 0;

}

// ============================================================
// GÊNERO
// ============================================================

function getGenre(
    req
) {

    if (
        !req.query.genre
    ) {

        return null;

    }

    const genre =
        String(
            req.query.genre
        ).trim();

    if (!genre) {
        return null;
    }

    return genre;

}

// ============================================================
// DATA
// ============================================================

function releaseDate(
    item,
    type
) {

    if (type === 'movie') {

        return (
            item.release_date ||
            ''
        );

    }

    return (
        item.first_air_date ||
        ''
    );

}

// ============================================================
// ORDENAÇÃO
//
// LANÇAMENTO MAIS RECENTE PRIMEIRO
// ============================================================

function sortNewestFirst(
    results,
    type
) {

    return results.sort(
        (a, b) => {

            const dateA =
                releaseDate(
                    a,
                    type
                );

            const dateB =
                releaseDate(
                    b,
                    type
                );

            if (
                !dateA &&
                !dateB
            ) {
                return 0;
            }

            if (!dateA) {
                return 1;
            }

            if (!dateB) {
                return -1;
            }

            const comparison =
                dateB.localeCompare(
                    dateA
                );

            if (
                comparison !== 0
            ) {

                return comparison;

            }

            return (
                Number(
                    b.popularity || 0
                ) -
                Number(
                    a.popularity || 0
                )
            );

        }
    );

}

// ============================================================
// DUPLICADOS
// ============================================================

function uniqueResults(
    results
) {

    const seen =
        new Set();

    return results.filter(
        item => {

            if (
                seen.has(item.id)
            ) {

                return false;

            }

            seen.add(item.id);

            return true;

        }
    );

}

// ============================================================
// META PREVIEW
// ============================================================

function toMeta(
    item,
    type,
    provider
) {

    const isMovie =
        type === 'movie';

    const name =
        isMovie
            ? item.title
            : item.name;

    const originalName =
        isMovie
            ? item.original_title
            : item.original_name;

    const date =
        releaseDate(
            item,
            type
        );

    return {

        id:
            `tmdb:${item.id}`,

        type,

        name:
            name ||
            originalName ||
            'Sem título',

        poster:
            image(
                item.poster_path,
                'w500'
            ),

        background:
            image(
                item.backdrop_path,
                'w1280'
            ),

        description:
            item.overview || '',

        releaseInfo:
            date
                ? date.substring(
                    0,
                    4
                )
                : '',

        imdbRating:
            typeof item.vote_average ===
            'number'
                ? Number(
                    item.vote_average.toFixed(
                        1
                    )
                )
                : undefined,

        genres:
            Array.isArray(
                item.genre_ids
            )
                ? item.genre_ids
                : [],

        posterShape:
            'poster',

        behaviorHints: {

            defaultVideoId:
                `tmdb:${item.id}`

        },

        netcineProvider:
            provider.id,

        netcineProviderName:
            provider.name

    };

}

// ============================================================
// BUSCAR CATÁLOGO TMDB
// ============================================================

async function discover(
    type,
    provider,
    page,
    genre
) {

    const endpoint =
        type === 'movie'
            ? '/discover/movie'
            : '/discover/tv';

    const params = {

        watch_region:
            REGION,

        with_watch_providers:
            String(
                provider.tmdbId
            ),

        with_watch_monetization_types:
            'flatrate',

        sort_by:
            type === 'movie'
                ? 'primary_release_date.desc'
                : 'first_air_date.desc',

        page:
            String(page),

        include_adult:
            'false'

    };

    // --------------------------------------------------------
    // GÊNERO
    // --------------------------------------------------------

    if (genre) {

        /*
         * O usuário seleciona o nome do gênero
         * no Nuvio.
         *
         * Primeiro tentamos converter pelo
         * endpoint de gêneros do TMDB.
         */

        const genreData =
            await getGenreId(
                type,
                genre
            );

        if (genreData) {

            params.with_genres =
                String(
                    genreData
                );

        }

    }

    return tmdb(
        endpoint,
        params
    );

}

// ============================================================
// CACHE DE GÊNEROS
// ============================================================

const genreCache = {

    movie: null,

    series: null

};

async function getGenreId(
    type,
    name
) {

    const normalized =
        String(
            name
        )
        .trim()
        .toLowerCase();

    if (
        !genreCache[type]
    ) {

        const endpoint =
            type === 'movie'
                ? '/genre/movie/list'
                : '/genre/tv/list';

        const data =
            await tmdb(
                endpoint
            );

        genreCache[type] =
            Array.isArray(
                data.genres
            )
                ? data.genres
                : [];

    }

    const found =
        genreCache[type].find(
            genre =>
                String(
                    genre.name
                )
                .trim()
                .toLowerCase() ===
                normalized
        );

    return found
        ? found.id
        : null;

}

// ============================================================
// CATÁLOGO
// ============================================================

async function catalogHandler(
    req,
    res
) {

    const type =
        req.params.type;

    const providerId =
        req.params.provider;

    const provider =
        getProvider(
            providerId
        );

    if (
        !provider ||
        !validType(type)
    ) {

        return res.json({
            metas: []
        });

    }

    const skip =
        getSkip(req);

    const genre =
        getGenre(req);

    const page =
        Math.floor(
            skip / PAGE_SIZE
        ) + 1;

    console.log(
        `[NetCine] ${provider.name} | ${type} | página ${page} | skip ${skip}${genre ? ` | gênero ${genre}` : ''}`
    );

    try {

        const data =
            await discover(
                type,
                provider,
                page,
                genre
            );

        let results =
            Array.isArray(
                data.results
            )
                ? data.results
                : [];

        results =
            uniqueResults(
                results
            );

        results =
            sortNewestFirst(
                results,
                type
            );

        /*
         * O TMDB já entregou a página correspondente
         * ao skip.
         *
         * Portanto não fazemos slice global aqui.
         */

        const metas =
            results.map(
                item =>
                    toMeta(
                        item,
                        type,
                        provider
                    )
            );

        console.log(
            `[NetCine] ${provider.name} ${type}: ${metas.length} títulos`
        );

        if (
            metas.length
        ) {

            console.log(
                `[NetCine] Primeiro: ${metas[0].name} (${metas[0].releaseInfo})`
            );

        }

        return res.json({

            metas

        });

    } catch (error) {

        console.error(
            `[NetCine] Erro catálogo ${provider.name}:`,
            error.message
        );

        return res.json({

            metas: []

        });

    }

}

// ============================================================
// META
//
// Isso acompanha a estrutura do manifest oficial:
// resources -> meta
// idPrefixes -> tmdb:
// ============================================================

async function metaHandler(
    req,
    res
) {

    const type =
        req.params.type;

    const rawId =
        req.params.id;

    if (
        !validType(type)
    ) {

        return res.json({
            meta: null
        });

    }

    const tmdbId =
        getTmdbId(
            rawId
        );

    if (!tmdbId) {

        return res.json({
            meta: null
        });

    }

    try {

        let data;

        if (
            String(
                tmdbId
            ).startsWith('tt')
        ) {

            data =
                await tmdb(
                    `/find/${encodeURIComponent(tmdbId)}`,
                    {
                        external_source:
                            'imdb_id'
                    }
                );

            const list =
                type === 'movie'
                    ? data.movie_results
                    : data.tv_results;

            const item =
                Array.isArray(list) &&
                list.length
                    ? list[0]
                    : null;

            if (!item) {

                return res.json({
                    meta: null
                });

            }

            return res.json({

                meta:
                    toMeta(
                        item,
                        type,
                        PROVIDERS[0]
                    )

            });

        }

        data =
            await tmdb(
                `/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`
            );

        if (!data || !data.id) {

            return res.json({
                meta: null
            });

        }

        const item = {

            ...data,

            genre_ids:
                Array.isArray(
                    data.genres
                )
                    ? data.genres.map(
                        genre =>
                            genre.id
                    )
                    : []

        };

        return res.json({

            meta:
                toMeta(
                    item,
                    type,
                    PROVIDERS[0]
                )

        });

    } catch (error) {

        console.error(
            '[NetCine] Erro meta:',
            error.message
        );

        return res.json({
            meta: null
        });

    }

}

// ============================================================
// ROTAS CATALOG
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
// ROTAS META
// ============================================================

app.get(
    '/meta/:type/:id.json',
    metaHandler
);

// ============================================================
// MANIFEST
// ============================================================

app.get(
    '/manifest.json',
    (req, res) => {

        res.json(
            MANIFEST
        );

    }
);

// ============================================================
// HOME / STATUS
// ============================================================

app.get(
    '/',
    (req, res) => {

        res.json({

            name:
                'NetCine',

            status:
                'online',

            version:
                MANIFEST.version,

            mode:
                'catalog-only',

            region:
                REGION,

            language:
                LANGUAGE,

            resources:
                MANIFEST.resources,

            catalogs:
                catalogs.length,

            providers:
                PROVIDERS.map(
                    provider =>
                        provider.name
                )

        });

    }
);

// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            error:
                'Endpoint não encontrado',

            path:
                req.path

        });

    }
);

// ============================================================
// LIMPEZA CACHE
// ============================================================

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                key,
                value
            ]
            of cache.entries()
        ) {

            if (
                now -
                value.timestamp >
                CACHE_TTL
            ) {

                cache.delete(
                    key
                );

            }

        }

    },
    5 * 60 * 1000
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
            'NETCINE'
        );

        console.log(
            'Versão:',
            MANIFEST.version
        );

        console.log(
            'Status: ONLINE'
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
            'Idioma:',
            LANGUAGE
        );

        console.log(
            'TMDB:',
            TMDB_KEY
                ? 'CONFIGURADA'
                : 'AUSENTE'
        );

        console.log(
            'Catálogos:',
            catalogs.length
        );

        console.log(
            'Recursos:',
            'catalog + meta'
        );

        console.log(
            'Ordenação:',
            'LANÇAMENTO MAIS RECENTE'
        );

        console.log(
            '========================================'
        );

    }
);