const express = require('express');

const app = express();
const PORT = Number(process.env.PORT || 8080);

const TMDB_KEY = process.env.TMDB_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const LANGUAGE = process.env.TMDB_LANGUAGE || 'pt-BR';
const REGION = process.env.TMDB_REGION || 'BR';

const IMAGE_BASE = 'https://image.tmdb.org/t/p/';

if (!TMDB_KEY) {
    console.warn('[NetCine] TMDB_KEY não configurada. Cadastre TMDB_KEY nas Variables do Railway.');
}

app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ============================================================
// NETCINE — CATÁLOGO SOMENTE
//
// Organização:
// Serviço
//   ├── Filmes
//   │    └── gênero / paginação
//   └── Séries
//        └── gênero / paginação
//
// Não existe stream, player, link de vídeo ou resolução.
// ============================================================

const SERVICES = [
    {
        id: 'netflix',
        name: 'Netflix',
        aliases: ['Netflix'],
        fallbackProviderId: 8,
        logo: 'https://image.tmdb.org/t/p/original/t2yyOv40HZeVlLjYsCsPHnWLk4W.jpg'
    },
    {
        id: 'disney_plus',
        name: 'Disney+',
        aliases: ['Disney Plus', 'Disney+'],
        fallbackProviderId: 337,
        logo: 'https://image.tmdb.org/t/p/original/7rwgEs15tFwyR9NPQ5vpzxTj19Q.jpg'
    },
    {
        id: 'prime_video',
        name: 'Prime Video',
        aliases: ['Amazon Prime Video', 'Prime Video'],
        fallbackProviderId: 119,
        logo: 'https://image.tmdb.org/t/p/original/emthp39XA2YScoYL1p0sdbAH2WA.jpg'
    },
    {
        id: 'max',
        name: 'Max',
        aliases: ['HBO Max', 'Max'],
        fallbackProviderId: 1899,
        logo: 'https://image.tmdb.org/t/p/original/6AK8H0dHnX6cV3aK1mQmFJYQf8H.jpg'
    },
    {
        id: 'apple_tv_plus',
        name: 'Apple TV+',
        aliases: ['Apple TV Plus', 'Apple TV+'],
        fallbackProviderId: 350,
        logo: 'https://image.tmdb.org/t/p/original/peURlLlr8jggOwK53fJ5wdQl05y.jpg'
    },
    {
        id: 'paramount_plus',
        name: 'Paramount+',
        aliases: ['Paramount Plus', 'Paramount+'],
        fallbackProviderId: 531,
        logo: 'https://image.tmdb.org/t/p/original/xbhHHa1YgtpwhC8lb1NQ3ACVcLd.jpg'
    },
    {
        id: 'globoplay',
        name: 'Globoplay',
        aliases: ['Globoplay'],
        fallbackProviderId: 307,
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
        ['36', 'História'],
        ['27', 'Terror'],
        ['9648', 'Mistério'],
        ['878', 'Ficção científica'],
        ['53', 'Thriller'],
        ['10749', 'Romance'],
        ['10752', 'Guerra']
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
        ['10766', 'Novela'],
        ['10763', 'Notícias'],
        ['10764', 'Reality']
    ]
};

const SORT_OPTIONS = [
    ['popular', 'Mais populares'],
    ['top_rated', 'Mais bem avaliados'],
    ['recent', 'Mais recentes']
];

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(key) {
    const item = cache.get(key);
    if (!item || Date.now() - item.ts > CACHE_TTL) {
        if (item) cache.delete(key);
        return null;
    }
    return item.data;
}

function cacheSet(key, data, ttl = CACHE_TTL) {
    cache.set(key, { data, ts: Date.now(), ttl });
    return data;
}

async function tmdb(path, params = {}) {
    if (!TMDB_KEY) {
        throw new Error('TMDB_KEY não configurada');
    }

    const query = new URLSearchParams({
        api_key: TMDB_KEY,
        language: LANGUAGE,
        ...params
    });

    const url = `${TMDB_BASE}${path}?${query.toString()}`;
    const cached = cacheGet(url);
    if (cached) return cached;

    const response = await fetch(url, {
        headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`TMDB HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
    }

    const data = await response.json();
    return cacheSet(url, data);
}

function image(path, size = 'w500') {
    return path ? `${IMAGE_BASE}${size}${path}` : null;
}

function normalizeName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9+]+/g, ' ')
        .trim();
}

function findProviderId(list, service) {
    const aliases = service.aliases.map(normalizeName);

    const exact = list.find(provider =>
        aliases.includes(normalizeName(provider.provider_name))
    );

    if (exact) return exact.provider_id;

    const partial = list.find(provider => {
        const name = normalizeName(provider.provider_name);
        return aliases.some(alias => name.includes(alias) || alias.includes(name));
    });

    return partial ? partial.provider_id : service.fallbackProviderId;
}

async function getProviderIds(service) {
    const key = `provider-ids:${service.id}:${REGION}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    try {
        const [movieProviders, tvProviders] = await Promise.all([
            tmdb('/watch/providers/movie', {
                watch_region: REGION,
                language: LANGUAGE
            }),
            tmdb('/watch/providers/tv', {
                watch_region: REGION,
                language: LANGUAGE
            })
        ]);

        const result = {
            movie: findProviderId(movieProviders.results || [], service),
            series: findProviderId(tvProviders.results || [], service)
        };

        return cacheSet(key, result, 24 * 60 * 60 * 1000);
    } catch (error) {
        console.warn(`[NetCine] Falha ao consultar provedor ${service.name}:`, error.message);
        return {
            movie: service.fallbackProviderId,
            series: service.fallbackProviderId
        };
    }
}

function getService(serviceId) {
    return SERVICES.find(service => service.id === serviceId);
}

function getTypeName(type) {
    return type === 'movie' ? 'Filmes' : 'Séries';
}

function getSort(type, sort) {
    if (sort === 'top_rated') return 'vote_average.desc';
    if (sort === 'recent') {
        return type === 'movie'
            ? 'primary_release_date.desc'
            : 'first_air_date.desc';
    }
    return 'popularity.desc';
}

function buildCatalog(id, type, service) {
    return {
        id,
        type,
        name: `${service.name} • ${getTypeName(type)}`,
        poster: service.logo,
        posterShape: 'landscape',
        extra: [
            {
                name: 'genre',
                isRequired: false,
                options: GENRES[type].map(([genreId, name]) => ({
                    id: genreId,
                    name
                }))
            },
            {
                name: 'sort',
                isRequired: false,
                options: SORT_OPTIONS.map(([sortId, name]) => ({
                    id: sortId,
                    name
                }))
            },
            {
                name: 'skip',
                isRequired: false
            }
        ]
    };
}

const catalogs = [];
for (const service of SERVICES) {
    catalogs.push(buildCatalog(`${service.id}_movie`, 'movie', service));
    catalogs.push(buildCatalog(`${service.id}_series`, 'series', service));
}

const MANIFEST = {
    id: 'br.netcine.catalog',
    version: '2.1.0',
    name: 'NetCine Catálogo',
    description: 'Catálogo organizado por serviço de streaming, filmes, séries e gêneros. Somente catálogo e metadados.',
    logo: SERVICES[0].logo,
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs
};

app.get('/manifest.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(MANIFEST);
});

app.get('/', (req, res) => {
    res.json({
        name: 'NetCine Catálogo',
        version: MANIFEST.version,
        status: 'online',
        mode: 'catalog-only',
        region: REGION,
        language: LANGUAGE,
        resources: ['catalog'],
        services: SERVICES.map(service => service.name)
    });
});

function toMeta(item, type, service) {
    const title = type === 'movie' ? item.title : item.name;
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
        releaseInfo: date ? String(date).slice(0, 4) : '',
        imdbRating: typeof item.vote_average === 'number'
            ? Number(item.vote_average.toFixed(1))
            : undefined,
        genres: Array.isArray(item.genre_ids) ? item.genre_ids : [],
        posterShape: 'poster',
        behaviorHints: {
            defaultVideoId: `tmdb:${item.id}`
        },
        netcineProvider: service.id,
        netcineProviderName: service.name
    };
}

async function catalogHandler(req, res) {
    const { type, provider } = req.params;
    const service = getService(provider);

    if (!service || !['movie', 'series'].includes(type)) {
        return res.status(404).json({ metas: [] });
    }

    const rawSkip = Number.parseInt(req.query.skip || '0', 10);
    const skip = Number.isFinite(rawSkip) && rawSkip >= 0 ? rawSkip : 0;
    const genre = String(req.query.genre || 'all');
    const sort = String(req.query.sort || 'popular');

    const page = Math.floor(skip / 20) + 1;
    const providerIds = await getProviderIds(service);
    const providerId = providerIds[type];

    const params = {
        watch_region: REGION,
        with_watch_providers: String(providerId),
        with_watch_monetization_types: 'flatrate',
        include_adult: 'false',
        include_video: 'false',
        page: String(page),
        sort_by: getSort(type, sort)
    };

    if (genre !== 'all' && GENRES[type].some(([id]) => id === genre)) {
        params.with_genres = genre;
    }

    try {
        const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
        const data = await tmdb(path, params);

        const metas = (data.results || [])
            .filter(item => item && item.id)
            .map(item => toMeta(item, type, service));

        res.json({
            metas,
            cacheMaxAge: 600
        });
    } catch (error) {
        console.error(`[NetCine Catalog] ${service.name}/${type}:`, error.message);
        res.status(200).json({
            metas: [],
            cacheMaxAge: 60
        });
    }
}

// Padrão:
// /catalog/movie/netflix.json
// /catalog/series/disney_plus.json
app.get('/catalog/:type/:provider.json', catalogHandler);

// Compatibilidade com clientes que acrescentem extras na URL.
app.get('/catalog/:type/:provider/:extra.json', catalogHandler);

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache) {
        if (now - value.ts > (value.ttl || CACHE_TTL)) {
            cache.delete(key);
        }
    }
}, 5 * 60 * 1000).unref();

app.listen(PORT, () => {
    console.log('========================================');
    console.log('NetCine Catálogo iniciado');
    console.log('Porta:', PORT);
    console.log('Modo: SOMENTE CATÁLOGO');
    console.log('Região:', REGION);
    console.log('Serviços:', SERVICES.map(service => service.name).join(', '));
    console.log('TMDB_KEY:', TMDB_KEY ? 'CONFIGURADA' : 'NÃO CONFIGURADA');
    console.log('========================================');
});
