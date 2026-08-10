const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();

// Rutas ajustadas para la carpeta client/komorebi.database/
const PUBLIC_DIR = path.join(process.cwd(), 'public');
    ? path.join(process.cwd(), 'public')
    : path.resolve(__dirname, '../../public');
const DB_FILE = path.join(__dirname, 'komorebi_backend_db.json');
const PORT = process.env.PORT || 3000;

// Permite orígenes locales y el dominio de Render
function esOrigenPermitido(origin) {
    if (!origin) return true;

    try {
        const { protocol, hostname } = new URL(origin);
        if (protocol !== 'http:' && protocol !== 'https:') return false;
        return (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname.endsWith('.localhost') ||
            hostname.endsWith('.onrender.com')
        );
    } catch {
        return false;
    }
}

app.use(cors({
    origin(origin, callback) {
        if (esOrigenPermitido(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Origen no permitido por CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin(origin, callback) {
            if (esOrigenPermitido(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Origen no permitido por CORS'));
            }
        },
        methods: ['GET', 'POST']
    }
});

function defaultDB() {
    return { usuarios: {}, amigos: {}, grupos: [], chatsPrivados: {}, sessions: {}, statuses: [] };
}

function migrarDB(db) {
    if (!db.sessions) db.sessions = {};
    if (!db.chatsPrivados) db.chatsPrivados = {};
    if (!db.amigos) db.amigos = {};
    if (!db.statuses) db.statuses = [];
    db.grupos = (db.grupos || []).map((grupo) => ({
        ...grupo,
        id: grupo.id || crypto.randomUUID(),
        messages: grupo.messages || []
    }));
    return db;
}

function cargarDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            return migrarDB(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
        } catch (e) {
            console.error('Error leyendo base de datos:', e.message);
        }
    }
    return defaultDB();
}

function guardarDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function sanitizarTexto(str, maxLen = 500) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLen);
}

function esUrlSegura(url) {
    if (!url) return true;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function esFotoValida(foto) {
    if (!foto || typeof foto !== 'string') return false;
    const valor = foto.trim();
    if (!valor) return false;
    if (valor.startsWith('data:image/')) return true;
    return esUrlSegura(valor);
}

function perfilPublico(user) {
    if (!user) return null;
    const { password, ...rest } = user;
    return rest;
}

function crearToken() {
    return crypto.randomBytes(32).toString('hex');
}

function obtenerSesion(db, token) {
    if (!token || !db.sessions[token]) return null;
    return db.sessions[token];
}

function crearSesion(db, username) {
    const token = crearToken();
    db.sessions[token] = { username, createdAt: Date.now() };
    return token;
}

function respuestaAuth(db, username, token) {
    const userData = db.usuarios[username];
    return {
        success: true,
        token,
        username,
        email: userData.email,
        profile: perfilPublico(userData),
        usuariosRegistrados: Object.keys(db.usuarios).filter((u) => u !== username),
        amigos: db.amigos[username] || [],
        grupos: db.grupos
    };
}

async function verificarPassword(user, password) {
    if (!user?.password) return false;
    if (user.password.startsWith('$2')) {
        return bcrypt.compare(password, user.password);
    }
    return user.password === password;
}

async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
    const db = cargarDB();
    const sesion = obtenerSesion(db, token);
    if (!sesion || !db.usuarios[sesion.username]) {
        return res.status(401).json({ success: false, error: 'No autorizado. Inicia sesión de nuevo.' });
    }
    req.username = sesion.username;
    req.token = token;
    req.db = db;
    next();
}

function usuarioEnChatPrivado(chatKey, username) {
    const participantes = chatKey.split('_');
    return participantes.includes(username);
}

function buscarGrupo(db, grupoId) {
    return db.grupos.find((g) => g.id === grupoId);
}

function obtenerStatusPublicos(db, username) {
    return (db.statuses || [])
        .filter((status) => status.username === username || status.visibility === 'public')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);
}

function renombrarUsuarioEnDB(db, oldName, newName) {
    db.usuarios[newName] = { ...db.usuarios[oldName] };
    delete db.usuarios[oldName];

    if (db.amigos[oldName]) {
        db.amigos[newName] = db.amigos[oldName];
        delete db.amigos[oldName];
    } else {
        db.amigos[newName] = [];
    }

    Object.keys(db.amigos).forEach((user) => {
        db.amigos[user] = db.amigos[user].map((a) => (a === oldName ? newName : a));
    });

    const nuevosChats = {};
    Object.entries(db.chatsPrivados).forEach(([key, messages]) => {
        const newKey = key.split('_').map((p) => (p === oldName ? newName : p)).sort().join('_');
        nuevosChats[newKey] = messages.map((msg) => (
            msg.user === oldName ? { ...msg, user: newName } : msg
        ));
    });
    db.chatsPrivados = nuevosChats;

    db.grupos = db.grupos.map((grupo) => ({
        ...grupo,
        messages: (grupo.messages || []).map((msg) => (
            msg.user === oldName ? { ...msg, user: newName } : msg
        ))
    }));

    Object.values(db.sessions).forEach((sesion) => {
        if (sesion.username === oldName) sesion.username = newName;
    });
}

// --- RUTAS API ---

app.post('/api/login', async (req, res) => {
    try {
        let { username, password, email, photo, isRegistering } = req.body;
        username = sanitizarTexto(username, 50);
        password = sanitizarTexto(password, 128);
        email = sanitizarTexto(email, 120);
        photo = typeof photo === 'string' ? sanitizarTexto(photo, 200000) : '';

        const db = cargarDB();

        if (isRegistering) {
            if (!username || !password || !email || !photo) {
                return res.json({ success: false, error: 'Todos los campos, incluyendo la foto de perfil obligatoria, son requeridos.' });
            }
            if (!email.includes('@')) {
                return res.json({ success: false, error: 'Ingresa un correo electrónico válido.' });
            }
            if (!esFotoValida(photo)) {
                return res.json({ success: false, error: 'La foto de perfil debe ser un archivo de imagen o un enlace http(s) válido.' });
            }
            if (db.usuarios[username]) {
                return res.json({ success: false, error: 'El nombre de usuario ya está en uso. Elige otro.' });
            }

            db.usuarios[username] = {
                password: await hashPassword(password),
                email,
                photo,
                banner: '',
                bgColor: '#1e1e1e',
                bgImage: '',
                fontFamily: 'sans-serif',
                isNew: true
            };
            db.amigos[username] = [];
            const token = crearSesion(db, username);
            guardarDB(db);
            return res.json(respuestaAuth(db, username, token));
        }

        if (!username || !password) {
            return res.json({ success: false, error: 'Usuario y contraseña son requeridos.' });
        }

        const user = db.usuarios[username];
        if (!user || !(await verificarPassword(user, password))) {
            return res.json({ success: false, error: 'Usuario o contraseña incorrectos.' });
        }

        if (!user.password.startsWith('$2')) {
            user.password = await hashPassword(password);
            guardarDB(db);
        }

        const token = crearSesion(db, username);
        guardarDB(db);
        return res.json(respuestaAuth(db, username, token));
    } catch (err) {
        console.error('Error en /api/login:', err);
        return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
    }
});

app.post('/api/session', requireAuth, (req, res) => {
    const db = req.db;
    return res.json(respuestaAuth(db, req.username, req.token));
});

app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
    const db = cargarDB();
    if (token && db.sessions[token]) {
        delete db.sessions[token];
        guardarDB(db);
    }
    res.json({ success: true });
});

app.post('/api/actualizar-perfil', requireAuth, (req, res) => {
    const { photo, banner, bgColor, bgImage, fontFamily } = req.body;
    const db = req.db;
    const user = db.usuarios[req.username];

    if (photo !== undefined) {
        if (photo && !esFotoValida(photo)) {
            return res.json({ success: false, error: 'La foto debe ser un archivo de imagen o un enlace http(s) válido.' });
        }
        user.photo = typeof photo === 'string' ? sanitizarTexto(photo, 200000) || user.photo : user.photo;
    }
    if (banner !== undefined) {
        if (banner && !esUrlSegura(banner)) {
            return res.json({ success: false, error: 'El banner debe ser un enlace http(s) válido.' });
        }
        user.banner = sanitizarTexto(banner, 500);
    }
    if (bgImage !== undefined) {
        if (bgImage && !esUrlSegura(bgImage)) {
            return res.json({ success: false, error: 'La imagen de fondo debe ser un enlace http(s) válido.' });
        }
        user.bgImage = sanitizarTexto(bgImage, 500);
    }
    if (bgColor !== undefined) user.bgColor = sanitizarTexto(bgColor, 20) || '#1e1e1e';
    if (fontFamily !== undefined) user.fontFamily = sanitizarTexto(fontFamily, 50) || 'sans-serif';
    user.isNew = false;

    guardarDB(db);
    res.json({ success: true, profile: perfilPublico(user) });
});

app.post('/api/actualizar-email', requireAuth, (req, res) => {
    const email = sanitizarTexto(req.body.email, 120);
    if (!email || !email.includes('@')) {
        return res.json({ success: false, error: 'Ingresa un correo electrónico válido.' });
    }
    const db = req.db;
    db.usuarios[req.username].email = email;
    guardarDB(db);
    res.json({ success: true, email });
});

app.post('/api/renombrar-usuario', requireAuth, (req, res) => {
    const nuevoUsername = sanitizarTexto(req.body.nuevoUsername, 50);
    if (!nuevoUsername) {
        return res.json({ success: false, error: 'El nombre no puede estar vacío.' });
    }
    const db = req.db;
    if (nuevoUsername === req.username) {
        return res.json({ success: true, username: req.username });
    }
    if (db.usuarios[nuevoUsername]) {
        return res.json({ success: false, error: 'Ese nombre de usuario ya está en uso.' });
    }

    renombrarUsuarioEnDB(db, req.username, nuevoUsername);
    db.sessions[req.token].username = nuevoUsername;
    guardarDB(db);
    res.json({ success: true, username: nuevoUsername, profile: perfilPublico(db.usuarios[nuevoUsername]) });
});

app.post('/api/amigos', requireAuth, (req, res) => {
    const amigo = sanitizarTexto(req.body.amigo, 50);
    const db = req.db;
    const user = req.username;

    if (!amigo || amigo === user) {
        return res.json({ success: false, error: 'Nombre de amigo inválido.' });
    }
    if (!db.usuarios[amigo]) {
        return res.json({ success: false, error: 'El usuario no existe.' });
    }

    if (!db.amigos[user]) db.amigos[user] = [];
    if (!db.amigos[amigo]) db.amigos[amigo] = [];

    if (!db.amigos[user].includes(amigo)) db.amigos[user].push(amigo);
    if (!db.amigos[amigo].includes(user)) db.amigos[amigo].push(user);

    guardarDB(db);
    res.json({ success: true, amigos: db.amigos[user] });
});

app.get('/api/perfiles/:username', requireAuth, (req, res) => {
    const db = req.db;
    const username = sanitizarTexto(req.params.username, 50);
    const user = db.usuarios[username];
    if (!user) {
        return res.status(404).json({ success: false, error: 'Perfil no encontrado.' });
    }

    const isOwner = username === req.username;
    res.json({
        success: true,
        profile: perfilPublico(user),
        isOwner,
        statuses: obtenerStatusPublicos(db, username),
        friends: db.amigos[username] || []
    });
});

app.get('/api/statuses', requireAuth, (req, res) => {
    const db = req.db;
    const visible = (db.statuses || [])
        .filter((status) => status.visibility === 'public' || status.username === req.username)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

    res.json({ success: true, statuses: visible });
});

app.post('/api/statuses', requireAuth, (req, res) => {
    const db = req.db;
    const media = sanitizarTexto(req.body.media || '', 1200000);
    const text = sanitizarTexto(req.body.text || '', 200);
    const emoji = sanitizarTexto(req.body.emoji || '', 50);
    const visibility = req.body.visibility === 'private' ? 'private' : 'public';
    const username = req.username;
    const statusType = req.body.statusType === 'creative' ? 'creative' : 'static';
    const backgroundColor = sanitizarTexto(req.body.backgroundColor || '', 20);
    const backgroundMedia = sanitizarTexto(req.body.backgroundMedia || '', 1200000);

    if (!media && !text && !emoji && !backgroundMedia && !backgroundColor) {
        return res.json({ success: false, error: 'Debes añadir algún contenido al estado.' });
    }

    const status = {
        id: crypto.randomUUID(),
        username,
        media,
        text,
        emoji,
        visibility,
        statusType,
        backgroundColor,
        backgroundMedia,
        createdAt: Date.now()
    };

    db.statuses.push(status);
    guardarDB(db);
    res.json({ success: true, status });
});

app.post('/api/grupos', requireAuth, (req, res) => {
    const name = sanitizarTexto(req.body.name, 80);
    const desc = sanitizarTexto(req.body.desc, 300);
    const photo = sanitizarTexto(req.body.photo, 500);

    if (!name) {
        return res.json({ success: false, error: 'El nombre del grupo es obligatorio.' });
    }
    if (photo && !esUrlSegura(photo)) {
        return res.json({ success: false, error: 'La foto del grupo debe ser un enlace http(s) válido.' });
    }

    const db = req.db;
    const nuevoGrupo = {
        id: crypto.randomUUID(),
        name,
        desc,
        photo,
        creator: req.username,
        messages: []
    };
    db.grupos.push(nuevoGrupo);
    guardarDB(db);
    io.emit('grupo_creado', nuevoGrupo);
    res.json({ success: true, grupos: db.grupos });
});

app.get('/api/chats/:chatKey', requireAuth, (req, res) => {
    const chatKey = sanitizarTexto(req.params.chatKey, 120);
    if (!usuarioEnChatPrivado(chatKey, req.username)) {
        return res.status(403).json({ success: false, error: 'No tienes acceso a este chat.' });
    }
    const db = req.db;
    res.json({ success: true, messages: db.chatsPrivados[chatKey] || [] });
});

app.get('/api/grupos/:grupoId/mensajes', requireAuth, (req, res) => {
    const grupo = buscarGrupo(req.db, req.params.grupoId);
    if (!grupo) {
        return res.status(404).json({ success: false, error: 'Grupo no encontrado.' });
    }
    res.json({ success: true, messages: grupo.messages || [] });
});

// --- SOCKET.IO ---

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const db = cargarDB();
    const sesion = obtenerSesion(db, token);
    if (!sesion || !db.usuarios[sesion.username]) {
        return next(new Error('No autorizado'));
    }
    socket.username = sesion.username;
    socket.token = token;
    next();
});

io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.username);

    socket.on('unir_chat', (chatKey) => {
        if (usuarioEnChatPrivado(chatKey, socket.username)) {
            socket.join(chatKey);
        }
    });

    socket.on('enviar_mensaje_privado', ({ chatKey, message }) => {
        if (!usuarioEnChatPrivado(chatKey, socket.username)) return;

        const db = cargarDB();
        const media = typeof message?.media === 'string' ? sanitizarTexto(message.media, 5000) : '';
        const mensajeSeguro = {
            user: socket.username,
            text: sanitizarTexto(message?.text, 2000),
            media,
            timestamp: Date.now()
        };
        if (!mensajeSeguro.text && !mensajeSeguro.media) return;

        if (!db.chatsPrivados[chatKey]) db.chatsPrivados[chatKey] = [];
        db.chatsPrivados[chatKey].push(mensajeSeguro);
        guardarDB(db);
        io.to(chatKey).emit('nuevo_mensaje', mensajeSeguro);
    });

    socket.on('enviar_mensaje_grupo', ({ grupoId, message }) => {
        const db = cargarDB();
        const grupo = buscarGrupo(db, grupoId);
        if (!grupo) return;

        const mensajeSeguro = {
            user: socket.username,
            text: sanitizarTexto(message?.text, 2000),
            timestamp: Date.now()
        };
        if (!mensajeSeguro.text) return;

        if (!grupo.messages) grupo.messages = [];
        grupo.messages.push(mensajeSeguro);
        guardarDB(db);
        io.emit('nuevo_mensaje_grupo', { grupoId, message: mensajeSeguro });
    });
});

// Sirve index.html para cualquier ruta GET que no pertenezca a la API
app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
        return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    }
    next();
});

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`Servidor Komorebi corriendo en el puerto ${PORT}`);
    });
}

module.exports = { app, server, io };
