const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

// Intentar cargar módulos opcionales si existen
let iniciarConsolaDev, detectarContenidoNSFW, db;
try {
    iniciarConsolaDev = require('./devConsole').iniciarConsolaDev;
    detectarContenidoNSFW = require('./nsfwFilter').detectarContenidoNSFW;
    db = require('./dbConnection');
    if (iniciarConsolaDev && db) iniciarConsolaDev(db);
} catch (e) {
    console.log("Nota: Módulos de DB/NSFW no cargados o en modo liviano.");
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir la carpeta estática (Ajusta la ruta según dónde esté tu carpeta 'public')
const PUBLIC_DIR = path.join(process.cwd(), 'public');
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: '*',
        methods: ['GET', 'POST']
    } 
});

// --- RUTAS API ---
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        // Validación simulada / DB
        res.json({ status: 'ok', mensaje: 'Sesión iniciada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Fallback para servir el index.html en cualquier otra ruta
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('autenticar', async ({ hwid }) => {
        if (!db) return;
        try {
            const [sanciones] = await db.query(
                'SELECT expira_en FROM sanciones_hwid WHERE hwid = ? AND expira_en > NOW()', 
                [hwid]
            );

            if (sanciones.length > 0) {
                socket.emit('bloqueado', {
                    mensaje: 'Se envió contenido sensible a un chat.',
                    expira_en: sanciones[0].expira_en
                });
                socket.disconnect();
            }
        } catch (err) {
            console.error("Error en autenticación socket:", err);
        }
    });

    socket.on('enviar_mensaje', async (datos) => {
        console.log("📥 Mensaje recibido del cliente:", datos);
        const { usuario_id, grupo_id, hwid, es_imagen, contenido_imagen } = datos;

        if (es_imagen && detectarContenidoNSFW && db) {
            const esNSFW = await detectarContenidoNSFW(contenido_imagen);

            if (esNSFW) {
                const expiraEn = new Date(Date.now() + 60 * 60 * 1000);

                await db.query(
                    'INSERT INTO sanciones_hwid (hwid, razon, expira_en) VALUES (?, "Contenido sensible", ?) ON DUPLICATE KEY UPDATE expira_en = ?',
                    [hwid, expiraEn, expiraEn]
                );

                const [usr] = await db.query('SELECT username FROM usuarios WHERE id = ?', [usuario_id]);
                
                io.to(grupo_id).emit('mensaje_sistema', {
                    texto: `⚠️ ${usr[0]?.username || 'Un usuario'} intentó enviar contenido sensible.`
                });

                socket.emit('cerrar_sesion_forzado', { motivo: 'Baneo de 1 hora por contenido sensible.' });
                socket.disconnect();
                return;
            }
        }

        io.to(grupo_id).emit('nuevo_mensaje', datos);
    });
});

// Usar la variable de entorno PORT obligatoria para Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor Komorebi corriendo en puerto ${PORT}`));
    });
});

server.listen(3000, () => console.log('Servidor Komorebi corriendo en http://localhost:3000'));
