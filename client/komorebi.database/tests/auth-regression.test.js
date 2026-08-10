const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '3111';
const { server } = require('../server');

test('unauthenticated session check returns 401 JSON without crashing', async () => {
    await new Promise((resolve) => server.listen(3111, resolve));

    try {
        const response = await fetch('http://127.0.0.1:3111/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const payload = await response.json();

        assert.equal(response.status, 401);
        assert.equal(payload.success, false);
        assert.match(payload.error, /No autorizado|Inicia sesión/);
    } finally {
        server.close();
    }
});
