const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Инициализация базы данных PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Проверка подключения
pool.connect((err, client, release) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to PostgreSQL database');
        release();
    }
});

// Создание таблиц
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                creator_nickname TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                revoked BOOLEAN DEFAULT false,
                expires_at TIMESTAMP,
                created_at TIMESTAMP NOT NULL,
                deleted_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_registrations (
                id SERIAL PRIMARY KEY,
                nickname TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT 'reader',
                invited_by TEXT,
                invite_code TEXT,
                registered_at TIMESTAMP NOT NULL
            )
        `);

        // Add password_hash column if it doesn't exist (for existing installations)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_registrations' AND column_name='password_hash') THEN
                    ALTER TABLE user_registrations ADD COLUMN password_hash TEXT NOT NULL DEFAULT '';
                END IF;
            END $$;
        `);

        // Add role column if it doesn't exist (for existing installations)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_registrations' AND column_name='role') THEN
                    ALTER TABLE user_registrations ADD COLUMN role TEXT NOT NULL DEFAULT 'reader';
                END IF;
            END $$;
        `);

        // Ensure 02ashes is always admin
        await pool.query(`
            UPDATE user_registrations SET role = 'admin' WHERE nickname = '02ashes'
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                from_user TEXT NOT NULL,
                message_type TEXT DEFAULT 'text',
                text TEXT,
                voice_file TEXT,
                voice_duration TEXT,
                timestamp TIMESTAMP NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS session_logs (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                creator_nickname TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                timestamp TIMESTAMP NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS snippet_logs (
                id SERIAL PRIMARY KEY,
                snippet_id TEXT,
                folder_id TEXT,
                user_nickname TEXT NOT NULL,
                action TEXT NOT NULL,
                item_type TEXT NOT NULL,
                item_name TEXT,
                old_content TEXT,
                new_content TEXT,
                details TEXT,
                timestamp TIMESTAMP NOT NULL
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS invite_codes (
                id SERIAL PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                creator_nickname TEXT NOT NULL,
                used BOOLEAN DEFAULT false,
                used_by TEXT,
                created_at TIMESTAMP NOT NULL,
                used_at TIMESTAMP
            )
        `);

        // Таблица для хранения сниппетов
        await pool.query(`
            CREATE TABLE IF NOT EXISTS snippets_data (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL,
                updated_at TIMESTAMP NOT NULL,
                updated_by TEXT NOT NULL
            )
        `);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_session ON session_logs(session_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_creator ON sessions(creator_nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_snippet_logs_user ON snippet_logs(user_nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_snippet_logs_timestamp ON snippet_logs(timestamp)`);

        // ===== Таблицы системы кейсов =====
        await pool.query(`
            CREATE TABLE IF NOT EXISTS case_prizes (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'reward',
                case_tier INT,
                icon TEXT DEFAULT '🎁',
                rarity TEXT NOT NULL DEFAULT 'common',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS case_tier_prizes (
                id SERIAL PRIMARY KEY,
                tier INT NOT NULL,
                prize_id INT NOT NULL REFERENCES case_prizes(id) ON DELETE CASCADE,
                weight INT NOT NULL DEFAULT 1
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS case_grants (
                id SERIAL PRIMARY KEY,
                worker_nickname TEXT NOT NULL,
                tier INT NOT NULL,
                granted_by TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'admin',
                granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
                opened BOOLEAN DEFAULT false,
                opened_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS case_openings (
                id SERIAL PRIMARY KEY,
                grant_id INT NOT NULL,
                worker_nickname TEXT NOT NULL,
                tier INT NOT NULL,
                prize_id INT,
                prize_name TEXT NOT NULL,
                prize_kind TEXT NOT NULL DEFAULT 'reward',
                prize_icon TEXT DEFAULT '🎁',
                prize_rarity TEXT NOT NULL DEFAULT 'common',
                opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
                delivered BOOLEAN DEFAULT false,
                delivered_by TEXT,
                delivered_at TIMESTAMP
            )
        `);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_case_grants_worker ON case_grants(worker_nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_case_openings_worker ON case_openings(worker_nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_case_tier_prizes_tier ON case_tier_prizes(tier)`);

        console.log('Database tables initialized');

        // Загружаем данные из БД при старте
        await loadDataFromDatabase();

        // Засеваем призы кейсов, если пул пуст
        await seedCasePrizes();
    } catch (err) {
        console.error('Error creating tables:', err);
    }
})();

// Загрузка данных из БД при старте сервера
async function loadDataFromDatabase() {
    try {
        // 1. Загружаем зарегистрированных пользователей с ролями
        const usersResult = await pool.query('SELECT nickname, role FROM user_registrations');

        // Очищаем users Map и загружаем заново из БД
        users.clear();
        usersResult.rows.forEach(row => {
            const role = (row.nickname === SUPER_ADMIN) ? 'admin' : (row.role || 'reader');
            users.set(row.nickname, { role });
        });
        console.log(`Loaded ${users.size} registered users from database`);

        // 2. Загружаем сниппеты
        const snippetsResult = await pool.query('SELECT data FROM snippets_data ORDER BY id DESC LIMIT 1');
        if (snippetsResult.rows.length > 0) {
            globalSnippets = snippetsResult.rows[0].data;
            console.log('Loaded snippets from database');
        } else {
            console.log('No snippets found in database, using empty state');
        }
    } catch (err) {
        console.error('Error loading data from database:', err);
    }
}

// Засев призов кейсов при первом запуске (если пул ещё пуст)
async function seedCasePrizes() {
    try {
        const existing = await pool.query('SELECT COUNT(*) AS c FROM case_prizes');
        if (parseInt(existing.rows[0].c) > 0) return;

        // kind: reward (выдаёт админ) | task (задание воркеру) | case (выпадает кейс)
        // rarity: common | rare | legendary (только для цвета в ленте)
        const prizeDefs = [
            { key: 'paste',   name: 'Паста от админа',                    kind: 'reward', icon: '📝', rarity: 'common',    caseTier: null },
            { key: 'ava',     name: 'Кастом ава в тайминг',               kind: 'reward', icon: '🖼️', rarity: 'legendary', caseTier: null },
            { key: 'algo',    name: 'Прохождение алгоритма',              kind: 'reward', icon: '🧭', rarity: 'rare',      caseTier: null },
            { key: 'preview', name: 'Кастом превью на бандл',             kind: 'reward', icon: '🎬', rarity: 'rare',      caseTier: null },
            { key: 'task',    name: 'Задание: написать 20 молчунам',      kind: 'task',   icon: '🎯', rarity: 'common',    caseTier: null },
            { key: 'case2',   name: 'Кейс Тир 2',                         kind: 'case',   icon: '📦', rarity: 'rare',      caseTier: 2 },
            { key: 'case3',   name: 'Кейс Тир 3',                         kind: 'case',   icon: '🧰', rarity: 'legendary', caseTier: 3 },
            { key: 'm1',      name: '$1',  kind: 'reward', icon: '💵', rarity: 'common',    caseTier: null },
            { key: 'm5',      name: '$5',  kind: 'reward', icon: '💵', rarity: 'common',    caseTier: null },
            { key: 'm10',     name: '$10', kind: 'reward', icon: '💵', rarity: 'rare',      caseTier: null },
            { key: 'm15',     name: '$15', kind: 'reward', icon: '💰', rarity: 'rare',      caseTier: null },
            { key: 'm30',     name: '$30', kind: 'reward', icon: '💎', rarity: 'legendary', caseTier: null }
        ];

        const idByKey = {};
        for (const p of prizeDefs) {
            const r = await pool.query(
                'INSERT INTO case_prizes (name, kind, case_tier, icon, rarity, is_active, created_at) VALUES ($1,$2,$3,$4,$5,true,NOW()) RETURNING id',
                [p.name, p.kind, p.caseTier, p.icon, p.rarity]
            );
            idByKey[p.key] = r.rows[0].id;
        }

        // Веса: часто 50, средне 18, редко 7, очень редко 3, супер редко 1
        const tierMap = [
            // Тир 1
            { tier: 1, key: 'paste', weight: 50 },
            { tier: 1, key: 'ava',   weight: 3 },
            { tier: 1, key: 'case2', weight: 7 },
            { tier: 1, key: 'case3', weight: 1 },
            { tier: 1, key: 'task',  weight: 3 },
            // Тир 2
            { tier: 2, key: 'paste',   weight: 50 },
            { tier: 2, key: 'case3',   weight: 1 },
            { tier: 2, key: 'algo',    weight: 50 },
            { tier: 2, key: 'preview', weight: 50 },
            { tier: 2, key: 'm5',      weight: 7 },
            // Тир 3 (редкость денег зависит от суммы)
            { tier: 3, key: 'm1',    weight: 50 },
            { tier: 3, key: 'm5',    weight: 30 },
            { tier: 3, key: 'm10',   weight: 15 },
            { tier: 3, key: 'm15',   weight: 6 },
            { tier: 3, key: 'm30',   weight: 2 },
            { tier: 3, key: 'algo',  weight: 50 },
            { tier: 3, key: 'paste', weight: 50 }
        ];
        for (const t of tierMap) {
            await pool.query(
                'INSERT INTO case_tier_prizes (tier, prize_id, weight) VALUES ($1,$2,$3)',
                [t.tier, idByKey[t.key], t.weight]
            );
        }
        console.log('Case prizes seeded');
    } catch (err) {
        console.error('Seed case prizes error:', err);
    }
}

// Периодическая синхронизация пользователей с БД (каждые 5 минут)
setInterval(async () => {
    try {
        const usersResult = await pool.query('SELECT nickname FROM user_registrations');

        // Удаляем пользователей, которых нет в БД
        const dbNicknames = new Set(usersResult.rows.map(row => row.nickname));
        for (const nickname of users.keys()) {
            if (!dbNicknames.has(nickname)) {
                users.delete(nickname);
                console.log(`Removed deleted user from memory: ${nickname}`);
            }
        }

        // Добавляем новых пользователей из БД (note: role will be fetched on next full sync)
        usersResult.rows.forEach(row => {
            if (!users.has(row.nickname)) {
                users.set(row.nickname, { role: 'reader' });
                console.log(`Added new user to memory: ${row.nickname}`);
            }
        });

        console.log(`User sync: ${users.size} users in memory`);
    } catch (err) {
        console.error('User sync error:', err);
    }
}, 5 * 60 * 1000); // Каждые 5 минут

// Main page shows Lovense clone (masked landing page) - MUST be before express.static
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lovense-home.html'));
});

// Admin panel (hidden behind "Community" link)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve static files
app.use(express.static(__dirname));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' })); // Увеличенный лимит для больших объемов снипетов

app.use('/voice', express.static(path.join(__dirname, 'voice_messages')));

app.get('/control.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'control.html'));
});

app.get('/wheel.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'wheel.html'));
});

app.get('/control', (req, res) => {
    res.sendFile(path.join(__dirname, 'control.html'));
});

// Lovense-like control link format: /t2/{sessionId}?share_type=103
app.get('/t2/:sessionId', (req, res) => {
    res.sendFile(path.join(__dirname, 'control.html'));
});

app.get('/wheel', (req, res) => {
    res.sendFile(path.join(__dirname, 'wheel.html'));
});

app.get('/cases', (req, res) => {
    res.sendFile(path.join(__dirname, 'cases.html'));
});

app.get('/cases.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'cases.html'));
});

app.get('/logs.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'logs.html'));
});

const sessions = new Map();
const expiryTimers = new Map();
const MASTER_INVITE_CODE = 'wearetop1';
const SUPER_ADMIN = '02ashes'; // Permanent admin, cannot be changed
const users = new Map();

const voiceMessages = [
    { id: 'dickrate', name: 'Dick Rate', file: 'dickrate.ogg', duration: '0:05' },
    { id: 'vibrations', name: 'Vibrations', file: 'vibrations.ogg', duration: '0:06' },
    { id: 'moans', name: 'Moans', file: 'moans.ogg', duration: '0:10' },
    { id: 'itworks', name: 'It Works', file: 'it works.ogg', duration: '0:03' },
    { id: 'pussylovense', name: 'Pussy Lovense', file: 'pussy lovense.ogg', duration: '0:06' },
    { id: 'wanttofuckyou', name: 'Want To Fuck You', file: 'want to fuck you.ogg', duration: '0:09' }
];
const invites = new Map();
const onlineUsers = new Set();
const wheelCodes = new Map();

// Text Snippets хранилище (общее для всех админов)
let globalSnippets = {
    folders: {},
    snippets: {},
    structure: []
};

// Helper to get or create session in memory (for real-time sync)
async function getOrCreateSessionInMemory(sessionId, callback) {
    if (sessions.has(sessionId)) {
        return callback(null, sessions.get(sessionId));
    }

    try {
        const sessionResult = await pool.query('SELECT * FROM sessions WHERE id = $1 AND deleted_at IS NULL', [sessionId]);
        const dbSession = sessionResult.rows[0];

        if (dbSession) {
            const msgsResult = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY id ASC', [sessionId]);
            const msgs = msgsResult.rows;

            const messages = (msgs || []).map(m => ({
                id: m.message_id,
                sessionId: m.session_id,
                from: m.from_user,
                type: m.message_type,
                text: m.text,
                voiceFile: m.voice_file,
                duration: m.voice_duration,
                timestamp: m.timestamp
            }));

            const session = {
                messages: messages,
                intensity: 0,
                isActive: dbSession.is_active,
                revoked: dbSession.revoked,
                expiresAt: dbSession.expires_at,
                wasCreated: true,
                creatorNickname: dbSession.creator_nickname
            };

            sessions.set(sessionId, session);
            callback(null, session);
        } else {
            const session = {
                messages: [],
                intensity: 0,
                isActive: false,
                revoked: false,
                expiresAt: null,
                wasCreated: false,
                creatorNickname: null
            };
            sessions.set(sessionId, session);
            callback(null, session);
        }
    } catch (err) {
        return callback(err);
    }
}

// Revoke session API
app.post('/api/revoke', requireRegistration, async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    getOrCreateSessionInMemory(sessionId, async (err, session) => {
        if (err) return res.status(500).json({ error: 'database_error' });

        session.revoked = true;
        session.isActive = false;
        sessions.set(sessionId, session);

        try {
            // Отзываем сессию
            const updateResult = await pool.query('UPDATE sessions SET revoked = true, is_active = false WHERE id = $1', [sessionId]);

            // Логируем только если сессия была найдена и обновлена
            if (updateResult.rowCount > 0) {
                await logAction(sessionId, req.user.nickname, 'revoke', 'Session revoked');
            } else {
                console.log(`Session ${sessionId} not found for revoke, skipping log`);
            }

            io.to(sessionId).emit('session-revoked');

            if (expiryTimers.has(sessionId)) {
                clearTimeout(expiryTimers.get(sessionId));
                expiryTimers.delete(sessionId);
            }

            return res.json({ ok: true });
        } catch (err) {
            console.error('Revoke error:', err);
            return res.status(500).json({ error: 'database_error' });
        }
    });
});

// Delete session API (удаляет историю)
app.post('/api/delete', requireRegistration, async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    // Check if user is admin
    const nickname = req.user.nickname;
    let isAdmin = false;
    try {
        const roleResult = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        isAdmin = (nickname === SUPER_ADMIN) || (roleResult.rows[0]?.role === 'admin');
    } catch (err) {
        console.error('Role check error:', err);
    }

    getOrCreateSessionInMemory(sessionId, async (err, session) => {
        if (err) return res.status(500).json({ error: 'database_error' });

        if (session.creatorNickname && session.creatorNickname !== nickname && !isAdmin) {
            return res.status(403).json({ error: 'permission_denied' });
        }

        try {
            // Помечаем сессию как удаленную
            const updateResult = await pool.query('UPDATE sessions SET deleted_at = $1 WHERE id = $2', [new Date(), sessionId]);

            // Логируем только если сессия была найдена и обновлена
            if (updateResult.rowCount > 0) {
                await logAction(sessionId, nickname, 'delete', 'Session and history deleted');
            } else {
                console.log(`Session ${sessionId} not found for deletion, skipping log`);
            }

            sessions.delete(sessionId);

            if (expiryTimers.has(sessionId)) {
                clearTimeout(expiryTimers.get(sessionId));
                expiryTimers.delete(sessionId);
            }

            io.to(sessionId).emit('session-revoked');

            return res.json({ ok: true });
        } catch (err) {
            console.error('Delete error:', err);
            return res.status(500).json({ error: 'database_error' });
        }
    });
});

// Create session API
app.post('/api/create', requireRegistration, async (req, res) => {
    const { sessionId, expiresAt } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const nickname = req.user.nickname;
    const now = new Date();

    try {
        const result = await pool.query('SELECT * FROM sessions WHERE id = $1 AND deleted_at IS NULL', [sessionId]);
        const existingSession = result.rows[0];

        if (existingSession) {
            getOrCreateSessionInMemory(sessionId, async (err, session) => {
                if (err) return res.status(500).json({ error: 'database_error' });

                session.revoked = false;
                session.isActive = true;
                session.wasCreated = true;
                session.expiresAt = expiresAt || null;
                session.creatorNickname = nickname;
                sessions.set(sessionId, session);

                setupExpiry(sessionId, expiresAt);
                await logAction(sessionId, nickname, 'create', expiresAt ? `Expires at: ${expiresAt}` : 'No expiration (infinite)');

                return res.json({ ok: true });
            });
        } else {
            await pool.query('INSERT INTO sessions (id, creator_nickname, is_active, revoked, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                [sessionId, nickname, true, false, expiresAt || null, now]);

            const session = {
                messages: [],
                intensity: 0,
                isActive: true,
                revoked: false,
                expiresAt: expiresAt || null,
                wasCreated: true,
                creatorNickname: nickname
            };
            sessions.set(sessionId, session);

            setupExpiry(sessionId, expiresAt);
            await logAction(sessionId, nickname, 'create', expiresAt ? `Expires at: ${expiresAt}` : 'No expiration (infinite)');

            return res.json({ ok: true });
        }
    } catch (err) {
        console.error('Create session error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

function setupExpiry(sessionId, expiresAt) {
    if (expiryTimers.has(sessionId)) {
        clearTimeout(expiryTimers.get(sessionId));
        expiryTimers.delete(sessionId);
    }

    if (expiresAt) {
        const delay = Math.max(0, new Date(expiresAt).getTime() - Date.now());
        const t = setTimeout(() => {
            getOrCreateSessionInMemory(sessionId, async (err, s) => {
                if (err) return;
                s.revoked = true;
                s.isActive = false;
                sessions.set(sessionId, s);
                try {
                    await pool.query('UPDATE sessions SET revoked = true, is_active = false WHERE id = $1', [sessionId]);
                    await logAction(sessionId, 'system', 'expire', 'Session expired automatically');
                    io.to(sessionId).emit('session-revoked');
                    expiryTimers.delete(sessionId);
                } catch (err) {
                    console.error('Expiry error:', err);
                }
            });
        }, delay);
        expiryTimers.set(sessionId, t);
    }
}

async function logAction(sessionId, nickname, action, details) {
    try {
        // Проверяем существование сессии перед логированием
        const sessionExists = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);

        if (sessionExists.rows.length > 0) {
            await pool.query('INSERT INTO session_logs (session_id, creator_nickname, action, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [sessionId, nickname, action, details || '', new Date()]);
        } else {
            console.log(`Skipping log for non-existent session ${sessionId}: ${action} by ${nickname}`);
        }
    } catch (err) {
        console.error('Log action error:', err);
        console.error('Session ID:', sessionId, 'Action:', action);
    }
}

// Get all sessions for current user
app.get('/api/sessions', requireRegistration, async (req, res) => {
    const nickname = req.user.nickname;
    try {
        const result = await pool.query(`
            SELECT s.*, 
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
            FROM sessions s 
            WHERE s.creator_nickname = $1 AND s.deleted_at IS NULL
            ORDER BY s.created_at DESC
        `, [nickname]);
        return res.json({ ok: true, sessions: result.rows || [] });
    } catch (err) {
        console.error('Get sessions error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Get session history (messages)
app.get('/api/sessions/:sessionId/messages', requireRegistration, async (req, res) => {
    const { sessionId } = req.params;

    try {
        const sessionResult = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
        const session = sessionResult.rows[0];

        if (!session) return res.status(404).json({ error: 'session_not_found' });

        // Check if user has access (creator, admin, or has log access)
        const nickname = req.user.nickname;
        const roleResult = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        const isAdmin = (nickname === SUPER_ADMIN) || (roleResult.rows[0]?.role === 'admin');

        if (!isAdmin && session.creator_nickname !== nickname) {
            return res.status(403).json({ error: 'permission_denied' });
        }

        const msgsResult = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY id ASC', [sessionId]);
        const msgs = msgsResult.rows;

        const messages = (msgs || []).map(m => ({
            id: m.message_id,
            sessionId: m.session_id,
            from: m.from_user,
            type: m.message_type,
            text: m.text,
            voiceFile: m.voice_file,
            duration: m.voice_duration,
            timestamp: m.timestamp
        }));

        return res.json({ ok: true, session, messages });
    } catch (err) {
        console.error('Get messages error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Logs API (только для определенных админов)
app.get('/api/logs', requireRegistration, requireLogAccess, async (req, res) => {
    const { limit = 100, offset = 0, sessionId } = req.query;

    try {
        let query = `
            SELECT sl.*, s.creator_nickname as session_creator
            FROM session_logs sl
            LEFT JOIN sessions s ON sl.session_id = s.id
        `;

        const params = [];
        let paramIndex = 1;

        if (sessionId) {
            query += ` WHERE sl.session_id = $${paramIndex}`;
            params.push(sessionId);
            paramIndex++;
        }

        query += ` ORDER BY sl.timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const logsResult = await pool.query(query, params);

        let countQuery = `SELECT COUNT(*) as total FROM session_logs`;
        if (sessionId) {
            countQuery += ` WHERE session_id = $1`;
        }

        const countResult = await pool.query(countQuery, sessionId ? [sessionId] : []);

        return res.json({
            ok: true,
            logs: logsResult.rows || [],
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (err) {
        console.error('Get logs error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Get all sessions with logs (для страницы логов)
app.get('/api/logs/sessions', requireRegistration, requireLogAccess, async (req, res) => {
    const limit = parseInt(req.query.limit) || 200;
    const offset = parseInt(req.query.offset) || 0;

    try {
        const query = `
            SELECT s.*, 
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count,
                   (SELECT COUNT(*) FROM session_logs sl WHERE sl.session_id = s.id) as log_count
            FROM sessions s 
            ORDER BY s.created_at DESC
            LIMIT $1 OFFSET $2
        `;

        const result = await pool.query(query, [limit, offset]);

        return res.json({ ok: true, sessions: result.rows || [], limit, offset });
    } catch (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Get all user registrations (для страницы логов)
app.get('/api/logs/registrations', requireRegistration, requireLogAccess, async (req, res) => {
    try {
        const query = `
            SELECT nickname, role, invited_by, invite_code, registered_at 
            FROM user_registrations 
            ORDER BY registered_at DESC
            LIMIT 200
        `;

        const result = await pool.query(query, []);
        return res.json({ ok: true, registrations: result.rows || [] });
    } catch (err) {
        console.error('Get registrations error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Get snippet logs (для страницы логов)
app.get('/api/logs/snippets', requireRegistration, requireLogAccess, async (req, res) => {
    const { limit = 200, offset = 0, userNickname, action, itemType } = req.query;

    try {
        let query = `
            SELECT * FROM snippet_logs
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (userNickname) {
            query += ` AND user_nickname = $${paramIndex}`;
            params.push(userNickname);
            paramIndex++;
        }

        if (action) {
            query += ` AND action = $${paramIndex}`;
            params.push(action);
            paramIndex++;
        }

        if (itemType) {
            query += ` AND item_type = $${paramIndex}`;
            params.push(itemType);
            paramIndex++;
        }

        query += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        // Подсчитываем общее количество
        let countQuery = `SELECT COUNT(*) as total FROM snippet_logs WHERE 1=1`;
        const countParams = [];
        let countParamIndex = 1;

        if (userNickname) {
            countQuery += ` AND user_nickname = $${countParamIndex}`;
            countParams.push(userNickname);
            countParamIndex++;
        }

        if (action) {
            countQuery += ` AND action = $${countParamIndex}`;
            countParams.push(action);
            countParamIndex++;
        }

        if (itemType) {
            countQuery += ` AND item_type = $${countParamIndex}`;
            countParams.push(itemType);
        }

        const countResult = await pool.query(countQuery, countParams);

        return res.json({
            ok: true,
            logs: result.rows || [],
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (err) {
        console.error('Get snippet logs error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Clean up all deleted sessions
app.post('/api/logs/cleanup-all', requireRegistration, requireLogAccess, async (req, res) => {
    try {
        const deleteResult = await pool.query('DELETE FROM sessions WHERE deleted_at IS NOT NULL');
        const deletedCount = deleteResult.rowCount;

        // Удаляем связанные сообщения
        await pool.query('DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)');

        // Логируем в консоль (не в БД, так как это системное действие не привязанное к конкретной сессии)
        console.log(`Cleanup performed by ${req.user.nickname}: Cleaned ${deletedCount} deleted sessions`);

        return res.json({ ok: true, deleted: deletedCount });
    } catch (err) {
        console.error('Cleanup error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Delete single session from logs
app.post('/api/logs/delete-session', requireRegistration, requireLogAccess, async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    try {
        // Проверяем, существует ли сессия
        const sessionCheck = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);

        // Если сессия существует - логируем её удаление
        if (sessionCheck.rows.length > 0) {
            await pool.query('INSERT INTO session_logs (session_id, creator_nickname, action, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [sessionId, req.user.nickname, 'delete_from_logs', `Deleting session ${sessionId} from logs`, new Date()]);
        } else {
            console.log(`Session ${sessionId} not found in database, skipping log creation`);
        }

        // Удаляем логи этой сессии (независимо от того, есть сессия или нет)
        const logsDeleted = await pool.query('DELETE FROM session_logs WHERE session_id = $1', [sessionId]);
        console.log(`Deleted ${logsDeleted.rowCount} log entries for session ${sessionId}`);

        // Удаляем связанные сообщения
        const messagesDeleted = await pool.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
        console.log(`Deleted ${messagesDeleted.rowCount} messages for session ${sessionId}`);

        // Удаляем саму сессию (если она есть)
        const sessionDeleted = await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
        console.log(`Deleted ${sessionDeleted.rowCount} session(s) with id ${sessionId}`);

        // Clean up memory and timers
        sessions.delete(sessionId);
        if (expiryTimers.has(sessionId)) {
            clearTimeout(expiryTimers.get(sessionId));
            expiryTimers.delete(sessionId);
        }

        return res.json({
            ok: true,
            deleted: {
                session: sessionDeleted.rowCount,
                messages: messagesDeleted.rowCount,
                logs: logsDeleted.rowCount
            }
        });
    } catch (err) {
        console.error('Delete session error:', err);
        console.error('Error details:', err.message);
        return res.status(500).json({ error: 'database_error', message: err.message });
    }
});

app.post('/api/register', async (req, res) => {
    const { nickname, password, code } = req.body || {};
    if (!nickname || !password || !code) return res.status(400).json({ error: 'nickname, password and code required' });

    // Validate password length
    if (password.length < 4) {
        return res.status(400).json({ error: 'password_too_short' });
    }

    try {
        // Проверяем в БД - есть ли уже такой никнейм
        const existingUser = await pool.query('SELECT nickname FROM user_registrations WHERE nickname = $1', [nickname]);
        if (existingUser.rows.length > 0) {
            return res.status(409).json({ error: 'nickname_taken' });
        }

        const now = new Date();
        let invitedBy = null;

        // Hash password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        if (code === MASTER_INVITE_CODE) {
            invitedBy = 'MASTER_CODE';
            // 02ashes (SUPER_ADMIN) gets admin role, others get reader
            const role = (nickname === SUPER_ADMIN) ? 'admin' : 'reader';

            // Сохраняем в БД с паролем и ролью
            await pool.query('INSERT INTO user_registrations (nickname, password_hash, role, invited_by, invite_code, registered_at) VALUES ($1, $2, $3, $4, $5, $6)',
                [nickname, passwordHash, role, invitedBy, code, now]);

            // Добавляем в память
            users.set(nickname, { role });

            console.log(`New user registered: ${nickname} (via master code, role: ${role})`);
            return res.json({ ok: true, role });
        }

        // Проверяем инвайт-код в БД
        const inviteResult = await pool.query(
            'SELECT * FROM invite_codes WHERE code = $1',
            [code]
        );

        if (inviteResult.rows.length === 0) {
            return res.status(400).json({ error: 'invalid_or_used_code' });
        }

        const invite = inviteResult.rows[0];

        if (invite.used) {
            return res.status(400).json({ error: 'invalid_or_used_code' });
        }

        invitedBy = invite.creator_nickname;

        // Помечаем инвайт как использованный в БД
        await pool.query(
            'UPDATE invite_codes SET used = true, used_by = $1, used_at = $2 WHERE code = $3',
            [nickname, now, code]
        );

        // Обновляем в памяти (кэш)
        if (invites.has(code)) {
            const inv = invites.get(code);
            inv.used = true;
            invites.set(code, inv);
        }

        // Новые пользователи всегда reader, кроме SUPER_ADMIN
        const role = (nickname === SUPER_ADMIN) ? 'admin' : 'reader';

        // Сохраняем в БД с паролем и ролью
        await pool.query('INSERT INTO user_registrations (nickname, password_hash, role, invited_by, invite_code, registered_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [nickname, passwordHash, role, invitedBy, code, now]);

        // Добавляем в память
        users.set(nickname, { role });

        console.log(`New user registered: ${nickname} (invited by ${invitedBy}, role: ${role})`);
        return res.json({ ok: true, role });
    } catch (err) {
        console.error('Registration error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
    const { nickname, password } = req.body || {};
    if (!nickname || !password) return res.status(400).json({ error: 'nickname and password required' });

    try {
        // Find user in database with role
        const userResult = await pool.query('SELECT nickname, password_hash, role FROM user_registrations WHERE nickname = $1', [nickname]);

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'invalid_credentials' });
        }

        const user = userResult.rows[0];

        // Check if user has a password set (for legacy users without password)
        if (!user.password_hash || user.password_hash === '') {
            return res.status(401).json({ error: 'password_not_set', message: 'Please contact admin to reset your password' });
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatch) {
            return res.status(401).json({ error: 'invalid_credentials' });
        }

        // Get role (ensure 02ashes is always admin)
        const role = (nickname === SUPER_ADMIN) ? 'admin' : (user.role || 'reader');

        // Add user to memory
        users.set(nickname, { role });

        console.log(`User logged in: ${nickname} (role: ${role})`);
        return res.json({ ok: true, nickname, role });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Get current user role
app.get('/api/user/role', requireRegistration, async (req, res) => {
    const nickname = req.user.nickname;
    try {
        const result = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'user_not_found' });
        }
        // Ensure 02ashes is always admin
        const role = (nickname === SUPER_ADMIN) ? 'admin' : (result.rows[0].role || 'reader');
        return res.json({ nickname, role });
    } catch (err) {
        console.error('Get role error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Change user role (admin only)
app.post('/api/user/role', requireRegistration, async (req, res) => {
    const adminNickname = req.user.nickname;
    const { targetNickname, newRole } = req.body || {};

    if (!targetNickname || !newRole) {
        return res.status(400).json({ error: 'targetNickname and newRole required' });
    }

    // Validate role
    const validRoles = ['admin', 'user', 'reader'];
    if (!validRoles.includes(newRole)) {
        return res.status(400).json({ error: 'invalid_role', validRoles });
    }

    try {
        // Check if requester is admin
        const adminResult = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [adminNickname]);
        const isAdmin = (adminNickname === SUPER_ADMIN) || (adminResult.rows[0]?.role === 'admin');

        if (!isAdmin) {
            return res.status(403).json({ error: 'admin_required' });
        }

        // Cannot change SUPER_ADMIN role
        if (targetNickname === SUPER_ADMIN) {
            return res.status(403).json({ error: 'cannot_change_super_admin' });
        }

        // Update role in database
        const updateResult = await pool.query(
            'UPDATE user_registrations SET role = $1 WHERE nickname = $2 RETURNING nickname, role',
            [newRole, targetNickname]
        );

        if (updateResult.rows.length === 0) {
            return res.status(404).json({ error: 'user_not_found' });
        }

        // Update in memory cache
        if (users.has(targetNickname)) {
            users.set(targetNickname, { role: newRole });
        }

        console.log(`Role changed: ${targetNickname} -> ${newRole} (by ${adminNickname})`);
        return res.json({ ok: true, nickname: targetNickname, role: newRole });
    } catch (err) {
        console.error('Change role error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Get all users with roles (admin only)
app.get('/api/users', requireRegistration, async (req, res) => {
    const nickname = req.user.nickname;

    try {
        // Check if requester is admin
        const adminResult = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        const isAdmin = (nickname === SUPER_ADMIN) || (adminResult.rows[0]?.role === 'admin');

        if (!isAdmin) {
            return res.status(403).json({ error: 'admin_required' });
        }

        const result = await pool.query('SELECT nickname, role, registered_at FROM user_registrations ORDER BY registered_at DESC');
        return res.json({ users: result.rows });
    } catch (err) {
        console.error('Get users error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

app.post('/api/invite/generate', requireRegistration, async (req, res) => {
    const nickname = req.user.nickname;

    try {
        // Check if user is admin (only admins can generate invites)
        const roleResult = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        const isAdmin = (nickname === SUPER_ADMIN) || (roleResult.rows[0]?.role === 'admin');

        if (!isAdmin) {
            return res.status(403).json({ error: 'admin_required' });
        }

        // Генерируем уникальный код
        let code;
        let codeExists = true;
        let attempts = 0;

        while (codeExists && attempts < 10) {
            code = Math.random().toString(36).slice(2, 8);
            const existing = await pool.query('SELECT code FROM invite_codes WHERE code = $1', [code]);
            codeExists = existing.rows.length > 0;
            attempts++;
        }

        if (codeExists) {
            return res.status(500).json({ error: 'failed_to_generate_unique_code' });
        }

        // Сохраняем в БД
        await pool.query(
            'INSERT INTO invite_codes (code, creator_nickname, used, created_at) VALUES ($1, $2, $3, $4)',
            [code, nickname, false, new Date()]
        );

        // Также сохраняем в память для быстрого доступа (кэш)
        invites.set(code, { creator: nickname, used: false });

        console.log(`Invite code ${code} created by ${nickname}`);
        return res.json({ ok: true, code });
    } catch (err) {
        console.error('Generate invite error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// API для удаления пользователя (только для админов)
app.post('/api/users/delete', requireRegistration, requireLogAccess, async (req, res) => {
    const { nickname } = req.body || {};
    if (!nickname) return res.status(400).json({ error: 'nickname required' });

    try {
        // Удаляем из БД
        const result = await pool.query('DELETE FROM user_registrations WHERE nickname = $1', [nickname]);

        if (result.rowCount > 0) {
            // Удаляем из памяти
            users.delete(nickname);
            console.log(`User ${nickname} deleted by ${req.user.nickname}`);
            return res.json({ ok: true, message: `User ${nickname} deleted` });
        } else {
            return res.status(404).json({ error: 'user_not_found' });
        }
    } catch (err) {
        console.error('Delete user error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

async function requireRegistration(req, res, next) {
    const nickname = req.headers['x-nickname'] || req.body?.nickname;
    if (!nickname) {
        return res.status(401).json({ error: 'registration_required' });
    }

    // Проверяем в памяти
    if (!users.has(nickname)) {
        // Если нет в памяти - проверяем в БД (может быть новый пользователь)
        try {
            const result = await pool.query('SELECT nickname, role FROM user_registrations WHERE nickname = $1', [nickname]);
            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'registration_required' });
            }
            // Добавляем в память с ролью
            const role = (nickname === SUPER_ADMIN) ? 'admin' : (result.rows[0].role || 'reader');
            users.set(nickname, { role });
        } catch (err) {
            console.error('Registration check error:', err);
            return res.status(500).json({ error: 'database_error' });
        }
    }

    req.user = { nickname };
    next();
}

async function requireLogAccess(req, res, next) {
    try {
        // Check if user is admin (only admins can view logs)
        const nickname = req.user.nickname;
        const result = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        const isAdmin = (nickname === SUPER_ADMIN) || (result.rows[0]?.role === 'admin');

        if (!isAdmin) {
            return res.status(403).json({ error: 'admin_required' });
        }
        next();
    } catch (err) {
        console.error('requireLogAccess error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
}

app.get('/api/auth/check', requireRegistration, async (req, res) => {
    const nickname = req.user.nickname;
    try {
        const result = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        const role = (nickname === SUPER_ADMIN) ? 'admin' : (result.rows[0]?.role || 'reader');
        return res.json({ ok: true, nickname, role });
    } catch (err) {
        return res.json({ ok: true, nickname, role: 'reader' });
    }
});

app.get('/api/voice/list', requireRegistration, (req, res) => {
    return res.json({ ok: true, voices: voiceMessages });
});

// Snippets API
app.get('/api/snippets/list', requireRegistration, (req, res) => {
    return res.json({ ok: true, snippets: globalSnippets });
});

// Функция логирования действий со сниппетами
async function logSnippetAction(userNickname, action, itemType, itemId, itemName, details = null, oldContent = null, newContent = null) {
    try {
        await pool.query(
            'INSERT INTO snippet_logs (snippet_id, folder_id, user_nickname, action, item_type, item_name, old_content, new_content, details, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [
                itemType === 'snippet' ? itemId : null,
                itemType === 'folder' ? itemId : null,
                userNickname,
                action,
                itemType,
                itemName,
                oldContent,
                newContent,
                details,
                new Date()
            ]
        );
    } catch (err) {
        console.error('Snippet log error:', err);
    }
}

app.post('/api/snippets/save', requireRegistration, async (req, res) => {
    const { snippets, action, itemType, itemId, itemName, oldContent, newContent } = req.body || {};
    if (!snippets) return res.status(400).json({ error: 'snippets required' });

    // Check role - only admin and user can edit snippets, readers cannot
    const nickname = req.user.nickname;
    try {
        const roleResult = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        const role = (nickname === SUPER_ADMIN) ? 'admin' : (roleResult.rows[0]?.role || 'reader');

        if (role === 'reader') {
            return res.status(403).json({ error: 'readers_cannot_edit' });
        }
    } catch (err) {
        console.error('Role check error:', err);
        return res.status(500).json({ error: 'database_error' });
    }

    try {
        const oldSnippets = JSON.parse(JSON.stringify(globalSnippets));
        globalSnippets = snippets;

        // Сохраняем в БД
        await pool.query(
            'INSERT INTO snippets_data (data, updated_at, updated_by) VALUES ($1, $2, $3)',
            [JSON.stringify(snippets), new Date(), req.user.nickname]
        );

        // Логируем изменения
        if (action) {
            await logSnippetAction(
                req.user.nickname,
                action,
                itemType,
                itemId,
                itemName,
                null,
                oldContent || null,
                newContent || null
            );
        } else {
            // Автоматическое определение изменений для обратной совместимости
            await detectAndLogChanges(oldSnippets, snippets, req.user.nickname);
        }

        // Синхронизируем с другими пользователями
        io.emit('snippets-updated', { snippets: globalSnippets });

        console.log(`Snippets saved by ${req.user.nickname}`);
        return res.json({ ok: true, snippets: globalSnippets });
    } catch (err) {
        console.error('Save snippets error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Автоматическое определение изменений сниппетов
async function detectAndLogChanges(oldSnippets, newSnippets, userNickname) {
    try {
        // Проверяем новые сниппеты
        for (const [id, snippet] of Object.entries(newSnippets.snippets || {})) {
            if (!oldSnippets.snippets || !oldSnippets.snippets[id]) {
                await logSnippetAction(userNickname, 'create', 'snippet', id, snippet.name, 'Сниппет создан');
            } else if (oldSnippets.snippets[id].content !== snippet.content) {
                await logSnippetAction(
                    userNickname,
                    'edit',
                    'snippet',
                    id,
                    snippet.name,
                    'Контент изменен',
                    oldSnippets.snippets[id].content,
                    snippet.content
                );
            }
        }

        // Проверяем удаленные сниппеты
        for (const [id, snippet] of Object.entries(oldSnippets.snippets || {})) {
            if (!newSnippets.snippets || !newSnippets.snippets[id]) {
                await logSnippetAction(userNickname, 'delete', 'snippet', id, snippet.name, 'Сниппет удален');
            }
        }

        // Проверяем новые папки
        for (const [id, folder] of Object.entries(newSnippets.folders || {})) {
            if (!oldSnippets.folders || !oldSnippets.folders[id]) {
                await logSnippetAction(userNickname, 'create', 'folder', id, folder.name, 'Папка создана');
            }
        }

        // Проверяем удаленные папки
        for (const [id, folder] of Object.entries(oldSnippets.folders || {})) {
            if (!newSnippets.folders || !newSnippets.folders[id]) {
                await logSnippetAction(userNickname, 'delete', 'folder', id, folder.name, 'Папка удалена');
            }
        }
    } catch (err) {
        console.error('Detect changes error:', err);
    }
}

app.post('/api/wheel/create', requireRegistration, (req, res) => {
    const { code, prize } = req.body || {};
    if (!code || !prize) return res.status(400).json({ error: 'code and prize required' });

    const validPrizes = ['Lovense', 'Threesome', 'Fucklist', 'Sexting', 'Custom', 'Videocall', 'Anal', 'Pussy', 'Nudes', 'Squirt'];
    if (!validPrizes.includes(prize)) return res.status(400).json({ error: 'invalid prize' });

    const existingCode = wheelCodes.get(code);
    if (existingCode && !existingCode.used) {
        return res.status(409).json({ error: 'code_already_exists' });
    }

    wheelCodes.set(code, {
        prize: prize,
        used: false,
        createdAt: Date.now()
    });

    return res.json({ ok: true, code, prize });
});

app.post('/api/wheel/check', (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });

    const wheelCode = wheelCodes.get(code);
    if (!wheelCode) return res.status(404).json({ error: 'invalid_code' });

    if (wheelCode.used) return res.status(410).json({ error: 'code_already_used' });

    return res.json({ ok: true, targetPrize: wheelCode.prize });
});

app.post('/api/wheel/result', (req, res) => {
    const { code, prize } = req.body || {};
    if (!code || !prize) return res.status(400).json({ error: 'code and prize required' });

    const wheelCode = wheelCodes.get(code);
    if (!wheelCode) return res.status(404).json({ error: 'invalid_code' });

    wheelCode.used = true;
    wheelCodes.set(code, wheelCode);

    return res.json({ ok: true });
});

// ==================== СИСТЕМА КЕЙСОВ ====================

// Взвешенный рандом по весам призов (розыгрыш на сервере)
function weightedPick(items) {
    const valid = items.filter(it => Number(it.weight) > 0);
    if (valid.length === 0) return null;
    const total = valid.reduce((s, it) => s + Number(it.weight), 0);
    let r = Math.random() * total;
    for (const it of valid) {
        r -= Number(it.weight);
        if (r < 0) return it;
    }
    return valid[valid.length - 1];
}

// Инвентарь воркера: непрокрученные кейсы + выигранные призы
app.get('/api/cases/inventory', requireRegistration, async (req, res) => {
    const nickname = req.user.nickname;
    try {
        const cases = await pool.query(
            'SELECT id, tier, source, granted_at FROM case_grants WHERE worker_nickname = $1 AND opened = false ORDER BY tier ASC, id ASC',
            [nickname]
        );
        const prizes = await pool.query(
            `SELECT id, tier, prize_name, prize_kind, prize_icon, prize_rarity, opened_at, delivered, delivered_at
             FROM case_openings
             WHERE worker_nickname = $1 AND prize_kind <> 'case'
             ORDER BY opened_at DESC LIMIT 100`,
            [nickname]
        );
        return res.json({ ok: true, cases: cases.rows, prizes: prizes.rows });
    } catch (err) {
        console.error('Cases inventory error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Список призов тира (для показа содержимого кейса)
app.get('/api/cases/pool/:tier', requireRegistration, async (req, res) => {
    const tier = parseInt(req.params.tier);
    if (![1, 2, 3].includes(tier)) return res.status(400).json({ error: 'invalid_tier' });
    try {
        const r = await pool.query(
            `SELECT p.id, p.name, p.kind, p.icon, p.rarity, ctp.weight
             FROM case_tier_prizes ctp JOIN case_prizes p ON p.id = ctp.prize_id
             WHERE ctp.tier = $1 AND p.is_active = true`,
            [tier]
        );
        return res.json({ ok: true, tier, prizes: r.rows });
    } catch (err) {
        console.error('Cases pool error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Открыть кейс (розыгрыш делает сервер)
app.post('/api/cases/open', requireRegistration, async (req, res) => {
    const nickname = req.user.nickname;
    const { grantId } = req.body || {};
    if (!grantId) return res.status(400).json({ error: 'grantId required' });
    try {
        // Атомарно забираем кейс — защита от двойного открытия / накрутки
        const claim = await pool.query(
            `UPDATE case_grants SET opened = true, opened_at = NOW()
             WHERE id = $1 AND worker_nickname = $2 AND opened = false
             RETURNING id, tier`,
            [grantId, nickname]
        );
        if (claim.rowCount === 0) {
            return res.status(409).json({ error: 'case_unavailable' });
        }
        const tier = claim.rows[0].tier;

        const poolRes = await pool.query(
            `SELECT p.id, p.name, p.kind, p.case_tier, p.icon, p.rarity, ctp.weight
             FROM case_tier_prizes ctp JOIN case_prizes p ON p.id = ctp.prize_id
             WHERE ctp.tier = $1 AND p.is_active = true`,
            [tier]
        );
        if (poolRes.rows.length === 0) {
            // Пул пуст — возвращаем кейс воркеру
            await pool.query('UPDATE case_grants SET opened = false, opened_at = NULL WHERE id = $1', [grantId]);
            return res.status(500).json({ error: 'empty_pool' });
        }

        const prize = weightedPick(poolRes.rows);
        const isCase = prize.kind === 'case';

        await pool.query(
            `INSERT INTO case_openings
             (grant_id, worker_nickname, tier, prize_id, prize_name, prize_kind, prize_icon, prize_rarity, opened_at, delivered, delivered_by, delivered_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11)`,
            [grantId, nickname, tier, prize.id, prize.name, prize.kind, prize.icon, prize.rarity,
             isCase, isCase ? 'system' : null, isCase ? new Date() : null]
        );

        // Кейс-приз сразу падает в инвентарь, остальное идёт в очередь к админу
        let newCase = null;
        if (isCase && [1, 2, 3].includes(prize.case_tier)) {
            const ng = await pool.query(
                `INSERT INTO case_grants (worker_nickname, tier, granted_by, source, granted_at)
                 VALUES ($1,$2,'system','case',NOW()) RETURNING id, tier`,
                [nickname, prize.case_tier]
            );
            newCase = ng.rows[0];
        }

        return res.json({
            ok: true,
            prize: {
                id: prize.id, name: prize.name, kind: prize.kind,
                icon: prize.icon, rarity: prize.rarity, caseTier: prize.case_tier
            },
            pool: poolRes.rows.map(p => ({ id: p.id, name: p.name, kind: p.kind, icon: p.icon, rarity: p.rarity })),
            newCase
        });
    } catch (err) {
        console.error('Case open error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Выдать кейсы воркеру (админ)
app.post('/api/cases/grant', requireRegistration, requireLogAccess, async (req, res) => {
    const { workerNickname, tier, count } = req.body || {};
    const t = parseInt(tier);
    const n = Math.min(50, Math.max(1, parseInt(count) || 1));
    if (!workerNickname || ![1, 2, 3].includes(t)) {
        return res.status(400).json({ error: 'workerNickname and valid tier required' });
    }
    try {
        const userCheck = await pool.query('SELECT nickname FROM user_registrations WHERE nickname = $1', [workerNickname]);
        if (userCheck.rows.length === 0) return res.status(404).json({ error: 'worker_not_found' });

        for (let i = 0; i < n; i++) {
            await pool.query(
                `INSERT INTO case_grants (worker_nickname, tier, granted_by, source, granted_at)
                 VALUES ($1,$2,$3,'admin',NOW())`,
                [workerNickname, t, req.user.nickname]
            );
        }
        console.log(`Cases granted: ${n}x tier ${t} to ${workerNickname} by ${req.user.nickname}`);
        return res.json({ ok: true, granted: n });
    } catch (err) {
        console.error('Case grant error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Очередь призов на выдачу (админ)
app.get('/api/cases/pending', requireRegistration, requireLogAccess, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT id, worker_nickname, tier, prize_name, prize_kind, prize_icon, prize_rarity, opened_at
             FROM case_openings
             WHERE delivered = false AND prize_kind <> 'case'
             ORDER BY opened_at ASC`
        );
        return res.json({ ok: true, pending: r.rows });
    } catch (err) {
        console.error('Cases pending error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Отметить приз выданным / задание зачтённым (админ)
app.post('/api/cases/deliver', requireRegistration, requireLogAccess, async (req, res) => {
    const { openingId } = req.body || {};
    if (!openingId) return res.status(400).json({ error: 'openingId required' });
    try {
        const r = await pool.query(
            `UPDATE case_openings SET delivered = true, delivered_by = $1, delivered_at = NOW()
             WHERE id = $2 AND delivered = false RETURNING id`,
            [req.user.nickname, openingId]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_done' });
        return res.json({ ok: true });
    } catch (err) {
        console.error('Case deliver error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Конфиг призов и тиров для редактора (админ)
app.get('/api/cases/admin/config', requireRegistration, requireLogAccess, async (req, res) => {
    try {
        const prizes = await pool.query('SELECT id, name, kind, case_tier, icon, rarity, is_active FROM case_prizes ORDER BY id ASC');
        const tp = await pool.query('SELECT tier, prize_id, weight FROM case_tier_prizes ORDER BY tier ASC, weight DESC');
        const tiers = { 1: [], 2: [], 3: [] };
        tp.rows.forEach(row => { if (tiers[row.tier]) tiers[row.tier].push({ prizeId: row.prize_id, weight: row.weight }); });
        return res.json({ ok: true, prizes: prizes.rows, tiers });
    } catch (err) {
        console.error('Cases config error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Создать / изменить приз (админ)
app.post('/api/cases/admin/prize', requireRegistration, requireLogAccess, async (req, res) => {
    let { id, name, kind, caseTier, icon, rarity, isActive } = req.body || {};
    name = (name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!['reward', 'task', 'case'].includes(kind)) kind = 'reward';
    if (!['common', 'rare', 'legendary'].includes(rarity)) rarity = 'common';
    icon = (icon || '🎁').toString().slice(0, 8);
    const ct = (kind === 'case' && [1, 2, 3].includes(parseInt(caseTier))) ? parseInt(caseTier) : null;
    const active = isActive !== false;
    try {
        if (id) {
            const r = await pool.query(
                `UPDATE case_prizes SET name=$1, kind=$2, case_tier=$3, icon=$4, rarity=$5, is_active=$6 WHERE id=$7
                 RETURNING id, name, kind, case_tier, icon, rarity, is_active`,
                [name, kind, ct, icon, rarity, active, id]
            );
            if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
            return res.json({ ok: true, prize: r.rows[0] });
        } else {
            const r = await pool.query(
                `INSERT INTO case_prizes (name, kind, case_tier, icon, rarity, is_active, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,NOW())
                 RETURNING id, name, kind, case_tier, icon, rarity, is_active`,
                [name, kind, ct, icon, rarity, active]
            );
            return res.json({ ok: true, prize: r.rows[0] });
        }
    } catch (err) {
        console.error('Case prize save error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Удалить приз (админ)
app.post('/api/cases/admin/prize/delete', requireRegistration, requireLogAccess, async (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
        await pool.query('DELETE FROM case_tier_prizes WHERE prize_id = $1', [id]);
        await pool.query('DELETE FROM case_prizes WHERE id = $1', [id]);
        return res.json({ ok: true });
    } catch (err) {
        console.error('Case prize delete error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Задать вес приза в тире (вес 0 = убрать из тира) (админ)
app.post('/api/cases/admin/tier-prize', requireRegistration, requireLogAccess, async (req, res) => {
    const t = parseInt(req.body?.tier);
    const pid = parseInt(req.body?.prizeId);
    const w = parseInt(req.body?.weight);
    if (![1, 2, 3].includes(t) || !pid || isNaN(w)) return res.status(400).json({ error: 'invalid_input' });
    try {
        if (w <= 0) {
            await pool.query('DELETE FROM case_tier_prizes WHERE tier=$1 AND prize_id=$2', [t, pid]);
            return res.json({ ok: true, removed: true });
        }
        const upd = await pool.query('UPDATE case_tier_prizes SET weight=$1 WHERE tier=$2 AND prize_id=$3 RETURNING id', [w, t, pid]);
        if (upd.rowCount === 0) {
            await pool.query('INSERT INTO case_tier_prizes (tier, prize_id, weight) VALUES ($1,$2,$3)', [t, pid, w]);
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error('Tier-prize save error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Лог последних открытий (админ)
app.get('/api/cases/admin/log', requireRegistration, requireLogAccess, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT id, worker_nickname, tier, prize_name, prize_kind, prize_icon, prize_rarity, opened_at, delivered
             FROM case_openings ORDER BY opened_at DESC LIMIT 100`
        );
        return res.json({ ok: true, log: r.rows });
    } catch (err) {
        console.error('Cases log error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Rate limiting для Socket.io событий
const socketRateLimits = new Map();
const RATE_LIMIT_WINDOW = 1000;
const MAX_MESSAGES_PER_WINDOW = 10;
const MAX_INTENSITY_UPDATES_PER_WINDOW = 20;

function checkRateLimit(socketId, eventType, maxEvents) {
    const key = `${socketId}:${eventType}`;
    const now = Date.now();

    if (!socketRateLimits.has(key)) {
        socketRateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        return true;
    }

    const limit = socketRateLimits.get(key);

    if (now > limit.resetAt) {
        limit.count = 1;
        limit.resetAt = now + RATE_LIMIT_WINDOW;
        return true;
    }

    if (limit.count >= maxEvents) {
        return false;
    }

    limit.count++;
    return true;
}

// Очистка rate limits каждые 5 минут
setInterval(() => {
    const now = Date.now();
    for (const [key, limit] of socketRateLimits.entries()) {
        if (now > limit.resetAt + 60000) {
            socketRateLimits.delete(key);
        }
    }
}, 300000);

// Автоматическая очистка неактивных сессий из памяти каждые 10 минут
setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    for (const [sessionId, session] of sessions.entries()) {
        // Удаляем из памяти неактивные сессии старше 1 часа
        if (!session.isActive || session.revoked) {
            const lastMessage = session.messages[session.messages.length - 1];
            const lastActivity = lastMessage ? new Date(lastMessage.timestamp).getTime() : 0;

            if (lastActivity < oneHourAgo) {
                sessions.delete(sessionId);
                console.log(`Cleaned inactive session from memory: ${sessionId}`);
            }
        }
    }

    console.log(`Memory: Sessions in cache: ${sessions.size}, Timers: ${expiryTimers.size}`);
}, 600000); // 10 минут

// Автоматическая очистка старых удаленных сессий из БД каждые 24 часа
setInterval(async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    try {
        const result = await pool.query('DELETE FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at < $1', [thirtyDaysAgo]);

        if (result.rowCount > 0) {
            console.log(`Auto-cleanup: Deleted ${result.rowCount} old sessions from database`);

            // Очистка осиротевших сообщений
            const msgResult = await pool.query('DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)');
            console.log(`Auto-cleanup: Deleted ${msgResult.rowCount} orphan messages`);
        }
    } catch (err) {
        console.error('Auto-cleanup error:', err);
    }
}, 86400000); // 24 часа

// Очистка старых использованных wheelCodes каждый час (предотвращает memory leak)
setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let cleaned = 0;

    for (const [code, data] of wheelCodes.entries()) {
        if (data.used && data.createdAt < oneHourAgo) {
            wheelCodes.delete(code);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`WheelCodes cleanup: Removed ${cleaned} old used codes. Remaining: ${wheelCodes.size}`);
    }
}, 3600000); // 1 час

io.on('connection', (socket) => {
    socket.on('identify', (nickname) => {
        if (typeof nickname === 'string' && nickname.trim()) {
            onlineUsers.add(nickname);
            socket.data.nickname = nickname;
            io.emit('online-update', Array.from(onlineUsers));
        }
    });

    socket.on('join-session', (sessionId, role) => {
        socket.join(sessionId);
        socket.data.currentSession = sessionId;
        socket.data.role = role || 'controller';

        getOrCreateSessionInMemory(sessionId, (err, sessionData) => {
            if (err) {
                socket.emit('error', { message: 'Session load error' });
                return;
            }

            if (role !== 'admin') {
                const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
                    socket.handshake.headers['x-real-ip'] ||
                    socket.handshake.address ||
                    socket.conn.remoteAddress ||
                    'Unknown';

                const userAgent = socket.handshake.headers['user-agent'] || 'Unknown';
                const isMobile = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
                const deviceType = isMobile ? '📱 Mobile' : '💻 Desktop';

                const sendConnectionInfo = async (locationInfo = '') => {
                    const connectionMessage = {
                        id: Date.now(),
                        sessionId: sessionId,
                        text: `👤 User connected\n${deviceType}\nIP: ${ip}${locationInfo}`,
                        from: 'system',
                        timestamp: new Date()
                    };

                    sessionData.messages.push(connectionMessage);

                    try {
                        await pool.query('INSERT INTO messages (session_id, message_id, from_user, message_type, text, voice_file, voice_duration, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                            [sessionId, connectionMessage.id.toString(), 'system', 'text', connectionMessage.text, null, null, connectionMessage.timestamp]);
                    } catch (err) {
                        console.error('Insert message error:', err);
                    }

                    io.to(sessionId).emit('new-message', connectionMessage);
                };

                if (ip !== 'Unknown' && !ip.startsWith('127.') && !ip.startsWith('::') && !ip.includes('localhost')) {
                    const https = require('https');
                    https.get(`https://ipapi.co/${ip}/json/`, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            try {
                                const geoData = JSON.parse(data);
                                if (geoData.country_code) {
                                    const countryFlag = geoData.country_code
                                        .toUpperCase()
                                        .split('')
                                        .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
                                        .join('');

                                    const city = geoData.city || '';
                                    const country = geoData.country_name || '';
                                    const locationInfo = `\n${countryFlag} ${city ? city + ', ' : ''}${country}`;
                                    sendConnectionInfo(locationInfo);
                                } else {
                                    sendConnectionInfo();
                                }
                            } catch (e) {
                                sendConnectionInfo();
                            }
                        });
                    }).on('error', () => {
                        sendConnectionInfo();
                    });
                } else {
                    sendConnectionInfo();
                }
            }

            if (!sessionData.wasCreated && role !== 'admin') {
                socket.emit('session-revoked');
                socket.disconnect(true);
                return;
            }

            if (sessionData.revoked) {
                socket.emit('session-revoked');
                socket.disconnect(true);
                return;
            }

            if (sessionData.expiresAt && Date.now() >= new Date(sessionData.expiresAt).getTime()) {
                sessionData.revoked = true;
                sessionData.isActive = false;
                sessions.set(sessionId, sessionData);
                socket.emit('session-revoked');
                socket.disconnect(true);
                return;
            }

            socket.emit('session-data', {
                ...sessionData,
                sessionId: sessionId
            });
        });
    });

    socket.on('leave-session', (sessionId) => {
        socket.leave(sessionId);
        if (socket.data.currentSession === sessionId) {
            socket.data.currentSession = null;
            socket.data.role = null;
        }
    });

    socket.on('chat-message', async (data) => {
        if (!checkRateLimit(socket.id, 'chat-message', MAX_MESSAGES_PER_WINDOW)) return;

        const { sessionId, message } = data;

        if (!sessionId || !message) return;

        if (message.type === 'voice') {
            if (!message.voiceFile || !message.duration) return;
        } else {
            if (typeof message.text !== 'string') return;
            if (message.text.length > 1000) {
                socket.emit('error', { message: 'Message too long (max 1000 characters)' });
                return;
            }
        }

        if (sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            if (session.revoked) return;

            if (!message.sessionId) {
                message.sessionId = sessionId;
            }

            session.messages.push(message);

            try {
                await pool.query('INSERT INTO messages (session_id, message_id, from_user, message_type, text, voice_file, voice_duration, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [sessionId, message.id.toString(), message.from, message.type || 'text', message.text || null, message.voiceFile || null, message.duration || null, message.timestamp]);
            } catch (err) {
                console.error('Insert message error:', err);
            }

            io.to(sessionId).emit('new-message', message);
        }
    });

    socket.on('intensity-update', (data) => {
        if (!checkRateLimit(socket.id, 'intensity-update', MAX_INTENSITY_UPDATES_PER_WINDOW)) {
            return;
        }

        const { sessionId, intensity } = data;

        if (!sessionId || typeof intensity !== 'number' || intensity < 0 || intensity > 100) {
            return;
        }

        if (sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            if (session.revoked) return;
            session.intensity = Math.round(intensity);
            io.to(sessionId).emit('intensity-changed', session.intensity);
        }
    });

    socket.on('control-action', async (data) => {
        if (!checkRateLimit(socket.id, 'control-action', MAX_MESSAGES_PER_WINDOW)) {
            return;
        }

        const { sessionId, action } = data;

        if (!sessionId || typeof action !== 'string' || action.length > 200) {
            return;
        }

        if (sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            if (session.revoked) return;
            const message = {
                id: Date.now(),
                sessionId: sessionId,
                text: action,
                from: 'system',
                timestamp: new Date()
            };
            session.messages.push(message);

            try {
                await pool.query('INSERT INTO messages (session_id, message_id, from_user, message_type, text, voice_file, voice_duration, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [sessionId, message.id.toString(), 'system', 'text', message.text, null, null, message.timestamp]);
            } catch (err) {
                console.error('Insert message error:', err);
            }

            io.to(sessionId).emit('new-message', message);
        }
    });

    socket.on('disconnect', () => {
        if (socket.data && socket.data.nickname) {
            onlineUsers.delete(socket.data.nickname);
            io.emit('online-update', Array.from(onlineUsers));
        }

        // Очистка при отключении
        if (socket.data && socket.data.currentSession) {
            socket.leave(socket.data.currentSession);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Database: PostgreSQL (Railway)`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

