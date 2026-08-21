const express = require('express');

const PORT = process.env.PORT || 8080;
const app = express();

const TMDB_KEY =
    process.env.TMDB_KEY ||
    'd8e8e85d692358d3b5db2cfd08487457';

const TMDB_BASE =
    'https://api.themoviedb.org/3';

const LANGUAGE = 'pt-BR';
const REGION = 'BR';

const PAGE_SIZE = 20;

// Quantas páginas do TMDB serão analisadas
// para montar uma página do catálogo.
// 3 páginas = até 60 títulos analisados.
const FETCH_PAGES = 3;

// Cache
const CACHE_TTL =
    10 * 60 * 1000;

// ============================================================
// EXPRESS
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
// STREAMINGS
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
// MANIFEST
// ============================================================

const catalogs = [];

for (const provider of PROVIDERS) {

    // FILMES
    catalogs.push({

        id:
            `${provider.id}_movie`,

        type:
            'movie',

        name:
            `${provider.name} Filmes`,

        extra: [
            {
                name: 'skip',
                isRequired: false
            }
        ]

    });

    // SÉRIES
    catalogs.push({

        id:
            `${provider.id}_series`,

        type:
            'series',

        name:
            `${provider.name} Séries`,

        extra: [
            {
                name: 'skip',
                isRequired: false
            }
        ]

    });

}

const MANIFEST = {

    id:
        'br.netcine.catalog',

    version:
        '2.3.0',

    name:
        'NetCine',

    description:
        'Catálogo brasileiro de filmes e séries organizado por serviço de streaming e lançamento.',

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
// CACHE TMDB
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

    /*
     * Node 18 possui fetch nativo.
     *
     * Isso elimina a necessidade do node-fetch
     * que estava causando o crash anteriormente.
     */

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
    providerId
) {

    return PROVIDERS.find(
        provider =>
            provider.id === providerId
    );

}

// ============================================================
// SKIP
// ============================================================

function getSkip(req) {

    let skip =
        req.query.skip;

    if (
        skip !== undefined &&
        skip !== null &&
        skip !== ''
    ) {

        const value =
            parseInt(skip, 10);

        if (
            Number.isFinite(value) &&
            value >= 0
        ) {

            return value;

        }

    }

    const extra =
        req.params.extra;

    if (extra) {

        const decoded =
            decodeURIComponent(
                String(extra)
            );

        const match =
            decoded.match(
                /skip[=:](\d+)/i
            );

        if (match) {

            const value =
                parseInt(
                    match[1],
                    10
                );

            if (
                Number.isFinite(value) &&
                value >= 0
            ) {

                return value;

            }

        }

        if (
            /^\d+$/.test(decoded)
        ) {

            return parseInt(
                decoded,
                10
            );

        }

    }

    return 0;

}

// ============================================================
// DATA DE LANÇAMENTO
// ============================================================

function getReleaseDate(
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
// MAIS NOVO PRIMEIRO
//
// YYYY-MM-DD
// YYYY-MM-DD
// YYYY-MM-DD
// ...
// ============================================================

function sortByReleaseDate(
    items,
    type
) {

    return items.sort(
        (a, b) => {

            const dateA =
                getReleaseDate(
                    a,
                    type
                );

            const dateB =
                getReleaseDate(
                    b,
                    type
                );

            // Sem data vai para o final
            if (!dateA && !dateB) {
                return 0;
            }

            if (!dateA) {
                return 1;
            }

            if (!dateB) {
                return -1;
            }

            // Mais recente primeiro
            if (
                dateA !== dateB
            ) {

                return dateB.localeCompare(
                    dateA
                );

            }

            // Desempate por popularidade
            const popularityA =
                Number(
                    a.popularity || 0
                );

            const popularityB =
                Number(
                    b.popularity || 0
                );

            return (
                popularityB -
                popularityA
            );

        }
    );

}

// ============================================================
// REMOVER DUPLICADOS
// ============================================================

function removeDuplicates(
    items
) {

    const seen =
        new Set();

    return items.filter(
        item => {

            const id =
                String(
                    item.id
                );

            if (
                seen.has(id)
            ) {

                return false;

            }

            seen.add(id);

            return true;

        }
    );

}

// ============================================================
// BUSCA ORDENADA
//
// O TMDB já oferece sort_by por data.
// Nós buscamos várias páginas e fazemos
// uma segunda ordenação local.
//
// Isso evita depender somente da ordem
// retornada pela API.
// ============================================================

async function getOrderedCatalog(
    type,
    provider,
    requestedPage
) {

    const path =
        type === 'movie'
            ? '/discover/movie'
            : '/discover/tv';

    const sortBy =
        type === 'movie'
            ? 'primary_release_date.desc'
            : 'first_air_date.desc';

    /*
     * Para cada página pedida pelo Nuvio,
     * analisamos algumas páginas do TMDB.
     *
     * Exemplo:
     *
     * skip=0
     * -> páginas 1,2,3
     *
     * skip=20
     * -> páginas 1,2,3,4
     *
     * Isso permite manter uma ordenação global
     * dentro do conjunto analisado.
     */

    const lastPageNeeded =
        Math.max(
            FETCH_PAGES,
            requestedPage + 1
        );

    const pages = [];

    for (
        let page = 1;
        page <= lastPageNeeded;
        page++
    ) {

        pages.push(
            tmdb(
                path,
                {

                    watch_region:
                        REGION,

                    with_watch_providers:
                        String(
                            provider.tmdbId
                        ),

                    with_watch_monetization_types:
                        'flatrate',

                    sort_by:
                        sortBy,

                    page:
                        String(page),

                    include_adult:
                        'false'

                }
            )
        );

    }

    const responses =
        await Promise.all(
            pages
        );

    let results = [];

    for (
        const data of responses
    ) {

        if (
            Array.isArray(
                data.results
            )
        ) {

            results.push(
                ...data.results
            );

        }

    }

    // Remove duplicados
    results =
        removeDuplicates(
            results
        );

    // Ordena novamente
    results =
        sortByReleaseDate(
            results,
            type
        );

    return results;

}

// ============================================================
// META
// ============================================================

function toMeta(
    item,
    type,
    provider
) {

    const isMovie =
        type === 'movie';

    const title =
        isMovie
            ? item.title
            : item.name;

    const originalTitle =
        isMovie
            ? item.original_title
            : item.original_name;

    const releaseDate =
        getReleaseDate(
            item,
            type
        );

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

        /*
         * O Nuvio continua vendo somente
         * o ano.
         */
        releaseInfo:
            releaseDate
                ? releaseDate.substring(
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

    // --------------------------------------------------------
    // VALIDAÇÃO
    // --------------------------------------------------------

    if (
        !provider ||
        (
            type !== 'movie' &&
            type !== 'series'
        )
    ) {

        return res.json({
            metas: []
        });

    }

    // --------------------------------------------------------
    // PAGINAÇÃO
    // --------------------------------------------------------

    const skip =
        getSkip(req);

    const requestedPage =
        Math.floor(
            skip / PAGE_SIZE
        ) + 1;

    console.log(
        `[NetCine] ${provider.name} ${type} | skip=${skip} | página=${requestedPage}`
    );

    try {

        // ----------------------------------------------------
        // BUSCAR E ORDENAR
        // ----------------------------------------------------

        let results =
            await getOrderedCatalog(
                type,
                provider,
                requestedPage
            );

        // ----------------------------------------------------
        // POSIÇÃO DA PÁGINA
        // ----------------------------------------------------

        const start =
            skip;

        const end =
            start + PAGE_SIZE;

        const pageResults =
            results.slice(
                start,
                end
            );

        // ----------------------------------------------------
        // TRANSFORMAR
        // ----------------------------------------------------

        const metas =
            pageResults.map(
                item =>
                    toMeta(
                        item,
                        type,
                        provider
                    )
            );

        // ----------------------------------------------------
        // LOG
        // ----------------------------------------------------

        console.log(
            `[NetCine] ${provider.name} ${type}: ${metas.length} títulos`
        );

        if (
            metas.length > 0
        ) {

            console.log(
                `[NetCine] PRIMEIRO: ${metas[0].name} - ${metas[0].releaseInfo}`
            );

            console.log(
                `[NetCine] ÚLTIMO: ${metas[metas.length - 1].name} - ${metas[metas.length - 1].releaseInfo}`
            );

        }

        // ----------------------------------------------------
        // RESPOSTA
        // ----------------------------------------------------

        return res.json({

            metas

        });

    } catch (error) {

        console.error(
            '[NetCine] ERRO:',
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
// HOME
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

            providers:
                PROVIDERS.map(
                    provider =>
                        provider.name
                )

        });

    }
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
// ERRO 404
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
// SERVIDOR
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            '========================================'
        );

        console.log(
            'NetCine iniciado'
        );

        console.log(
            'Versão:',
            MANIFEST.version
        );

        console.log(
            'Porta:',
            PORT
        );

        console.log(
            'Modo:',
            'CATÁLOGO'
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
            'Streaming:',
            PROVIDERS
                .map(
                    provider =>
                        provider.name
                )
                .join(', ')
        );

        console.log(
            'Ordenação:',
            'LANÇAMENTO — MAIS RECENTE PRIMEIRO'
        );

        console.log(
            '========================================'
        );

    }
);