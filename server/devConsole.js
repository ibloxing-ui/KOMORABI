const readline = require('readline');

function iniciarConsolaDev(db) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on('line', async (linea) => {
        const [comando, param] = linea.trim().toLowerCase().split(' ');

        switch (comando) {
            case 'unban':
                if (param) {
                    await db.query('DELETE FROM sanciones_hwid WHERE hwid = ?', [param]);
                    console.log(`\x1b[32m[DEV] HWID '${param}' desbaneado.\x1b[0m`);
                } else {
                    console.log('\x1b[33m[DEV] Uso: unban <HWID>\x1b[0m');
                }
                break;

            case 'unbanall':
                await db.query('DELETE FROM sanciones_hwid');
                console.log('\x1b[32m[DEV] Todos los baneos eliminados.\x1b[0m');
                break;

            case 'listbans':
                const [rows] = await db.query('SELECT hwid, razon, expira_en FROM sanciones_hwid');
                console.table(rows);
                break;
        }
    });
}

module.exports = { iniciarConsolaDev };