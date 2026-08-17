function getBackendUrl() {
    if (window.KOMOREBI_API) return window.KOMOREBI_API;
    
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `https://komorabi.onrender.com`;
    }
    
    return window.location.origin;
}

const SOCKET_URL = getBackendUrl();

function fetchJson(url, options = {}) {
    return fetch(url, options)
        .then(async (res) => {
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                data = { success: false, error: 'Respuesta inválida del servidor.' };
            }
            return { res, data };
        })
        .then(({ res, data }) => {
            if (!res.ok && !data.success) {
                throw new Error(data.error || 'Error del servidor');
            }
            return data;
        });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isSafeImageUrl(url) {
    if (!url) return false;
    if (typeof url !== 'string') return false;
    if (url.startsWith('data:image/')) return true;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function getStatusMediaTag(media) {
    if (!media) return '';
    if (typeof media !== 'string') return '';
    if (media.startsWith('data:video/')) {
        return `<video controls autoplay loop muted style="width:100%;border-radius:12px;max-height:260px;background:#000;"> <source src="${escapeHtml(media)}"></video>`;
    }
    if (media.startsWith('data:audio/')) {
        return `<audio controls style="width:100%;"> <source src="${escapeHtml(media)}"></audio>`;
    }
    if (media.startsWith('data:image/')) {
        return `<img src="${escapeHtml(media)}" alt="estado" style="width:100%;border-radius:12px;max-height:260px;object-fit:cover;">`;
    }
    return `<p class="empty-text">Archivo no compatible.</p>`;
}

const HUD = {
    container: document.getElementById('app-root'),
    currentUser: null,
    currentEmail: '',
    currentProfile: null,
    authToken: null,
    isRegistering: false,
    currentTab: 'privado',
    activeChat: null,
    socket: null,
    usuariosGlobales: [],
    amigosList: [],
    gruposList: [],
    filtroAmigos: '',
    profileView: null,
    contactProfiles: {},
    unreadByContact: {},
    activeContacts: {},
    statusEditorState: {
        mode: 'static',
        backgroundColor: '#111827',
        layers: [],
        selectedLayerId: null,
        dragLayerId: null,
        dragOffsetX: 0,
        dragOffsetY: 0,
        canvas: null,
        ctx: null
    },

    authHeaders() {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.authToken}`
        };
    },

    init() {
        this.authToken = localStorage.getItem('komorebi_token');
        const session = localStorage.getItem('komorebi_session');
        if (!this.authToken || !session) {
            this.renderAuth();
        } else {
            this.restaurarSesion();
        }
    },

    restaurarSesion() {
        fetchJson(`${SOCKET_URL}/api/session`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ token: this.authToken })
        })
            .then((data) => {
                if (data.success) {
                    this.aplicarDatosSesion(data);
                } else {
                    this.limpiarSesion();
                    this.renderAuth();
                }
            })
            .catch(() => {
                alert('No se pudo conectar con el servidor. Asegúrate de que esté corriendo.');
                this.limpiarSesion();
                this.renderAuth();
            });
    },

    aplicarDatosSesion(data) {
        this.authToken = data.token;
        this.currentUser = data.username;
        this.currentEmail = data.email || '';
        this.currentProfile = data.profile;
        this.usuariosGlobales = data.usuariosRegistrados || [];
        this.amigosList = data.amigos || [];
        this.gruposList = data.grupos || [];
        this.cargarPerfilesAmigos();

        localStorage.setItem('komorebi_token', this.authToken);
        localStorage.setItem('komorebi_session', this.currentUser);

        if (this.socket) this.socket.disconnect();
        this.socket = io(SOCKET_URL, { auth: { token: this.authToken } });
        this.initSockets();
        this.renderMain();

        if (this.currentProfile?.isNew) {
            setTimeout(() => this.abrirModalPersonalizacion(), 300);
        }
    },

    initSockets() {
        this.socket.off('nuevo_mensaje');
        this.socket.off('nuevo_mensaje_grupo');
        this.socket.off('grupo_creado');
        this.socket.off('usuario_conectado');
        this.socket.off('usuario_desconectado');

        this.socket.on('nuevo_mensaje', (msg) => {
            if (!msg?.user || msg.user === this.currentUser) return;
            const isActiveChat = this.activeChat?.type === 'privado' && this.activeChat.id === msg.user;
            if (isActiveChat) {
                const feed = document.getElementById('feed');
                if (feed) this.appendChatMessage(feed, msg);
                return;
            }

            this.unreadByContact[msg.user] = (this.unreadByContact[msg.user] || 0) + 1;
            if (this.currentTab === 'privado' && !this.activeChat) {
                this.renderMain();
            }
        });

        this.socket.on('nuevo_mensaje_grupo', ({ grupoId, message }) => {
            if (this.activeChat?.type === 'grupo' && this.activeChat.id === grupoId) {
                const feed = document.getElementById('feed');
                if (feed) this.appendChatMessage(feed, message);
            }
        });

        this.socket.on('grupo_creado', (grupo) => {
            if (!this.gruposList.find((g) => g.id === grupo.id)) {
                this.gruposList.push(grupo);
            }
            if (this.currentTab === 'grupos') this.renderMain();
        });

        this.socket.on('usuario_conectado', ({ username }) => {
            if (username) {
                this.activeContacts[username] = true;
                if (this.currentTab === 'privado') this.renderMain();
            }
        });

        this.socket.on('usuario_desconectado', ({ username }) => {
            if (username) {
                this.activeContacts[username] = false;
                if (this.currentTab === 'privado') this.renderMain();
            }
        });
    },

    appendChatMessage(feed, msg) {
        const loading = feed.querySelector('.empty-text');
        if (loading) loading.remove();

        const div = document.createElement('div');
        div.className = `chat-msg ${msg.user === this.currentUser ? 'chat-msg-mine' : 'chat-msg-theirs'}`;

        const avatarMarkup = msg.user === this.currentUser
            ? ''
            : `<div class="chat-msg-avatar">${this.getAvatarMarkupForUsername(msg.user, 'small')}</div>`;

        const mediaMarkup = msg.media ? `<div class="chat-media-wrap">${msg.media.startsWith('data:image/') ? `<img src="${escapeHtml(msg.media)}" alt="adjunto" class="chat-media">` : `<div class="chat-media-placeholder">📎 adjunto</div>`}</div>` : '';

        div.innerHTML = `
            ${avatarMarkup}
            <div class="chat-msg-body">
                <div class="chat-msg-meta">${escapeHtml(msg.user)}</div>
                ${mediaMarkup}
                ${msg.text ? `<div class="chat-msg-text">${escapeHtml(msg.text)}</div>` : ''}
            </div>
        `;
        feed.appendChild(div);
        feed.scrollTop = feed.scrollHeight;
    },

    getAvatarMarkupForUsername(username, size = 'medium') {
        const profile = username === this.currentUser
            ? (this.currentProfile || {})
            : (this.contactProfiles?.[username] || {});
        const isActive = Boolean(this.activeContacts?.[username]);
        const ringClass = isActive ? 'active-ring' : 'inactive-ring';
        const sizeClass = size === 'small' ? 'avatar-small' : 'avatar-medium';
        return `
            <div class="avatar-shell ${sizeClass} ${ringClass}">
                ${isSafeImageUrl(profile.photo)
                    ? `<img src="${escapeHtml(profile.photo)}" alt="${escapeHtml(username)}" class="avatar-image">`
                    : '<span class="avatar-fallback">👤</span>'}
            </div>
        `;
    },

    getContactPhotoMarkup(amigo) {
        const unread = this.getContactUnreadCount(amigo);
        return `
            <div class="amigo-avatar-wrap" onclick="event.stopPropagation(); HUD.abrirPerfil('${escapeHtml(amigo)}')">
                ${this.getAvatarMarkupForUsername(amigo, 'medium')}
                ${unread > 0 ? `<span class="notification-badge">${unread}</span>` : ''}
            </div>
        `;
    },

    getContactUnreadCount(amigo) {
        return this.unreadByContact?.[amigo] || 0;
    },

    cargarPerfilesAmigos() {
        const usernames = [...new Set((this.amigosList || []).filter(Boolean))];
        if (!usernames.length) {
            this.contactProfiles = {};
            return Promise.resolve();
        }

        return Promise.all(usernames.map((amigo) =>
            fetchJson(`${SOCKET_URL}/api/perfiles/${encodeURIComponent(amigo)}`, { headers: this.authHeaders() })
                .then((data) => {
                    if (data.success) this.contactProfiles[amigo] = data.profile;
                })
                .catch(() => {})
        )).then(() => {
            if (this.currentTab === 'privado' && !this.activeChat) {
                this.renderMain();
            }
        });
    },

    renderAuth() {
        this.container.innerHTML = `
            <div class="auth-container">
                <div class="auth-box">
                    <h2>KOMOREBI ${this.isRegistering ? 'REGISTRO' : 'ACCESO'}</h2>
                    <div class="form-group">
                        <label>NOMBRE DE USUARIO</label>
                        <input type="text" id="auth-user" placeholder="Tu nombre..." autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label>CONTRASEÑA</label>
                        <input type="password" id="auth-pass" placeholder="Tu contraseña..." autocomplete="${this.isRegistering ? 'new-password' : 'current-password'}">
                    </div>
                    ${this.isRegistering ? `
                    <div class="form-group">
                        <label>CORREO ELECTRÓNICO</label>
                        <input type="email" id="auth-email" placeholder="tucorreo@dominio.com" autocomplete="email">
                    </div>
                    <div class="form-group">
                        <label>FOTO DE PERFIL</label>
                        <input type="file" id="auth-photo" accept="image/*">
                    </div>
                    ` : ''}
                    <div class="auth-buttons">
                        <button class="hud-btn btn-crear" onclick="HUD.login()">${this.isRegistering ? 'CREAR CUENTA' : 'ENTRAR'}</button>
                        <button class="hud-btn btn-cancelar" onclick="HUD.toggleRegistro()">${this.isRegistering ? 'Ya tengo cuenta' : 'Registrarme'}</button>
                    </div>
                </div>
            </div>
        `;

        const passInput = document.getElementById('auth-pass');
        if (passInput) {
            passInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.login();
            });
        }
    },

    toggleRegistro() {
        this.isRegistering = !this.isRegistering;
        this.renderAuth();
    },

    login() {
        const username = document.getElementById('auth-user').value.trim();
        const password = document.getElementById('auth-pass').value.trim();
        if (!username || !password) return alert('Usuario y contraseña son requeridos.');

        const body = { username, password, isRegistering: this.isRegistering };
        if (this.isRegistering) {
            body.email = document.getElementById('auth-email').value.trim();
            const photoInput = document.getElementById('auth-photo');
            body.photo = photoInput && photoInput.files && photoInput.files[0] ? photoInput.files[0] : '';
        }

        if (this.isRegistering && body.photo instanceof File) {
            const fileReader = new FileReader();
            fileReader.onload = () => {
                body.photo = fileReader.result;
                this.enviarAuth(body);
            };
            fileReader.onerror = () => {
                alert('No se pudo leer la imagen seleccionada.');
            };
            fileReader.readAsDataURL(body.photo);
            return;
        }

        if (this.isRegistering && typeof body.photo === 'string' && body.photo.startsWith('data:image/')) {
            this.enviarAuth(body);
            return;
        }

        this.enviarAuth(body);
    },

    enviarAuth(body) {
        fetchJson(`${SOCKET_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then((data) => {
                if (data.success) {
                    this.isRegistering = false;
                    this.aplicarDatosSesion(data);
                } else {
                    alert(data.error || 'No se pudo iniciar sesión.');
                }
            })
            .catch(() => {
                alert('No se pudo conectar con el servidor backend.');
            });
    },

    renderMain() {
        this.container.innerHTML = `
            ${this.navComponent()}
            <main id="content-area">
                ${this.getActiveViewComponent()}
            </main>
            <div id="modal-container"></div>
        `;

        if (this.activeChat) {
            this.loadChatHistory();
        }
    },

    navComponent() {
        return `
            <nav class="top-nav">
                ${this.activeChat ? `
                    <div class="chat-top-bar">
                        <div class="chat-top-user">
                            ${this.activeChat.type === 'privado'
                                ? this.getAvatarMarkupForUsername(this.activeChat.id, 'small')
                                : '<div class="avatar-shell avatar-small inactive-ring"><span class="avatar-fallback">👥</span></div>'}
                            <span class="chat-top-title">${escapeHtml(this.activeChat.type === 'privado' ? this.activeChat.id : (this.gruposList.find((g) => g.id === this.activeChat.id)?.name || 'Grupo'))}</span>
                        </div>
                    </div>
                ` : `
                    <button class="hud-btn ${this.currentTab === 'privado' ? 'active-btn' : ''}" onclick="HUD.switchTab('privado')">PRIVADO</button>
                    <button class="hud-btn ${this.currentTab === 'grupos' ? 'active-btn' : ''}" onclick="HUD.switchTab('grupos')">GRUPOS</button>
                    <button class="hud-btn ${this.currentTab === 'confi' ? 'active-btn' : ''}" onclick="HUD.switchTab('confi')">CONFI</button>
                `}
            </nav>
        `;
    },

    getActiveViewComponent() {
        if (this.activeChat) return this.chatViewComponent();
        switch (this.currentTab) {
            case 'privado': return this.privadoViewComponent();
            case 'grupos': return this.gruposViewComponent();
            case 'confi': return this.confiViewComponent();
            default: return this.privadoViewComponent();
        }
    },

    privadoViewComponent() {
        const amigosFiltrados = (this.amigosList || []).filter((a) =>
            a.toLowerCase().includes(this.filtroAmigos.toLowerCase())
        );

        return `
            <section class="view view-enter chat-layout">
                <aside class="sidebar-grupos">
                    <div class="sidebar-title">CONTACTOS</div>
                    <div class="contact-list">
                        ${amigosFiltrados.length === 0
                            ? '<p class="empty-text" style="text-align:center;margin-top:12px;">No hay contactos todavía.</p>'
                            : amigosFiltrados.map((amigo) => `
                                <div class="amigo-item hud-btn ${this.activeChat?.id === amigo ? 'active-contact' : ''}"
                                     data-amigo="${escapeHtml(amigo)}"
                                     onclick="HUD.abrirChatPrivado(this.dataset.amigo)">
                                    ${this.getContactPhotoMarkup(amigo)}
                                    <div class="amigo-item-text">
                                        <span class="amigo-nombre">${escapeHtml(amigo)}</span>
                                        <span class="amigo-hint">Abrir chat</span>
                                    </div>
                                </div>
                            `).join('')}
                    </div>
                    <button class="hud-btn sidebar-add-btn" onclick="HUD.abrirModalAnadirAmigo()">+ añadir amigo</button>
                    <div class="sidebar-search-box">
                        <input type="text" class="search-bar-input" placeholder="Buscar contactos..."
                               value="${escapeHtml(this.filtroAmigos)}" oninput="HUD.filtrarAmigos(this.value)">
                    </div>
                </aside>
                <div class="chat-main">
                    <div class="chat-feed"></div>
                </div>
            </section>
        `;
    },

    filtrarAmigos(val) {
        this.filtroAmigos = val;
        const feed = document.querySelector('.contact-list');
        const amigosFiltrados = (this.amigosList || []).filter((a) =>
            a.toLowerCase().includes(val.toLowerCase())
        );
        if (feed) {
            feed.innerHTML = amigosFiltrados.length === 0
                ? '<p class="empty-text" style="text-align:center;margin-top:12px;">No hay contactos.</p>'
                : amigosFiltrados.map((amigo) => `
                    <div class="amigo-item hud-btn ${this.activeChat?.id === amigo ? 'active-contact' : ''}" data-amigo="${escapeHtml(amigo)}" onclick="HUD.abrirChatPrivado(this.dataset.amigo)">
                        ${this.getContactPhotoMarkup(amigo)}
                        <div class="amigo-item-text">
                            <span class="amigo-nombre">${escapeHtml(amigo)}</span>
                            <span class="amigo-hint">Abrir chat</span>
                        </div>
                    </div>
                `).join('');
        }
    },

    gruposViewComponent() {
        if (this.gruposList.length === 0) {
            return `
                <section class="view view-enter welcome-groups-view">
                    <div class="welcome-container">
                        <h1 class="welcome-title">CREA UN GRUPO HOY</h1>
                        <div class="welcome-buttons single-btn-center">
                            <button class="hud-btn action-card-btn" onclick="HUD.abrirModalCrearGrupo()">CREAR</button>
                        </div>
                    </div>
                </section>
            `;
        }

        return `
            <section class="view view-enter chat-layout">
                <div class="sidebar-grupos">
                    ${this.gruposList.map((g) => `
                        <div class="grupo-icon hud-btn ${this.activeChat?.id === g.id ? 'active-g' : ''}"
                             data-grupo-id="${escapeHtml(g.id)}"
                             onclick="HUD.abrirChatGrupo(this.dataset.grupoId)"
                             title="${escapeHtml(g.name)}">
                            ${isSafeImageUrl(g.photo)
                                ? `<img src="${escapeHtml(g.photo)}" alt="" style="width:100%;height:100%;border-radius:12px;object-fit:cover;">`
                                : '👥'}
                        </div>
                    `).join('')}
                    <div class="grupo-icon hud-btn" onclick="HUD.abrirModalCrearGrupo()" title="Crear grupo">+</div>
                </div>
                <div class="chat-main-welcome">
                    <p class="empty-text">Selecciona un grupo a la izquierda para chatear.</p>
                </div>
            </section>
        `;
    },

    chatViewComponent() {
        let title = '';
        if (this.activeChat.type === 'privado') {
            title = this.activeChat.id;
            const chatKey = [this.currentUser, this.activeChat.id].sort().join('_');
            if (this.socket) this.socket.emit('unir_chat', chatKey);
        } else {
            const grupo = this.gruposList.find((g) => g.id === this.activeChat.id);
            title = grupo ? grupo.name : 'Grupo';
        }

        return `
            <section class="view view-enter chat-layout">
                <div class="sidebar-grupos"></div>
                <div class="chat-main">
                    <div class="chat-top-bar">
                        <div class="chat-top-user">
                            ${this.activeChat.type === 'privado'
                                ? this.getAvatarMarkupForUsername(this.activeChat.id, 'small')
                                : '<div class="avatar-shell avatar-small inactive-ring"><span class="avatar-fallback">👥</span></div>'}
                            <span class="chat-top-title">${escapeHtml(title)}</span>
                        </div>
                    </div>
                    <div id="feed" class="chat-feed">
                        <p class="empty-text" style="text-align:center;margin-top:10px;">Cargando mensajes...</p>
                    </div>
                    <footer class="chat-input-area">
    <div class="message-input-wrap">
        <label for="msg-image" class="chat-voice-btn" style="cursor:pointer;" title="Adjuntar imagen">📷</label>
        <!-- El ID 'msg-image' es crítico para evitar el error de referencia nula -->
        <input type="file" id="msg-image" accept="image/*" style="display:none;" onchange="HUD.handleMediaSelection(event)">
        <input type="text" id="msg-input" placeholder="Escribe para enviar un mensaje..." onkeypress="HUD.handleKeyPress(event)">
        <button class="chat-voice-btn" onclick="HUD.enviarNotaVoz()" type="button" aria-label="Enviar nota de voz">
            🎤
        </button>
    </div>
</footer>
                    <button class="hud-btn btn-cancelar chat-exit-btn" onclick="HUD.cerrarChat()">Exit chat</button>
                </div>
            </section>
        `;
    },

    loadChatHistory() {
        const feed = document.getElementById('feed');
        if (!feed || !this.activeChat) return;

        let url;
        if (this.activeChat.type === 'privado') {
            const chatKey = [this.currentUser, this.activeChat.id].sort().join('_');
            url = `${SOCKET_URL}/api/chats/${encodeURIComponent(chatKey)}`;
        } else {
            url = `${SOCKET_URL}/api/grupos/${encodeURIComponent(this.activeChat.id)}/mensajes`;
        }

        fetchJson(url, { headers: this.authHeaders() })
            .then((data) => {
                if (!data.success) {
                    feed.innerHTML = '<p class="empty-text">No se pudieron cargar los mensajes.</p>';
                    return;
                }
                feed.innerHTML = '';
                if (!data.messages.length) {
                    feed.innerHTML = '<p class="empty-text" style="text-align:center;margin-top:10px;">Sin mensajes aún. ¡Escribe el primero!</p>';
                    return;
                }
                data.messages.forEach((msg) => this.appendChatMessage(feed, msg));
            })
            .catch(() => {
                feed.innerHTML = '<p class="empty-text">Error al cargar el historial.</p>';
            });
    },

    confiViewComponent() {
        return `
            <section class="view view-enter">
                <div class="panel-box confi-panel">
                    <h2>configuración</h2>
                    <p>usuario actual: <strong>${escapeHtml(this.currentUser)}</strong></p>
                    <p>correo asociado: <strong>${escapeHtml(this.currentEmail)}</strong></p>
                    <div class="confi-actions">
                        <button class="hud-btn btn-crear" onclick="HUD.abrirModalPersonalizacion()">personalización de perfil</button>
                        <button class="hud-btn btn-crear" onclick="HUD.abrirPerfil(HUD.currentUser)">ver mi perfil</button>
                        <button class="hud-btn btn-crear" onclick="HUD.abrirModalEstados()">estado</button>
                        <button class="hud-btn btn-crear" onclick="HUD.abrirModalCorreo()">vincular / cambiar correo</button>
                        <button class="hud-btn btn-cancelar" onclick="HUD.logout()">cerrar sesión</button>
                    </div>
                </div>
            </section>
        `;
    },

    abrirModalPersonalizacion() {
        const p = this.currentProfile || {};
        document.getElementById('modal-container').innerHTML = `
            <div class="modal-overlay">
                <div class="modal-box modal-wide">
                    <h2>personalización</h2>
                    <div class="form-group">
                        <label>cambiar nombre de usuario</label>
                        <input type="text" id="input-nuevo-nombre" value="${escapeHtml(this.currentUser)}" placeholder="Nuevo nombre...">
                    </div>
                    <div class="form-group">
                        <label>foto de perfil</label>
                        <input type="file" id="input-photo" accept="image/*">
                    </div>
                    <div class="form-group">
                        <label>banner (URL)</label>
                        <input type="url" id="input-banner" value="${escapeHtml(p.banner || '')}" placeholder="https://...">
                    </div>
                    <div class="form-group">
                        <label>color de fondo</label>
                        <input type="text" id="input-bgcolor" value="${escapeHtml(p.bgColor || '#1e1e1e')}" placeholder="#1e1e1e">
                    </div>
                    <div class="form-group">
                        <label>imagen de fondo (URL)</label>
                        <input type="url" id="input-bgimage" value="${escapeHtml(p.bgImage || '')}" placeholder="https://...">
                    </div>
                    <div class="form-group">
                        <label>fuente</label>
                        <input type="text" id="input-font" value="${escapeHtml(p.fontFamily || 'sans-serif')}" placeholder="sans-serif">
                    </div>
                    <div class="modal-buttons">
                        <button class="hud-btn btn-cancelar" onclick="HUD.cerrarModal()">cancelar</button>
                        <button class="hud-btn btn-crear" onclick="HUD.guardarPersonalizacion()">guardar</button>
                    </div>
                </div>
            </div>
        `;
    },

    guardarPersonalizacion() {
        const nuevoNombre = document.getElementById('input-nuevo-nombre').value.trim();
        const photoInput = document.getElementById('input-photo');
        const photo = photoInput && photoInput.files && photoInput.files[0] ? photoInput.files[0] : '';
        const banner = document.getElementById('input-banner').value.trim();
        const bgColor = document.getElementById('input-bgcolor').value.trim();
        const bgImage = document.getElementById('input-bgimage').value.trim();
        const fontFamily = document.getElementById('input-font').value.trim();

        if (!nuevoNombre) return alert('El nombre no puede estar vacío.');

        const enviarPerfil = (photoValue) => {
            const perfilPromise = fetchJson(`${SOCKET_URL}/api/actualizar-perfil`, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({ photo: photoValue, banner, bgColor, bgImage, fontFamily })
            });

            const renamePromise = nuevoNombre !== this.currentUser
                ? fetchJson(`${SOCKET_URL}/api/renombrar-usuario`, {
                    method: 'POST',
                    headers: this.authHeaders(),
                    body: JSON.stringify({ nuevoUsername: nuevoNombre })
                })
                : Promise.resolve({ success: true, username: this.currentUser });

            Promise.all([perfilPromise, renamePromise])
                .then(([perfilData, renameData]) => {
                    if (!perfilData.success) return alert(perfilData.error);
                    if (!renameData.success) return alert(renameData.error);

                    if (renameData.username) {
                        this.currentUser = renameData.username;
                        localStorage.setItem('komorebi_session', this.currentUser);
                    }
                    this.currentProfile = perfilData.profile;
                    this.cerrarModal();
                    this.renderMain();
                    alert('Perfil actualizado correctamente.');
                })
                .catch(() => alert('Error al guardar el perfil.'));
        };

        if (photo instanceof File) {
            const fileReader = new FileReader();
            fileReader.onload = () => enviarPerfil(fileReader.result);
            fileReader.onerror = () => {
                alert('No se pudo leer la imagen seleccionada.');
            };
            fileReader.readAsDataURL(photo);
            return;
        }

        enviarPerfil('');
    },

    abrirPerfil(username) {
        if (!username) return;
        this.cerrarModal();
        document.getElementById('modal-container').innerHTML = `
            <div class="modal-overlay">
                <div class="modal-box modal-wide">
                    <h2>perfil</h2>
                    <p class="empty-text">Cargando perfil...</p>
                </div>
            </div>
        `;

        fetchJson(`${SOCKET_URL}/api/perfiles/${encodeURIComponent(username)}`, { headers: this.authHeaders() })
            .then((data) => {
                if (!data.success) {
                    this.cerrarModal();
                    alert(data.error || 'No se pudo cargar el perfil.');
                    return;
                }
                this.profileView = data;
                this.renderProfileModal();
            })
            .catch(() => {
                this.cerrarModal();
                alert('No se pudo cargar el perfil.');
            });
    },

    renderProfileModal() {
        const data = this.profileView || {};
        const profile = data.profile || {};
        const statuses = data.statuses || [];
        const isOwner = data.isOwner;

        document.getElementById('modal-container').innerHTML = `
            <div class="modal-overlay">
                <div class="modal-box modal-wide">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
                        <h2>${escapeHtml(profile.username || data.username || 'Perfil')}</h2>
                        <button class="hud-btn btn-cancelar" onclick="HUD.cerrarModal()">cerrar</button>
                    </div>
                    <div style="display:flex;gap:16px;align-items:center;margin:12px 0;flex-wrap:wrap;">
                        <div style="width:72px;height:72px;border-radius:50%;background:#2b2b2b;display:flex;align-items:center;justify-content:center;overflow:hidden;">
                            ${isSafeImageUrl(profile.photo)
                                ? `<img src="${escapeHtml(profile.photo)}" alt="avatar" style="width:100%;height:100%;object-fit:cover;">`
                                : '👤'}
                        </div>
                        <div>
                            <p style="margin:0;font-size:1.1rem;font-weight:bold;">${escapeHtml(profile.username || data.username || 'Perfil')}</p>
                            <p style="margin:2px 0;">${escapeHtml(profile.email || '')}</p>
                            <p style="margin:2px 0;">Amigos: ${escapeHtml(String(data.friends?.length || 0))}</p>
                        </div>
                    </div>
                    ${isOwner ? `
                    <div class="form-group">
                        <label>subir estado</label>
                        <input type="file" id="status-media" accept="image/*,video/*,audio/*">
                    </div>
                    <div class="form-group">
                        <label>texto</label>
                        <input type="text" id="status-text" placeholder="Añade un mensaje..."></input>
                    </div>
                    <div class="form-group">
                        <label>emoji</label>
                        <input type="text" id="status-emoji" placeholder="✨"></input>
                    </div>
                    <div class="modal-buttons">
                        <button class="hud-btn btn-crear" onclick="HUD.guardarStatus()">publicar estado</button>
                    </div>
                    ` : ''}
                    <div style="margin-top:14px;display:grid;gap:12px;">
                        ${statuses.length ? statuses.map((status) => `
                            <div style="border:1px solid #444;border-radius:14px;padding:12px;background:#1d1d1d;display:grid;gap:8px;">
                                <div style="display:flex;justify-content:space-between;align-items:center;">
                                    <strong>${escapeHtml(status.username || '')}</strong>
                                    <span style="font-size:0.9rem;color:#bbb;">${new Date(status.createdAt).toLocaleString()}</span>
                                </div>
                                ${getStatusMediaTag(status.media)}
                                ${status.emoji ? `<div style="font-size:1.2rem;">${escapeHtml(status.emoji)}</div>` : ''}
                                ${status.text ? `<div>${escapeHtml(status.text)}</div>` : ''}
                            </div>
                        `).join('') : '<p class="empty-text">Este perfil aún no tiene estados públicos.</p>'}
                    </div>
                </div>
            </div>
        `;
    },

    guardarStatus() {
        const mediaInput = document.getElementById('status-media');
        const mediaFile = mediaInput && mediaInput.files && mediaInput.files[0] ? mediaInput.files[0] : null;
        const text = document.getElementById('status-text').value.trim();
        const emoji = document.getElementById('status-emoji').value.trim();

        if (!mediaFile) {
            alert('Selecciona un archivo de imagen, video o audio para publicar el estado.');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            fetchJson(`${SOCKET_URL}/api/statuses`, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({ media: reader.result, text, emoji, visibility: 'public' })
            })
                .then((data) => {
                    if (!data.success) {
                        alert(data.error || 'No se pudo publicar el estado.');
                        return;
                    }
                    if (this.profileView?.profile?.username) {
                        this.abrirPerfil(this.profileView.profile.username);
                    }
                })
                .catch(() => alert('No se pudo publicar el estado.'));
        };
        reader.onerror = () => alert('No se pudo leer el archivo seleccionado.');
        reader.readAsDataURL(mediaFile);
    },

    abrirModalEstados() {
        document.getElementById('modal-container').innerHTML = `
            <div class="modal-overlay">
                <div class="modal-box modal-wide status-editor-modal">
                    <div class="status-editor-header">
                        <h2>crear estado</h2>
                        <button class="hud-btn btn-cancelar" onclick="HUD.cerrarModal()">cancelar</button>
                    </div>
                    <div class="status-mode-switch">
                        <button class="hud-btn btn-cancelar status-mode-btn active" onclick="HUD.setStatusMode('static')">Static</button>
                        <button class="hud-btn btn-cancelar status-mode-btn" onclick="HUD.setStatusMode('creative')">Creative</button>
                    </div>
                    <div class="status-editor-layout">
                        <div class="status-editor-preview-shell">
                            <canvas id="status-editor-canvas" width="420" height="720"></canvas>
                        </div>
                        <div class="status-editor-controls">
                            <div class="status-tools-panel">
                                <div class="status-tool-card" draggable="true" data-tool="text" ondragstart="HUD.iniciarArrastreHerramienta(event, 'text')" onclick="HUD.agregarTextoEstado()">
                                    <span class="status-tool-icon">T</span>
                                    <span>Texto</span>
                                </div>
                                <div class="status-tool-card" draggable="true" data-tool="emoji" ondragstart="HUD.iniciarArrastreHerramienta(event, 'emoji')" onclick="HUD.agregarEmojiEstado()">
                                    <span class="status-tool-icon">☺</span>
                                    <span>Emoji</span>
                                </div>
                                <div class="status-tool-card" draggable="true" data-tool="image" ondragstart="HUD.iniciarArrastreHerramienta(event, 'image')">
                                    <span class="status-tool-icon">🖼</span>
                                    <span>Imagen</span>
                                </div>
                            </div>
                            <div class="form-group">
                                <label>texto rápido</label>
                                <div class="status-editor-inline-row">
                                    <input type="text" id="status-text-editor" placeholder="Escribe algo..."></input>
                                    <button class="hud-btn btn-crear" onclick="HUD.agregarTextoEstado()">añadir</button>
                                </div>
                            </div>
                            <div class="form-group">
                                <label>emoji rápido</label>
                                <div class="status-editor-inline-row">
                                    <input type="text" id="status-emoji-editor" placeholder="✨"></input>
                                    <button class="hud-btn btn-crear" onclick="HUD.agregarEmojiEstado()">añadir</button>
                                </div>
                            </div>
                            <div class="form-group">
                                <label>subir imagen</label>
                                <input type="file" id="status-image-file" accept="image/png,image/gif,image/jpeg,image/webp">
                            </div>
                            <div class="form-group">
                                <label>color de fondo</label>
                                <input type="color" id="status-bg-color" value="#111827">
                            </div>
                            <div class="form-group">
                                <label>tipografía</label>
                                <select id="status-font-family">
                                    <option value="Inter, sans-serif">Inter</option>
                                    <option value="Poppins, sans-serif">Poppins</option>
                                    <option value="Roboto, sans-serif">Roboto</option>
                                    <option value="Playfair Display, serif">Playfair Display</option>
                                    <option value="Oswald, sans-serif">Oswald</option>
                                    <option value="Arial, sans-serif">Arial</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>tamaño</label>
                                <input type="range" id="status-layer-size" min="24" max="120" value="56">
                            </div>
                            <div class="form-group">
                                <label>rotación</label>
                                <input type="range" id="status-layer-rotation" min="-180" max="180" value="0">
                            </div>
                            <div class="form-group">
                                <label>color del texto</label>
                                <input type="color" id="status-layer-color" value="#ffffff">
                            </div>
                            <div class="form-group status-editor-actions">
                                <button class="hud-btn btn-cancelar" onclick="HUD.eliminarCapaSeleccionada()">borrar selección</button>
                                <button class="hud-btn btn-crear" onclick="HUD.guardarEstadoDesdeModal()">publicar estado</button>
                            </div>
                            <p class="empty-text">Arrastra las tarjetas hacia la vista previa para colocarlas. Usa el icono de movimiento o rotación para ajustar cada elemento.</p>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.statusEditorState = {
            mode: 'static',
            backgroundColor: '#111827',
            layers: [],
            selectedLayerId: null,
            dragLayerId: null,
            dragOffsetX: 0,
            dragOffsetY: 0,
            interactionMode: null,
            rotationStartAngle: 0,
            rotationStartValue: 0,
            canvas: null,
            ctx: null,
            activeTool: null
        };
        this.inicializarEditorEstado();
        this.setStatusMode('static');
    },

    iniciarArrastreHerramienta(event, tool) {
        event.dataTransfer?.setData('text/plain', tool);
        this.statusEditorState.activeTool = tool;
    },

    inicializarEditorEstado() {
        const state = this.statusEditorState;
        const canvas = document.getElementById('status-editor-canvas');
        if (!canvas) return;
        state.canvas = canvas;
        state.ctx = canvas.getContext('2d');

        const actualizarControles = () => {
            const selected = this.obtenerCapaSeleccionada();
            if (!selected) return;
            const colorInput = document.getElementById('status-layer-color');
            const sizeInput = document.getElementById('status-layer-size');
            const rotationInput = document.getElementById('status-layer-rotation');
            const fontInput = document.getElementById('status-font-family');
            if (selected.type === 'text' || selected.type === 'emoji') {
                colorInput.value = selected.color || '#ffffff';
                sizeInput.value = selected.fontSize || 56;
                fontInput.value = selected.fontFamily || 'Inter, sans-serif';
                rotationInput.value = selected.rotation || 0;
                colorInput.disabled = false;
                sizeInput.disabled = false;
                fontInput.disabled = false;
                rotationInput.disabled = false;
            } else {
                colorInput.disabled = true;
                sizeInput.disabled = true;
                fontInput.disabled = true;
                rotationInput.disabled = false;
            }
        };

        document.getElementById('status-bg-color')?.addEventListener('input', (event) => {
            state.backgroundColor = event.target.value;
            this.renderStatusEditor();
        });

        document.getElementById('status-font-family')?.addEventListener('change', (event) => {
            const selected = this.obtenerCapaSeleccionada();
            if (selected && (selected.type === 'text' || selected.type === 'emoji')) {
                selected.fontFamily = event.target.value;
                this.renderStatusEditor();
            }
        });

        document.getElementById('status-layer-size')?.addEventListener('input', (event) => {
            const selected = this.obtenerCapaSeleccionada();
            if (selected && (selected.type === 'text' || selected.type === 'emoji')) {
                selected.fontSize = Number(event.target.value) || 56;
                this.renderStatusEditor();
            }
        });

        document.getElementById('status-layer-rotation')?.addEventListener('input', (event) => {
            const selected = this.obtenerCapaSeleccionada();
            if (selected) {
                selected.rotation = Number(event.target.value) || 0;
                this.renderStatusEditor();
            }
        });

        document.getElementById('status-layer-color')?.addEventListener('input', (event) => {
            const selected = this.obtenerCapaSeleccionada();
            if (selected && (selected.type === 'text' || selected.type === 'emoji')) {
                selected.color = event.target.value;
                this.renderStatusEditor();
            }
        });

        document.getElementById('status-image-file')?.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                this.agregarImagenEstado(reader.result);
                event.target.value = '';
            };
            reader.readAsDataURL(file);
        });

        canvas.addEventListener('dragover', (event) => {
            event.preventDefault();
        });

        canvas.addEventListener('drop', (event) => {
            event.preventDefault();
            const tool = event.dataTransfer?.getData('text/plain') || state.activeTool || 'text';
            const rect = canvas.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
            const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
            if (tool === 'text') {
                this.agregarTextoEstado('', x, y);
            } else if (tool === 'emoji') {
                this.agregarEmojiEstado('', x, y);
            } else if (tool === 'image') {
                const input = document.getElementById('status-image-file');
                if (input) input.click();
            }
        });

        canvas.addEventListener('pointerdown', (event) => {
            const rect = canvas.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
            const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
            const layer = [...state.layers].reverse().find((item) => this.puntoDentroDeCapa(item, x, y));
            if (!layer) {
                state.selectedLayerId = null;
                state.interactionMode = null;
                this.renderStatusEditor();
                return;
            }

            if (this.estaEnHandleRotacion(layer, x, y)) {
                state.selectedLayerId = layer.id;
                state.interactionMode = 'rotate';
                state.rotationStartAngle = Math.atan2(y - layer.y, x - layer.x);
                state.rotationStartValue = layer.rotation;
                this.renderStatusEditor();
                actualizarControles();
                return;
            }

            state.selectedLayerId = layer.id;
            state.dragLayerId = layer.id;
            state.interactionMode = 'move';
            state.dragOffsetX = x - layer.x;
            state.dragOffsetY = y - layer.y;
            this.renderStatusEditor();
            actualizarControles();
        });

        const finishInteraction = () => {
            state.dragLayerId = null;
            state.interactionMode = null;
        };

        canvas.addEventListener('pointermove', (event) => {
            if (state.interactionMode === 'move' && state.dragLayerId) {
                const rect = canvas.getBoundingClientRect();
                const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
                const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
                const layer = state.layers.find((item) => item.id === state.dragLayerId);
                if (!layer) return;
                layer.x = Math.max(40, Math.min(canvas.width - 40, x - state.dragOffsetX));
                layer.y = Math.max(40, Math.min(canvas.height - 40, y - state.dragOffsetY));
                this.renderStatusEditor();
                return;
            }

            if (state.interactionMode === 'rotate') {
                const rect = canvas.getBoundingClientRect();
                const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
                const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
                const layer = this.obtenerCapaSeleccionada();
                if (!layer) return;
                const angle = Math.atan2(y - layer.y, x - layer.x);
                layer.rotation = state.rotationStartValue + ((angle - state.rotationStartAngle) * 180 / Math.PI);
                this.renderStatusEditor();
            }
        });

        window.addEventListener('pointerup', finishInteraction);
        window.addEventListener('pointercancel', finishInteraction);
        actualizarControles();
    },

    obtenerCapaSeleccionada() {
        return this.statusEditorState.layers.find((layer) => layer.id === this.statusEditorState.selectedLayerId) || null;
    },

    estaEnHandleMover(layer, x, y) {
        const distance = Math.hypot(x - layer.x, y - layer.y);
        return distance <= 20;
    },

 estaEnHandleRotacion(layer, x, y) {
    const handleDistance = Math.max(layer.width || 140, layer.height || 80) / 2 + 40;
    const handleX = layer.x + Math.cos((layer.rotation - 90) * Math.PI / 180) * handleDistance;
    const handleY = layer.y + Math.sin((layer.rotation - 90) * Math.PI / 180) * handleDistance;
    // Retornamos el cálculo de hitbox del handle de rotación
    return Math.hypot(x - handleX, y - handleY) <= 18;
},

    puntoDentroDeCapa(layer, x, y) {
        const halfW = (layer.width || 140) / 2;
        const halfH = (layer.height || 70) / 2;
        const cos = Math.cos(layer.rotation * Math.PI / 180);
        const sin = Math.sin(layer.rotation * Math.PI / 180);
        const dx = x - layer.x;
        const dy = y - layer.y;
        const localX = dx * cos + dy * sin;
        const localY = -dx * sin + dy * cos;
        return Math.abs(localX) <= halfW + 12 && Math.abs(localY) <= halfH + 12;
    },

    agregarTextoEstado(text = '', x = null, y = null) {
        const input = document.getElementById('status-text-editor');
        const textValue = text || input?.value.trim();
        if (!textValue) {
            alert('Escribe un mensaje para añadirlo al estado.');
            return;
        }
        const state = this.statusEditorState;
        const layer = {
            id: `text-${Date.now()}`,
            type: 'text',
            text: textValue,
            x: x ?? (state.canvas?.width ? state.canvas.width / 2 : 210),
            y: y ?? (state.canvas?.height ? state.canvas.height / 2 : 360),
            width: 220,
            height: 80,
            fontFamily: 'Inter, sans-serif',
            fontSize: 56,
            color: '#ffffff',
            rotation: 0
        };
        state.layers.push(layer);
        state.selectedLayerId = layer.id;
        if (input) input.value = '';
        this.renderStatusEditor();
        this.actualizarControlesDeCapa();
    },

    agregarEmojiEstado(text = '', x = null, y = null) {
        const input = document.getElementById('status-emoji-editor');
        const textValue = text || input?.value.trim();
        if (!textValue) {
            alert('Añade un emoji o símbolo para el estado.');
            return;
        }
        const state = this.statusEditorState;
        const layer = {
            id: `emoji-${Date.now()}`,
            type: 'emoji',
            text: textValue,
            x: x ?? (state.canvas?.width ? state.canvas.width / 2 : 210),
            y: y ?? (state.canvas?.height ? state.canvas.height / 2 : 360),
            width: 120,
            height: 120,
            fontFamily: 'Inter, sans-serif',
            fontSize: 72,
            color: '#ffffff',
            rotation: 0
        };
        state.layers.push(layer);
        state.selectedLayerId = layer.id;
        if (input) input.value = '';
        this.renderStatusEditor();
        this.actualizarControlesDeCapa();
    },

    agregarImagenEstado(dataUrl, x = null, y = null) {
        const state = this.statusEditorState;
        const img = new Image();
        img.onload = () => {
            const layer = {
                id: `image-${Date.now()}`,
                type: 'image',
                src: dataUrl,
                image: img,
                x: x ?? (state.canvas?.width ? state.canvas.width / 2 : 210),
                y: y ?? (state.canvas?.height ? state.canvas.height / 2 : 360),
                width: Math.min(img.width, 220) / (img.width > img.height ? 1.2 : 1),
                height: Math.min(img.height, 220) / (img.width > img.height ? 1 : 1.2),
                rotation: 0
            };
            state.layers.push(layer);
            state.selectedLayerId = layer.id;
            this.renderStatusEditor();
            this.actualizarControlesDeCapa();
        };
        img.src = dataUrl;
    },

    actualizarControlesDeCapa() {
        const selected = this.obtenerCapaSeleccionada();
        const colorInput = document.getElementById('status-layer-color');
        const sizeInput = document.getElementById('status-layer-size');
        const rotationInput = document.getElementById('status-layer-rotation');
        const fontInput = document.getElementById('status-font-family');
        if (!selected) {
            colorInput.disabled = true;
            sizeInput.disabled = true;
            fontInput.disabled = true;
            rotationInput.disabled = true;
            return;
        }
        if (selected.type === 'text' || selected.type === 'emoji') {
            colorInput.value = selected.color || '#ffffff';
            sizeInput.value = selected.fontSize || 56;
            fontInput.value = selected.fontFamily || 'Inter, sans-serif';
            rotationInput.value = selected.rotation || 0;
            colorInput.disabled = false;
            sizeInput.disabled = false;
            fontInput.disabled = false;
            rotationInput.disabled = false;
        } else {
            colorInput.disabled = true;
            sizeInput.disabled = true;
            fontInput.disabled = true;
            rotationInput.value = selected.rotation || 0;
            rotationInput.disabled = false;
        }
    },

    renderStatusEditor() {
        const state = this.statusEditorState;
        const canvas = state.canvas;
        const ctx = state.ctx;
        if (!canvas || !ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, state.mode === 'creative' ? state.backgroundColor : '#ffffff');
        gradient.addColorStop(1, state.mode === 'creative' ? '#111827' : '#f3f4f6');
        ctx.fillStyle = state.mode === 'creative' ? gradient : state.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
        ctx.restore();

        state.layers.forEach((layer) => {
            ctx.save();
            ctx.translate(layer.x, layer.y);
            ctx.rotate(layer.rotation * Math.PI / 180);
            if (layer.type === 'text' || layer.type === 'emoji') {
                ctx.font = `${layer.fontWeight || '700'} ${layer.fontSize || 56}px ${layer.fontFamily || 'Inter, sans-serif'}`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = layer.color || '#ffffff';
                ctx.fillText(layer.text, 0, 0);
            } else if (layer.image) {
                ctx.drawImage(layer.image, -(layer.width || 120) / 2, -(layer.height || 120) / 2, layer.width || 120, layer.height || 120);
            }
            ctx.restore();

            if (state.selectedLayerId === layer.id) {
                ctx.save();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 3;
                ctx.setLineDash([8, 6]);
                ctx.strokeRect(layer.x - (layer.width || 140) / 2 - 10, layer.y - (layer.height || 80) / 2 - 10, (layer.width || 140) + 20, (layer.height || 80) + 20);
                ctx.beginPath();
                ctx.arc(layer.x, layer.y, 14, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.fill();
                ctx.fillStyle = '#111827';
                ctx.font = '16px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('✚', layer.x, layer.y);
                const handleDistance = Math.max(layer.width || 140, layer.height || 80) / 2 + 34;
                const handleX = layer.x + Math.cos((layer.rotation - 90) * Math.PI / 180) * handleDistance;
                const handleY = layer.y + Math.sin((layer.rotation - 90) * Math.PI / 180) * handleDistance;
                ctx.beginPath();
                ctx.arc(handleX, handleY, 16, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.fill();
                ctx.fillStyle = '#111827';
                ctx.font = '14px sans-serif';
                ctx.fillText('↻', handleX, handleY);
                ctx.restore();
            }
        });
    },

    eliminarCapaSeleccionada() {
        const selected = this.obtenerCapaSeleccionada();
        if (!selected) return;
        this.statusEditorState.layers = this.statusEditorState.layers.filter((layer) => layer.id !== selected.id);
        this.statusEditorState.selectedLayerId = null;
        this.renderStatusEditor();
        this.actualizarControlesDeCapa();
    },

    setStatusMode(mode) {
        const buttons = document.querySelectorAll('.status-mode-btn');
        buttons.forEach((btn) => btn.classList.toggle('active', btn.textContent.toLowerCase().includes(mode)));
        this.statusEditorState.mode = mode;
        this.renderStatusEditor();
    },

    guardarEstadoDesdeModal() {
        const state = this.statusEditorState;
        const type = state.mode === 'creative' ? 'creative' : 'static';
        const backgroundColor = document.getElementById('status-bg-color')?.value || '#111827';
        if (!state.layers.length) {
            alert('Añade texto, emoji o una imagen antes de publicar el estado.');
            return;
        }

        const renderAndSend = () => {
            const canvas = state.canvas;
            const imageData = canvas.toDataURL('image/png');
            fetchJson(`${SOCKET_URL}/api/statuses`, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({ media: imageData, text: '', emoji: '', backgroundColor, visibility: 'public', statusType: type })
            })
                .then((data) => {
                    if (!data.success) return alert(data.error || 'No se pudo publicar el estado.');
                    this.cerrarModal();
                    this.abrirPerfil(this.currentUser);
                })
                .catch(() => alert('No se pudo publicar el estado.'));
        };

        const pendingImages = state.layers.filter((layer) => layer.type === 'image' && layer.image && !layer.image.complete);
        if (pendingImages.length) {
            Promise.all(pendingImages.map((layer) => new Promise((resolve) => {
                layer.image.onload = resolve;
                layer.image.onerror = resolve;
            }))).then(renderAndSend);
            return;
        }

        renderAndSend();
    },

    abrirModalCorreo() {
        document.getElementById('modal-container').innerHTML = `
            <div class="modal-overlay">
                <div class="modal-box">
                    <h2>gestión de correo</h2>
                    <div class="form-group">
                        <label>correo electrónico</label>
                        <input type="email" id="input-correo" value="${escapeHtml(this.currentEmail)}" placeholder="tucorreo@dominio.com">
                    </div>
                    <div class="modal-buttons">
                        <button class="hud-btn btn-cancelar" onclick="HUD.cerrarModal()">cancelar</button>
                        <button class="hud-btn btn-crear" onclick="HUD.guardarCorreo()">actualizar correo</button>
                    </div>
                </div>
            </div>
        `;
    },

    guardarCorreo() {
        const nuevoCorreo = document.getElementById('input-correo').value.trim();
        if (!nuevoCorreo || !nuevoCorreo.includes('@')) return alert('Ingresa un correo electrónico válido.');

        fetchJson(`${SOCKET_URL}/api/actualizar-email`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ email: nuevoCorreo })
        })
            .then((data) => {
                if (data.success) {
                    this.currentEmail = data.email;
                    alert('Correo actualizado correctamente.');
                    this.cerrarModal();
                    this.renderMain();
                } else {
                    alert(data.error);
                }
            })
            .catch(() => alert('Error al actualizar el correo.'));
    },

    switchTab(tabName) {
        this.activeChat = null;
        if (this.currentTab === tabName) return;
        this.currentTab = tabName;
        this.renderMain();
    },

    limpiarSesion() {
        localStorage.removeItem('komorebi_token');
        localStorage.removeItem('komorebi_session');
        this.authToken = null;
        this.currentUser = null;
        this.currentProfile = null;
    },

    logout() {
        if (this.authToken) {
            fetchJson(`${SOCKET_URL}/api/logout`, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({ token: this.authToken })
            }).catch(() => {});
        }
        if (this.socket) this.socket.disconnect();
        this.limpiarSesion();
        this.renderAuth();
    },

    abrirModalAnadirAmigo() {
        document.getElementById('modal-container').innerHTML = `
            <div class="modal-overlay">
                <div class="modal-box">
                    <h2>añadir amigo</h2>
                    <div class="form-group">
                        <label>nombre de usuario exacto</label>
                        <input type="text" id="input-amigo" placeholder="Nombre..." onkeypress="if(event.key==='Enter') HUD.guardarAmigo()">
                    </div>
                    <div class="modal-buttons">
                        <button class="hud-btn btn-cancelar" onclick="HUD.cerrarModal()">cancelar</button>
                        <button class="hud-btn btn-crear" onclick="HUD.guardarAmigo()">añadir</button>
                    </div>
                </div>
            </div>
        `;
    },

    guardarAmigo() {
        const amigo = document.getElementById('input-amigo').value.trim();
        if (!amigo || amigo === this.currentUser) return alert('Nombre inválido.');

        fetchJson(`${SOCKET_URL}/api/amigos`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ amigo })
        })
            .then((data) => {
                if (data.success) {
                    this.amigosList = data.amigos;
                    this.cerrarModal();
                    this.cargarPerfilesAmigos();
                } else {
                    alert(data.error);
                }
            });
    },

    abrirModalCrearGrupo() {
        document.getElementById('modal-container').innerHTML = `
            <div class="modal-overlay">
                <div class="modal-box">
                    <h2>nuevo grupo</h2>
                    <div class="form-group">
                        <label>nombre del grupo</label>
                        <input type="text" id="input-nombre-grupo" placeholder="Ej. Equipo Alfa">
                    </div>
                    <div class="form-group">
                        <label>descripción</label>
                        <textarea id="input-desc-grupo" placeholder="¿De qué trata este grupo?"></textarea>
                    </div>
                    <div class="form-group">
                        <label>foto de perfil (ENLACE)</label>
                        <input type="url" id="input-foto-grupo" placeholder="https://...">
                    </div>
                    <div class="modal-buttons">
                        <button class="hud-btn btn-cancelar" onclick="HUD.cerrarModal()">cancelar</button>
                        <button class="hud-btn btn-crear" onclick="HUD.guardarNuevoGrupo()">crear</button>
                    </div>
                </div>
            </div>
        `;
    },

    cerrarModal() {
        document.getElementById('modal-container').innerHTML = '';
    },

    guardarNuevoGrupo() {
        const name = document.getElementById('input-nombre-grupo').value.trim();
        const desc = document.getElementById('input-desc-grupo').value.trim();
        const photo = document.getElementById('input-foto-grupo').value.trim();
        if (!name) return;

        fetchJson(`${SOCKET_URL}/api/grupos`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ name, desc, photo })
        })
            .then((data) => {
                if (data.success) {
                    this.gruposList = data.grupos;
                    this.cerrarModal();
                    this.renderMain();
                } else {
                    alert(data.error);
                }
            });
    },

    abrirChatPrivado(amigo) {
        this.activeChat = { type: 'privado', id: amigo };
        delete this.unreadByContact[amigo];
        this.renderMain();
    },

    handleMediaSelection(event) {
        const input = event.target;
        if (!input.files?.[0]) return;
        const preview = document.getElementById('msg-input');
        if (preview) preview.placeholder = 'Imagen lista para enviar';
    },

    enviarNotaVoz() {
        const input = document.getElementById('msg-input');
        if (input) input.value = 'Voice note';
        this.sendCurrentMessage();
    },

sendCurrentMessage() {
    const input = document.getElementById('msg-input');
    const fileInput = document.getElementById('msg-image');
    const text = input?.value.trim() || '';
    const mediaFile = fileInput?.files?.[0] || null;

    if (!text && !mediaFile) return;

    // 1. Limpiar el DOM inmediatamente para mejorar la percepción de velocidad
    if (input) input.value = '';
    if (fileInput) fileInput.value = '';

    // 2. Optimistic Update: Renderizar en la UI local al instante
    const feed = document.getElementById('feed');
    if (feed) {
        const optimisticMsg = {
            user: this.currentUser,
            text: text || (mediaFile ? 'Cargando imagen...' : ''),
            // Usamos un Object URL local, es instantáneo y no bloquea el hilo
            media: mediaFile ? URL.createObjectURL(mediaFile) : '',
            timestamp: Date.now()
        };
        this.appendChatMessage(feed, optimisticMsg);
    }

    // 3. Procesamiento y envío de red
    const sendPayload = (mediaValue = '') => {
        if (!this.activeChat) return;

        const msgPayload = {
            user: this.currentUser,
            text: text || (mediaValue ? '📷 Imagen' : ''),
            media: mediaValue, // Aquí viaja el Base64 hacia los demás
            timestamp: Date.now()
        };

        if (this.activeChat.type === 'privado') {
            const chatKey = [this.currentUser, this.activeChat.id].sort().join('_');
            this.socket.emit('enviar_mensaje_privado', { chatKey, message: msgPayload });
        } else {
            this.socket.emit('enviar_mensaje_grupo', { grupoId: this.activeChat.id, message: msgPayload });
        }
    };

    if (mediaFile) {
        // Ejecutamos la lectura asíncrona del archivo sin retrasar la UI
        const reader = new FileReader();
        reader.onload = () => sendPayload(reader.result);
        reader.onerror = () => alert('No se pudo procesar la imagen.');
        reader.readAsDataURL(mediaFile);
    } else {
        sendPayload('');
    }
},

abrirChatGrupo(grupoId) {
        this.activeChat = { type: 'grupo', id: grupoId };
        this.renderMain();
    },

    cerrarChat() {
        this.activeChat = null;
        this.renderMain();
    },

    handleKeyPress(event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.sendCurrentMessage();
    }
};

window.HUD = HUD;

document.addEventListener('DOMContentLoaded', () => {
    HUD.init();
});
