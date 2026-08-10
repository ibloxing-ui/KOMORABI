/**
 * Demo independiente de chat con Supabase.
 * No forma parte del flujo principal de Komorebi (ver js/hud.js).
 * Configura tus claves en variables de entorno o reemplaza los placeholders.
 */
const SUPABASE_URL = window.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = window.SUPABASE_KEY || 'YOUR_SUPABASE_ANON_KEY';

if (SUPABASE_URL === 'YOUR_SUPABASE_URL' || typeof supabase === 'undefined') {
    console.warn('app.js: Supabase no configurado. Este módulo es opcional.');
} else {
    const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    const feed = document.getElementById('feed');
    const input = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');
    const username = 'Amigo_' + Math.floor(Math.random() * 900 + 100);

    db.channel('messages-channel')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
            if (payload.new.username !== username) {
                renderMessage(payload.new);
            }
        })
        .subscribe();

    async function send() {
        const text = input.value.trim();
        if (text === '') return;

        const tempMsg = { username, content: text };
        input.value = '';
        renderMessage(tempMsg);
        await db.from('messages').insert([tempMsg]);
    }

    async function loadMessages() {
        const { data } = await db.from('messages').select('*').order('created_at', { ascending: true });
        if (data) data.forEach((msg) => renderMessage(msg));
    }

    function renderMessage(msg) {
        const card = document.createElement('div');
        card.className = 'msg-card';

        const header = document.createElement('div');
        header.className = 'msg-header';
        header.textContent = msg.username;

        const body = document.createElement('div');
        body.textContent = msg.content;

        card.appendChild(header);
        card.appendChild(body);
        feed.appendChild(card);
        feed.scrollTop = feed.scrollHeight;
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') send(); });

    loadMessages();
}
