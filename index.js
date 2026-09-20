const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 7000;

// Configuração de CORS para permitir requisições externas
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// Rota principal para verificação de status
app.get('/', (req, res) => {
  res.json({
    name: 'Addon Flecha Scraper',
    status: 'online',
    timestamp: new Date().toISOString()
  });
});

// Rota de teste utilizando o Axios
app.get('/scrape', async (req, res) => {
  try {
    const targetUrl = req.query.url;

    if (!targetUrl) {
      return res.status(400).json({ error: 'Informe a URL no parâmetro query, ex: /scrape?url=https://exemplo.com' });
    }

    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    res.json({
      status: response.status,
      contentLength: response.data ? response.data.length : 0,
      preview: typeof response.data === 'string' ? response.data.substring(0, 500) : response.data
    });
  } catch (error) {
    console.error('Erro na requisição Axios:', error.message);
    res.status(500).json({
      error: 'Falha ao buscar os dados da URL',
      details: error.message
    });
  }
});

// Inicialização do servidor
app.listen(PORT, () => {
  console.log(`[flecha-scraper] Servidor rodando na porta ${PORT}`);
});
