const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const API_BASE = "https://api.reidoscanais.st";
const SITE_REFERER = "https://reidoscanais.st/";

const PORT = Number(process.env.PORT) || 8080;

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, "");

// ======================================================
// MANIFESTO
// ======================================================

const manifest = {
  id: "org.reidoscanais.stremio",
  version: "1.0.0",
  name: "Rei dos Canais Addon",
  description: "Canais ao vivo do Rei dos Canais",
  resources: ["catalog", "stream"],
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

// ======================================================
// REQUISIÇÃO À API
// ======================================================

async function fetchFromApi(endpoint) {
  try {
    const response = await axios.get(
      `${API_BASE}${endpoint}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": SITE_REFERER,
          "Accept":
            "application/json, text/plain, */*"
        },

        timeout: 8000
      }
    );

    return response.data;

  } catch (err) {

    console.error(
      `[API ERROR] ${endpoint}:`,
      err.message
    );

    return null;
  }
}

// ======================================================
// CATÁLOGO
// ======================================================

builder.defineCatalogHandler(async (args) => {

  if (args.type !== "tv") {
    return {
      metas: []
    };
  }

  const data =
    await fetchFromApi("/channels");

  if (!data) {
    return {
      metas: []
    };
  }

  const items =
    Array.isArray(data)
      ? data
      : (
          data.channels ||
          data.data ||
          []
        );

  if (!Array.isArray(items)) {

    console.error(
      "[CATALOG ERROR] A API não retornou uma lista."
    );

    return {
      metas: []
    };
  }

  const metas = items
    .map((item) => {

      const id =
        item.id ||
        item.slug ||
        item.code ||
        item._id;

      if (!id) {
        return null;
      }

      return {

        id: `rc_${id}`,

        type: "tv",

        name:
          item.name ||
          item.title ||
          item.channel_name ||
          "Canal TV",

        poster:
          item.poster ||
          item.logo ||
          item.image ||
          item.icon ||
          ""
      };
    })
    .filter(Boolean);

  console.log(
    `[CATALOG] ${metas.length} canais encontrados`
  );

  return {
    metas
  };
});

// ======================================================
// STREAM
// ======================================================

builder.defineStreamHandler(async (args) => {

  if (args.type !== "tv") {
    return {
      streams: []
    };
  }

  if (!args.id) {
    return {
      streams: []
    };
  }

  const channelId =
    args.id.replace(/^rc_/, "");

  console.log(
    `[STREAM] Canal solicitado: ${channelId}`
  );

  const data =
    await fetchFromApi(
      `/stream/${channelId}`
    );

  if (!data) {
    return {
      streams: []
    };
  }

  let targetUrl = null;

  // Caso a API retorne diretamente uma URL
  if (
    typeof data === "string" &&
    /^https?:\/\//i.test(data)
  ) {

    targetUrl = data;

  }

  // Caso a API retorne um objeto
  else if (
    typeof data === "object" &&
    data !== null
  ) {

    targetUrl =
      data.url ||
      data.streamUrl ||
      data.link ||
      data.hls ||
      data.m3u8 ||
      null;
  }

  if (!targetUrl) {

    console.warn(
      `[STREAM] Nenhuma URL encontrada para ${channelId}`
    );

    return {
      streams: []
    };
  }

  console.log(
    `[STREAM] URL encontrada para ${channelId}`
  );

  // URL pública do proxy
  const proxyUrl =
    `${PUBLIC_URL}/proxy?url=${encodeURIComponent(
      targetUrl
    )}`;

  return {

    streams: [

      // Stream direto
      {
        title:
          "Rei dos Canais | Direct Stream",

        url: targetUrl,

        behaviorHints: {
          notSupported: false
        }
      },

      // Proxy
      {
        title:
          "Rei dos Canais | Server Proxy",

        url: proxyUrl,

        behaviorHints: {
          notSupported: false
        }
      }

    ]
  };
});

// ======================================================
// INTERFACE DO STREMIO
// ======================================================

const sdkInterface =
  builder.getInterface();

// ======================================================
// SERVIDOR HTTP
// ======================================================

const server = http.createServer(
  (req, res) => {

    try {

      // ==================================================
      // HEALTH CHECK
      // ==================================================

      if (
        req.url === "/health" ||
        req.url === "/health/"
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json; charset=utf-8",

            "Cache-Control":
              "no-cache"
          }
        );

        return res.end(
          JSON.stringify({
            status: "ok",
            service: "stremio-addon",
            port: PORT,
            timestamp:
              new Date().toISOString()
          })
        );
      }

      // ==================================================
      // PÁGINA PRINCIPAL
      // ==================================================

      if (
        req.url === "/" ||
        req.url === ""
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        );

        return res.end(
          "Stremio Addon online."
        );
      }

      // ==================================================
      // PROXY
      // ==================================================

      if (
        req.url.startsWith("/proxy")
      ) {

        let remoteUrl;

        try {

          const requestUrl =
            new URL(
              req.url,
              `http://${req.headers.host}`
            );

          remoteUrl =
            requestUrl.searchParams.get(
              "url"
            );

        } catch (err) {

          res.writeHead(
            400,
            {
              "Content-Type":
                "text/plain"
            }
          );

          return res.end(
            "URL de requisicao invalida."
          );
        }

        if (!remoteUrl) {

          res.writeHead(
            400,
            {
              "Content-Type":
                "text/plain"
            }
          );

          return res.end(
            "Parametro URL em falta."
          );
        }

        let parsedRemote;

        try {

          parsedRemote =
            new URL(remoteUrl);

        } catch (err) {

          res.writeHead(
            400,
            {
              "Content-Type":
                "text/plain"
            }
          );

          return res.end(
            "URL remota invalida."
          );
        }

        if (
          parsedRemote.protocol !== "http:" &&
          parsedRemote.protocol !== "https:"
        ) {

          res.writeHead(
            400,
            {
              "Content-Type":
                "text/plain"
            }
          );

          return res.end(
            "Protocolo nao permitido."
          );
        }

        const client =
          parsedRemote.protocol === "https:"
            ? https
            : http;

        const proxyReq =
          client.request(
            remoteUrl,
            {
              method:
                req.method || "GET",

              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",

                "Accept":
                  req.headers.accept ||
                  "*/*"
              },

              timeout: 15000
            },

            (proxyRes) => {

              const headers = {
                ...proxyRes.headers,

                "access-control-allow-origin":
                  "*"
              };

              res.writeHead(
                proxyRes.statusCode || 502,
                headers
              );

              proxyRes.pipe(res);
            }
          );

        proxyReq.on(
          "timeout",
          () => {

            console.error(
              "[PROXY] Timeout"
            );

            proxyReq.destroy();

            if (!res.headersSent) {

              res.writeHead(
                504,
                {
                  "Content-Type":
                    "text/plain"
                }
              );
            }

            res.end(
              "Timeout no servidor remoto."
            );
          }
        );

        proxyReq.on(
          "error",
          (err) => {

            console.error(
              "[PROXY ERROR]:",
              err.message
            );

            if (!res.headersSent) {

              res.writeHead(
                502,
                {
                  "Content-Type":
                    "text/plain"
                }
              );
            }

            res.end(
              "Erro ao conectar ao servidor remoto."
            );
          }
        );

        req.on(
          "close",
          () => {

            if (!proxyReq.destroyed) {
              proxyReq.destroy();
            }
          }
        );

        req.pipe(proxyReq);

        return;
      }

      // ==================================================
      // STREMIO SDK
      // ==================================================

      sdkInterface(
        req,
        res
      );

    } catch (err) {

      console.error(
        "[SERVER ERROR]",
        err
      );

      if (!res.headersSent) {

        res.writeHead(
          500,
          {
            "Content-Type":
              "text/plain"
          }
        );
      }

      res.end(
        "Erro interno do servidor."
      );
    }
  }
);

// ======================================================
// ERROS DO SERVIDOR
// ======================================================

server.on(
  "error",
  (err) => {

    console.error(
      "[SERVER ERROR]",
      err
    );
  }
);

// ======================================================
// ERROS DO NODE
// ======================================================

process.on(
  "uncaughtException",
  (err) => {

    console.error(
      "[UNCAUGHT EXCEPTION]",
      err
    );
  }
);

process.on(
  "unhandledRejection",
  (err) => {

    console.error(
      "[UNHANDLED REJECTION]",
      err
    );
  }
);

// ======================================================
// INICIAR SERVIDOR
// ======================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "Stremio Addon iniciado"
    );

    console.log(
      `Porta: ${PORT}`
    );

    console.log(
      "Host: 0.0.0.0"
    );

    console.log(
      `URL pública: ${PUBLIC_URL}`
    );

    console.log(
      `Health: ${PUBLIC_URL}/health`
    );

    console.log(
      `Manifest: ${PUBLIC_URL}/manifest.json`
    );

    console.log(
      "======================================"
    );
  }
);