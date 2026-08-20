const express = require('express');

const PORT = process.env.PORT || 8080;
const app = express();

const TMDB_KEY = process.env.TMDB_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

const LANGUAGE = 'pt-BR';
const REGION = 'BR';
const PAGE_SIZE = 20;

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
// MANIFEST
// ============================================================

const catalogs = [];

for (const provider of PROVIDERS) {

    catalogs.push({
        id: `${provider.id}_movie`,
        type: 'movie',
        name: `${provider.name} Filmes`,
        extra: [
            {
                name: 'skip',
                isRequired: false
            }
        ]
    });

    catalogs.push({
        id: `${provider.id}_series`,
        type: 'series',
        name: `${provider.name} Séries`,
        extra: [
            {
                name: 'skip',
                isRequired: false
            }
        ]
    });
}

const MANIFEST = {
    id: 'br.netcine.catalog',
    version: '2.2.1',
    name: 'NetCine',
    description:
        'Catálogo brasileiro de filmes e séries organizado por serviço de streaming.',
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
        version: MANIFEST.version,
        mode: 'catalog-only',
        region: REGION,
        language: LANGUAGE,
        providers: PROVIDERS.map(
            provider => provider.name
        )
    });
});

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// ============================================================
// CACHE
// ============================================================

const cache = new Map();

const CACHE_TTL = 10 * 60 * 1000;

async function tmdb(path, params = {}) {

    if (!TMDB_KEY) {
        throw new Error(
            'TMDB_KEY não configurada no servidor'
        );
    }

    const query = new URLSearchParams({
        api_key: TMDB_KEY,
        language: LANGUAGE,
        ...params
    });

    const url =
        `${TMDB_BASE}${path}?${query.toString()}`;

    const cached = cache.get(url);

    if (
        cached &&
        Date.now() - cached.timestamp < CACHE_TTL
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
// PROVIDER
// ============================================================

function getProvider(providerId) {

    return PROVIDERS.find(
        provider => provider.id === providerId
    );
}

// ============================================================
// EXTRAI SKIP
//
// Aceita:
//
// ?skip=20
//
// /catalog/movie/netflix/skip=20.json
//
// /catalog/movie/netflix/20.json
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

        const skipMatch =
            decoded.match(
                /(?:^|[&;,])skip[=:](\d+)/i
            );

        if (skipMatch) {

            const value =
                parseInt(
                    skipMatch[1],
                    10
                );

            if (
                Number.isFinite(value) &&
                value >= 0
            ) {
                return value;
            }
        }

        const onlyNumber =
            decoded.match(
                /^(\d+)$/
            );

        if (onlyNumber) {

            const value =
                parseInt(
                    onlyNumber[1],
                    10
                );

            if (
                Number.isFinite(value) &&
                value >= 0
            ) {
                return value;
            }
        }
    }

    return 0;
}

// ============================================================
// DATA DO TÍTULO
// ============================================================

function getReleaseDate(item, type) {

    if (type === 'movie') {
        return item.release_date || '';
    }

    return item.first_air_date || '';
}

// ============================================================
// ORDENAÇÃO REAL
//
// O TMDB já manda ordenado.
//
// Mesmo assim nós ordenamos novamente aqui,
// antes de enviar para o Nuvio.
//
// Mais recente primeiro.
// ============================================================

function sortByReleaseDate(results, type) {

    return results
        .filter(item => {

            const date =
                getReleaseDate(
                    item,
                    type
                );

            return /^\d{4}-\d{2}-\d{2}$/.test(
                date
            );
        })
        .sort((a, b) => {

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

            // Mais recente primeiro
            const comparison =
                dateB.localeCompare(dateA);

            if (comparison !== 0) {
                return comparison;
            }

            // Desempate por popularidade
            const popularityA =
                Number(a.popularity || 0);

            const popularityB =
                Number(b.popularity || 0);

            return popularityB - popularityA;
        });
}

// ============================================================
// METADATA
// ============================================================

function toMeta(item, type, provider) {

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

    const date =
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

        releaseInfo:
            date
                ? date.substring(0, 4)
                : '',

        imdbRating:
            typeof item.vote_average === 'number'
                ? Number(
                    item.vote_average.toFixed(1)
                )
                : undefined,

        genres:
            Array.isArray(item.genre_ids)
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

async function catalogHandler(req, res) {

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

    const page =
        Math.floor(
            skip / PAGE_SIZE
        ) + 1;

    // --------------------------------------------------------
    // ENDPOINT TMDB
    // --------------------------------------------------------

    const path =
        type === 'movie'
            ? '/discover/movie'
            : '/discover/tv';

    // --------------------------------------------------------
    // ORDENAÇÃO TMDB
    // --------------------------------------------------------

    const sortBy =
        type === 'movie'
            ? 'primary_release_date.desc'
            : 'first_air_date.desc';

    // --------------------------------------------------------
    // PARÂMETROS
    // --------------------------------------------------------

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
            sortBy,

        page:
            String(page),

        include_adult:
            'false'
    };

    // Para filmes, o Brasil também é usado
    // para considerar a data regional.
    if (type === 'movie') {

        params.region =
            REGION;
    }

    // ========================================================
    // CONSULTA
    // ========================================================

    try {

        console.log(
            `[NetCine] Buscando ${provider.name} ${type}`
        );

        console.log(
            `[NetCine] Página: ${page}`
        );

        console.log(
            `[NetCine] Skip: ${skip}`
        );

        console.log(
            `[NetCine] Ordenação: ${sortBy}`
        );

        const data =
            await tmdb(
                path,
                params
            );

        let results =
            Array.isArray(
                data.results
            )
                ? data.results
                : [];

        // ====================================================
        // ORDENAÇÃO LOCAL
        // ====================================================

        results =
            sortByReleaseDate(
                results,
                type
            );

        // ====================================================
        // REMOVE DUPLICADOS
        // ====================================================

        const seen =
            new Set();

        results =
            results.filter(item => {

                if (
                    seen.has(
                        item.id
                    )
                ) {
                    return false;
                }

                seen.add(
                    item.id
                );

                return true;
            });

        // ====================================================
        // TRANSFORMA PARA NUVIO
        // ====================================================

        const metas =
            results
                .map(item =>
                    toMeta(
                        item,
                        type,
                        provider
                    )
                );

        // ====================================================
        // LOG
        // ====================================================

        if (metas.length > 0) {

            const first =
                metas[0];

            const last =
                metas[
                    metas.length - 1
                ];

            console.log(
                `[NetCine] ${provider.name} ${type}: ${metas.length} títulos`
            );

            console.log(
                `[NetCine] Primeiro: ${first.name} (${first.releaseInfo})`
            );

            console.log(
                `[NetCine] Último: ${last.name} (${last.releaseInfo})`
            );

        } else {

            console.log(
                `[NetCine] ${provider.name} ${type}: nenhum resultado`
            );
        }

        // ====================================================
        // RESPOSTA
        // ====================================================

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
// ROTAS
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
            now - value.timestamp >
            CACHE_TTL
        ) {

            cache.delete(
                key
            );
        }
    }

}, 5 * 60 * 1000);

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
            'NetCine Catálogo iniciado'
        );

        console.log(
            'Porta:',
            PORT
        );

        console.log(
            'Versão:',
            MANIFEST.version
        );

        console.log(
            'Modo: SOMENTE CATÁLOGO'
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
            'TMDB_KEY:',
            TMDB_KEY
                ? 'CONFIGURADA'
                : 'AUSENTE'
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