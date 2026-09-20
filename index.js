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
  description: 'Add-on para extrair streams de flecha.lat com bypass de CAPTCHA',
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

app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

// Converte o ID IMDb (tt...) para o nome da série/filme via Cinemeta API do Stremio
async function resolveImdbMeta(id) {
  try {
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? String(parts[1]).padStart(2, '0') : null;
    const episode = parts[2] ? String(parts[2]).padStart(2, '0') : null;

    const type = season ? 'series' : 'movie';
    const response = await axios.get(`https://v3-cinemeta.strem.fun/meta/${type}/${imdbId}.json`);
    
    const name = response.data?.meta?.name;
    if (!name) return null;

    // Formata o slug (ex: reacher-01x01)
    const cleanName = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    if (type === 'series') {
      return `${cleanName}-${season}x${episode}`;
    }
    return cleanName;
  } catch (err) {
    console.error('[Meta] Erro ao resolver ID IMDb:', err.message);
    return null;
  }
}

async function extractStreamUrl(episodeSlug) {
  let streamUrl = null;
  const episodeUrl = `https://flecha.lat/episode/${episodeSlug}/`;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();

  try {
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('.m3u8') || (url.includes('.mp4') && !url.includes('captcha'))) {
        streamUrl = url;
      }
    });

    console.log(`[Puppeteer] A navegar até: ${episodeUrl}`);
    const response = await page.goto(episodeUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    if (response.status() === 404) {
      console.log(`[Puppeteer] Página não encontrada (404) para a URL: ${episodeUrl}`);
      await browser.close();
      return null;
    }

    const captchaInputSelector = 'input[placeholder="Código"], input[type="text"]';
    const validateBtnSelector = 'button, input[type="submit"], input[value="Validar"]';

    const hasCaptchaInput = await page.$(captchaInputSelector);

    if (hasCaptchaInput) {
      console.log('[Puppeteer] Verificação Humana detetada. A capturar imagem do CAPTCHA...');

      // Seleciona especificamente o elemento da imagem do CAPTCHA
      const captchaImgElement = await page.$('img[src*="captcha"], .captcha-area img, form img');
      
      if (captchaImgElement) {
        const imageBuffer = await captchaImgElement.screenshot();

        const worker = await createWorker('eng');
        const { data: { text } } = await worker.recognize(imageBuffer);
        await worker.terminate();

        const cleanedCode = text.replace(/[^a-zA-Z0-9]/g, '').trim();
        console.log(`[OCR] Código lido do CAPTCHA: ${cleanedCode}`);

        if (cleanedCode) {
          await page.type(captchaInputSelector, cleanedCode);
          
          await Promise.all([
            page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button, input[type="submit"], .btn'));
              const validateBtn = btns.find(b => b.textContent.includes('Validar') || b.value === 'Validar');
              if (validateBtn) validateBtn.click();
            }),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
          ]);
        }
      }
    }

    let attempts = 0;
    while (!streamUrl && attempts < 12) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
    }

  } catch (error) {
    console.error('[Puppeteer] Erro durante a extração:', error.message);
  } finally {
    await browser.close();
  }

  return streamUrl;
}

app.get('/stream/:type/:id.json', async (req, res) => {
  const { id } = req.params;
  console.log(`[Stremio] Pedido de stream recebido para o ID: ${id}`);

  // Resolve o ID do IMDb para o formato de slug do site (ex: reacher-01x01)
  const episodeSlug = await resolveImdbMeta(id);

  if (!episodeSlug) {
    console.log('[Stremio] Não foi possível converter o ID IMDb.');
    return res.json({ streams: [] });
  }

  console.log(`[Stremio] Slug gerado: ${episodeSlug}`);
  const stream = await extractStreamUrl(episodeSlug);

  if (stream) {
    return res.json({
      streams: [
        {
          name: 'Flecha Lat',
          title: 'HD (Auto-Bypass CAPTCHA)',
          url: stream
        }
      ]
    });
  }

  return res.json({ streams: [] });
});

app.listen(PORT, () => {
  console.log(`Add-on a executar na porta ${PORT}`);
});
