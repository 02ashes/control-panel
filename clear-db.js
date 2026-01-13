const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function clearDatabase() {
    try {
        console.log('Clearing all tables...');
        await pool.query('TRUNCATE TABLE user_registrations, invite_codes, sessions, messages, session_logs, snippet_logs, snippets_data CASCADE');
        console.log('✅ All tables cleared!');
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await pool.end();
    }
}

clearDatabase();
