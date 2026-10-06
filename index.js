const http = require("http");
const https = require("https");
const axios = require("axios");
const { URL } = require("url");
const {
  addonBuilder,
  getRouter
} = require("stremio-addon-sdk");

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

/*
 * =========================================================
 * CATÁLOGO
 * =========================================================
 */

builder.defineCatalogHandler(async (args) => {
  console.log("[CATALOG]", JSON.stringify(args));

  try {
    const response = await axios.get(`${API_BASE}/channels`, {
      headers: {
        Referer: API_REFERER,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 15000
    });

    const data = response.data;

    // Aceita tanto array direto quanto respostas
    // encapsuladas em propriedades comuns.
    const channels = Array.isArray(data)
      ? data
      : Array.isArray(data.channels)
        ? data.channels
        : Array.isArray(data.data)
          ? data.data
          : [];

    const metas = channels.map((channel, index) => {
      const id =
        channel.id ??
        channel.channelId ??
        channel.slug ??
        channel.name ??
        `channel_${index}`;

      const name =
        channel.name ??
        channel.title ??
        channel.channelName ??
        `Canal ${index + 1}`;

      const poster =
        channel.poster ??
        channel.logo ??
        channel.image ??
        channel.icon ??
        "";

      return {
        id: String(id),
        type: "tv",
        name: String(name),
        poster: poster ? String(poster) : undefined
      };
    });

    console.log(`[CATALOG] ${metas.length} canais encontrados`);

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

/*
 * =========================================================
 * STREAM
 * =========================================================
 */

builder.defineStreamHandler(async (args) => {
  console.log("[STREAM]", JSON.stringify(args));

  try {
    const channelId = args.id;

    if (!channelId) {
      console.log("[STREAM] ID do canal não informado");
      return { streams: [] };
    }

    const response = await axios.get(
      `${API_BASE}/stream/${encodeURIComponent(channelId)}`,
      {
        headers: {
          Referer: API_REFERER,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout: 15000
      }
    );

    const data = response.data;

    let streamUrl = null;

    if (typeof data === "string") {
      streamUrl = data;
    } else if (data) {
      streamUrl =
        data.url ??
        data.stream ??
        data.streamUrl ??
        data.src ??
        data.source ??
        data.file ??
        null;
    }

    if (!streamUrl || typeof streamUrl !== "string") {
      console.log("[STREAM] Nenhuma URL encontrada");
      return { streams: [] };
    }

    console.log("[STREAM] URL encontrada");

    return {
      streams: [
        {
          url: streamUrl,
          title: "Ao vivo"
        }
      ]
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

/*
 * =========================================================
 * INTERFACE / ROUTER DO STREMIO
 * =========================================================
 */

const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);

/*
 * =========================================================
 * HTTP SERVER
 * =========================================================
 */

const server = http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  /*
   * Health check da Railway
   */
  if (requestUrl.pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "stremio-addon",
        port: PORT,
        timestamp: new Date().toISOString()
      })
    );

    return;
  }

  /*
   * Página inicial
   */
  if (requestUrl.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end(
      "Stremio Addon online.\n\n" +
      `Manifest: ${PUBLIC_URL}/manifest.json\n` +
      `Health: ${PUBLIC_URL}/health\n`
    );

    return;
  }

  /*
   * Todas as rotas do Stremio são entregues
   * ao router oficial do SDK.
   */
  try {
    addonRouter(req, res, (err) => {
      if (err) {
        console.error("[ROUTER ERROR]", err);

        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8"
          });

          res.end(
            JSON.stringify({
              error: "Internal server error"
            })
          );
        }

        return;
      }

      if (!res.headersSent) {
        res.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8"
        });

        res.end(
          JSON.stringify({
            error: "Not found"
          })
        );
      }
    });
  } catch (error) {
    console.error("[SERVER ERROR]", error);

    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8"
      });

      res.end(
        JSON.stringify({
          error: "Internal server error"
        })
      );
    }
  }
});

/*
 * =========================================================
 * INICIAR
 * =========================================================
 */

server.listen(PORT, HOST, () => {
  console.log("======================================");
  console.log("Stremio Addon iniciado");
  console.log(`Porta: ${PORT}`);
  console.log(`Host: ${HOST}`);
  console.log(`URL pública: ${PUBLIC_URL}`);
  console.log(`Health: ${PUBLIC_URL}/health`);
  console.log(`Manifest: ${PUBLIC_URL}/manifest.json`);
  console.log("======================================");
});

/*
 * =========================================================
 * ERROS DO PROCESSO
 * =========================================================
 */

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION]", error);
});

process.on("unhandledRejection", (error) => {
  console.error("[UNHANDLED REJECTION]", error);
});

process.on("SIGTERM", () => {
  console.log("[SIGTERM] Encerrando servidor...");
  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("[SIGINT]