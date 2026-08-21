const http = require('http');

const PORT = process.env.PORT || 8080;

const TMDB_KEY = process.env.TMDB_KEY || 'd8e8e85d692358d3b5db2cfd08487457';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const LANGUAGE = 'pt-BR';
const REGION = 'BR';


// ============================================================
// SERVIÇOS
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
// MANIFEST
//
// SOMENTE CATÁLOGO
//
// SEM:
// stream
// meta
// extra
// options
// configurações
//
// O objetivo aqui é deixar o Nuvio aceitar o addon primeiro.
// ============================================================

const catalogs = [];

for (const provider of PROVIDERS) {

    catalogs.push({
        id: provider.id + '_movies',
        type: 'movie',
        name: provider.name + ' • Filmes'
    });

    catalogs.push({
        id: provider.id + '_series',
        type: 'series',
        name: provider.name + ' • Séries'
    });
}


const MANIFEST = {
    id: 'br.netcine.catalog',
    version: '3.0.0',
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
    catalogs: catalogs
};


// ============================================================
// CACHE
// ============================================================

const cache = new Map();

const CACHE_TIME = 10 * 60 * 1000;


// ============================================================
// TMDB
// ============================================================

async function tmdb(path, params = {}) {

    const query = new URLSearchParams();

    query.set('api_key', TMDB_KEY);
    query.set('language', LANGUAGE);

    for (const [key, value] of Object.entries(params)) {
        query.set(key, String(value));
    }

    const url = TMDB_BASE + path + '?' + query.toString();

    const old = cache.get(url);

    if (old && Date.now() - old.time < CACHE_TIME) {
        return old.data;
    }

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            'TMDB HTTP ' + response.status
        );
    }

    const data = await response.json();

    cache.set(url, {
        time: Date.now(),
        data: data
    });

    return data;
}


// ============================================================
// IMAGENS
// ============================================================

function image(path, size) {

    if (!path) {
        return null;
    }

    return 'https://image.tmdb.org/t/p/' +
        (size || 'w500') +
        path;
}


// ============================================================
// METADATA DO CATÁLOGO
// ============================================================

function createMeta(item, type, provider) {

    let name = '';
    let originalTitle = '';
    let releaseDate = '';

    if (type === 'movie') {

        name = item.title || '';
        originalTitle = item.original_title || '';
        releaseDate = item.release_date || '';

    } else {

        name = item.name || '';
        originalTitle = item.original_name || '';
        releaseDate = item.first_air_date || '';
    }


    const meta = {
        id: 'tmdb:' + item.id,

        type: type,

        name: name || originalTitle || 'Sem título',

        poster: image(
            item.poster_path,
            'w500'
        ),

        background: image(
            item.backdrop_path,
            'w1280'
        ),

        description: item.overview || '',

        releaseInfo: releaseDate
            ? releaseDate.substring(0, 4)
            : '',

        posterShape: 'poster',

        netcineProvider: provider.id,

        netcineProviderName: provider.name
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
        meta.genres = item.genre_ids;
    }


    return meta;
}


// ============================================================
// ENCONTRAR SERVIÇO
// ============================================================

function findProvider(id) {

    return PROVIDERS.find(
        provider => provider.id === id
    );
}


// ============================================================
// CATÁLOGO
// ============================================================

async function getCatalog(
    type,
    providerId,
    skip
) {

    const provider =
        findProvider(providerId);


    if (!provider) {
        return [];
    }


    const page =
        Math.floor(
            Number(skip || 0) / 20
        ) + 1;


    let endpoint = '';


    if (type === 'movie') {
        endpoint = '/discover/movie';
    } else {
        endpoint = '/discover/tv';
    }


    const data = await tmdb(
        endpoint,
        {
            watch_region: REGION,

            with_watch_providers:
                provider.tmdbId,

            with_watch_monetization_types:
                'flatrate',

            sort_by:
                'popularity.desc',

            page: page
        }
    );


    if (
        !data ||
        !Array.isArray(data.results)
    ) {
        return [];
    }


    return data.results.map(
        item =>
            createMeta(
                item,
                type,
                provider
            )
    );
}


// ============================================================
// RESPOSTA JSON
// ============================================================

function sendJson(
    response,
    status,
    data
) {

    const body =
        JSON.stringify(data);


    response.statusCode = status;

    response.setHeader(
        'Content-Type',
        'application/json; charset=utf-8'
    );

    response.setHeader(
        'Access-Control-Allow-Origin',
        '*'
    );

    response.setHeader(
        'Access-Control-Allow-Headers',
        '*'
    );

    response.setHeader(
        'Access-Control-Allow-Methods',
        'GET, OPTIONS'
    );

    response.end(body);
}


// ============================================================
// SERVIDOR
// ============================================================

const server = http.createServer(
    async (request, response) => {

        try {

            if (
                request.method === 'OPTIONS'
            ) {
                response.statusCode = 204;
                response.end();
                return;
            }


            const url =
                new URL(
                    request.url,
                    'http://' +
                    (request.headers.host ||
                        'localhost')
                );


            const path =
                url.pathname;


            // ------------------------------------------------
            // MANIFEST
            // ------------------------------------------------

            if (
                path === '/manifest.json'
            ) {

                sendJson(
                    response,
                    200,
                    MANIFEST
                );

                return;
            }


            // ------------------------------------------------
            // HOME
            // ------------------------------------------------

            if (
                path === '/'
            ) {

                sendJson(
                    response,
                    200,
                    {
                        name: 'NetCine',

                        status: 'online',

                        mode: 'catalog-only',

                        version: '3.0.0',

                        resources: [
                            'catalog'
                        ],

                        catalogs:
                            catalogs.length,

                        services:
                            PROVIDERS.map(
                                provider =>
                                    provider.name
                            )
                    }
                );

                return;
            }


            // ------------------------------------------------
            // CATALOG
            //
            // /catalog/movie/netflix_movies.json
            //
            // /catalog/series/disney_plus_series.json
            // ------------------------------------------------

            const match =
                path.match(
                    /^\/catalog\/(movie|series)\/([^/]+)\.json$/
                );


            if (match) {

                const type =
                    match[1];

                const catalogId =
                    match[2];


                let provider = null;


                for (
                    const item of PROVIDERS
                ) {

                    if (
                        catalogId ===
                        item.id + '_movies'
                    ) {

                        provider = item;
                        break;
                    }


                    if (
                        catalogId ===
                        item.id + '_series'
                    ) {

                        provider = item;
                        break;
                    }
                }


                if (!provider) {

                    sendJson(
                        response,
                        200,
                        {
                            metas: []
                        }
                    );

                    return;
                }


                const skip =
                    parseInt(
                        url.searchParams.get(
                            'skip'
                        ) || '0',
                        10
                    ) || 0;


                const metas =
                    await getCatalog(
                        type,
                        provider.id,
                        skip
                    );


                sendJson(
                    response,
                    200,
                    {
                        metas: metas
                    }
                );


                return;
            }


            // ------------------------------------------------
            // CATALOG COM EXTRA
            //
            // Compatibilidade
            // ------------------------------------------------

            const extraMatch =
                path.match(
                    /^\/catalog\/(movie|series)\/([^/]+)\/(.+)\.json$/
                );


            if (extraMatch) {

                const type =
                    extraMatch[1];

                const catalogId =
                    extraMatch[2];


                let provider = null;


                for (
                    const item of PROVIDERS
                ) {

                    if (
                        catalogId ===
                        item.id + '_movies' ||
                        catalogId ===
                        item.id + '_series'
                    ) {

                        provider = item;
                        break;
                    }
                }


                if (!provider) {

                    sendJson(
                        response,
                        200,
                        {
                            metas: []
                        }
                    );

                    return;
                }


                const skip =
                    parseInt(
                        url.searchParams.get(
                            'skip'
                        ) || '0',
                        10
                    ) || 0;


                const metas =
                    await getCatalog(
                        type,
                        provider.id,
                        skip
                    );


                sendJson(
                    response,
                    200,
                    {
                        metas: metas
                    }
                );


                return;
            }


            // ------------------------------------------------
            // 404
            // ------------------------------------------------

            sendJson(
                response,
                404,
                {
                    error: 'Not found'
                }
            );


        } catch (error) {

            console.error(
                '[NetCine]',
                error
            );


            sendJson(
                response,
                200,
                {
                    metas: []
                }
            );
        }
    }
);


// ============================================================
// START
// ============================================================

server.listen(
    PORT,
    () => {

        console.log(
            '========================================'
        );

        console.log(
            'NetCine Catálogo iniciado'
        );

        console.log(
            'Porta:',
            PORT
        );

        console.log(
            'Versão:',
            '3.0.0'
        );

        console.log(
            'Modo:',
            'SOMENTE CATÁLOGO'
        );

        console.log(
            'TMDB_KEY:',
            TMDB_KEY
                ? 'CONFIGURADA'
                : 'AUSENTE'
        );

        console.log(
            'Catálogos:',
            catalogs.length
        );

        console.log(
            'Serviços:',
            PROVIDERS
                .map(
                    provider =>
                        provider.name
                )
                .join(', ')
        );

        console.log(
            '========================================'
        );
    }
);