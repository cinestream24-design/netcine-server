import express from 'express';
import puppeteer from 'puppeteer';
import { createWorker } from 'tesseract.js';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 8080;

const MANIFEST = {
  id: 'org.flecha.scraper.addon',
  version: '1.0.0',
  name: 'Flecha Lat Scraper',
  description: 'Add-on para extrair streams do flecha.lat via pesquisa interna',
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

// Obtém o título e dados do IMDb via Cinemeta
async function getMediaInfo(id) {
  try {
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1], 10) : null;
    const episode = parts[2] ? parseInt(parts[2], 10) : null;
    const type = season ? 'series' : 'movie';

    const res = await axios.get(`https://v3-cinemeta.strem.fun/meta/${type}/${imdbId}.json`);
    const name = res.data?.meta?.name;

    return { name, season, episode, type };
  } catch (err) {
    console.error('[Cinemeta] Erro ao obter metadados:', err.message);
    return null;
  }
}

async function searchAndExtractStream(media) {
  let streamUrl = null;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();

  try {
    // Intercetador de pedidos para capturar o link do vídeo (.m3u8 / .mp4)
    page.on('request', (request) => {
      const url = request.url();
      if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('captcha')) {
        streamUrl = url;
      }
    });

    // 1. Aceder à página inicial / pesquisa do flecha.lat
    const searchUrl = `https://flecha.lat/?s=${encodeURIComponent(media.name)}`;
    console.log(`[Puppeteer] A pesquisar por "${media.name}" em: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // 2. Clicar no primeiro resultado correspondente ao filme/série
    const itemSelector = '.result-item a, .search-page a, article a';
    const foundLink = await page.evaluate((title) => {
      const links = Array.from(document.querySelectorAll('a'));
      const match = links.find(l => l.innerText.toLowerCase().includes(title.toLowerCase()));
      return match ? match.href : null;
    }, media.name);

    if (!foundLink) {
      console.log(`[Puppeteer] NENHUM resultado encontrado para "${media.name}".`);
      await browser.close();
      return null;
    }

    console.log(`[Puppeteer] Página do título encontrada: ${foundLink}`);
    await page.goto(foundLink, { waitUntil: 'networkidle2', timeout: 45000 });

    // 3. Se for série, navegar até à temporada e episódio corretos
    if (media.type === 'series' && media.season && media.episode) {
      console.log(`[Puppeteer] A procurar Temporada ${media.season}, Episódio ${media.episode}...`);
      
      const epSelector = `a[href*="-${media.season}x${media.episode}"], a[href*="season-${media.season}-episode-${media.episode}"]`;
      const epElement = await page.$(epSelector);

      if (epElement) {
        await Promise.all([
          epElement.click(),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);
      } else {
        console.log(`[Puppeteer] Episódio T${media.season}E${media.episode} não localizado na página.`);
      }
    }

    // 4. Detetar e resolver CAPTCHA se estiver presente
    const captchaImgSelector = 'img[src*="captcha"], .captcha img';
    const captchaInputSelector = 'input[placeholder*="Código"], input[type="text"]';

    const captchaImg = await page.$(captchaImgSelector);
    if (captchaImg) {
      console.log('[Puppeteer] CAPTCHA detetado. A resolver...');
      const imageBuffer = await captchaImg.screenshot();

      const worker = await createWorker('eng');
      const { data: { text } } = await worker.recognize(imageBuffer);
      await worker.terminate();

      const code = text.replace(/[^a-zA-Z0-9]/g, '').trim();
      console.log(`[OCR] Código resolvido: ${code}`);

      if (code) {
        await page.type(captchaInputSelector, code);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // 5. Aguardar captura da URL de vídeo
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

app.get('/stream/:type/:id.json', async (req, res) => {
  const { id } = req.params;
  console.log(`\n[Stremio] Novo pedido para o ID: ${id}`);

  const media = await getMediaInfo(id);
  if (!media) return res.json({ streams: [] });

  const stream = await searchAndExtractStream(media);

  if (stream) {
    return res.json({
      streams: [{
        name: 'Flecha Lat',
        title: `${media.name} (Auto Search)`,
        url: stream
      }]
    });
  }

  return res.json({ streams: [] });
});

app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
