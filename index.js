const express = require("express");
const { chromium } = require("playwright");

const app = express();

const PORT = process.env.PORT || 8080;

const API_BASE = "https://api.reidoscanais.st";
const API_REFERER = "https://reidoscanais.st/";
const SITE_BASE = "https://rdcanais.net";

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Moto G15) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

let browser = null;
let browserPromise = null;
let channelsCache = null;
let channelsCacheTime = 0;

const CACHE_TIME = 5 * 60 * 1000;

// ============================================================
// BROWSER
// ============================================================

async function getBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }

  if (browserPromise) {
    return browserPromise;
  }

  browserPromise = chromium.launch({
    headless: true,

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--disable-blink-features=AutomationControlled",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding"
    ]
  });

  try {
    browser = await browserPromise;

    browser.on("disconnected", () => {
      console.log("Chromium desconectado");
      browser = null;
      browserPromise = null;
    });

    console.log("Chromium iniciado");

    return browser;
  } catch (error) {
    browserPromise = null;
    browser = null;

    console.error("Erro ao iniciar Chromium:", error);

    throw error;
  }
}

// ============================================================
// NORMALIZAÇÃO DE URL
// ============================================================

function normalizeUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }

  url = url.trim();

  if (!url) {
    return null;
  }

  return url;
}

// ============================================================
// EXTRAÇÃO DE URLS
// ============================================================

function extractUrlsFromValue(value, output = []) {
  if (!value) {
    return output;
  }

  if (typeof value === "string") {
    const matches = value.match(
      /https?:\/\/[^\s"'<>\\]+/gi
    );

    if (matches) {
      for (const url of matches) {
        const clean = url
          .replace(/\\u0026/g, "&")
          .replace(/\\u003d/g, "=")
          .replace(/\\\//g, "/");

        if (!output.includes(clean)) {
          output.push(clean);
        }
      }
    }

    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractUrlsFromValue(item, output);
    }

    return output;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      try {
        extractUrlsFromValue(value[key], output);
      } catch (_) {}
    }
  }

  return output;
}

function isHLS(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  const lower = url.toLowerCase();

  return (
    lower.includes(".m3u8") ||
    lower.includes("application/vnd.apple.mpegurl") ||
    lower.includes("format=m3u8") ||
    lower.includes("type=m3u8")
  );
}

// ============================================================
// API DOS CANAIS
// ============================================================

async function getChannels() {
  const now = Date.now();

  if (
    channelsCache &&
    now - channelsCacheTime < CACHE_TIME
  ) {
    return channelsCache;
  }

  console.log("Buscando canais na API...");

  const response = await fetch(`${API_BASE}/channels`, {
    method: "GET",

    headers: {
      Accept: "application/json",
      Referer: API_REFERER,
      Origin: "https://reidoscanais.st",
      "User-Agent": USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(
      `API retornou HTTP ${response.status}`
    );
  }

  const json = await response.json();

  let channels = [];

  if (Array.isArray(json)) {
    channels = json;
  } else if (Array.isArray(json.data)) {
    channels = json.data;
  } else if (Array.isArray(json.channels)) {
    channels = json.channels;
  } else if (json.data && Array.isArray(json.data.channels)) {
    channels = json.data.channels;
  } else if (Array.isArray(json.results)) {
    channels = json.results;
  }

  console.log(
    "API channels: objeto com chaves:",
    Object.keys(json).join(", ")
  );

  console.log(
    `Canais recebidos: ${channels.length}`
  );

  channelsCache = channels;
  channelsCacheTime = now;

  return channels;
}

// ============================================================
// DADOS DO CANAL
// ============================================================

function getChannelId(channel) {
  return String(
    channel.id ||
    channel.slug ||
    channel.code ||
    channel.name ||
    ""
  )
    .trim()
    .toLowerCase();
}

function getChannelName(channel) {
  return (
    channel.name ||
    channel.title ||
    channel.nome ||
    channel.label ||
    getChannelId(channel)
  );
}

function getChannelLogo(channel) {
  return (
    channel.logo_url ||
    channel.logo ||
    channel.image ||
    channel.icon ||
    ""
  );
}

function getChannelDescription(channel) {
  return (
    channel.description ||
    channel.desc ||
    `Canal ${getChannelName(channel)}`
  );
}

function getEmbeds(channel) {
  const embeds =
    channel.embeds ||
    channel.embed ||
    channel.urls ||
    channel.url ||
    [];

  if (Array.isArray(embeds)) {
    return embeds.filter(Boolean);
  }

  if (typeof embeds === "string") {
    return [embeds];
  }

  return [];
}

// ============================================================
// ENCONTRAR CANAL
// ============================================================

async function findChannel(id) {
  const channels = await getChannels();

  const target = String(id).toLowerCase();

  return (
    channels.find(
      channel =>
        getChannelId(channel) === target
    ) ||
    channels.find(
      channel =>
        String(channel.slug || "").toLowerCase() === target
    ) ||
    channels.find(
      channel =>
        String(channel.id || "").toLowerCase() === target
    )
  );
}

// ============================================================
// RESOLVER HLS
// ============================================================

async function resolveHLS(pageUrl) {
  const browser = await getBrowser();

  const context = await browser.newContext({
    userAgent: USER_AGENT,

    viewport: {
      width: 1280,
      height: 720
    },

    locale: "pt-BR",

    extraHTTPHeaders: {
      Referer: API_REFERER,
      Origin: "https://reidoscanais.st",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    }
  });

  const page = await context.newPage();

  const found = [];

  function registerUrl(url, source) {
    if (!url) {
      return false;
    }

    url = normalizeUrl(url);

    if (!url) {
      return false;
    }

    if (!isHLS(url)) {
      return false;
    }

    if (!found.includes(url)) {
      found.push(url);

      console.log(
        `HLS encontrado via ${source}: ${url}`
      );
    }

    return true;
  }

  // ----------------------------------------------------------
  // REQUEST
  // ----------------------------------------------------------

  page.on("request", request => {
    try {
      const url = request.url();

      if (isHLS(url)) {
        registerUrl(url, "REQUEST");
      }
    } catch (_) {}
  });

  // ----------------------------------------------------------
  // RESPONSE
  // ----------------------------------------------------------

  page.on("response", response => {
    try {
      const url = response.url();

      const contentType =
        response.headers()["content-type"] || "";

      if (
        isHLS(url) ||
        contentType
          .toLowerCase()
          .includes("mpegurl")
      ) {
        registerUrl(url, "RESPONSE");
      }
    } catch (_) {}
  });

  // ----------------------------------------------------------
  // LOG DE ERROS
  // ----------------------------------------------------------

  page.on("console", message => {
    try {
      console.log(
        `PAGE: ${message.type()} ${message.text()}`
      );
    } catch (_) {}
  });

  page.on("pageerror", error => {
    console.log(
      "PAGEERROR:",
      error.message
    );
  });

  // ----------------------------------------------------------
  // POPUPS
  // ----------------------------------------------------------

  page.on("popup", popup => {
    console.log(
      "Popup detectado:",
      popup.url()
    );

    popup.on("request", request => {
      try {
        registerUrl(
          request.url(),
          "POPUP REQUEST"
        );
      } catch (_) {}
    });

    popup.on("response", response => {
      try {
        registerUrl(
          response.url(),
          "POPUP RESPONSE"
        );
      } catch (_) {}
    });
  });

  try {
    console.log(
      "========================================"
    );

    console.log(
      "Abrindo página:",
      pageUrl
    );

    console.log(
      "========================================"
    );

    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    console.log(
      "Página carregada:",
      page.url()
    );

    // --------------------------------------------------------
    // ESPERA INICIAL
    // --------------------------------------------------------

    await page.waitForTimeout(3000);

    // --------------------------------------------------------
    // STREAM_URLS
    // --------------------------------------------------------

    try {
      const streamUrls =
        await page.evaluate(() => {
          return (
            window.STREAM_URLS ||
            window.streamUrls ||
            window.STREAMS ||
            []
          );
        });

      console.log(
        "STREAM_URLS encontrados:",
        JSON.stringify(streamUrls)
      );

      const urls =
        extractUrlsFromValue(
          streamUrls
        );

      for (const url of urls) {
        if (registerUrl(url, "STREAM_URLS")) {
          break;
        }
      }
    } catch (error) {
      console.log(
        "Não foi possível ler STREAM_URLS:",
        error.message
      );
    }

    // --------------------------------------------------------
    // INSPECIONAR HTML
    // --------------------------------------------------------

    try {
      const html = await page.content();

      const htmlUrls =
        extractUrlsFromValue(html);

      for (const url of htmlUrls) {
        registerUrl(
          url,
          "HTML"
        );
      }
    } catch (_) {}

    // --------------------------------------------------------
    // FRAMES
    // --------------------------------------------------------

    console.log(
      `Frames encontrados: ${page.frames().length}`
    );

    for (const frame of page.frames()) {
      try {
        console.log(
          "Frame:",
          frame.url()
        );

        const frameUrls =
          await frame.evaluate(() => {
            const result = [];

            if (
              Array.isArray(
                window.STREAM_URLS
              )
            ) {
              result.push(
                ...window.STREAM_URLS
              );
            }

            const html =
              document.documentElement
                ?.outerHTML || "";

            result.push(html);

            return result;
          });

        const urls =
          extractUrlsFromValue(
            frameUrls
          );

        for (const url of urls) {
          registerUrl(
            url,
            "FRAME"
          );
        }
      } catch (error) {
        console.log(
          "Erro lendo frame:",
          error.message
        );
      }
    }

    // --------------------------------------------------------
    // SE AINDA NÃO ACHOU, ESPERA MAIS
    // --------------------------------------------------------

    if (found.length === 0) {
      console.log(
        "Nenhum HLS ainda. Aguardando player..."
      );

      await page.waitForTimeout(7000);
    }

    // --------------------------------------------------------
    // STREAM_URLS NOVAMENTE
    // --------------------------------------------------------

    if (found.length === 0) {
      try {
        const streamUrls =
          await page.evaluate(() => {
            return (
              window.STREAM_URLS ||
              window.streamUrls ||
              window.STREAMS ||
              []
            );
          });

        console.log(
          "STREAM_URLS após espera:",
          JSON.stringify(streamUrls)
        );

        const urls =
          extractUrlsFromValue(
            streamUrls
          );

        for (const url of urls) {
          registerUrl(
            url,
            "STREAM_URLS_FINAL"
          );
        }
      } catch (_) {}
    }

    // --------------------------------------------------------
    // FRAMES NOVAMENTE
    // --------------------------------------------------------

    if (found.length === 0) {
      for (const frame of page.frames()) {
        try {
          const frameData =
            await frame.evaluate(() => {
              return {
                url: location.href,
                streamUrls:
                  window.STREAM_URLS || [],
                html:
                  document.documentElement
                    ?.outerHTML || ""
              };
            });

          const urls =
            extractUrlsFromValue(
              frameData
            );

          for (const url of urls) {
            registerUrl(
              url,
              "FRAME_FINAL"
            );
          }
        } catch (_) {}
      }
    }

    // --------------------------------------------------------
    // RESULTADO
    // --------------------------------------------------------

    if (found.length > 0) {
      console.log(
        "========================================"
      );

      console.log(
        `HLS FINAL ENCONTRADO: ${found[0]}`
      );

      console.log(
        "========================================"
      );

      return found[0];
    }

    console.log(
      "Nenhum HLS encontrado."
    );

    return null;

  } finally {
    try {
      await context.close();
    } catch (_) {}
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "netcine-server"
  });
});

// ============================================================
// MANIFEST
// ============================================================

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "netcine.server",
    version: "2.6.0",
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

// ============================================================
// CATALOG
// ============================================================

app.get(
  "/catalog/tv/netcine.json",
  async (req, res) => {
    try {
      const channels =
        await getChannels();

      console.log(
        `Montando catálogo com ${channels.length} canais`
      );

      const metas = channels.map(channel => {
        const id =
          getChannelId(channel);

        return {
          id,
          type: "tv",
          name:
            getChannelName(channel),
          poster:
            getChannelLogo(channel),
          posterShape: "landscape",
          description:
            getChannelDescription(channel)
        };
      });

      console.log(
        `Catálogo final: ${metas.length} canais`
      );

      res.json({
        metas
      });

    } catch (error) {
      console.error(
        "Erro catálogo:",
        error
      );

      res.status(500).json({
        metas: [],
        error: error.message
      });
    }
  }
);

// ============================================================
// META
// ============================================================

app.get(
  "/meta/tv/:id.json",
  async (req, res) => {
    try {
      const channel =
        await findChannel(
          req.params.id
        );

      if (!channel) {
        return res.status(404).json({
          meta: null
        });
      }

      res.json({
        meta: {
          id:
            getChannelId(channel),

          type: "tv",

          name:
            getChannelName(channel),

          poster:
            getChannelLogo(channel),

          posterShape: "landscape",

          description:
            getChannelDescription(channel)
        }
      });

    } catch (error) {
      console.error(
        "Erro meta:",
        error
      );

      res.status(500).json({
        meta: null,
        error: error.message
      });
    }
  }
);

// ============================================================
// STREAM
// ============================================================

app.get(
  "/stream/tv/:id.json",
  async (req, res) => {
    try {
      const id =
        req.params.id;

      console.log(
        "========================================"
      );

      console.log(
        `Solicitando stream: ${id}`
      );

      console.log(
        "========================================"
      );

      const channel =
        await findChannel(id);

      if (!channel) {
        console.log(
          "Canal não encontrado:",
          id
        );

        return res.json({
          streams: []
        });
      }

      const embeds =
        getEmbeds(channel);

      console.log(
        `Canal ${id}: ${embeds.length} embeds`
      );

      if (embeds.length === 0) {
        return res.json({
          streams: []
        });
      }

      for (const embed of embeds) {
        const url =
          normalizeUrl(
            typeof embed === "string"
              ? embed
              : embed.url ||
                embed.src ||
                embed.link
          );

        if (!url) {
          continue;
        }

        console.log(
          "Tentando resolver:",
          url
        );

        try {
          const hls =
            await resolveHLS(url);

          if (hls) {
            console.log(
              "STREAM FINAL:",
              hls
            );

            return res.json({
              streams: [
                {
                  name:
                    getChannelName(channel),

                  title:
                    getChannelName(channel),

                  url: hls,

                  type: "hls",

                  behaviorHints: {
                    notWebReady: false,

                    bingeGroup:
                      "netcine-tv",

                    proxyHeaders: {
                      request: {
                        Referer:
                          API_REFERER,

                        "User-Agent":
                          USER_AGENT
                      }
                    }
                  }
                }
              ]
            });
          }

        } catch (error) {
          console.error(
            "Erro no stream:",
            error
          );
        }
      }

      return res.json({
        streams: []
      });

    } catch (error) {
      console.error(
        "Erro geral stream:",
        error
      );

      return res.status(500).json({
        streams: [],
        error: error.message
      });
    }
  }
);

// ============================================================
// FALLBACK
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      error: "Endpoint não encontrado"
    });
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "NetCine Server iniciado"
    );

    console.log(
      `Porta: ${PORT}`
    );

    console.log(
      "========================================"
    );
  }
);