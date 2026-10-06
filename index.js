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

  // ====================================================
  // API RETORNANDO URL DIRETAMENTE
  // ====================================================

  if (
    typeof data === "string" &&
    /^https?:\/\//i.test(data)
  ) {

    targetUrl = data;

  }

  // ====================================================
  // API RETORNANDO OBJETO
  // ====================================================

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

  // ====================================================
  // NENHUMA URL
  // ====================================================

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

  // ====================================================
  // URL DO PROXY
  // ====================================================

  const proxyUrl =
    `${PUBLIC_URL}/proxy?url=${encodeURIComponent(
      targetUrl
    )}`;

  return {

    streams: [

      // ------------------------------------------------
      // STREAM DIRETO
      // ------------------------------------------------

      {
        title:
          "Rei dos Canais | Direct Stream",

        url: targetUrl,

        behaviorHints: {
          notSupported: false
        }
      },

      // ------------------------------------------------
      // STREAM PELO SERVIDOR
      // ------------------------------------------------

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
// FUNÇÃO PARA ENVIAR JSON
// ======================================================

function sendJson(res, statusCode, data) {

  if (res.headersSent) {
    return;
  }

  res.writeHead(
    statusCode,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Methods":
        "GET, OPTIONS",

      "Access-Control-Allow-Headers":
        "*",

      "Cache-Control":
        "no-cache"
    }
  );

  res.end(
    JSON.stringify(data)
  );
}

// ======================================================
// PARSER DOS EXTRAS DO STREMIO
// ======================================================

function parseExtra(extraString) {

  const extra = {};

  if (!extraString) {
    return extra;
  }

  const parts =
    extraString.split("&");

  for (const part of parts) {

    if (!part) {
      continue;
    }

    const separator =
      part.indexOf("=");

    if (separator === -1) {

      extra[
        decodeURIComponent(part)
      ] = true;

      continue;
    }

    const key =
      decodeURIComponent(
        part.substring(0, separator)
      );

    const value =
      decodeURIComponent(
        part.substring(separator + 1)
      );

    extra[key] = value;
  }

  return extra;
}

// ======================================================
// TRATAR ROTAS DO STREMIO
// ======================================================

async function handleStremioRequest(
  req,
  res,
  pathname
) {

  // ====================================================
  // MANIFEST
  // ====================================================

  if (
    pathname === "/manifest.json" ||
    pathname === "/manifest"
  ) {

    return sendJson(
      res,
      200,
      manifest
    );
  }

  // ====================================================
  // CATALOG
  // ====================================================

  if (
    pathname.startsWith("/catalog/")
  ) {

    let route =
      pathname.substring(
        "/catalog/".length
      );

    route =
      route.replace(/\.json$/, "");

    const parts =
      route.split("/");

    const type =
      parts[0]
        ? decodeURIComponent(parts[0])
        : null;

    const id =
      parts[1]
        ? decodeURIComponent(parts[1])
        : null;

    const extraString =
      parts.length > 2
        ? parts.slice(2).join("/")
        : "";

    if (!type || !id) {

      return sendJson(
        res,
        400,
        {
          error:
            "Rota de catálogo inválida."
        }
      );
    }

    try {

      const result =
        await sdkInterface.get({
          resource: "catalog",
          type,
          id,
          extra:
            parseExtra(extraString)
        });

      return sendJson(
        res,
        200,
        result || { metas: [] }
      );

    } catch (err) {

      console.error(
        "[CATALOG REQUEST ERROR]",
        err
      );

      return sendJson(
        res,
        500,
        {
          metas: [],
          error:
            "Erro ao carregar catálogo."
        }
      );
    }
  }

  // ====================================================
  // STREAM
  // ====================================================

  if (
    pathname.startsWith("/stream/")
  ) {

    let route =
      pathname.substring(
        "/stream/".length
      );

    route =
      route.replace(/\.json$/, "");

    const parts =
      route.split("/");

    const type =
      parts[0]
        ? decodeURIComponent(parts[0])
        : null;

    const id =
      parts[1]
        ? decodeURIComponent(parts[1])
        : null;

    const extraString =
      parts.length > 2
        ? parts.slice(2).join("/")
        : "";

    if (!type || !id) {

      return sendJson(
        res,
        400,
        {
          streams: []
        }
      );
    }

    try {

      console.log(
        `[STREMIO] Stream request: ${type}/${id}`
      );

      const result =
        await sdkInterface.get({
          resource: "stream",
          type,
          id,
          extra:
            parseExtra(extraString)
        });

      return sendJson(
        res,
        200,
        result || { streams: [] }
      );

    } catch (err) {

      console.error(
        "[STREAM REQUEST ERROR]",
        err
      );

      return sendJson(
        res,
        500,
        {
          streams: [],
          error:
            "Erro ao carregar stream."
        }
      );
    }
  }

  return false;
}

// ======================================================
// SERVIDOR HTTP
// ======================================================

const server =
  http.createServer(
    async (req, res) => {

      try {

        // =================================================
        // CORS / OPTIONS
        // =================================================

        if (req.method === "OPTIONS") {

          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET, OPTIONS",

              "Access-Control-Allow-Headers":
                "*"
            }
          );

          return res.end();
        }

        // =================================================
        // URL
        // =================================================

        const requestUrl =
          new URL(
            req.url || "/",
            `http://${req.headers.host || "localhost"}`
          );

        const pathname =
          requestUrl.pathname;

        // =================================================
        // HEALTH CHECK
        // =================================================

        if (
          pathname === "/health" ||
          pathname === "/health/"
        ) {

          return sendJson(
            res,
            200,
            {
              status: "ok",
              service: "stremio-addon",
              port: PORT,
              timestamp:
                new Date().toISOString()
            }
          );
        }

        // =================================================
        // PÁGINA PRINCIPAL
        // =================================================

        if (
          pathname === "/" ||
          pathname === ""
        ) {

          res.writeHead(
            200,
            {
              "Content-Type":
                "text/plain; charset=utf-8",

              "Access-Control-Allow-Origin":
                "*"
            }
          );

          return res.end(
            "Stremio Addon online."
          );
        }

        // =================================================
        // PROXY
        // =================================================

        if (
          pathname === "/proxy"
        ) {

          const remoteUrl =
            requestUrl.searchParams.get(
              "url"
            );

          if (!remoteUrl) {

            res.writeHead(
              400,
              {
                "Content-Type":
                  "text/plain; charset=utf-8"
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
                  "text/plain; charset=utf-8"
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
                  "text/plain; charset=utf-8"
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
                      "text/plain; charset=utf-8"
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
                      "text/plain; charset=utf-8"
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

              if (
                !proxyReq.destroyed
              ) {

                proxyReq.destroy();
              }
            }
          );

          req.pipe(proxyReq);

          return;
        }

        // =================================================
        // ROTAS DO STREMIO
        // =================================================

        const handled =
          await handleStremioRequest(
            req,
            res,
            pathname
          );

        if (handled !== false) {
          return;
        }

        // =================================================
        // 404
        // =================================================

        if (!res.headersSent) {

          res.writeHead(
            404,
            {
              "Content-Type":
                "text/plain; charset=utf-8",

              "Access-Control-Allow-Origin":
                "*"
            }
          );

          res.end(
            "Not Found"
          );
        }

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
                "text/plain; charset=utf-8",

              "Access-Control-Allow-Origin":
                "*"
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