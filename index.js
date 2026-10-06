const express = require("express");
const { chromium } = require("playwright");

const app = express();

const PORT = process.env.PORT || 3000;

const API_BASE = "https://api.reidoscanais.st";
const API_REFERER = "https://reidoscanais.st/";

let browser = null;

// =====================================================
// BROWSER
// =====================================================

async function getBrowser() {
  if (browser) return browser;

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote"
    ]
  });

  return browser;
}

// =====================================================
// API
// =====================================================

async function getChannels() {
  const response = await fetch(`${API_BASE}/channels`, {
    headers: {
      "Referer": API_REFERER,
      "Origin": "https://reidoscanais.st",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
      "Accept": "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(
      `API channels respondeu HTTP ${response.status}`
    );
  }

  const data = await response.json();

  console.log(
    "API channels:",
    Array.isArray(data)
      ? `array com ${data.length} itens`
      : `objeto com chaves: ${Object.keys(data || {}).join(", ")}`
  );

  // A API pode retornar diretamente um array
  if (Array.isArray(data)) {
    return data;
  }

  // Ou pode retornar os canais dentro de alguma propriedade
  if (Array.isArray(data.channels)) {
    return data.channels;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (Array.isArray(data.results)) {
    return data.results;
  }

  return [];
}

// =====================================================
// RESOLVER HLS
// =====================================================

async function resolveHLS(pageUrl) {
  const b = await getBrowser();

  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",

    extraHTTPHeaders: {
      Referer: "https://reidoscanais.st/"
    }
  });

  const page = await context.newPage();

  let found = null;

  function checkUrl(url) {
    if (!url) return;

    if (
      url.includes(".m3u8") ||
      url.includes("m3u8?")
    ) {
      if (!found) {
        found = url;
        console.log("HLS ENCONTRADO:", url);
      }
    }
  }

  page.on("request", request => {
    checkUrl(request.url());
  });

  page.on("response", response => {
    checkUrl(response.url());

    const type = response.headers()["content-type"] || "";

    if (
      type.includes("mpegurl") ||
      type.includes("x-mpegurl")
    ) {
      checkUrl(response.url());
    }
  });

  page.on("console", msg => {
    console.log("PAGE:", msg.text());
  });

  try {
    console.log("Abrindo página:", pageUrl);

    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(15000);

    // Verifica novamente todos os frames
    for (const frame of page.frames()) {
      try {
        const html = await frame.content();

        const match = html.match(
          /https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/i
        );

        if (match) {
          found = match[0];
          console.log("HLS encontrado no HTML:", found);
          break;
        }
      } catch (_) {}
    }
  } catch (err) {
    console.log("Erro ao abrir página:", err.message);
  }

  await context.close();

  return found;
}

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "netcine-server"
  });
});

// =====================================================
// MANIFEST
// =====================================================

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "netcine.server",
    version: "2.4.0",
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
        name: "NetCine"
      }
    ]
  });
});

// =====================================================
// CATALOG
// =====================================================

app.get("/catalog/tv/netcine.json", async (req, res) => {
  try {
    const channels = await getChannels();

    console.log(
      `Montando catálogo com ${channels.length} canais`
    );

    const metas = channels
      .map((channel, index) => {
        const id =
          channel.id ??
          channel.slug ??
          channel.channel_id ??
          channel.code ??
          `channel-${index}`;

        const name =
          channel.name ??
          channel.title ??
          channel.nome ??
          `Canal ${index + 1}`;

        const logo =
          channel.logo_url ??
          channel.logo ??
          channel.image ??
          channel.poster ??
          "";

        return {
          id: String(id),
          type: "tv",
          name: String(name),
          poster: logo,
          posterShape: "landscape"
        };
      })
      .filter(channel => channel.id && channel.name);

    console.log(
      `Catálogo final: ${metas.length} canais`
    );

    res.json({
      metas
    });
  } catch (error) {
    console.error(
      "Erro no catálogo:",
      error
    );

    res.status(500).json({
      metas: [],
      error: error.message
    });
  }
});

// =====================================================
// META
// =====================================================

app.get("/meta/tv/:id.json", async (req, res) => {
  try {
    const channels = await getChannels();

    const channel = channels.find(channel => {
      const id =
        channel.id ??
        channel.slug ??
        channel.channel_id ??
        channel.code;

      return String(id) === String(req.params.id);
    });

    if (!channel) {
      return res.json({
        meta: {
          id: req.params.id,
          type: "tv",
          name: req.params.id
        }
      });
    }

    const name =
      channel.name ??
      channel.title ??
      channel.nome ??
      req.params.id;

    const logo =
      channel.logo_url ??
      channel.logo ??
      channel.image ??
      channel.poster ??
      "";

    res.json({
      meta: {
        id: String(
          channel.id ??
          channel.slug ??
          channel.channel_id ??
          channel.code
        ),
        type: "tv",
        name: String(name),
        poster: logo,
        posterShape: "landscape"
      }
    });
  } catch (error) {
    console.error("Erro no meta:", error);

    res.status(500).json({
      meta: {
        id: req.params.id,
        type: "tv",
        name: req.params.id
      }
    });
  }
});

// =====================================================
// STREAM
// =====================================================

app.get("/stream/tv/:id.json", async (req, res) => {
  try {
    const channels = await getChannels();

    const channel = channels.find(channel => {
      const id =
        channel.id ??
        channel.slug ??
        channel.channel_id ??
        channel.code;

      return String(id) === String(req.params.id);
    });

    if (!channel) {
      return res.json({
        streams: []
      });
    }

    const embeds =
      channel.embeds ??
      channel.embed ??
      channel.sources ??
      [];

    const embedList = Array.isArray(embeds)
      ? embeds
      : [embeds];

    console.log(
      `Canal ${req.params.id}: ${embedList.length} embeds`
    );

    for (const embed of embedList) {
      let url = null;

      if (typeof embed === "string") {
        url = embed;
      } else if (embed) {
        url =
          embed.url ??
          embed.embed_url ??
          embed.src ??
          embed.link;
      }

      if (!url) continue;

      console.log(
        "Tentando resolver:",
        url
      );

      const hls = await resolveHLS(url);

      if (hls) {
        return res.json({
          streams: [
            {
              name:
                channel.name ??
                channel.title ??
                "NetCine",

              title:
                channel.name ??
                channel.title ??
                "NetCine",

              url: hls,

              type: "hls"
            }
          ]
        });
      }
    }

    console.log(
      "Nenhum HLS encontrado para",
      req.params.id
    );

    return res.json({
      streams: []
    });
  } catch (error) {
    console.error(
      "Erro no stream:",
      error
    );

    res.status(500).json({
      streams: [],
      error: error.message
    });
  }
});

// =====================================================
// START
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("========================================");
    console.log("NetCine Server iniciado");
    console.log("Porta:", PORT);
    console.log("========================================");
  }
);