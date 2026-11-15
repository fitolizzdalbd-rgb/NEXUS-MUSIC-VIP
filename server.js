const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, '../public');
const VIP_FILE = path.join(__dirname, '../../data/nexus_vip.json');

function enviarJSON(res, status, dados) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(dados));
}

function consultarVIP(id) {
  const registos = JSON.parse(fs.readFileSync(VIP_FILE, 'utf8'));

  const encontrados = Object.entries(registos).filter(([jid]) =>
    jid.split('@')[0] === id
  );

  if (encontrados.length > 1) {
    return { erro: 'ID ambíguo. Contacta o suporte.' };
  }

  if (encontrados.length === 0) {
    return {
      ativo: false,
      dias: 0,
      expiraEm: null
    };
  }

  const [, conta] = encontrados[0];
  const expiraEm = Number(conta.expiraEm);
  const dias = Math.max(0, Math.ceil((expiraEm - Date.now()) / 86400000));

  return {
    ativo: dias > 0,
    dias,
    expiraEm: dias > 0 ? expiraEm : null
  };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let url;

      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        res.writeHead(400);
        return res.end('Pedido inválido');
      }

      if (url.pathname === '/api/vip') {
        const id = url.searchParams.get('id') || '';

        if (!/^[0-9]+$/.test(id)) {
          return enviarJSON(res, 400, {
            erro: 'ID inválido.'
          });
        }

        try {
          const resultado = consultarVIP(id);

          if (resultado.erro) {
            return enviarJSON(res, 409, resultado);
          }

          return enviarJSON(res, 200, {
            sucesso: true,
            ...resultado
          });
        } catch (error) {
          console.error('Erro ao consultar VIP:', error.message);
          return enviarJSON(res, 500, {
            erro: 'Não foi possível consultar o VIP.'
          });
        }
      }

      let requestedPath;

      try {
        requestedPath = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400);
        return res.end('Pedido inválido');
      }

      if (requestedPath === '/') {
        requestedPath = '/index.html';
      }

      const filePath = path.resolve(PUBLIC_DIR, '.' + requestedPath);

      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        return res.end('Acesso negado');
      }

      fs.readFile(filePath, (error, content) => {
        if (error) {
          res.writeHead(404);
          return res.end('Página não encontrada');
        }

        const extension = path.extname(filePath);
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8'
        };

        res.writeHead(200, {
          'Content-Type': types[extension] || 'application/octet-stream'
        });

        res.end(content);
      });
    });

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.log('🌐 NEXUS MUSIC: porta 3000 já está em utilização.');
        return resolve(null);
      }
      reject(error);
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log('🎵 NEXUS MUSIC ONLINE!');
      console.log(`🌐 http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch(console.error);
}

module.exports = { startServer };
