const express = require('express');
const http = require('http');
const cors = require('cors'); // <--- 1. Importar cors
const { Server } = require('socket.io');
const { iniciarConsolaDev } = require('./devConsole');
const { detectarContenidoNSFW } = require('./nsfwFilter');

const app = express();

// 2. Middlewares esenciales
app.use(cors()); // Permite peticiones desde Live Server (:5500)
app.use(express.json({ limit: '10mb' })); // Para recibir JSON e imágenes en base64
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: '*',
        methods: ['GET', 'POST']
    } 
});

// Conexión a Base de Datos
const db = require('./dbConnection'); 

// Iniciar consola interactiva en terminal
iniciarConsolaDev(db);

// --- RUTAS API ---

// Ejemplo de Endpoint de Login para eliminar el error 404 de /api/login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        // Agrega aquí tu validación con DB
        res.json({ status: 'ok', mensaje: 'Sesión iniciada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SOCKET.IO ---

io.on('connection', (socket) => {

    // Verificación automática de baneo al conectarse
    socket.on('autenticar', async ({ hwid }) => {
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

    // Procesamiento de mensajes e imágenes NSFW
    socket.on('enviar_mensaje', async (datos) => {
        console.log("📥 Mensaje recibido del cliente:", datos);
        const { usuario_id, grupo_id, hwid, es_imagen, contenido_imagen } = datos;

        if (es_imagen) {
            const esNSFW = await detectarContenidoNSFW(contenido_imagen);

            if (esNSFW) {
                const expiraEn = new Date(Date.now() + 60 * 60 * 1000); // 1 hora baneo

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

server.listen(3000, () => console.log('Servidor Komorebi corriendo en http://localhost:3000'));