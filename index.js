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

/* =========================
   CATALOG
========================= */

builder.defineCatalogHandler(async (args) => {
  console.log("[CATALOG REQUEST]", JSON.stringify(args));

  try {
    const response = await axios.get(`${API_BASE}/channels`, {
      headers: {
        Referer: API_REFERER,
        "User-Agent": "Mozilla/5.0"
      },
      timeout: 15000
    });

    const data = response.data;

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
        undefined;

      const meta = {
        id: String(id),
        type: "tv",
        name: String(name)
      };

      if (poster) {
        meta.poster = String(poster);
      }

      return meta;
    });

    console.log("[CATALOG] Canais encontrados:", metas.length);

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

/* =========================
   STREAM
========================= */

builder.defineStreamHandler(async (args) => {
  console.log("[STREAM REQUEST]", JSON.stringify(args));

  try {
    const channelId = args.id;

    if (!channelId) {
      console.log("[STREAM] ID não informado");
      return { streams: [] };
    }

    const response = await axios.get(
      `${API_BASE}/stream/${encodeURIComponent(channelId)}`,
      {
        headers: {
          Referer: API_REFERER,
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 15000
      }
    );

    const data = response.data;

    let streamUrl = null;

    if (typeof data === "string") {
      streamUrl = data;
    } else if (data && typeof data === "object") {
      streamUrl =
        data.url ||
        data.stream ||
        data.streamUrl ||
        data.src ||
        data.source ||
        data.file ||
        null;
    }

    if (!streamUrl || typeof streamUrl !== "string") {
      console.log("[STREAM] URL não encontrada");
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

/* =========================
   STREMIO ROUTER
========================= */

const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  /* HEALTH */
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

  /* HOME */
  if (requestUrl.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end(
      "Stremio Addon online.\n" +
      `Manifest: ${PUBLIC_URL}/manifest.json\n` +
      `Health: ${PUBLIC_URL}/health\n`
    );

    return;
  }

  /* STREMIO */
  try {
    addonRouter(req, res, (error) => {
      if (error) {
        console.error("[ROUTER ERROR]", error);

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

/* =========================
   START SERVER
========================= */

server.listen(PORT, HOST, () => {
  console.log("======================================");
  console.log("Stremio Addon iniciado");
  console.log("Porta:", PORT);
  console.log("Host:", HOST);
  console.log("URL pública:", PUBLIC_URL);
  console.log("Health:", `${PUBLIC_URL}/health`);
  console.log("Manifest:", `${PUBLIC_URL}/manifest.json`);
  console.log("======================================");
});