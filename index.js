const http = require("http");
const axios = require("axios");
const { URL } = require("url");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, "");

const API_BASE = "https://api.reidoscanais.st";
const API_REFERER = "https://reidoscanais.st/";

const HTTP_HEADERS = {
  Referer: API_REFERER,
  Origin: "https://reidoscanais.st",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  Accept: "*/*"
};

const manifest = {
  id: "org.reidoscanais.stremio",
  version: "2.0.0",
  name: "Rei dos Canais Addon",
  description: "Canais ao vivo do Rei dos Canais",

  resources: [
    "catalog",
    "meta",
    "stream"
  ],

  types: ["tv"],

  catalogs: [
    {
      type: "tv",
      id: "reidoscanais_tv",
      name: "Rei dos Canais - Ao Vivo"
    }
  ]
};

const builder = new addonBuilder(manifest);

/* =========================================================
   BUSCAR CANAIS NA API
   ========================================================= */

async function getChannels() {
  const response = await axios.get(
    `${API_BASE}/channels`,
    {
      headers: HTTP_HEADERS,
      timeout: 15000
    }
  );

  const data = response.data;

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.channels)) {
    return data.channels;
  }

  return [];
}

/* =========================================================
   ID
   ========================================================= */

function getChannelId(channel, index) {
  return String(
    channel.id ??
    channel.channelId ??
    channel.slug ??
    channel.name ??
    `channel_${index}`
  );
}

/* =========================================================
   NOME
   ========================================================= */

function getChannelName(channel, index) {
  return String(
    channel.name ??
    channel.title ??
    channel.channelName ??
    `Canal ${index + 1}`
  );
}

/* =========================================================
   LOGO
   ========================================================= */

function getChannelPoster(channel) {
  return (
    channel.logo_url ??
    channel.poster ??
    channel.logo ??
    channel.image ??
    channel.icon ??
    null
  );
}

/* =========================================================
   TRANSFORMAR URL
   ========================================================= */

function cleanUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  let url = value.trim();

  url = url
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/\\x26/g, "&");

  return url;
}

/* =========================================================
   VERIFICAR SE É HLS
   ========================================================= */

function isHlsUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  return (
    /\.m3u8(?:[?#]|$)/i.test(url) ||
    /\/hls(?:[/?]|$)/i.test(url)
  );
}

/* =========================================================
   EXTRAIR STREAM_URLS DO PLAYER
   ========================================================= */

function extractStreamUrls(html) {
  const urls = [];

  if (!html || typeof html !== "string") {
    return urls;
  }

  /*
   Exemplo procurado:

   window.STREAM_URLS = [
      "https://servidor/live/canal/index.m3u8"
   ];
  */

  const patterns = [
    /window\.STREAM_URLS\s*=\s*(\[[\s\S]*?\])\s*;/i,

    /STREAM_URLS\s*=\s*(\[[\s\S]*?\])\s*;/i,

    /STREAM_URLS\s*:\s*(\[[\s\S]*?\])/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (!match) {
      continue;
    }

    const arrayText = match[1];

    const stringMatches = arrayText.match(
      /["'`](https?:\/\/[^"'`]+)["'`]/gi
    );

    if (!stringMatches) {
      continue;
    }

    for (const item of stringMatches) {
      const urlMatch = item.match(
        /["'`](https?:\/\/[^"'`]+)["'`]/
      );

      if (!urlMatch) {
        continue;
      }

      const url = cleanUrl(urlMatch[1]);

      if (url && isHlsUrl(url)) {
        urls.push(url);
      }
    }
  }

  /*
   Fallback:
   procura qualquer URL .m3u8 dentro do HTML.
  */

  if (urls.length === 0) {
    const matches = html.match(
      /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi
    );

    if (matches) {
      for (const value of matches) {
        const url = cleanUrl(value);

        if (url && isHlsUrl(url)) {
          urls.push(url);
        }
      }
    }
  }

  return [...new Set(urls)];
}

/* =========================================================
   RESOLVER EMBED
   ========================================================= */

async function resolveEmbed(embedUrl) {
  if (!embedUrl) {
    return [];
  }

  /*
   Se a própria API já entregar um .m3u8,
   não precisamos abrir o player.
  */

  if (isHlsUrl(embedUrl)) {
    return [embedUrl];
  }

  console.log(
    "[RESOLVE] Abrindo player:",
    embedUrl
  );

  try {
    const response = await axios.get(
      embedUrl,
      {
        headers: {
          ...HTTP_HEADERS,
          Referer: API_REFERER
        },
        timeout: 15000,
        maxRedirects: 5,
        responseType: "text"
      }
    );

    const html = response.data;

    console.log(
      "[RESOLVE] HTML recebido:",
      typeof html === "string"
        ? html.length
        : 0,
      "bytes"
    );

    const urls = extractStreamUrls(html);

    console.log(
      "[RESOLVE] HLS encontrados:",
      urls.length
    );

    for (const url of urls) {
      console.log(
        "[RESOLVE] HLS:",
        url
      );
    }

    return urls;

  } catch (error) {

    console.error(
      "[RESOLVE ERROR]",
      error.response?.status || "",
      error.message
    );

    return [];
  }
}

/* =========================================================
   CATALOG
   ========================================================= */

builder.defineCatalogHandler(async (args) => {

  console.log(
    "[CATALOG REQUEST]",
    JSON.stringify(args)
  );

  try {

    const channels = await getChannels();

    const metas = channels.map(
      (channel, index) => {

        const id =
          getChannelId(channel, index);

        const name =
          getChannelName(channel, index);

        const poster =
          getChannelPoster(channel);

        const meta = {
          id,
          type: "tv",
          name
        };

        if (poster) {
          meta.poster = String(poster);
        }

        return meta;
      }
    );

    console.log(
      "[CATALOG] Canais encontrados:",
      metas.length
    );

    return {
      metas
    };

  } catch (error) {

    console.error(
      "[CATALOG ERROR]",
      error.response?.status || "",
      error.message
    );

    return {
      metas: []
    };
  }
});

/* =========================================================
   META
   ========================================================= */

builder.defineMetaHandler(async (args) => {

  console.log(
    "[META REQUEST]",
    JSON.stringify(args)
  );

  try {

    const channelId = args.id;

    if (!channelId) {
      return {
        meta: null
      };
    }

    const channels =
      await getChannels();

    const channelIndex =
      channels.findIndex(
        (channel, index) =>
          getChannelId(
            channel,
            index
          ) === String(channelId)
      );

    if (channelIndex === -1) {

      return {
        meta: {
          id: String(channelId),
          type: "tv",
          name: String(channelId)
        }
      };
    }

    const channel =
      channels[channelIndex];

    const name =
      getChannelName(
        channel,
        channelIndex
      );

    const poster =
      getChannelPoster(channel);

    const meta = {
      id: String(channelId),
      type: "tv",
      name
    };

    if (poster) {
      meta.poster = String(poster);
    }

    if (channel.description) {
      meta.description =
        String(channel.description);
    }

    return {
      meta
    };

  } catch (error) {

    console.error(
      "[META ERROR]",
      error.response?.status || "",
      error.message
    );

    return {
      meta: null
    };
  }
});

/* =========================================================
   STREAM
   ========================================================= */

builder.defineStreamHandler(async (args) => {

  console.log(
    "[STREAM REQUEST]",
    JSON.stringify(args)
  );

  try {

    const channelId = args.id;

    if (!channelId) {

      console.log(
        "[STREAM] ID não informado"
      );

      return {
        streams: []
      };
    }

    const channels =
      await getChannels();

    const channelIndex =
      channels.findIndex(
        (channel, index) =>
          getChannelId(
            channel,
            index
          ) === String(channelId)
      );

    if (channelIndex === -1) {

      console.log(
        "[STREAM] Canal não encontrado:",
        channelId
      );

      return {
        streams: []
      };
    }

    const channel =
      channels[channelIndex];

    const embeds =
      Array.isArray(channel.embeds)
        ? channel.embeds
        : [];

    console.log(
      "[STREAM] Canal:",
      getChannelName(
        channel,
        channelIndex
      )
    );

    console.log(
      "[STREAM] Embeds encontrados:",
      embeds.length
    );

    if (embeds.length === 0) {

      console.log(
        "[STREAM] Nenhum embed disponível"
      );

      return {
        streams: []
      };
    }

    const streams = [];

    for (const embed of embeds) {

      if (
        !embed ||
        typeof embed !== "object"
      ) {
        continue;
      }

      /*
       Primeiro tenta campos que já sejam
       diretamente HLS.
      */

      const directUrl =
        embed.m3u8_url ??
        embed.m3u8 ??
        embed.stream_url ??
        embed.streamUrl ??
        embed.hls_url ??
        embed.hls ??
        null;

      if (
        directUrl &&
        typeof directUrl === "string" &&
        isHlsUrl(directUrl)
      ) {

        const url =
          cleanUrl(directUrl);

        console.log(
          "[STREAM] HLS direto:",
          url
        );

        streams.push({
          url,
          title:
            embed.provider
              ? String(embed.provider)
              : "HLS"
        });

        continue;
      }

      /*
       Caso normal:
       API entrega embed_url.
      */

      const embedUrl =
        embed.embed_url ??
        embed.url ??
        embed.src ??
        null;

      if (
        !embedUrl ||
        typeof embedUrl !== "string"
      ) {
        continue;
      }

      console.log(
        "[STREAM] Embed:",
        embedUrl
      );

      const hlsUrls =
        await resolveEmbed(embedUrl);

      const provider =
        embed.provider
          ? String(embed.provider)
          : "Servidor";

      const quality =
        embed.quality
          ? String(embed.quality)
          : "";

      for (const hlsUrl of hlsUrls) {

        streams.push({
          url: hlsUrl,

          title: quality
            ? `${provider} - ${quality}`
            : provider,

          behaviorHints: {
            notWebReady: false
          }
        });
      }
    }

    /*
     Remove URLs duplicadas.
    */

    const uniqueStreams = [];

    const seen = new Set();

    for (const stream of streams) {

      if (
        !stream.url ||
        seen.has(stream.url)
      ) {
        continue;
      }

      seen.add(stream.url);

      uniqueStreams.push(stream);
    }

    console.log(
      "[STREAM] Streams HLS disponíveis:",
      uniqueStreams.length
    );

    return {
      streams: uniqueStreams
    };

  } catch (error) {

    console.error(
      "[STREAM ERROR]",
      error.response?.status || "",
      error.message
    );

    return {
      streams: []
    };
  }
});

/* =========================================================
   ROUTER
   ========================================================= */

const addonInterface =
  builder.getInterface();

const addonRouter =
  getRouter(addonInterface);

/* =========================================================
   SERVIDOR
   ========================================================= */

const server =
  http.createServer(
    (req, res) => {

      const requestUrl =
        new URL(
          req.url || "/",
          `http://${req.headers.host || "localhost"}`
        );

      /*
       CORS
      */

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );

      res.setHeader(
        "Access-Control-Allow-Headers",
        "*"
      );

      /* HEALTH */

      if (
        requestUrl.pathname === "/health"
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json; charset=utf-8"
          }
        );

        res.end(
          JSON.stringify({
            status: "ok",
            service: "stremio-addon",
            port: PORT,
            timestamp:
              new Date().toISOString()
          })
        );

        return;
      }

      /* HOME */

      if (
        requestUrl.pathname === "/"
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        );

        res.end(
          "Stremio Addon online.\n" +
          `Manifest: ${PUBLIC_URL}/manifest.json\n` +
          `Health: ${PUBLIC_URL}/health\n`
        );

        return;
      }

      /* STREMIO */

      try {

        addonRouter(
          req,
          res,
          (error) => {

            if (error) {

              console.error(
                "[ROUTER ERROR]",
                error
              );

              if (!res.headersSent) {

                res.writeHead(
                  500,
                  {
                    "Content-Type":
                      "application/json; charset=utf-8"
                  }
                );

                res.end(
                  JSON.stringify({
                    error:
                      "Internal server error"
                  })
                );
              }

              return;
            }

            if (!res.headersSent) {

              res.writeHead(
                404,
                {
                  "Content-Type":
                    "application/json; charset=utf-8"
                }
              );

              res.end(
                JSON.stringify({
                  error: "Not found"
                })
              );
            }
          }
        );

      } catch (error) {

        console.error(
          "[SERVER ERROR]",
          error
        );

        if (!res.headersSent) {

          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json; charset=utf-8"
            }
          );

          res.end(
            JSON.stringify({
              error:
                "Internal server error"
            })
          );
        }
      }
    }
  );

/* =========================================================
   INICIAR
   ========================================================= */

server.listen(
  PORT,
  HOST,
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "Stremio Addon iniciado"
    );

    console.log(
      "Versão:",
      manifest.version
    );

    console.log(
      "Porta:",
      PORT
    );

    console.log(
      "Host:",
      HOST
    );

    console.log(
      "URL pública:",
      PUBLIC_URL
    );

    console.log(
      "Health:",
      `${PUBLIC_URL}/health`
    );

    console.log(
      "Manifest:",
      `${PUBLIC_URL}/manifest.json`
    );

    console.log(
      "======================================"
    );
  }
);