const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const API_BASE = "https://api.reidoscanais.st";
const SITE_REFERER = "https://reidoscanais.st/";

// 1. Definição do Manifesto do Addon
const manifest = {
  id: "org.reidoscanais.stremio",
  version: "1.0.0",
  name: "Rei dos Canais Addon",
  description: "Canais ao vivo do Rei dos Canais com suporte a Proxy Direct",
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

// Helper para requisições à API
async function fetchFromApi(endpoint) {
  try {
    const response = await axios.get(`${API_BASE}${endpoint}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": SITE_REFERER
      },
      timeout: 8000
    });
    return response.data;
  } catch (err) {
    console.error(`[API Error] ${endpoint}:`, err.message);
    return null;
  }
}

// 2. Handler do Catálogo
builder.defineCatalogHandler(async (args) => {
  if (args.type !== "tv") return { metas: [] };

  const data = await fetchFromApi("/channels");
  if (!data) return { metas: [] };

  const items = Array.isArray(data) ? data : (data.channels || data.data || []);

  const metas = items.map((item) => {
    const id = item.id || item.slug || item.code || item._id;
    return {
      id: `rc_${id}`,
      type: "tv",
      name: item.name || item.title || item.channel_name || "Canal TV",
      poster: item.poster || item.logo || item.image || item.icon || ""
    };
  });

  return { metas };
});

// 3. Handler do Stream
builder.defineStreamHandler(async (args) => {
  if (args.type !== "tv") return { streams: [] };

  const channelId = args.id.replace("rc_", "");
  const data = await fetchFromApi(`/stream/${channelId}`);

  if (!data) return { streams: [] };

  // Extrai a URL retornada pela API
  let targetUrl = null;
  if (typeof data === "string" && data.startsWith("http")) {
    targetUrl = data;
  } else if (typeof data === "object") {
    targetUrl = data.url || data.streamUrl || data.link || data.hls || data.m3u8;
  }

  if (!targetUrl) {
    console.warn(`[Stream Warning] Nenhuma URL encontrada para o ID: ${channelId}`);
    return { streams: [] };
  }

  // Define porta dinâmica do ambiente ou 7000 por defeito
  const currentPort = process.env.PORT || 7000;
  
  // Constrói a rota do Proxy interno
  const proxyUrl = `http://localhost:${currentPort}/proxy?url=${encodeURIComponent(targetUrl)}`;

  return {
    streams: [
      {
        title: "Rei dos Canais | Direct Stream",
        url: targetUrl,
        behaviorHints: {
          notSupported: false,
          proxyHeaders: {
            request: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
              "Referer": SITE_REFERER
            }
          }
        }
      },
      {
        title: "Rei dos Canais | Server Proxy (Fallback)",
        url: proxyUrl
      }
    ]
  };
});

// 4. Servidor HTTP + Proxy de streaming para contornar restrições no cliente Stremio
const port = process.env.PORT || 7000;
const sdkInterface = builder.getInterface();

const server = http.createServer((req, res) => {
  // Rota de Proxy Interna para contornar o bloqueio de Referer nos clientes
  if (req.url.startsWith("/proxy")) {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const remoteUrl = reqUrl.searchParams.get("url");

    if (!remoteUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Parametro URL em falta.");
    }

    try {
      const parsedRemote = new URL(remoteUrl);
      const client = parsedRemote.protocol === "https:" ? https : http;

      const proxyReq = client.request(
        remoteUrl,
        {
          method: req.method,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": SITE_REFERER
          }
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on("error", (err) => {
        console.error("[Proxy Direct Error]:", err.message);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        res.end("Erro no Proxy.");
      });

      req.pipe(proxyReq);
      return;
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("URL invalida.");
    }
  }

  // Delega as restantes rotas para a interface do Stremio SDK
  sdkInterface(req, res);
});

server.listen(port, () => {
  console.log(`Addon ativo na porta ${port}`);
});
