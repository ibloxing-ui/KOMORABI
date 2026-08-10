// server/dbConnection.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',      // Tu usuario de base de datos
    password: '',      // Tu contraseña de base de datos
    database: 'komorebi',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;