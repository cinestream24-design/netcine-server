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

const manifest = {
  id: "org.reidoscanais.stremio",
  version: "1.0.2",
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
   BUSCAR CANAIS
   ========================================================= */

async function getChannels() {
  const response = await axios.get(
    `${API_BASE}/channels`,
    {
      headers: {
        Referer: API_REFERER,
        "User-Agent": "Mozilla/5.0"
      },
      timeout: 15000
    }
  );

  const data = response.data;

  // A API atual retorna:
  // { success: true, data: [...] }

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
   PEGAR ID DO CANAL
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
   PEGAR NOME DO CANAL
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
   PEGAR LOGO
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
   CATALOG
   ========================================================= */

builder.defineCatalogHandler(async (args) => {
  console.log(
    "[CATALOG REQUEST]",
    JSON.stringify(args)
  );

  try {
    const channels = await getChannels();

    const metas = channels.map((channel, index) => {
      const id = getChannelId(
        channel,
        index
      );

      const name = getChannelName(
        channel,
        index
      );

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
    });

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
      console.log(
        "[META] ID não informado"
      );

      return {
        meta: null
      };
    }

    const channels = await getChannels();

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
        "[META] Canal não encontrado:",
        channelId
      );

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

    console.log(
      "[META] Canal encontrado:",
      name
    );

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

    /*
     * A API não possui /stream/{id}.
     *
     * O endpoint /channels já retorna os
     * embeds de cada canal.
     */

    const channels = await getChannels();

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

      const provider =
        embed.provider
          ? String(embed.provider)
          : "Servidor";

      const quality =
        embed.quality
          ? String(embed.quality)
          : "";

      streams.push({
        url: embedUrl,
        title: quality
          ? `${provider} - ${quality}`
          : provider
      });
    }

    console.log(
      "[STREAM] Streams disponíveis:",
      streams.length
    );

    return {
      streams
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
   SERVIDOR HTTP
   ========================================================= */

const server = http.createServer(
  (req, res) => {

    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );

    /* =========================
       HEALTH
       ========================= */

    if (
      requestUrl.pathname === "/health"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "application/json; charset=utf-8"
      });

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

    /* =========================
       HOME
       ========================= */

    if (
      requestUrl.pathname === "/"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "text/plain; charset=utf-8"
      });

      res.end(
        "Stremio Addon online.\n" +
        `Manifest: ${PUBLIC_URL}/manifest.json\n` +
        `Health: ${PUBLIC_URL}/health\n`
      );

      return;
    }

    /* =========================
       STREMIO ROUTER
       ========================= */

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
   INICIAR SERVIDOR
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