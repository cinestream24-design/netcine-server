import express from 'express';
import cors from 'cors';
import { addonBuilder } from 'stremio-addon-sdk';

const app = express();
app.use(cors());

// Manifest do Addon
const manifest = {
  id: 'community.torrent.flecha.addon',
  version: '1.0.0',
  name: 'Torrent & Flecha Stream Combined',
  description: 'Addon para Stremio combinando Bittorrent e Flecha Stream HLS.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'kitsu'],
  catalogs: []
};

const builder = new addonBuilder(manifest);

const FLECHA_NAME = 'Flecha Stream';

// Manipulador de Streams
builder.defineStreamHandler(async (args) => {
  const { type, id } = args;
  const cfg = { showFile: true };

  try {
    // Exemplo de busca e parsing de items do Bittorrent e Flecha Stream
    const rawItems = await fetchSources(type, id);

    const finalItems = rawItems.filter((item) => item && item.stream);

    const streams = finalItems.map((item) => {
      const out = { ...item.stream };

      // Preserva a identificação correta para o player do Stremio
      if (item.source === FLECHA_NAME) {
        out.name = item.stream.name || `${FLECHA_NAME} | HD`;
      } else {
        out.name = `${item.title || 'Torrent'}${item.res ? ' | ' + item.res : ''}`;
      }

      // Oculta nome do arquivo caso configurado
      if (!cfg.showFile && out.title) {
        out.title = out.title.split('\n').filter((l) => !l.startsWith('📄')).join('\n');
      }

      return out;
    });

    return { streams };
  } catch (error) {
    console.error('Erro ao processar streams:', error);
    return { streams: [] };
  }
});

// Exemplo simples de função de busca (Adapte com seus scrapers reais)
async function fetchSources(type, id) {
  const items = [];

  // Exemplo de retorno para Flecha Stream (HLS Direct Link)
  /*
  items.push({
    source: FLECHA_NAME,
    stream: {
      title: "Stream HLS | Flecha\n710p / 1080p",
      url: "https://seu-servidor-flecha.com/live/stream.m3u8"
    }
  });
  */

  return items;
}

// Configuração do servidor HTTP do Stremio
const addonInterface = builder.getInterface();

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(addonInterface.manifest);
});

app.get('/stream/:type/:id.json', (req, res) => {
  addonInterface.get('stream', req.params.type, req.params.id)
    .then((resp) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(resp);
    })
    .catch(() => {
      res.status(500).send({ streams: [] });
    });
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`Addon rodando em: http://localhost:${PORT}/manifest.json`);
});
