const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  consultarNexusVIP,
  acrescentarDiasNexusVIP
} = require('../../src/comandos');

const PORT = Number(
  process.env.SERVER_PORT || process.env.PORT
) || 3000;
const PUBLIC_DIR = path.join(__dirname, '../public');
const VIP_FILE = path.join(__dirname, '../../data/nexus_vip.json');
const CYCLES_FILE = path.join(__dirname, '../../data/nexus_reward_cycles.json');

const TEMPO_CICLO = 5 * 60 * 1000;

const ORIGENS_PERMITIDAS = new Set([
  'https://nexus-music-vip.onrender.com'
]);

function enviarJSON(res, status, dados) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(dados));
}

function configurarCORS(req, res) {
  const origem = req.headers.origin;

  if (origem && ORIGENS_PERMITIDAS.has(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, cf-skip-browser-warning'
  );
}

function lerJSON(arquivo, padrao) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (erro) {
    if (erro.code === 'ENOENT') return padrao;
    throw erro;
  }
}

function guardarJSON(arquivo, dados) {
  const temporario = arquivo + '.tmp';

  fs.writeFileSync(
    temporario,
    JSON.stringify(dados, null, 2),
    'utf8'
  );

  fs.renameSync(temporario, arquivo);
}

function validarID(id) {
  return typeof id === 'string' &&
    /^[0-9]{6,20}$/.test(id);
}

function encontrarJID(id) {
  const base = lerJSON(VIP_FILE, {});

  const encontrados = Object.keys(base).filter(jid =>
    jid.split('@')[0] === id
  );

  if (encontrados.length > 1) {
    throw new Error('ID ambíguo. Contacta o suporte.');
  }

  return encontrados[0] || null;
}

function consultarVIP(id) {
  const jid = encontrarJID(id);

  if (!jid) {
    return {
      ativo: false,
      dias: 0,
      expiraEm: null
    };
  }

  const resultado = consultarNexusVIP(jid);

  return {
    ativo: resultado.ativo,
    dias: resultado.dias,
    expiraEm: resultado.ativo
      ? resultado.expiraEm
      : null
  };
}

async function lerCorpo(req) {
  let corpo = '';

  for await (const parte of req) {
    corpo += parte;

    if (corpo.length > 10000) {
      throw new Error('Pedido demasiado grande.');
    }
  }

  return JSON.parse(corpo || '{}');
}

function startServer() {
  fs.mkdirSync(path.dirname(CYCLES_FILE), {
    recursive: true
  });

  if (!fs.existsSync(CYCLES_FILE)) {
    guardarJSON(CYCLES_FILE, {});
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      configurarCORS(req, res);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      let url;

      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return enviarJSON(res, 400, {
          erro: 'Pedido inválido.'
        });
      }

      // CONSULTAR VALIDADE VIP
      if (url.pathname === '/api/vip' && req.method === 'GET') {
        const id = url.searchParams.get('id') || '';

        if (!validarID(id)) {
          return enviarJSON(res, 400, {
            erro: 'ID inválido.'
          });
        }

        try {
          return enviarJSON(res, 200, {
            sucesso: true,
            ...consultarVIP(id)
          });
        } catch (erro) {
          console.error('Erro na consulta VIP:', erro.message);

          return enviarJSON(res, 500, {
            erro: 'Não foi possível consultar o VIP.'
          });
        }
      }

      // ROTAS DE RECOMPENSA
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') {
          return enviarJSON(res, 405, {
            erro: 'Método não permitido.'
          });
        }

        let dados;

        try {
          dados = await lerCorpo(req);
        } catch {
          return enviarJSON(res, 400, {
            erro: 'Dados inválidos.'
          });
        }

        const id = dados.id;

        if (!validarID(id)) {
          return enviarJSON(res, 400, {
            erro: 'ID inválido.'
          });
        }

        try {
          // Contas antigas mantêm o JID original.
          // Contas novas utilizam o formato LID.
          const jid = encontrarJID(id) || `${id}@lid`;

          const ciclos = lerJSON(CYCLES_FILE, {});

          // INICIAR CONTAGEM DE CINCO MINUTOS
          if (url.pathname === '/api/start-cycle') {
            const token = crypto.randomBytes(32).toString('hex');

            ciclos[id] = {
              token,
              jid,
              iniciadoEm: Date.now(),
              usado: false,
              processando: false
            };

            guardarJSON(CYCLES_FILE, ciclos);

            return enviarJSON(res, 200, {
              sucesso: true,
              token,
              duracao: 300
            });
          }

          const ciclo = ciclos[id];

          if (
            !ciclo ||
            typeof dados.token !== 'string' ||
            ciclo.token !== dados.token ||
            ciclo.jid !== jid
          ) {
            return enviarJSON(res, 409, {
              erro: 'Ciclo inválido. Inicia novamente.'
            });
          }

          // CANCELAR CICLO QUANDO A PESSOA SAI
          if (url.pathname === '/api/cancel-cycle') {
            ciclo.usado = true;
            guardarJSON(CYCLES_FILE, ciclos);

            return enviarJSON(res, 200, {
              sucesso: true
            });
          }

          // ENTREGAR UM DIA VIP
          if (url.pathname === '/api/reward') {
            if (ciclo.usado || ciclo.processando) {
              return enviarJSON(res, 409, {
                erro: 'Este ciclo já foi utilizado.'
              });
            }

            const decorrido = Date.now() - ciclo.iniciadoEm;

            if (decorrido < TEMPO_CICLO) {
              return enviarJSON(res, 403, {
                erro: 'Os cinco minutos ainda não terminaram.'
              });
            }

            ciclo.processando = true;
            guardarJSON(CYCLES_FILE, ciclos);

            try {
              const resultado = acrescentarDiasNexusVIP(jid, 1);

              ciclo.usado = true;
              ciclo.processando = false;
              ciclo.concluidoEm = Date.now();

              guardarJSON(CYCLES_FILE, ciclos);

              console.log('VIP +1 dia:', id);

              return enviarJSON(res, 200, {
                sucesso: true,
                mensagem: 'PARABÉNS! Recebeste mais um dia VIP!',
                vip: resultado
              });
            } catch (erro) {
              ciclo.processando = false;
              guardarJSON(CYCLES_FILE, ciclos);
              throw erro;
            }
          }

          return enviarJSON(res, 404, {
            erro: 'Rota não encontrada.'
          });

        } catch (erro) {
          console.error('Erro na recompensa:', erro.message);

          return enviarJSON(res, 500, {
            erro: erro.message || 'Erro no servidor.'
          });
        }
      }

      // SERVIR AS PÁGINAS DO SITE
      let caminho;

      try {
        caminho = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400);
        return res.end('Pedido inválido.');
      }

      if (caminho === '/') {
        caminho = '/index.html';
      }

      const ficheiro = path.resolve(
        PUBLIC_DIR,
        '.' + caminho
      );

      if (!ficheiro.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        return res.end('Acesso negado.');
      }

      fs.readFile(ficheiro, (erro, conteudo) => {
        if (erro) {
          res.writeHead(404);
          return res.end('Página não encontrada.');
        }

        const tipos = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8'
        };

        res.writeHead(200, {
          'Content-Type':
            tipos[path.extname(ficheiro)] ||
            'application/octet-stream'
        });

        res.end(conteudo);
      });
    });

    server.once('error', erro => {
      if (erro.code === 'EADDRINUSE') {
        console.log('A porta ' + PORT + ' já está em utilização.');
        return resolve(null);
      }

      reject(erro);
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log('NEXUS MUSIC VIP ONLINE!');
      console.log('Porta VIP utilizada:', PORT);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch(console.error);
}

module.exports = { startServer };
      
