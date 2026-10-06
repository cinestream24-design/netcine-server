const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = "https://api.reidoscanais.st";
const API_REFERER = "https://reidoscanais.st/";

let browser = null;

async function getBrowser() {
  if (browser) {
    try {
      if (browser.isConnected()) return browser;
    } catch {}
  }

  console.log("[BROWSER] Iniciando Chromium...");

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process"
    ]
  });

  return browser;
}

function isHls(url) {
  if (!url) return false;

  const value = url.toLowerCase();

  return (
    value.includes(".m3u8") ||
    value.includes("application/vnd.apple.mpegurl") ||
    value.includes("application/x-mpegurl") ||
    value.includes("mpegurl")
  );
}

async function resolveHLS(pageUrl) {
  console.log(`[RESOLVE] Abrindo player: ${pageUrl}`);

  const browser = await getBrowser();

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",

    extraHTTPHeaders: {
      Referer: API_REFERER
    },

    viewport: {
      width: 1280,
      height: 720
    }
  });

  const page = await context.newPage();

  const found = new Set();

  function capture(url, source) {
    if (!url) return;

    if (isHls(url)) {
      if (!found.has(url)) {
        found.add(url);
        console.log(`[HLS] Encontrado via ${source}: ${url}`);
      }
    }
  }

  // Captura requisições normais
  page.on("request", request => {
    capture(request.url(), "request");
  });

  // Captura respostas
  page.on("response", response => {
    const url = response.url();

    capture(url, "response");

    const contentType =
      response.headers()["content-type"] || "";

    if (
      contentType.includes("mpegurl") ||
      contentType.includes("application/vnd.apple.mpegurl")
    ) {
      capture(url, "content-type");
    }
  });

  // Intercepta possíveis URLs colocadas pelo player
  page.on("console", msg => {
    const text = msg.text();

    if (text.includes(".m3u8")) {
      console.log("[PAGE] Console:", text);

      const matches = text.match(
        /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi
      );

      if (matches) {
        for (const url of matches) {
          capture(url, "console");
        }
      }
    }
  });

  try {
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
  } catch (err) {
    console.log("[PAGE] goto:", err.message);
  }

  console.log("[RESOLVE] Página carregada. Aguardando player...");

  // Dá tempo para JS, iframe e player carregarem
  for (let i = 0; i < 20; i++) {
    if (found.size > 0) break;

    await page.waitForTimeout(1000);

    // Procura também no HTML/DOM atual
    try {
      const html = await page.content();

      const matches = html.match(
        /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi
      );

      if (matches) {
        for (const url of matches) {
          capture(url, "html");
        }
      }
    } catch {}

    // Procura dentro dos frames
    for (const frame of page.frames()) {
      try {
        const html = await frame.content();

        const matches = html.match(
          /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi
        );

        if (matches) {
          for (const url of matches) {
            capture(url, "iframe");
          }
        }
      } catch {}
    }
  }

  const result = [...found][0] || null;

  await context.close();

  if (result) {
    console.log(`[RESOLVE] HLS FINAL: ${result}`);
  } else {
    console.log("[RESOLVE] Nenhum HLS encontrado.");
  }

  return result;
}


// ---------------------------------------------------------
// HEALTH
// ---------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "netcine-server"
  });
});


// ---------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------

app.get("/manifest.json", async (req, res) => {
  res.json({
    id: "netcine.server",
    version: "2.3.0",
    name: "NetCine",
    description: "Canais de TV ao vivo",
    logo: "https://cdn.reidoscanais.st/imagens/logo.png",

    resources: [
      "catalog",
      "meta",
      "stream"
    ],

    types: [
      "tv"
    ],

    catalogs: [
      {
        type: "tv",
        id: "netcine",
        name: "NetCine",
        extra: [
          {
            name: "search",
            isRequired: false
          }
        ]
      }
    ]
  });
});


// ---------------------------------------------------------
// CATÁLOGO
// ---------------------------------------------------------

app.get("/catalog/tv/netcine.json", async (req, res) => {
  try {
    const response = await fetch(`${API_BASE}/channels`, {
      headers: {
        Referer: API_REFERER
      }
    });

    if (!response.ok) {
      throw new Error(`API respondeu ${response.status}`);
    }

    const data = await response.json();

    const channels = Array.isArray(data)
      ? data
      : data.channels || data.results || [];

    const metas = channels.map(channel => ({
      id: String(
        channel.id ||
        channel.slug ||
        channel.name
      ),

      type: "tv",

      name:
        channel.name ||
        channel.title ||
        "Canal",

      poster:
        channel.logo_url ||
        channel.logo ||
        channel.poster ||
        ""
    }));

    res.json({
      metas
    });

  } catch (err) {
    console.error("[CATALOG]", err);

    res.status(500).json({
      metas: []
    });
  }
});


// ---------------------------------------------------------
// STREAM
// ---------------------------------------------------------

app.get("/stream/tv/:id.json", async (req, res) => {
  const id = req.params.id;

  console.log("");
  console.log("========================================");
  console.log(`[STREAM] Solicitação: ${id}`);
  console.log("========================================");

  try {
    const response = await fetch(`${API_BASE}/channels`, {
      headers: {
        Referer: API_REFERER
      }
    });

    if (!response.ok) {
      throw new Error(`API respondeu ${response.status}`);
    }

    const data = await response.json();

    const channels = Array.isArray(data)
      ? data
      : data.channels || data.results || [];

    const channel = channels.find(ch => {
      const channelId = String(
        ch.id ||
        ch.slug ||
        ch.name ||
        ""
      );

      return channelId === String(id);
    });

    if (!channel) {
      console.log(`[STREAM] Canal não encontrado: ${id}`);

      return res.json({
        streams: []
      });
    }

    console.log(
      `[STREAM] Canal: ${channel.name || channel.title || id}`
    );

    // Pega embeds conhecidos
    let embeds = channel.embeds || [];

    if (!Array.isArray(embeds)) {
      embeds = [];
    }

    console.log(`[STREAM] Embeds: ${embeds.length}`);

    for (const embed of embeds) {
      const url =
        typeof embed === "string"
          ? embed
          : embed.url ||
            embed.embed_url ||
            embed.src ||
            embed.link;

      if (!url) continue;

      console.log(`[STREAM] Tentando: ${url}`);

      try {
        const hls = await resolveHLS(url);

        if (hls) {
          console.log(`[STREAM] HLS encontrado!`);

          return res.json({
            streams: [
              {
                name: channel.name || "NetCine",
                title: channel.name || "TV ao vivo",
                url: hls,
                type: "hls"
              }
            ]
          });
        }
      } catch (err) {
        console.error(
          `[STREAM] Erro no embed ${url}:`,
          err.message
        );
      }
    }

    console.log("[STREAM] Nenhum stream encontrado.");

    return res.json({
      streams: []
    });

  } catch (err) {
    console.error("[STREAM] ERRO:", err);

    return res.status(500).json({
      streams: []
    });
  }
});


// ---------------------------------------------------------
// START
// ---------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("NetCine Server iniciado");
  console.log(`Porta: ${PORT}`);
  console.log("========================================");
});


// ---------------------------------------------------------
// ENCERRAMENTO
// ---------------------------------------------------------

process.on("SIGTERM", async () => {
  console.log("[SERVER] Encerrando...");

  if (browser) {
    try {
      await browser.close();
    } catch {}
  }

  process.exit(0);
});