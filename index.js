const express = require('express');

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const TMDB_KEY =
    process.env.TMDB_KEY ||
    'd8e8e85d692358d3b5db2cfd08487457';

const TMDB_BASE =
    'https://api.themoviedb.org/3';

const LANGUAGE = 'pt-BR';
const REGION = 'BR';

const CURRENT_YEAR =
    new Date().getFullYear();

const CACHE_TTL =
    10 * 60 * 1000;

const cache = new Map();


// ============================================================
// EXPRESS
// ============================================================

app.disable('x-powered-by');

app.use(express.json());

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

    res.setHeader(
        'Cache-Control',
        'public, max-age=300, stale-while-revalidate=600'
    );

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
        logo:
            'https://image.tmdb.org/t/p/original/t2yyOv40HZeVlLjYsCsPHnWLk4W.jpg'
    },

    {
        id: 'prime_video',
        name: 'Prime Video',
        tmdbId: 119,
        logo:
            'https://image.tmdb.org/t/p/original/emthp39XA2YScoYL1p0sdbAH2WA.jpg'
    },

    {
        id: 'disney_plus',
        name: 'Disney+',
        tmdbId: 337,
        logo:
            'https://image.tmdb.org/t/p/original/7rwgEs15tFwyR9NPQ5vpzxTj19Q.jpg'
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
// TODOS OS GÊNEROS DE FILMES
// ============================================================

const MOVIE_GENRES = [

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
// TODOS OS GÊNEROS DE SÉRIES
// ============================================================

const SERIES_GENRES = [

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
    ['10766', 'Soap'],
    ['10767', 'Talk show'],
    ['10768', 'Guerra e política'],
    ['37', 'Faroeste']

];


// ============================================================
// GÊNEROS DAS CATEGORIAS ESPECIAIS
// ============================================================

const SPECIAL_GENRES = [

    ['16', 'Animação'],
    ['28', 'Ação'],
    ['12', 'Aventura'],
    ['35', 'Comédia'],
    ['80', 'Crime'],
    ['18', 'Drama'],
    ['10751', 'Família'],
    ['14', 'Fantasia'],
    ['27', 'Terror'],
    ['9648', 'Mistério'],
    ['10749', 'Romance'],
    ['878', 'Ficção científica'],
    ['53', 'Thriller'],
    ['10752', 'Guerra'],
    ['36', 'História']

];


// ============================================================
// OPÇÕES DOS CATÁLOGOS
// ============================================================

function extraOptions(genres) {

    return [

        {
            name: 'search',
            isRequired: false
        },

        {
            name: 'genre',
            isRequired: false,
            options: [
                {
                    id: 'all',
                    name: 'Todos os gêneros'
                },

                ...genres.map(
                    ([id, name]) => ({
                        id,
                        name
                    })
                )
            ]
        },

        {
            name: 'skip',
            isRequired: false
        }

    ];

}


// ============================================================
// CONSTRUÇÃO DOS CATÁLOGOS
//
// IMPORTANTE:
//
// O tipo técnico continua sendo movie/series,
// porque é o formato aceito pelo ecossistema.
//
// A separação visual é feita pelos CATÁLOGOS.
//
// FILMES
// SÉRIES
// ANIMES
// DESENHO INFANTIL
// DORAMAS
//
// Nada é misturado entre as categorias.
// ============================================================

function buildCatalogs() {

    const catalogs = [];

    for (const provider of PROVIDERS) {

        // ------------------------------------------------------
        // FILMES
        // ------------------------------------------------------

        catalogs.push({

            id:
                `movies_${provider.id}`,

            type:
                'movie',

            name:
                `${provider.name} • Filmes • ${CURRENT_YEAR}`,

            extra:
                extraOptions(
                    MOVIE_GENRES
                )

        });


        // ------------------------------------------------------
        // SÉRIES
        // ------------------------------------------------------

        catalogs.push({

            id:
                `series_${provider.id}`,

            type:
                'series',

            name:
                `${provider.name} • Séries • ${CURRENT_YEAR}`,

            extra:
                extraOptions(
                    SERIES_GENRES
                )

        });


        // ------------------------------------------------------
        // ANIMES - FILMES
        // ------------------------------------------------------

        catalogs.push({

            id:
                `anime_movies_${provider.id}`,

            type:
                'movie',

            name:
                `${provider.name} • Animes • Filmes`,

            extra:
                extraOptions(
                    SPECIAL_GENRES
                )

        });


        // ------------------------------------------------------
        // ANIMES - SÉRIES
        // ------------------------------------------------------

        catalogs.push({

            id:
                `anime_series_${provider.id}`,

            type:
                'series',

            name:
                `${provider.name} • Animes • Séries`,

            extra:
                extraOptions(
                    SPECIAL_GENRES
                )

        });


        // ------------------------------------------------------
        // DESENHO INFANTIL - FILMES
        // ------------------------------------------------------

        catalogs.push({

            id:
                `kids_movies_${provider.id}`,

            type:
                'movie',

            name:
                `${provider.name} • Desenho Infantil • Filmes`,

            extra:
                extraOptions(
                    SPECIAL_GENRES
                )

        });


        // ------------------------------------------------------
        // DESENHO INFANTIL - SÉRIES
        // ------------------------------------------------------

        catalogs.push({

            id:
                `kids_series_${provider.id}`,

            type:
                'series',

            name:
                `${provider.name} • Desenho Infantil • Séries`,

            extra:
                extraOptions(
                    SPECIAL_GENRES
                )

        });


        // ------------------------------------------------------
        // DORAMAS
        // ------------------------------------------------------

        catalogs.push({

            id:
                `dorama_series_${provider.id}`,

            type:
                'series',

            name:
                `${provider.name} • Doramas`,

            extra:
                extraOptions(
                    SPECIAL_GENRES
                )

        });

    }

    return catalogs;
}


// ============================================================
// MANIFEST
// ============================================================

const MANIFEST = {

    id:
        'br.netcine.catalog',

    version:
        '2.3.0',

    name:
        'NetCine',

    description:
        'Catálogo brasileiro organizado por tipo, serviço, gênero e ano.',

    logo:
        PROVIDERS[0].logo,

    resources:
        [
            'catalog',
            'meta'
        ],

    types:
        [
            'movie',
            'series'
        ],

    catalogs:
        buildCatalogs(),

    behaviorHints:
        {
            configurable: false
        }

};


// ============================================================
// IMAGENS
// ============================================================

function image(
    path,
    size = 'w500'
) {

    if (!path) {
        return undefined;
    }

    return (
        `https://image.tmdb.org/t/p/${size}${path}`
    );

}


// ============================================================
// NOMES DOS GÊNEROS
// ============================================================

function genreNames(
    ids,
    type
) {

    const source =
        type === 'movie'
            ? MOVIE_GENRES
            : SERIES_GENRES;

    const map =
        new Map(source);

    return (
        Array.isArray(ids)
            ? ids
            : []
    )
        .map(String)
        .map(id => map.get(id))
        .filter(Boolean);

}


// ============================================================
// IDENTIFICAÇÃO DO CATÁLOGO
// ============================================================

function catalogConfig(
    id,
    type
) {

    const provider =
        PROVIDERS.find(
            p =>
                id.endsWith(
                    `_${p.id}`
                )
        );

    if (!provider) {
        return null;
    }

    let kind =
        'normal';


    if (
        id.startsWith(
            'anime_movies_'
        )
    ) {

        kind =
            'anime_movie';

    }

    else if (
        id.startsWith(
            'anime_series_'
        )
    ) {

        kind =
            'anime_series';

    }

    else if (
        id.startsWith(
            'kids_movies_'
        )
    ) {

        kind =
            'kids_movie';

    }

    else if (
        id.startsWith(
            'kids_series_'
        )
    ) {

        kind =
            'kids_series';

    }

    else if (
        id.startsWith(
            'dorama_series_'
        )
    ) {

        kind =
            'dorama_series';

    }

    else if (
        id.startsWith(
            'movies_'
        )
    ) {

        kind =
            'movie';

    }

    else if (
        id.startsWith(
            'series_'
        )
    ) {

        kind =
            'series';

    }

    else {

        return null;

    }


    if (
        kind.includes('movie') &&
        type !== 'movie'
    ) {

        return null;

    }


    if (
        kind.includes('series') &&
        type !== 'series'
    ) {

        return null;

    }


    return {
        provider,
        kind
    };

}


// ============================================================
// EXTRA / PAGINAÇÃO
// ============================================================

function parseExtra(
    req,
    extraParam
) {

    const output =
        {
            ...req.query
        };

    if (!extraParam) {
        return output;
    }

    let raw =
        extraParam;

    try {

        raw =
            decodeURIComponent(
                raw
            );

    } catch (_) {}


    for (
        const part of raw.split('&')
    ) {

        const index =
            part.indexOf('=');

        if (index === -1) {
            continue;
        }

        let key =
            part.slice(
                0,
                index
            );

        let value =
            part.slice(
                index + 1
            );

        try {

            key =
                decodeURIComponent(
                    key
                );

            value =
                decodeURIComponent(
                    value
                );

        } catch (_) {}

        if (key) {
            output[key] =
                value;
        }

    }

    return output;

}


function cleanInt(
    value,
    fallback = 0,
    min = 0,
    max = 1000
) {

    const n =
        Number.parseInt(
            value,
            10
        );

    if (
        !Number.isFinite(n)
    ) {

        return fallback;

    }

    return Math.min(
        max,
        Math.max(
            min,
            n
        )
    );

}


// ============================================================
// TMDB
// ============================================================

async function tmdb(
    path,
    params = {}
) {

    if (!TMDB_KEY) {

        throw new Error(
            'TMDB_KEY não configurada'
        );

    }

    const query =
        new URLSearchParams({

            api_key:
                TMDB_KEY,

            language:
                LANGUAGE,

            include_adult:
                'false',

            ...params

        });


    const url =
        `${TMDB_BASE}${path}?${query}`;


    const cached =
        cache.get(url);


    if (
        cached &&
        Date.now() - cached.ts <
        CACHE_TTL
    ) {

        return cached.data;

    }


    const response =
        await fetch(
            url,
            {
                headers: {
                    Accept:
                        'application/json'
                }
            }
        );


    if (!response.ok) {

        const text =
            await response
                .text()
                .catch(
                    () => ''
                );

        throw new Error(
            `TMDB HTTP ${response.status}` +
            (
                text
                    ? `: ${text.slice(0, 180)}`
                    : ''
            )
        );

    }


    const data =
        await response.json();


    cache.set(
        url,
        {
            data,
            ts:
                Date.now()
        }
    );


    return data;

}


// ============================================================
// CLASSIFICAÇÃO
// ============================================================

function isAnime(
    item
) {

    const genres =
        Array.isArray(
            item.genre_ids
        )
            ? item.genre_ids
            : [];

    const countries =
        Array.isArray(
            item.origin_country
        )
            ? item.origin_country
            : [];


    return (
        genres.includes(16) &&
        (
            item.original_language === 'ja' ||
            countries.includes('JP')
        )
    );

}


function isKids(
    item,
    type
) {

    const genres =
        Array.isArray(
            item.genre_ids
        )
            ? item.genre_ids
            : [];


    if (
        !genres.includes(16)
    ) {

        return false;

    }


    if (
        type === 'movie'
    ) {

        return genres.includes(
            10751
        );

    }


    return (
        genres.includes(10762) ||
        genres.includes(10751)
    );

}


function isDorama(
    item
) {

    const countries =
        Array.isArray(
            item.origin_country
        )
            ? item.origin_country
            : [];

    const genres =
        Array.isArray(
            item.genre_ids
        )
            ? item.genre_ids
            : [];


    return (
        countries.some(
            country =>
                [
                    'KR',
                    'JP',
                    'CN'
                ].includes(country)
        ) &&
        genres.includes(18)
    );

}


// ============================================================
// FILTRO DAS CATEGORIAS
// ============================================================

function applySpecialFilter(
    results,
    type,
    kind
) {

    if (
        kind === 'anime_movie' ||
        kind === 'anime_series'
    ) {

        return results.filter(
            isAnime
        );

    }


    if (
        kind === 'kids_movie' ||
        kind === 'kids_series'
    ) {

        return results.filter(
            item =>
                isKids(
                    item,
                    type
                ) &&
                !isAnime(item)
        );

    }


    if (
        kind === 'dorama_series'
    ) {

        return results.filter(
            item =>
                isDorama(item) &&
                !isAnime(item)
        );

    }


    // Catálogo normal:
    // não mistura anime,
    // desenho infantil ou dorama.

    return results.filter(
        item =>
            !isAnime(item) &&
            !isKids(item, type) &&
            !isDorama(item)
    );

}


// ============================================================
// PARÂMETROS DISCOVER
// ============================================================

function buildDiscoverParams(
    type,
    config,
    extra
) {

    const params = {

        watch_region:
            REGION,

        with_watch_providers:
            String(
                config.provider.tmdbId
            ),

        with_watch_monetization_types:
            'flatrate',

        sort_by:
            type === 'movie'
                ? 'primary_release_date.desc'
                : 'first_air_date.desc',

        page:
            String(
                Math.floor(
                    cleanInt(
                        extra.skip,
                        0
                    ) / 20
                ) + 1
            )

    };


    // ----------------------------------------------------------
    // FILMES E SÉRIES NORMAIS
    // ----------------------------------------------------------

    if (
        config.kind === 'movie'
    ) {

        params.primary_release_year =
            String(
                CURRENT_YEAR
            );

    }


    if (
        config.kind === 'series'
    ) {

        params.first_air_date_year =
            String(
                CURRENT_YEAR
            );

    }


    // ----------------------------------------------------------
    // GÊNERO
    // ----------------------------------------------------------

    if (
        extra.genre &&
        extra.genre !== 'all'
    ) {

        params.with_genres =
            String(
                extra.genre
            );

    }


    // ----------------------------------------------------------
    // ANIMES
    // ----------------------------------------------------------

    if (
        config.kind === 'anime_movie' ||
        config.kind === 'anime_series'
    ) {

        params.with_genres =
            '16';

        params.with_original_language =
            'ja';

    }


    // ----------------------------------------------------------
    // DESENHOS INFANTIS
    // ----------------------------------------------------------

    if (
        config.kind === 'kids_movie'
    ) {

        params.with_genres =
            '16,10751';

    }


    if (
        config.kind === 'kids_series'
    ) {

        params.with_genres =
            '16,10762';

    }


    // ----------------------------------------------------------
    // DORAMAS
    // ----------------------------------------------------------

    if (
        config.kind === 'dorama_series'
    ) {

        params.with_origin_country =
            'KR|JP|CN';

        params.with_genres =
            '18';

    }


    return params;

}


// ============================================================
// META
// ============================================================

function toMeta(
    item,
    type,
    provider,
    kind
) {

    const title =
        type === 'movie'
            ? item.title
            : item.name;

    const originalTitle =
        type === 'movie'
            ? item.original_title
            : item.original_name;

    const date =
        type === 'movie'
            ? item.release_date
            : item.first_air_date;


    return {

        id:
            `tmdb:${item.id}`,

        type,

        name:
            title ||
            originalTitle ||
            'Sem título',

        poster:
            image(
                item.poster_path
            ),

        background:
            image(
                item.backdrop_path,
                'w1280'
            ),

        description:
            item.overview ||
            '',

        releaseInfo:
            date ||
            '',

        imdbRating:
            typeof item.vote_average ===
            'number'
                ? Number(
                    item.vote_average
                        .toFixed(1)
                )
                : undefined,

        genres:
            genreNames(
                item.genre_ids,
                type
            ),

        posterShape:
            'poster',

        behaviorHints:
            {
                defaultVideoId:
                    `tmdb:${item.id}`
            },

        netcineProvider:
            provider.id,

        netcineProviderName:
            provider.name,

        netcineCategory:
            kind

    };

}


// ============================================================
// CATALOG
// ============================================================

async function catalogHandler(
    req,
    res
) {

    const {
        type,
        id,
        extra
    } = req.params;


    const config =
        catalogConfig(
            id,
            type
        );


    if (!config) {

        return res
            .status(404)
            .json({
                metas: []
            });

    }


    const params =
        parseExtra(
            req,
            extra
        );


    const skip =
        cleanInt(
            params.skip,
            0
        );


    const search =
        typeof params.search ===
        'string'
            ? params.search.trim()
            : '';


    try {

        let results = [];


        // ======================================================
        // BUSCA
        // ======================================================

        if (search) {

            const endpoint =
                type === 'movie'
                    ? '/search/movie'
                    : '/search/tv';


            const data =
                await tmdb(
                    endpoint,
                    {

                        query:
                            search,

                        page:
                            String(
                                Math.floor(
                                    skip / 20
                                ) + 1
                            ),

                        region:
                            REGION

                    }
                );


            results =
                data.results ||
                [];


            results =
                applySpecialFilter(
                    results,
                    type,
                    config.kind
                );

        }


        // ======================================================
        // CATÁLOGO
        // ======================================================

        else {

            const endpoint =
                type === 'movie'
                    ? '/discover/movie'
                    : '/discover/tv';


            const data =
                await tmdb(
                    endpoint,
                    buildDiscoverParams(
                        type,
                        config,
                        params
                    )
                );


            results =
                data.results ||
                [];


            results =
                applySpecialFilter(
                    results,
                    type,
                    config.kind
                );

        }


        // ======================================================
        // META
        // ======================================================

        const metas =
            results
                .filter(
                    item =>
                        item &&
                        item.id
                )
                .map(
                    item =>
                        toMeta(
                            item,
                            type,
                            config.provider,
                            config.kind
                        )
                );


        return res.json({
            metas
        });


    } catch (error) {

        console.error(
            '[NetCine 2.3] Catalog:',
            error.message
        );


        return res
            .status(200)
            .json({
                metas: []
            });

    }

}


// ============================================================
// META DETALHADA
// ============================================================

async function metaHandler(
    req,
    res
) {

    const {
        type,
        id
    } = req.params;


    if (
        ![
            'movie',
            'series'
        ].includes(type)
    ) {

        return res
            .status(404)
            .json({
                meta: null
            });

    }


    const rawId =
        String(id)
            .replace(
                /^tmdb:/,
                ''
            );


    if (
        !/^\d+$/.test(rawId)
    ) {

        return res
            .status(404)
            .json({
                meta: null
            });

    }


    try {

        const endpoint =
            type === 'movie'
                ? `/movie/${rawId}`
                : `/tv/${rawId}`;


        const data =
            await tmdb(
                endpoint,
                {

                    append_to_response:
                        'external_ids,credits,videos,images,watch/providers'

                }
            );


        const date =
            type === 'movie'
                ? data.release_date
                : data.first_air_date;


        const external =
            data.external_ids ||
            {};


        const meta = {

            id:
                `tmdb:${data.id}`,

            type,

            name:
                type === 'movie'
                    ? data.title
                    : data.name,

            poster:
                image(
                    data.poster_path,
                    'w780'
                ),

            background:
                image(
                    data.backdrop_path,
                    'original'
                ),

            logo:
                data.images?.logos?.[0]
                    ? image(
                        data.images.logos[0]
                            .file_path,
                        'w500'
                    )
                    : undefined,

            description:
                data.overview ||
                '',

            releaseInfo:
                date ||
                '',

            imdbRating:
                typeof data.vote_average ===
                'number'
                    ? Number(
                        data.vote_average
                            .toFixed(1)
                    )
                    : undefined,

            genres:
                Array.isArray(
                    data.genres
                )
                    ? data.genres
                        .map(
                            g => g.name
                        )
                        .filter(Boolean)
                    : [],

            director:
                type === 'movie' &&
                Array.isArray(
                    data.credits?.crew
                )
                    ? data.credits.crew
                        .filter(
                            x =>
                                x.job ===
                                'Director'
                        )
                        .map(
                            x => x.name
                        )
                        .slice(0, 3)
                    : undefined,

            cast:
                Array.isArray(
                    data.credits?.cast
                )
                    ? data.credits.cast
                        .slice(0, 20)
                        .map(
                            x => x.name
                        )
                        .filter(Boolean)
                    : undefined,

            imdb_id:
                external.imdb_id ||
                undefined,

            runtime:
                type === 'movie'
                    ? data.runtime
                    : undefined,

            videos: []

        };


        // ======================================================
        // TRAILERS
        // ======================================================

        if (
            Array.isArray(
                data.videos?.results
            )
        ) {

            const allowed =
                type === 'movie'
                    ? [
                        'Trailer',
                        'Teaser'
                    ]
                    : [
                        'Trailer'
                    ];


            meta.videos =
                data.videos.results
                    .filter(
                        v =>
                            v.site ===
                            'YouTube' &&
                            allowed.includes(
                                v.type
                            )
                    )
                    .slice(0, 5)
                    .map(
                        v => ({

                            id:
                                `youtube:${v.key}`,

                            title:
                                v.name ||
                                'Trailer',

                            thumbnail:
                                `https://i.ytimg.com/vi/${v.key}/hqdefault.jpg`,

                            released:
                                v.published_at ||
                                undefined

                        })
                    );

        }


        return res.json({
            meta
        });


    } catch (error) {

        console.error(
            '[NetCine 2.3] Meta:',
            error.message
        );


        return res
            .status(200)
            .json({
                meta: null
            });

    }

}


// ============================================================
// ROTAS
// ============================================================

app.get(
    '/manifest.json',
    (req, res) =>
        res.json(
            MANIFEST
        )
);


app.get(
    '/health',
    (req, res) =>
        res.json({

            ok:
                true,

            version:
                '2.3.0',

            tmdb:
                Boolean(
                    TMDB_KEY
                ),

            region:
                REGION,

            year:
                CURRENT_YEAR,

            catalogs:
                MANIFEST.catalogs.length

        })
);


app.get(
    '/',
    (req, res) =>
        res.json({

            name:
                'NetCine',

            version:
                '2.3.0',

            status:
                'online',

            resources:
                MANIFEST.resources,

            catalogs:
                MANIFEST.catalogs.length

        })
);


app.get(
    '/catalog/:type/:id/:extra.json',
    catalogHandler
);


app.get(
    '/catalog/:type/:id.json',
    catalogHandler
);


app.get(
    '/meta/:type/:id.json',
    metaHandler
);


// ============================================================
// LIMPEZA DO CACHE
// ============================================================

setInterval(
    () => {

        const now =
            Date.now();


        for (
            const [
                key,
                value
            ] of cache
        ) {

            if (
                now - value.ts >
                CACHE_TTL
            ) {

                cache.delete(
                    key
                );

            }

        }

    },
    5 * 60 * 1000
).unref();


// ============================================================
// SERVIDOR
// ============================================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '========================================'
        );

        console.log(
            'NetCine 2.3 iniciado'
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
            'Ano:',
            CURRENT_YEAR
        );

        console.log(
            'TMDB_KEY:',
            TMDB_KEY
                ? 'CONFIGURADA'
                : 'NÃO CONFIGURADA'
        );

        console.log(
            'Catálogos:',
            MANIFEST.catalogs.length
        );

        console.log(
            '========================================'
        );

    }
);