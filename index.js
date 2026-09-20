import express from 'express';
import puppeteer from 'puppeteer';
import { createWorker } from 'tesseract.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do Manifesto do Add-on do Stremio
const MANIFEST = {
  id: 'org.flecha.scraper.addon',
  version: '1.0.0',
  name: 'Flecha Lat Scraper',
  description: 'Add-on para extrair streams de flecha.lat com bypass de CAPTCHA',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'flecha'],
  catalogs: []
};

// CORS para permitir acesso do Stremio Web/Desktop
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// Rota do Manifesto do Stremio
app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

/**
 * Função responsável por navegar até à página,
 * resolver o CAPTCHA de verificação humana via OCR e capturar o stream.
 */
async function extractStreamUrl(episodeUrl) {
  let streamUrl = null;

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
    // Intercepta as requisições de rede em busca do link .m3u8 ou .mp4
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('.m3u8') || (url.includes('.mp4') && !url.includes('captcha'))) {
        streamUrl = url;
      }
    });

    console.log(`[Puppeteer] A navegar até: ${episodeUrl}`);
    await page.goto(episodeUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Seletores ajustados com base na tela do site
    const captchaInputSelector = 'input[placeholder="Código"], input[type="text"]';
    const validateBtnSelector = 'button, input[type="submit"], input[value="Validar"]';

    const hasCaptchaInput = await page.$(captchaInputSelector);

    if (hasCaptchaInput) {
      console.log('[Puppeteer] Verificação Humana detetada. A capturar imagem do CAPTCHA...');

      // Tira screenshot da área do formulário de CAPTCHA
      const captchaContainer = await page.$('.captcha-container, form, div:has(input)');
      const imageBuffer = captchaContainer
        ? await captchaContainer.screenshot()
        : await page.screenshot();

      // Executa OCR com Tesseract.js
      const worker = await createWorker('eng');
      const { data: { text } } = await worker.recognize(imageBuffer);
      await worker.terminate();

      const cleanedCode = text.replace(/[^a-zA-Z0-9]/g, '').trim();
      console.log(`[OCR] Código lido do CAPTCHA: ${cleanedCode}`);

      if (cleanedCode) {
        // Preenche o código e clica em Validar
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

    // Aguarda que o player carregue o vídeo e o evento request capture a URL
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

// Rota de Streams do Stremio
app.get('/stream/:type/:id.json', async (req, res) => {
  const { id } = req.params;
  console.log(`[Stremio] Pedido de stream recebido para o ID/slug: ${id}`);

  // Exemplo de construção do URL do episódio
  // Se o id recebido for no formato 'reacher-01x01', ele monta a URL correta do site
  const episodeUrl = `https://flecha.lat/episode/${id}/`;

  const stream = await extractStreamUrl(episodeUrl);

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
  console.log(`Manifesto disponível em: http://localhost:${PORT}/manifest.json`);
});
