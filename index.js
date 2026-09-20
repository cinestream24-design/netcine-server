import express from 'express';
import puppeteer from 'puppeteer';
import { createWorker } from 'tesseract.js';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 8080;

const MANIFEST = {
  id: 'org.flecha.scraper.addon',
  version: '1.0.0',
  name: 'Flecha / NetCine Scraper',
  description: 'Add-on Stremio para extrair streams com busca automatizada e bypass de CAPTCHA',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

// Obtém metadados do IMDb via Cinemeta com tratamento de erro/timeout
async function getMediaMeta(id) {
  const parts = id.split(':');
  const imdbId = parts[0];
  const season = parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts[2] ? parseInt(parts[2], 10) : null;
  const type = season ? 'series' : 'movie';

  const url = `https://v3-cinemeta.strem.fun/meta/${type}/${imdbId}.json`;

  try {
    console.log(`[Cinemeta] A consultar título para: ${imdbId}`);
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.data?.meta?.name) {
      return {
        name: response.data.meta.name,
        season,
        episode,
        type
      };
    }
  } catch (err) {
    console.error(`[Cinemeta] Erro ao consultar metadados (${err.message}). A tentar fallback...`);
  }

  return null;
}

// Scraper principal com Puppeteer
async function extractStream(media) {
  let streamUrl = null;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage();

  try {
    // Simular um navegador comum para desviar do bloqueio inicial
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Escutar requisições de rede para capturar o link do vídeo (.m3u8 / .mp4)
    page.on('request', (request) => {
      const url = request.url();
      if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('captcha')) {
        streamUrl = url;
      }
    });

    // 1. Fazer a busca pelo título no site
    const baseUrl = 'https://eee1.lat'; // ou https://flecha.lat
    const searchUrl = `${baseUrl}/?s=${encodeURIComponent(media.name)}`;

    console.log(`[Puppeteer] A abrir pesquisa: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Tratar tela intermediária de "Redirecting..." / Proteção
    let pageTitle = await page.title();
    if (pageTitle.includes('Redirecting') || pageTitle.includes('Just a moment')) {
      console.log('[Puppeteer] Redirecionamento detetado. A aguardar resolução...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    // 2. Selecionar o link correto nos resultados da busca
    console.log(`[Puppeteer] A procurar resultado para "${media.name}"...`);
    const targetLink = await page.evaluate((titleName) => {
      const anchors = Array.from(document.querySelectorAll('a'));
      const found = anchors.find(a => 
        a.innerText && a.innerText.toLowerCase().includes(titleName.toLowerCase()) && a.href.includes('http')
      );
      return found ? found.href : null;
    }, media.name);

    if (!targetLink) {
      console.log(`[Puppeteer] Nenhum resultado correspondente para "${media.name}".`);
      await browser.close();
      return null;
    }

    console.log(`[Puppeteer] Acedendo à página do título: ${targetLink}`);
    await page.goto(targetLink, { waitUntil: 'networkidle2', timeout: 45000 });

    // 3. Se for série, procurar e clicar no link do episódio específico
    if (media.type === 'series' && media.season && media.episode) {
      console.log(`[Puppeteer] A procurar T${media.season} E${media.episode}...`);

      const epLink = await page.evaluate((s, e) => {
        const links = Array.from(document.querySelectorAll('a'));
        const pattern = new RegExp(`(${s}x${e}|s0?${s}e0?${e}|temporada-${s}.*episodio-${e})`, 'i');
        const found = links.find(l => pattern.test(l.href) || pattern.test(l.innerText));
        return found ? found.href : null;
      }, media.season, media.episode);

      if (epLink) {
        console.log(`[Puppeteer] A navegar para o episódio: ${epLink}`);
        await page.goto(epLink, { waitUntil: 'networkidle2', timeout: 45000 });
      } else {
        console.log(`[Puppeteer] Link direto do episódio não localizado na página.`);
      }
    }

    // 4. Detetar e resolver CAPTCHA na imagem do elemento
    const captchaElement = await page.$('img[src*="captcha"], .captcha img, form img');
    if (captchaElement) {
      console.log('[Puppeteer] CAPTCHA localizado. A tirar screenshot do elemento...');
      const imageBuffer = await captchaElement.screenshot();

      const worker = await createWorker('eng');
      const { data: { text } } = await worker.recognize(imageBuffer);
      await worker.terminate();

      const cleanCode = text.replace(/[^a-zA-Z0-9]/g, '').trim();
      console.log(`[OCR] Código lido do CAPTCHA: ${cleanCode}`);

      const inputSelector = 'input[placeholder*="Código"], input[name*="captcha"], input[type="text"]';
      const inputExists = await page.$(inputSelector);

      if (cleanCode && inputExists) {
        await page.type(inputSelector, cleanCode);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 4000));
      }
    }

    // 5. Aguardar captura do stream (.m3u8 / .mp4)
    let attempts = 0;
    while (!streamUrl && attempts < 10) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }

  } catch (err) {
    console.error('[Puppeteer] Erro durante a navegação:', err.message);
  } finally {
    await browser.close();
  }

  return streamUrl;
}

// Endpoint de Streams do Stremio
app.get('/stream/:type/:id.json', async (req, res) => {
  const { id } = req.params;
  console.log(`\n========================================`);
  console.log(`[Stremio] Novo pedido recebido: ${id}`);

  const media = await getMediaMeta(id);

  if (!media) {
    console.log(`[Stremio] Não foi possível obter o título do IMDb para ${id}`);
    return res.json({ streams: [] });
  }

  console.log(`[Stremio] A processar: ${media.name} | Tipo: ${media.type} | T:${media.season || 'N/A'} E:${media.episode || 'N/A'}`);

  const streamUrl = await extractStream(media);

  if (streamUrl) {
    console.log(`[Stremio] Stream extraído com sucesso: ${streamUrl}`);
    return res.json({
      streams: [
        {
          name: 'Flecha / NetCine',
          title: `${media.name} ${media.season ? `T${media.season}E${media.episode}` : ''} (Auto Search)`,
          url: streamUrl
        }
      ]
    });
  }

  console.log(`[Stremio] Nenhum stream encontrado.`);
  return res.json({ streams: [] });
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Servidor ativo e a rodar na porta ${PORT}`);
  console.log(`========================================`);
});
