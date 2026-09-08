// Legacy TIMESTAMP columns contain UTC values. Use one timezone consistently
// for pg's Date serialization/parsing and expiry comparisons on every host.
process.env.TZ = 'UTC';

const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const crypto = require('crypto');
const backendState = require('./lib/backend-state');
const STAFF_SOCKET_ROOM = 'authenticated-staff';

const app = express();
let shuttingDown = false;
const backgroundTimers = new Set();
function backgroundInterval(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    backgroundTimers.add(timer);
    return timer;
}
// Railway terminates TLS at its proxy. Trust the first proxy so req.secure and
// secure cookies reflect the public HTTPS request instead of the internal hop.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.toLowerCase().startsWith('/api/')) res.setHeader('Cache-Control', 'private, no-store');
    next();
});
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const AUTH_COOKIE_NAME = 'control_panel_session';
const AUTH_SESSION_DAYS = 30;
const MASTER_INVITE_CODE = String(process.env.MASTER_INVITE_CODE || '').trim();
const DAY1_GROK_CONCURRENCY = Math.max(1, Math.min(8,
    Number.parseInt(process.env.DAY1_GROK_CONCURRENCY || '2', 10) || 2));
const DAY1_GROK_QUEUE_LIMIT = Math.max(DAY1_GROK_CONCURRENCY, Math.min(100,
    Number.parseInt(process.env.DAY1_GROK_QUEUE_LIMIT || '20', 10) || 20));

// Инициализация базы данных PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false
        : process.env.DATABASE_SSL === 'verify-full' ? { rejectUnauthorized: true }
        : (process.env.NODE_ENV === 'production' || process.env.DATABASE_SSL === 'require')
            ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    options: '-c timezone=UTC'
});
pool.on('error', error => console.error('Idle database client error:', error.message));

app.get('/healthz', (_req, res) => {
    res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'stopping' : 'ok' });
});
app.get('/readyz', async (_req, res) => {
    if (shuttingDown) return res.status(503).json({ status: 'stopping' });
    try {
        await pool.query({ text: 'SELECT 1', query_timeout: 2000 });
        return res.json({ status: 'ready' });
    } catch (_) {
        return res.status(503).json({ status: 'unavailable' });
    }
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

// ===== День 1: короткая теория + письменный отбор с Grok =====
const DAY1_PROGRAM = require('./learn/programs/day1-v1.js');
const DAY1_THEORY = require('./learn/day1-theory.js');
const gradingV2 = require('./learn/grading-v2.js');
const DAY1_ENABLED = process.env.TRAINING_DAY1_ENABLED !== '0';
const day1GradingInFlight = new Map();

// npm start loads .env with Node's parser; direct process env wins. Never read
// a secret file implicitly when importing application code in tools or tests.
const XAI_API_KEY = String(process.env.XAI_API_KEY || '').trim();
if (!MASTER_INVITE_CODE) {
    console.warn('MASTER_INVITE_CODE is not configured; master-code registration is disabled');
}

// Создание таблиц
const databaseReady = (async () => {
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

        await pool.query(`
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                nickname TEXT NOT NULL REFERENCES user_registrations(nickname) ON DELETE CASCADE,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP NOT NULL,
                revoked_at TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_nickname ON auth_sessions(nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)`);

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

        // Обучение: прогресс (источник правды для разблокировки) + лог событий
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_progress (
                nickname TEXT NOT NULL,
                lesson INTEGER NOT NULL,
                passed_at TIMESTAMP NOT NULL,
                correct INTEGER,
                total INTEGER,
                PRIMARY KEY (nickname, lesson)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_events (
                id SERIAL PRIMARY KEY,
                nickname TEXT NOT NULL,
                type TEXT NOT NULL,
                lesson INTEGER,
                qindex INTEGER,
                lesson_title TEXT,
                task TEXT,
                paste TEXT,
                score INTEGER,
                pass BOOLEAN,
                feedback TEXT,
                ts TIMESTAMP NOT NULL
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_training_events_nick ON training_events(nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_training_progress_nick ON training_progress(nickname)`);

        // Day 1 v2 lives alongside the legacy course so its data can be rolled
        // back or reset without touching the future Day 2 materials.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_v2_grade_cache (
                cache_key TEXT PRIMARY KEY,
                program_id TEXT NOT NULL,
                program_version INTEGER NOT NULL,
                task_id TEXT NOT NULL,
                rubric_version TEXT NOT NULL,
                model TEXT NOT NULL,
                answer_hash TEXT NOT NULL,
                result_json JSONB NOT NULL,
                created_at TIMESTAMP NOT NULL
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_v2_submissions (
                id BIGSERIAL PRIMARY KEY,
                nickname TEXT NOT NULL,
                program_id TEXT NOT NULL,
                program_version INTEGER NOT NULL,
                task_id TEXT NOT NULL,
                answer_text TEXT NOT NULL,
                answer_hash TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                rubric_version TEXT NOT NULL,
                score INTEGER NOT NULL,
                pass BOOLEAN NOT NULL,
                criteria JSONB NOT NULL,
                feedback TEXT NOT NULL,
                verdict JSONB NOT NULL DEFAULT '{}'::jsonb,
                grader_model TEXT NOT NULL,
                cache_hit BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMP NOT NULL,
                UNIQUE (nickname, program_id, program_version, task_id, cache_key)
            )
        `);
        await pool.query(`
            ALTER TABLE training_v2_submissions
            ADD COLUMN IF NOT EXISTS verdict JSONB NOT NULL DEFAULT '{}'::jsonb
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_v2_progress (
                nickname TEXT NOT NULL,
                program_id TEXT NOT NULL,
                program_version INTEGER NOT NULL,
                rubric_version TEXT NOT NULL,
                completed_tasks INTEGER NOT NULL DEFAULT 0,
                total_tasks INTEGER NOT NULL,
                average_score NUMERIC(5,2) NOT NULL DEFAULT 0,
                passed BOOLEAN NOT NULL DEFAULT false,
                passed_at TIMESTAMP,
                updated_at TIMESTAMP NOT NULL,
                PRIMARY KEY (nickname, program_id, program_version)
            )
        `);
        await pool.query(`
            ALTER TABLE training_v2_progress
            ADD COLUMN IF NOT EXISTS rubric_version TEXT NOT NULL DEFAULT 'legacy'
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_v2_attempt_slots (
                nickname TEXT NOT NULL,
                program_id TEXT NOT NULL,
                program_version INTEGER NOT NULL,
                rubric_version TEXT NOT NULL,
                task_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL,
                answer_hash TEXT NOT NULL,
                reservation_token TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'reserved',
                reserved_until TIMESTAMP,
                created_at TIMESTAMP NOT NULL,
                completed_at TIMESTAMP,
                PRIMARY KEY (nickname, program_id, program_version, rubric_version, task_id, attempt_number),
                UNIQUE (nickname, program_id, program_version, rubric_version, task_id, answer_hash)
            )
        `);
        await pool.query(`
            ALTER TABLE training_v2_attempt_slots
            ADD COLUMN IF NOT EXISTS reservation_token TEXT
        `);
        await pool.query(`
            UPDATE training_v2_attempt_slots
            SET reservation_token = md5(
                random()::text || clock_timestamp()::text ||
                nickname || task_id || attempt_number::text
            )
            WHERE reservation_token IS NULL
        `);
        await pool.query(`
            ALTER TABLE training_v2_attempt_slots
            ALTER COLUMN reservation_token SET NOT NULL
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_v2_theory_progress (
                nickname TEXT NOT NULL,
                program_id TEXT NOT NULL,
                program_version INTEGER NOT NULL,
                theory_id TEXT NOT NULL,
                theory_version INTEGER NOT NULL,
                module_id TEXT NOT NULL,
                selected_index INTEGER NOT NULL,
                completed_at TIMESTAMP NOT NULL,
                PRIMARY KEY (
                    nickname, program_id, program_version,
                    theory_id, theory_version, module_id
                )
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_training_v2_theory_nick
            ON training_v2_theory_progress(nickname, program_id, program_version)
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS training_v2_reset_state (
                nickname TEXT NOT NULL,
                program_id TEXT NOT NULL,
                program_version INTEGER NOT NULL,
                reset_generation INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP NOT NULL,
                PRIMARY KEY (nickname, program_id, program_version)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_training_v2_submissions_nick ON training_v2_submissions(nickname, program_id, program_version)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_training_v2_submissions_task ON training_v2_submissions(task_id, created_at)`);
        await pool.query(`
            DO $$
            DECLARE old_constraint TEXT;
            BEGIN
                SELECT c.conname INTO old_constraint
                FROM pg_constraint c
                JOIN pg_class t ON t.oid=c.conrelid
                WHERE t.relname='training_v2_submissions'
                  AND c.contype='u'
                  AND pg_get_constraintdef(c.oid) LIKE
                    '%(nickname, program_id, program_version, task_id, answer_hash, rubric_version)%'
                LIMIT 1;
                IF old_constraint IS NOT NULL THEN
                    EXECUTE format(
                        'ALTER TABLE training_v2_submissions DROP CONSTRAINT %I',
                        old_constraint
                    );
                END IF;
            END $$;
        `);
        // CREATE TABLE already creates a unique backing index on this exact
        // column set. Older installations may only have the explicit index,
        // so create it only when no equivalent unique index exists.
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_index i
                    JOIN pg_class t ON t.oid=i.indrelid
                    WHERE t.relname='training_v2_submissions'
                      AND i.indisunique
                      AND pg_get_indexdef(i.indexrelid) LIKE
                        '%(nickname, program_id, program_version, task_id, cache_key)%'
                ) THEN
                    CREATE UNIQUE INDEX idx_training_v2_submissions_cache_unique
                    ON training_v2_submissions(nickname, program_id, program_version, task_id, cache_key);
                END IF;
            END $$;
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_training_v2_attempt_slots_expiry
            ON training_v2_attempt_slots(status, reserved_until)
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

        await pool.query(`
            CREATE TABLE IF NOT EXISTS wheel_codes (
                code TEXT PRIMARY KEY,
                prize TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                used_at TIMESTAMP
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

        await pool.query(`ALTER TABLE case_openings ADD COLUMN IF NOT EXISTS result_json JSONB`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_case_openings_grant ON case_openings(grant_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_case_grants_worker ON case_grants(worker_nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_case_openings_worker ON case_openings(worker_nickname)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_case_tier_prizes_tier ON case_tier_prizes(tier)`);

        await cleanupAuthSessions();

        console.log('Database tables initialized');

        // Загружаем данные из БД при старте
        await loadDataFromDatabase();

        // Засеваем призы кейсов, если пул пуст
        await seedCasePrizes();
    } catch (err) {
        console.error('Error creating tables:', err);
        throw err;
    }
})();

async function cleanupAuthSessions() {
    try {
        await pool.query(`
            DELETE FROM auth_sessions
            WHERE expires_at <= NOW()
               OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
        `);
    } catch (err) {
        console.error('Auth session cleanup error:', err.message);
    }
}

const authSessionCleanupTimer = backgroundInterval(cleanupAuthSessions, 60 * 60 * 1000);
if (typeof authSessionCleanupTimer.unref === 'function') authSessionCleanupTimer.unref();

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
        const snippetsResult = await pool.query('SELECT id, data FROM snippets_data ORDER BY id DESC LIMIT 1');
        if (snippetsResult.rows.length > 0) {
            globalSnippets = snippetsResult.rows[0].data;
            snippetsRevision = Number(snippetsResult.rows[0].id);
            console.log('Loaded snippets from database');
        } else {
            console.log('No snippets found in database, using empty state');
        }
        // Expiration remains effective after a restart, even without a page visit.
        const expiring = await pool.query(`SELECT id, expires_at FROM sessions
            WHERE deleted_at IS NULL AND revoked=false AND is_active=true AND expires_at IS NOT NULL`);
        for (const row of expiring.rows) setupExpiry(row.id, row.expires_at);
    } catch (err) {
        console.error('Error loading data from database:', err);
        throw err;
    }
}

// Засев призов кейсов при первом запуске (если пул ещё пуст)
async function seedCasePrizes() {
    return backendState.transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [1936289394]);
        const existing = await client.query('SELECT COUNT(*) AS c FROM case_prizes');
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
            const r = await client.query(
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
            await client.query(
                'INSERT INTO case_tier_prizes (tier, prize_id, weight) VALUES ($1,$2,$3)',
                [t.tier, idByKey[t.key], t.weight]
            );
        }
        console.log('Case prizes seeded');
    });
}

// Периодическая синхронизация пользователей с БД (каждые 5 минут)
backgroundInterval(async () => {
    try {
        const usersResult = await pool.query('SELECT nickname, role FROM user_registrations');

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
            users.set(row.nickname, { role: row.nickname === SUPER_ADMIN ? 'admin' : (row.role || 'reader') });
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

app.get('/learn/start', (req, res) => {
    res.redirect(DAY1_ENABLED ? '/learn/day1.html' : '/learn/');
});

app.get(['/learn', '/learn/', '/learn/index.html'], (req, res, next) => {
    if (!DAY1_ENABLED) return next();
    return res.redirect('/learn/day1.html');
});

function normalizedRequestPath(req) {
    try {
        return path.posix.normalize('/' + decodeURIComponent(String(req.path || ''))
            .replace(/\\/g, '/')).toLowerCase();
    } catch (_) {
        return '';
    }
}

// These files contain the complete Day 1 course (and real account screenshots),
// so they must never fall through to the public static server.
const DAY1_PROTECTED_ASSETS = new Map([
    ['/learn/day1.html', { file: 'learn/day1.html' }],
    ['/learn/day1-app.js', { file: 'learn/day1-app.js' }],
    ['/learn/day1-normalize.js', { file: 'learn/day1-normalize.js' }],
    ['/learn/day1-styles.css', { file: 'learn/day1-styles.css' }],
    ['/learn/day1-theory.js', { file: 'learn/day1-theory.js' }],
    ['/learn/day1-dashboard.html', { file: 'learn/day1-dashboard.html', admin: true }],
    ['/learn/day1-dashboard.js', { file: 'learn/day1-dashboard.js', admin: true }],
    ['/learn/day1-dashboard.css', { file: 'learn/day1-dashboard.css', admin: true }],
    ['/onlyfans/карточка фана.jpg', { file: 'onlyfans/Карточка фана.jpg' }],
    ['/onlyfans/контент.jpg', { file: 'onlyfans/Контент.jpg' }],
    ['/молчуны/лайкает соо.jpg', { file: 'Молчуны/Лайкает соо.jpg' }],
    ['/кастом/photo_2025-01-17_05-27-05 (2).jpg', { file: 'кастом/photo_2025-01-17_05-27-05 (2).jpg' }],
    ['/видеочат/photo_2025-04-09_21-28-49 (3).jpg', { file: 'видеочат/photo_2025-04-09_21-28-49 (3).jpg' }]
]);

app.use((req, res, next) => {
    const asset = DAY1_PROTECTED_ASSETS.get(normalizedRequestPath(req));
    if (!asset) return next();
    if (!DAY1_ENABLED && !asset.admin) return res.status(404).send('not found');

    return requireAuthenticatedSession(req, res, () => {
        const send = () => {
            res.setHeader('Cache-Control', 'private, no-store');
            res.sendFile(path.join(__dirname, asset.file), err => {
                if (!err || res.headersSent) return;
                console.error('Protected Day 1 asset error:', err.message);
                res.status(err.statusCode === 404 ? 404 : 500).send('not found');
            });
        };
        return asset.admin
            ? requireLogAccess(req, res, send)
            : requireDay1Role(req, res, send);
    });
});

// Server-only graders and retired course assets are never public static files.
app.get('/learn/lessons.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/grading.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/grading-v2.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/grading-v2.test.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/day1-theory.test.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/day1-preview-server.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/server.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/results.json', (req, res) => res.status(404).send('not found'));
app.get('/learn/programs/day1-v1.js', (req, res) => res.status(404).send('not found'));
app.get('/learn/programs/day1-v1-rubrics.js', (req, res) => res.status(404).send('not found'));

// Explicit public surface: new source files, backups and fixtures are private by default.
const PUBLIC_FILES = new Map([
    ['/index.html', 'index.html'], ['/favicon.ico', 'favicon.ico'],
    ['/cases.css', 'cases.css'], ['/pic.png', 'pic.png'], ['/avatars.json', 'avatars.json'],
    ['/spin.mp3', 'spin.mp3'], ['/win.mp3', 'win.mp3'], ['/music.mp3', 'music.mp3'],
    ['/snippets-sync.js', 'public/snippets-sync.js'],
    ['/public/snippets-sync.js', 'public/snippets-sync.js'],
    ['/workspace-theme.css', 'public/workspace-theme.css'],
    ['/workspace-theme.js', 'public/workspace-theme.js'],
    ['/panel.css', 'public/panel.css'],
    ['/public/lovense-home.html', 'public/lovense-home.html']
]);
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    const file = PUBLIC_FILES.get(normalizedRequestPath(req));
    if (!file) return next();
    return res.sendFile(path.join(__dirname, file));
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), { index: false, dotfiles: 'deny' }));
app.use(express.json({ limit: '10mb' }));
app.use('/voice', express.static(path.join(__dirname, 'voice_messages'), { index: false, dotfiles: 'deny' }));

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
const pendingSessionLoads = new Set();
const expiryTimers = new Map();
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
const onlineUserSockets = new Map();
let snippetsRevision = 0;

// Text Snippets хранилище (общее для всех админов)
let globalSnippets = {
    folders: {},
    snippets: {},
    structure: []
};

function invalidatePendingSessionLoads(sessionId) {
    for (const pending of pendingSessionLoads) {
        if (pending.sessionId === sessionId) pending.invalidated = true;
    }
}

// Helper to get or create session in memory (for real-time sync)
async function getOrCreateSessionInMemory(sessionId, callback) {
    if (sessions.has(sessionId)) {
        return callback(null, sessions.get(sessionId));
    }

    const pending = { sessionId, invalidated: false };
    pendingSessionLoads.add(pending);
    try {
        const sessionResult = await pool.query('SELECT * FROM sessions WHERE id = $1 AND deleted_at IS NULL', [sessionId]);
        const dbSession = sessionResult.rows[0];

        if (dbSession) {
            const msgsResult = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY id ASC', [sessionId]);
            const msgs = msgsResult.rows;
            if (pending.invalidated) return getOrCreateSessionInMemory(sessionId, callback);
            if (sessions.has(sessionId)) return callback(null, sessions.get(sessionId));

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
            if (session.isActive && !session.revoked) setupExpiry(sessionId, session.expiresAt);
            callback(null, session);
        } else {
            if (pending.invalidated) return getOrCreateSessionInMemory(sessionId, callback);
            const session = {
                messages: [],
                intensity: 0,
                isActive: false,
                revoked: false,
                expiresAt: null,
                wasCreated: false,
                creatorNickname: null
            };
            callback(null, session);
        }
    } catch (err) {
        return callback(err);
    } finally {
        pendingSessionLoads.delete(pending);
    }
}

function canManageControlSession(user, session) {
    if (!backendState.isStaff(user) || !session || !session.wasCreated) return false;
    return user.role === 'admin' || session.creatorNickname === user.nickname;
}

function parseControlSessionExpiry(value) {
    if (value === null || value === undefined || value === '') {
        return { ok: true, value: null };
    }
    const timestamp = Date.parse(String(value));
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
        return { ok: false, value: null };
    }
    return { ok: true, value: new Date(timestamp).toISOString() };
}

// Revoke session API
app.post('/api/revoke', requireRegistration, async (req, res) => {
    const sessionId = normalizeSocketSessionId(req.body?.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' });

    getOrCreateSessionInMemory(sessionId, async (err, session) => {
        if (err) return res.status(500).json({ error: 'database_error' });

        if (!session.wasCreated) {
            return res.status(404).json({ error: 'session_not_found' });
        }
        if (!canManageControlSession(req.user, session)) {
            return res.status(403).json({ error: 'permission_denied' });
        }

        try {
            // Отзываем сессию
            const updateResult = await pool.query('UPDATE sessions SET revoked = true, is_active = false WHERE id = $1', [sessionId]);

            if (updateResult.rowCount === 0) {
                sessions.delete(sessionId);
                return res.status(404).json({ error: 'session_not_found' });
            }
            invalidatePendingSessionLoads(sessionId);
            session.revoked = true;
            session.isActive = false;
            sessions.set(sessionId, session);
            await logAction(sessionId, req.user.nickname, 'revoke', 'Session revoked');

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
    const sessionId = normalizeSocketSessionId(req.body?.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' });

    const nickname = req.user.nickname;

    getOrCreateSessionInMemory(sessionId, async (err, session) => {
        if (err) return res.status(500).json({ error: 'database_error' });

        if (!session.wasCreated) {
            return res.status(404).json({ error: 'session_not_found' });
        }
        if (!canManageControlSession(req.user, session)) {
            return res.status(403).json({ error: 'permission_denied' });
        }

        try {
            // Помечаем сессию как удаленную
            const updateResult = await pool.query('UPDATE sessions SET deleted_at = $1,revoked=true,is_active=false WHERE id = $2', [new Date(), sessionId]);
            invalidatePendingSessionLoads(sessionId);
            session.revoked = true;
            session.isActive = false;

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
    const sessionId = normalizeSocketSessionId(req.body?.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' });
    const parsedExpiry = parseControlSessionExpiry(req.body?.expiresAt);
    if (!parsedExpiry.ok) return res.status(400).json({ error: 'invalid_expiry' });
    const expiresAt = parsedExpiry.value;
    const nickname = req.user.nickname;
    try {
        const saved = await backendState.transaction(pool, async client => {
            // Coordinate with account deletion so old requests cannot recreate a removed identity's sessions.
            const user = await client.query('SELECT nickname,role FROM user_registrations WHERE nickname=$1 FOR UPDATE', [nickname]);
            if (!user.rows.length) throw new backendState.ApiError(401, 'login_required');
            if (!backendState.isStaff(user.rows[0])) throw new backendState.ApiError(403, 'trainee_restricted');
            const existing = await client.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
            const row = existing.rows[0];
            if (row && row.deleted_at) throw new backendState.ApiError(409, 'session_id_unavailable');
            if (row && user.rows[0].role !== 'admin' && row.creator_nickname !== nickname) {
                throw new backendState.ApiError(403, 'permission_denied');
            }
            if (row) {
                await client.query('UPDATE sessions SET revoked=false,is_active=true,expires_at=$1 WHERE id=$2', [expiresAt,sessionId]);
            } else {
                await client.query(`INSERT INTO sessions (id,creator_nickname,is_active,revoked,expires_at,created_at)
                    VALUES ($1,$2,true,false,$3,$4)`, [sessionId,nickname,expiresAt,new Date()]);
            }
            await client.query(`INSERT INTO session_logs (session_id,creator_nickname,action,details,timestamp)
                VALUES ($1,$2,'create',$3,$4)`, [sessionId,nickname,
                expiresAt ? `Expires at: ${expiresAt}` : 'No expiration (infinite)',new Date()]);
            const history = row
                ? await client.query('SELECT * FROM messages WHERE session_id=$1 ORDER BY id ASC', [sessionId])
                : { rows: [] };
            return { creatorNickname: row ? row.creator_nickname : nickname, messages: history.rows.map(m => ({
                id: m.message_id,sessionId:m.session_id,from:m.from_user,type:m.message_type,
                text:m.text,voiceFile:m.voice_file,duration:m.voice_duration,timestamp:m.timestamp
            })) };
        });
        invalidatePendingSessionLoads(sessionId);
        const previous = sessions.get(sessionId);
        const session = previous || { messages: saved.messages, intensity: 0 };
        Object.assign(session, { isActive: true, revoked: false, wasCreated: true, expiresAt,
            creatorNickname: saved.creatorNickname });
        sessions.set(sessionId, session);
        setupExpiry(sessionId, expiresAt);
        return res.json({ ok: true });
    } catch (err) {
        if (err instanceof backendState.ApiError) return res.status(err.statusCode).json({ error: err.code });
        if (err.code === '23505') return res.status(409).json({ error: 'session_id_unavailable' });
        console.error('Create session error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

function setupExpiry(sessionId, expiresAt) {
    if (expiryTimers.has(sessionId)) clearTimeout(expiryTimers.get(sessionId));
    expiryTimers.delete(sessionId);
    if (!expiresAt || !Number.isFinite(new Date(expiresAt).getTime())) return;
    const expectedExpiry = new Date(expiresAt).getTime();
    const arm = () => {
        const timer = setTimeout(async () => {
            if (expiryTimers.get(sessionId) !== timer) return;
            expiryTimers.delete(sessionId);
            if (Date.now() < expectedExpiry) return arm();
            try {
                // Conditional write prevents an old timer from revoking a renewed session.
                const result = await pool.query(`UPDATE sessions SET revoked=true, is_active=false
                    WHERE id=$1 AND date_trunc('milliseconds',expires_at)=$2 AND expires_at<=NOW()
                      AND deleted_at IS NULL AND revoked=false RETURNING id`,
                    [sessionId, new Date(expectedExpiry).toISOString()]);
                if (result.rowCount !== 1) return;
                invalidatePendingSessionLoads(sessionId);
                const session = sessions.get(sessionId);
                if (session) { session.revoked = true; session.isActive = false; }
                await logAction(sessionId, 'system', 'expire', 'Session expired automatically');
                io.to(sessionId).emit('session-revoked');
            } catch (error) {
                console.error('Expiry error:', error.message);
                // A temporary database failure must not permanently lose the expiry job.
                const retry = setTimeout(() => setupExpiry(sessionId, expiresAt), 30000);
                if (typeof retry.unref === 'function') retry.unref();
                expiryTimers.set(sessionId, retry);
            }
        }, backendState.expiryDelay(expectedExpiry));
        if (typeof timer.unref === 'function') timer.unref();
        expiryTimers.set(sessionId, timer);
    };
    arm();
}

function removeSessionsFromMemory(ids) {
    for (const id of ids) {
        invalidatePendingSessionLoads(id);
        sessions.delete(id);
        if (expiryTimers.has(id)) clearTimeout(expiryTimers.get(id));
        expiryTimers.delete(id);
        io.to(id).emit('session-revoked');
        io.in(id).socketsLeave(id);
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
        const result = await backendState.cleanupSessions(pool);
        removeSessionsFromMemory(result.ids);
        return res.json({ ok: true, deleted: result.deleted.session });
    } catch (err) {
        console.error('Cleanup error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

app.post('/api/logs/delete-session', requireRegistration, requireLogAccess, async (req, res) => {
    const sessionId = normalizeSocketSessionId(req.body?.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'invalid_session_id' });
    try {
        const result = await backendState.cleanupSessions(pool, { sessionId });
        removeSessionsFromMemory(result.ids);
        return res.json({ ok: true, deleted: result.deleted });
    } catch (err) {
        console.error('Delete session error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

const memoryRateLimitBuckets = new Map();

function consumeMemoryRateLimit({ name, windowMs, max }, rawKey) {
    const now = Date.now();
    const bucketKey = `${name}:${String(rawKey || 'unknown')}`;
    let bucket = memoryRateLimitBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        memoryRateLimitBuckets.set(bucketKey, bucket);
    }
    bucket.count++;
    return {
        allowed: bucket.count <= max,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
}

function memoryRateLimit({ name, windowMs, max, key, message }) {
    return (req, res, next) => {
        const rawKey = typeof key === 'function' ? key(req) : req.ip;
        const result = consumeMemoryRateLimit({ name, windowMs, max }, rawKey);
        if (result.allowed) return next();

        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        return res.status(429).json({
            error: 'rate_limited',
            message,
            retryAfterSeconds: result.retryAfterSeconds
        });
    };
}

const registerRateLimit = memoryRateLimit({
    name: 'register',
    windowMs: 60 * 60 * 1000,
    max: 8,
    key: req => req.ip,
    message: 'Слишком много попыток регистрации. Попробуйте позже.'
});
const loginRateLimit = memoryRateLimit({
    name: 'login',
    windowMs: 15 * 60 * 1000,
    max: 12,
    key: req => `${req.ip}:${String(req.body?.nickname || '').trim().toLowerCase().slice(0, 128)}`,
    message: 'Слишком много попыток входа. Подождите несколько минут.'
});
const loginIpRateLimit = memoryRateLimit({
    name: 'login-ip',
    windowMs: 15 * 60 * 1000,
    max: 40,
    key: req => req.ip,
    message: 'Слишком много попыток входа с этого адреса. Подождите несколько минут.'
});
const DAY1_GRADE_RATE_LIMIT = Object.freeze({
    name: 'day1-grade',
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: 'Слишком много проверок подряд. Подождите несколько минут и повторите.'
});

const memoryRateLimitCleanupTimer = backgroundInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of memoryRateLimitBuckets) {
        if (bucket.resetAt <= now) memoryRateLimitBuckets.delete(key);
    }
}, 15 * 60 * 1000);
if (typeof memoryRateLimitCleanupTimer.unref === 'function') memoryRateLimitCleanupTimer.unref();

app.post('/api/register', registerRateLimit, async (req, res) => {
    const { nickname, password, code } = req.body || {};
    if (!backendState.validNickname(nickname)) return res.status(400).json({ error: 'invalid_nickname' });
    if (typeof password !== 'string' || password.length < 4) return res.status(400).json({ error: 'password_too_short' });
    if (Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'password_too_long' });
    if (typeof code !== 'string' || !code || code.length > 128) return res.status(400).json({ error: 'invalid_or_used_code' });
    // The reserved administrator can only be bootstrapped by the server-side master secret.
    if (nickname === SUPER_ADMIN && (!MASTER_INVITE_CODE || code !== MASTER_INVITE_CODE)) {
        return res.status(403).json({ error: 'reserved_nickname' });
    }
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const role = nickname === SUPER_ADMIN ? 'admin' : 'reader';
        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date();
        await backendState.transaction(pool, async client => {
            let invitedBy = 'MASTER_CODE';
            if (!MASTER_INVITE_CODE || code !== MASTER_INVITE_CODE) {
                const invite = await client.query(`UPDATE invite_codes
                    SET used=true, used_by=$1, used_at=$2
                    WHERE code=$3 AND used=false RETURNING creator_nickname`, [nickname, now, code]);
                if (invite.rowCount !== 1) throw new backendState.ApiError(400, 'invalid_or_used_code');
                invitedBy = invite.rows[0].creator_nickname;
            }
            await client.query(`INSERT INTO user_registrations
                (nickname, password_hash, role, invited_by, invite_code, registered_at)
                VALUES ($1,$2,$3,$4,$5,$6)`, [nickname, passwordHash, role, invitedBy, code, now]);
            await client.query(`INSERT INTO auth_sessions (token_hash,nickname,expires_at,created_at)
                VALUES ($1,$2,$3,$4)`, [authTokenHash(token), nickname,
                new Date(now.getTime() + AUTH_SESSION_DAYS * 86400000), now]);
        });
        users.set(nickname, { role });
        if (invites.has(code)) invites.set(code, { ...invites.get(code), used: true });
        setAuthCookie(req, res, token, AUTH_SESSION_DAYS * 86400);
        return res.json({ ok: true, role });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'nickname_taken' });
        if (err instanceof backendState.ApiError) return res.status(err.statusCode).json({ error: err.code });
        console.error('Registration error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

function readCookie(req, name) {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const key = part.slice(0, separator).trim();
        if (key !== name) continue;
        try {
            return decodeURIComponent(part.slice(separator + 1).trim());
        } catch (_) {
            return '';
        }
    }
    return '';
}

function authTokenHash(token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function authSessionSocketRoom(tokenHash) {
    return `auth-session:${String(tokenHash || '')}`;
}

function authUserSocketRoom(nickname) {
    return `auth-user:${authTokenHash(String(nickname || ''))}`;
}

function disconnectAuthSessionSockets(tokenHash) {
    if (!tokenHash) return;
    io.in(authSessionSocketRoom(tokenHash)).disconnectSockets(true);
}

function disconnectAuthenticatedUserSockets(nickname) {
    if (!nickname) return;
    io.in(authUserSocketRoom(nickname)).disconnectSockets(true);
}

function shouldUseSecureCookie(req) {
    return Boolean(
        req?.secure ||
        process.env.NODE_ENV === 'production' ||
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_ENVIRONMENT_NAME ||
        process.env.RAILWAY_PROJECT_ID ||
        process.env.RAILWAY_PUBLIC_DOMAIN
    );
}

function setAuthCookie(req, res, token, maxAgeSeconds) {
    const parts = [
        `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSeconds}`
    ];
    if (shouldUseSecureCookie(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

async function issueAuthSession(req, res, nickname) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + AUTH_SESSION_DAYS * 24 * 60 * 60 * 1000);
    await pool.query(
        `INSERT INTO auth_sessions (token_hash, nickname, expires_at, created_at)
         VALUES ($1,$2,$3,$4)`,
        [authTokenHash(token), nickname, expiresAt, now]
    );
    setAuthCookie(req, res, token, AUTH_SESSION_DAYS * 24 * 60 * 60);
}

async function getAuthenticatedUserFromToken(token) {
    if (!token) return null;
    return getAuthenticatedUserFromTokenHash(authTokenHash(token));
}

async function getAuthenticatedUserFromTokenHash(tokenHash) {
    if (!tokenHash) return null;
    const result = await pool.query(
        `SELECT s.nickname, s.expires_at, u.role
         FROM auth_sessions s
         JOIN user_registrations u ON u.nickname=s.nickname
         WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
         LIMIT 1`,
        [tokenHash]
    );
    if (!result.rows.length) return null;
    const nickname = result.rows[0].nickname;
    return {
        nickname,
        role: nickname === SUPER_ADMIN ? 'admin' : (result.rows[0].role || 'reader'),
        sessionExpiresAt: result.rows[0].expires_at
            ? new Date(result.rows[0].expires_at).getTime()
            : 0
    };
}

async function requireAuthenticatedSession(req, res, next) {
    const token = readCookie(req, AUTH_COOKIE_NAME);
    if (!token) return res.status(401).json({ error: 'login_required' });

    try {
        const user = await getAuthenticatedUserFromToken(token);
        if (!user) {
            setAuthCookie(req, res, '', 0);
            return res.status(401).json({ error: 'login_required' });
        }

        req.user = user;

        next();
    } catch (err) {
        console.error('Authenticated session check error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
}

// Login endpoint
app.post('/api/login', loginIpRateLimit, loginRateLimit, async (req, res) => {
    const { nickname, password } = req.body || {};
    // New registrations enforce stricter nickname/bcrypt limits. Existing
    // accounts may predate them; do not lock out their historical credentials.
    if (typeof nickname !== 'string' || !nickname || nickname.length > 1024 || typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 4096) return res.status(400).json({ error: 'invalid_credentials' });

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
        await issueAuthSession(req, res, nickname);
        return res.json({ ok: true, nickname, role });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

app.post('/api/logout', async (req, res) => {
    const token = readCookie(req, AUTH_COOKIE_NAME);
    const tokenHash = token ? authTokenHash(token) : '';
    try {
        if (token) {
            await pool.query(
                'UPDATE auth_sessions SET revoked_at=$1 WHERE token_hash=$2',
                [new Date(), tokenHash]
            );
            disconnectAuthSessionSockets(tokenHash);
        }
        setAuthCookie(req, res, '', 0);
        return res.json({ ok: true });
    } catch (err) {
        console.error('Logout error:', err);
        setAuthCookie(req, res, '', 0);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Get current user role
app.get('/api/user/role', requireAuthenticatedSession, async (req, res) => {
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
    const validRoles = ['admin', 'user', 'reader', 'new'];
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

        // Update in memory cache (always — чтобы гард ученика сразу видел новую роль)
        users.set(targetNickname, { role: newRole });
        disconnectAuthenticatedUserSockets(targetNickname);

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
            code = crypto.randomBytes(12).toString('hex');
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

        console.log(`Invite created by ${nickname}`);
        return res.json({ ok: true, code });
    } catch (err) {
        console.error('Generate invite error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// API для удаления пользователя (только для админов)
app.post('/api/users/delete', requireRegistration, requireLogAccess, async (req, res) => {
    const { nickname } = req.body || {};
    if (typeof nickname !== 'string' || !nickname) return res.status(400).json({ error: 'nickname required' });
    if (nickname === SUPER_ADMIN) return res.status(403).json({ error: 'cannot_delete_super_admin' });
    if (nickname === req.user.nickname) return res.status(403).json({ error: 'cannot_delete_self' });
    try {
        const result = await backendState.transaction(pool, async client => {
            // Same lock as grading: no attempt can complete while its identity is removed.
            const user = await client.query('SELECT id FROM user_registrations WHERE nickname=$1 FOR UPDATE', [nickname]);
            if (!user.rows.length) throw new backendState.ApiError(404, 'user_not_found');
            const owned = await client.query('SELECT id FROM sessions WHERE creator_nickname=$1 FOR UPDATE', [nickname]);
            const ids = owned.rows.map(row => row.id);
            await backendState.deleteSessions(client, ids);
            for (const table of ['training_progress', 'training_events', 'training_v2_attempt_slots',
                'training_v2_submissions', 'training_v2_progress', 'training_v2_theory_progress']) {
                await client.query(`DELETE FROM ${table} WHERE nickname=$1`, [nickname]);
            }
            // Tombstone generations invalidate delayed requests and local drafts after nickname reuse.
            await client.query(`UPDATE training_v2_reset_state SET reset_generation=reset_generation+1,
                updated_at=NOW() WHERE nickname=$1`, [nickname]);
            await client.query(`INSERT INTO training_v2_reset_state
                (nickname,program_id,program_version,reset_generation,updated_at)
                VALUES ($1,$2,$3,1,NOW()) ON CONFLICT (nickname,program_id,program_version) DO NOTHING`,
                [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version]);
            await client.query('DELETE FROM case_openings WHERE worker_nickname=$1', [nickname]);
            await client.query('DELETE FROM case_grants WHERE worker_nickname=$1', [nickname]);
            await client.query('UPDATE wheel_codes SET used_at=COALESCE(used_at,NOW()) WHERE created_by=$1', [nickname]);
            await client.query('UPDATE invite_codes SET used=true,used_at=COALESCE(used_at,NOW()) WHERE creator_nickname=$1', [nickname]);
            await client.query('DELETE FROM user_registrations WHERE nickname=$1', [nickname]);
            return { ids };
        });
        users.delete(nickname);
        disconnectAuthenticatedUserSockets(nickname);
        removeSessionsFromMemory(result.ids);
        return res.json({ ok: true, message: `User ${nickname} deleted` });
    } catch (err) {
        if (err instanceof backendState.ApiError) return res.status(err.statusCode).json({ error: err.code });
        console.error('Delete user error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

async function requireRegistration(req, res, next) {
    return requireAuthenticatedSession(req, res, () => {
        if (!backendState.isStaff(req.user)) return res.status(403).json({ error: 'trainee_restricted' });
        next();
    });
}

async function requireLogAccess(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'admin_required' });
    }
    next();
}

function requireDay1Role(req, res, next) {
    if (!req.user || !['new', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'day1_access_required' });
    }
    next();
}

function getDay1Task(taskId) {
    return (DAY1_PROGRAM.tasks || []).find(task => task.id === taskId) || null;
}

function getPublicDay1Program() {
    return {
        id: DAY1_PROGRAM.id,
        slug: DAY1_PROGRAM.slug,
        version: DAY1_PROGRAM.version,
        rubricVersion: DAY1_PROGRAM.rubricVersion,
        title: DAY1_PROGRAM.title,
        subtitle: DAY1_PROGRAM.subtitle,
        instructions: DAY1_PROGRAM.instructions || [],
        responseLanguage: DAY1_PROGRAM.responseLanguage,
        translatorAllowed: !!DAY1_PROGRAM.translatorAllowed,
        snippetsAllowed: !!DAY1_PROGRAM.snippetsAllowed,
        aiAllowed: !!DAY1_PROGRAM.aiAllowed,
        passingScore: DAY1_PROGRAM.passingScore,
        minimumTaskScore: DAY1_PROGRAM.minimumTaskScore,
        maxAttemptsPerTask: DAY1_PROGRAM.maxAttemptsPerTask,
        theoryRequired: true,
        serverTheoryProgress: true,
        theory: {
            id: DAY1_THEORY.id,
            version: DAY1_THEORY.version,
            totalModules: (DAY1_THEORY.modules || []).length
        },
        tasks: (DAY1_PROGRAM.tasks || []).map(task => ({
            id: task.id,
            title: task.title,
            context: task.context,
            prompt: task.prompt,
            placeholder: task.placeholder || 'Write your answer in English…',
            maxWords: task.maxWords || null,
            minMessages: task.minMessages || 1,
            maxMessages: task.maxMessages || task.minMessages || 1
        }))
    };
}

function getDay1TheoryModule(moduleId) {
    return (DAY1_THEORY.modules || []).find(module => module.id === moduleId) || null;
}

async function getDay1TheoryState(nickname, queryable = pool) {
    const [progressResult, resetResult] = await Promise.all([
        queryable.query(
            `SELECT module_id
             FROM training_v2_theory_progress
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3
               AND theory_id=$4 AND theory_version=$5`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version,
                DAY1_THEORY.id, DAY1_THEORY.version]
        ),
        queryable.query(
            `SELECT reset_generation
             FROM training_v2_reset_state
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3
             LIMIT 1`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version]
        )
    ]);
    const recordedModuleIds = new Set(progressResult.rows.map(row => row.module_id));
    const completed = (DAY1_THEORY.modules || [])
        .map(module => module.id)
        .filter(id => recordedModuleIds.has(id));
    const totalModules = (DAY1_THEORY.modules || []).length;
    return {
        theory: {
            completed,
            completedCount: completed.length,
            totalModules,
            complete: totalModules > 0 && completed.length === totalModules
        },
        resetGeneration: Number(resetResult.rows[0]?.reset_generation || 0)
    };
}

function serializeDay1Submission(row) {
    return {
        id: Number(row.id),
        taskId: row.task_id,
        answer: row.answer_text,
        answerHash: row.answer_hash || '',
        score: Number(row.score),
        pass: !!row.pass,
        criteria: row.criteria || {},
        feedback: row.feedback || '',
        verdict: row.verdict || {},
        model: row.grader_model || '',
        cacheHit: !!row.cache_hit,
        createdAt: row.created_at ? new Date(row.created_at).getTime() : 0
    };
}

async function computeDay1State(nickname, persist = true) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Resets, grading commits and account deletion all hold FOR UPDATE on this row.
        // Keep submissions, theory, generation and the persisted aggregate in one snapshot.
        const user = await client.query(
            'SELECT nickname FROM user_registrations WHERE nickname=$1 FOR SHARE',
            [nickname]
        );
        if (!user.rows.length) {
            const error = new Error('login_required');
            error.code = 'login_required';
            throw error;
        }
        const state = await computeDay1StateSnapshot(nickname, persist, client);
        await client.query('COMMIT');
        return state;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function computeDay1StateSnapshot(nickname, persist, queryable) {
    const [result, theoryState] = await Promise.all([
        queryable.query(
            `SELECT id, task_id, answer_text, answer_hash, score, pass, criteria, feedback, verdict, grader_model, cache_hit, created_at
             FROM training_v2_submissions
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3 AND rubric_version=$4
             ORDER BY created_at ASC, id ASC`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version, DAY1_PROGRAM.rubricVersion]
        ),
        getDay1TheoryState(nickname, queryable)
    ]);

    const tasks = {};
    let completedTasks = 0;
    let scoreSum = 0;
    let everyTaskPassed = true;

    (DAY1_PROGRAM.tasks || []).forEach(task => {
        const history = result.rows
            .filter(row => row.task_id === task.id)
            .map(serializeDay1Submission);
        const latest = history.length ? history[history.length - 1] : null;
        const best = history.reduce((winner, attempt) => {
            if (!winner) return attempt;
            if (attempt.pass && !winner.pass) return attempt;
            if (attempt.pass === winner.pass && attempt.score > winner.score) return attempt;
            if (
                attempt.pass === winner.pass &&
                attempt.score === winner.score &&
                attempt.createdAt > winner.createdAt
            ) return attempt;
            return winner;
        }, null);

        tasks[task.id] = {
            latest,
            best,
            attempts: history.length,
            history
        };

        if (best) {
            completedTasks++;
            scoreSum += best.score;
            if (!best.pass || best.score < DAY1_PROGRAM.minimumTaskScore) everyTaskPassed = false;
        } else {
            everyTaskPassed = false;
        }
    });

    const totalTasks = (DAY1_PROGRAM.tasks || []).length;
    const averageScore = completedTasks ? Math.round((scoreSum / completedTasks) * 100) / 100 : 0;
    const passed = theoryState.theory.complete &&
        completedTasks === totalTasks &&
        averageScore >= DAY1_PROGRAM.passingScore &&
        everyTaskPassed;

    if (persist) {
        const now = new Date();
        await queryable.query(
            `INSERT INTO training_v2_progress
             (nickname, program_id, program_version, rubric_version, completed_tasks, total_tasks, average_score, passed, passed_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (nickname, program_id, program_version) DO UPDATE SET
               rubric_version=EXCLUDED.rubric_version,
               completed_tasks=EXCLUDED.completed_tasks,
               total_tasks=EXCLUDED.total_tasks,
               average_score=EXCLUDED.average_score,
               passed=EXCLUDED.passed,
               passed_at=CASE
                 WHEN EXCLUDED.passed THEN COALESCE(training_v2_progress.passed_at, EXCLUDED.passed_at)
                 ELSE NULL
               END,
               updated_at=EXCLUDED.updated_at`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version, DAY1_PROGRAM.rubricVersion,
                completedTasks, totalTasks, averageScore, passed, passed ? now : null, now]
        );
    }

    return {
        programId: DAY1_PROGRAM.id,
        programVersion: DAY1_PROGRAM.version,
        rubricVersion: DAY1_PROGRAM.rubricVersion,
        completedTasks,
        totalTasks,
        averageScore,
        passingScore: DAY1_PROGRAM.passingScore,
        minimumTaskScore: DAY1_PROGRAM.minimumTaskScore,
        passed,
        theory: theoryState.theory,
        resetGeneration: theoryState.resetGeneration,
        tasks
    };
}

async function safeComputeDay1State(nickname, context) {
    try {
        return await computeDay1State(nickname);
    } catch (error) {
        console.error(`Day 1 state refresh failed after ${context}:`, error);
        return null;
    }
}

function getDay1Hashes(taskId, answer) {
    const normalized = gradingV2.normalizeAnswer(answer);
    const answerHash = gradingV2.hashAnswer(normalized);
    const graderSignature = crypto.createHash('sha256')
        .update([
            gradingV2.GRADER_VERSION,
            gradingV2.buildSystemPrompt(taskId),
            JSON.stringify(gradingV2.buildResponseSchema(taskId))
        ].join('\0'), 'utf8')
        .digest('hex');
    const cacheMaterial = [
        DAY1_PROGRAM.id,
        DAY1_PROGRAM.version,
        DAY1_PROGRAM.rubricVersion,
        taskId,
        gradingV2.MODEL,
        gradingV2.REASONING_EFFORT,
        graderSignature,
        answerHash
    ].join('\0');
    return {
        normalized,
        answerHash,
        cacheKey: crypto.createHash('sha256').update(cacheMaterial, 'utf8').digest('hex')
    };
}

function assertDay1ResetGeneration(expectedGeneration, theoryState) {
    // Omitted generations remain compatible with older clients; current clients fence every write.
    if (expectedGeneration === undefined) return;
    const generation = Number(expectedGeneration);
    if (!Number.isInteger(generation) || generation !== theoryState.resetGeneration) {
        const error = new Error('training_reset');
        error.code = 'training_reset';
        error.statusCode = 409;
        error.resetGeneration = theoryState.resetGeneration;
        throw error;
    }
}

async function reserveDay1Attempt(nickname, taskId, answerHash, cacheKey, expectedGeneration) {
    const key = [
        nickname,
        DAY1_PROGRAM.id,
        DAY1_PROGRAM.version,
        DAY1_PROGRAM.rubricVersion,
        taskId
    ];
    const now = new Date();
    const reservedUntil = new Date(now.getTime() + 10 * 60 * 1000);
    const reservationToken = crypto.randomBytes(32).toString('hex');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query(
            'SELECT nickname FROM user_registrations WHERE nickname=$1 FOR UPDATE',
            [nickname]
        );
        if (!userResult.rows.length) {
            const error = new Error('login_required');
            error.code = 'login_required';
            error.statusCode = 401;
            throw error;
        }
        const theoryState = await getDay1TheoryState(nickname, client);
        assertDay1ResetGeneration(expectedGeneration, theoryState);
        if (!theoryState.theory.complete) {
            const error = new Error('theory_required');
            error.code = 'theory_required';
            error.statusCode = 409;
            error.theory = theoryState.theory;
            error.resetGeneration = theoryState.resetGeneration;
            throw error;
        }
        await client.query(
            `DELETE FROM training_v2_attempt_slots
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3
               AND rubric_version=$4 AND task_id=$5
               AND status='reserved' AND reserved_until < NOW()`,
            key
        );

        const existingSubmission = await client.query(
            `SELECT id, task_id, answer_text, answer_hash, score, pass, criteria, feedback, verdict,
                    grader_model, cache_hit, created_at
             FROM training_v2_submissions
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3
               AND rubric_version=$4 AND task_id=$5 AND answer_hash=$6
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version,
                DAY1_PROGRAM.rubricVersion, taskId, answerHash]
        );
        if (existingSubmission.rows.length) {
            await client.query('COMMIT');
            return { existing: existingSubmission.rows[0] };
        }

        const sameAnswer = await client.query(
            `SELECT status FROM training_v2_attempt_slots
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3
               AND rubric_version=$4 AND task_id=$5 AND answer_hash=$6
             LIMIT 1`,
            [...key, answerHash]
        );
        if (sameAnswer.rows.some(row => row.status === 'reserved')) {
            const error = new Error('grading_in_progress');
            error.code = 'grading_in_progress';
            error.statusCode = 409;
            throw error;
        }

        for (let attempt = 0; attempt <= DAY1_PROGRAM.maxAttemptsPerTask; attempt++) {
            const result = await client.query(
                `WITH next_slot AS (
                   SELECT slot
                   FROM generate_series(1, $10::int) AS slots(slot)
                   WHERE NOT EXISTS (
                     SELECT 1 FROM training_v2_attempt_slots
                     WHERE nickname=$1 AND program_id=$2 AND program_version=$3
                       AND rubric_version=$4 AND task_id=$5 AND attempt_number=slot
                   )
                   ORDER BY slot
                   LIMIT 1
                 )
                 INSERT INTO training_v2_attempt_slots
                   (nickname, program_id, program_version, rubric_version, task_id,
                    attempt_number, answer_hash, reservation_token, status, reserved_until, created_at)
                 SELECT $1,$2,$3,$4,$5,slot,$6,$7,'reserved',$8,$9
                 FROM next_slot
                 ON CONFLICT DO NOTHING
                 RETURNING attempt_number, reservation_token`,
                [...key, answerHash, reservationToken, reservedUntil, now, DAY1_PROGRAM.maxAttemptsPerTask]
            );
            if (result.rows.length) {
                await client.query('COMMIT');
                return {
                    attemptNumber: Number(result.rows[0].attempt_number),
                    reservationToken: result.rows[0].reservation_token
                };
            }
        }

        const error = new Error('max_attempts_reached');
        error.code = 'max_attempts_reached';
        error.statusCode = 409;
        throw error;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function releaseDay1Attempt(nickname, taskId, attemptNumber, reservationToken) {
    await pool.query(
        `DELETE FROM training_v2_attempt_slots
         WHERE nickname=$1 AND program_id=$2 AND program_version=$3
           AND rubric_version=$4 AND task_id=$5
           AND attempt_number=$6 AND reservation_token=$7 AND status='reserved'`,
        [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version, DAY1_PROGRAM.rubricVersion,
            taskId, attemptNumber, reservationToken]
    );
}

let activeDay1GrokRequests = 0;
const waitingDay1GrokRequests = [];

function drainDay1GrokQueue() {
    while (
        activeDay1GrokRequests < DAY1_GROK_CONCURRENCY &&
        waitingDay1GrokRequests.length
    ) {
        const next = waitingDay1GrokRequests.shift();
        if (next.cancelled) continue;
        clearTimeout(next.timer);
        activeDay1GrokRequests++;
        next.resolve(() => {
            activeDay1GrokRequests = Math.max(0, activeDay1GrokRequests - 1);
            drainDay1GrokQueue();
        });
    }
}

function acquireDay1GrokSlot() {
    if (activeDay1GrokRequests < DAY1_GROK_CONCURRENCY) {
        activeDay1GrokRequests++;
        return Promise.resolve(() => {
            activeDay1GrokRequests = Math.max(0, activeDay1GrokRequests - 1);
            drainDay1GrokQueue();
        });
    }
    if (waitingDay1GrokRequests.length >= DAY1_GROK_QUEUE_LIMIT) {
        const error = new Error('Day 1 grader queue is full');
        error.code = 'grader_busy';
        error.retryable = true;
        error.statusCode = 503;
        return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
        const entry = { resolve, reject, cancelled: false, timer: null };
        entry.timer = setTimeout(() => {
            entry.cancelled = true;
            const index = waitingDay1GrokRequests.indexOf(entry);
            if (index >= 0) waitingDay1GrokRequests.splice(index, 1);
            const error = new Error('Day 1 grader queue wait timed out');
            error.code = 'grader_busy';
            error.retryable = true;
            error.statusCode = 503;
            reject(error);
        }, 60 * 1000);
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        waitingDay1GrokRequests.push(entry);
    });
}

async function callDay1GrokBounded(answer, taskId) {
    const release = await acquireDay1GrokSlot();
    try {
        return await gradingV2.callGrok(answer, taskId, XAI_API_KEY);
    } finally {
        release();
    }
}

app.get('/api/auth/check', requireAuthenticatedSession, async (req, res) => {
    const nickname = req.user.nickname;
    try {
        const result = await pool.query('SELECT role FROM user_registrations WHERE nickname = $1', [nickname]);
        const role = (nickname === SUPER_ADMIN) ? 'admin' : (result.rows[0]?.role || 'reader');
        return res.json({ ok: true, nickname, role });
    } catch (err) {
        return res.json({ ok: true, nickname, role: 'reader' });
    }
});

// ===================== ДЕНЬ 1 · ПРАКТИЧЕСКИЙ ТЕСТ v2 =====================

app.use('/api/training/v2', (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
});

app.get('/api/training/v2/programs/day1-v1', requireAuthenticatedSession, requireDay1Role, (req, res) => {
    if (!DAY1_ENABLED) return res.status(404).json({ error: 'day1_disabled' });
    res.json({ ok: true, program: getPublicDay1Program() });
});

app.get('/api/training/v2/programs/day1-v1/state', requireAuthenticatedSession, requireDay1Role, async (req, res) => {
    if (!DAY1_ENABLED) return res.status(404).json({ error: 'day1_disabled' });
    try {
        const state = await computeDay1State(req.user.nickname);
        res.json({ ok: true, state });
    } catch (err) {
        console.error('Day 1 state error:', err);
        res.status(500).json({ error: 'database_error' });
    }
});

app.post('/api/training/v2/programs/day1-v1/theory', requireAuthenticatedSession, requireDay1Role, async (req, res) => {
    if (!DAY1_ENABLED) return res.status(404).json({ error: 'day1_disabled' });

    const moduleId = String(req.body?.moduleId || '').trim();
    const theoryId = String(req.body?.theoryId || '').trim();
    const theoryVersion = Number(req.body?.theoryVersion);
    const selectedIndex = Number(req.body?.selectedIndex);
    const module = getDay1TheoryModule(moduleId);

    if (!module) return res.status(400).json({ error: 'unknown_theory_module' });
    if (theoryId !== DAY1_THEORY.id || theoryVersion !== Number(DAY1_THEORY.version)) {
        return res.status(409).json({
            error: 'theory_version_mismatch',
            theoryId: DAY1_THEORY.id,
            theoryVersion: DAY1_THEORY.version
        });
    }
    const options = Array.isArray(module.check?.options) ? module.check.options : [];
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= options.length) {
        return res.status(400).json({ error: 'invalid_selected_index' });
    }

    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionOpen = true;
        const userResult = await client.query(
            'SELECT nickname FROM user_registrations WHERE nickname=$1 FOR UPDATE',
            [req.user.nickname]
        );
        if (!userResult.rows.length) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(401).json({ error: 'login_required' });
        }

        const before = await getDay1TheoryState(req.user.nickname, client);
        assertDay1ResetGeneration(req.body?.resetGeneration, before);
        const modules = DAY1_THEORY.modules || [];
        const moduleIndex = modules.findIndex(item => item.id === moduleId);
        const completedSet = new Set(before.theory.completed);
        const firstIncompleteIndex = modules.findIndex(item => !completedSet.has(item.id));
        if (!completedSet.has(moduleId) && firstIncompleteIndex !== moduleIndex) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            return res.status(409).json({ error: 'theory_module_locked' });
        }

        if (selectedIndex !== Number(module.check?.correctIndex)) {
            await client.query('ROLLBACK');
            transactionOpen = false;
            client.release();
            client = null;
            const state = await computeDay1State(req.user.nickname);
            return res.json({ ok: true, correct: false, state, theory: state.theory });
        }

        await client.query(
            `INSERT INTO training_v2_theory_progress
             (nickname, program_id, program_version, theory_id, theory_version,
              module_id, selected_index, completed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (nickname, program_id, program_version, theory_id, theory_version, module_id)
             DO UPDATE SET selected_index=EXCLUDED.selected_index`,
            [req.user.nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version,
                DAY1_THEORY.id, DAY1_THEORY.version, moduleId, selectedIndex, new Date()]
        );
        await client.query('COMMIT');
        transactionOpen = false;
        client.release();
        client = null;
        const state = await computeDay1State(req.user.nickname);
        return res.json({ ok: true, correct: true, state, theory: state.theory });
    } catch (err) {
        if (client && transactionOpen) {
            try { await client.query('ROLLBACK'); } catch (_) {}
        }
        console.error('Day 1 theory progress error:', err);
        if (err.code === 'training_reset') {
            return res.status(409).json({ error: err.code, resetGeneration: err.resetGeneration });
        }
        return res.status(500).json({ error: 'database_error' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/training/v2/programs/day1-v1/tasks/:taskId/grade', requireAuthenticatedSession, requireDay1Role, async (req, res) => {
    if (!DAY1_ENABLED) return res.status(404).json({ error: 'day1_disabled' });

    const taskId = String(req.params.taskId || '');
    const task = getDay1Task(taskId);
    if (!task) return res.status(404).json({ error: 'unknown_task' });

    const rawAnswer = typeof req.body?.answer === 'string' ? req.body.answer : '';
    const { normalized, answerHash, cacheKey } = getDay1Hashes(taskId, rawAnswer);
    const preflight = gradingV2.preflightAnswer(normalized);
    if (!preflight.ok) {
        const error = preflight.flags.empty
            ? 'empty_answer'
            : (preflight.flags.too_short ? 'answer_too_short' : 'answer_too_long');
        return res.status(400).json({ error });
    }
    if (task.maxWords && preflight.wordCount > task.maxWords) {
        return res.status(400).json({ error: 'word_limit_exceeded', maxWords: task.maxWords });
    }
    const messageCount = gradingV2.messageCount(normalized);
    const minMessages = task.minMessages || 1;
    const maxMessages = task.maxMessages || minMessages;
    if (messageCount < minMessages || messageCount > maxMessages) {
        return res.status(400).json({
            error: 'message_count_mismatch',
            minMessages,
            maxMessages,
            actualMessages: messageCount
        });
    }

    try {
        const theoryState = await getDay1TheoryState(req.user.nickname);
        if (!theoryState.theory.complete) {
            return res.status(409).json({
                error: 'theory_required',
                theory: theoryState.theory,
                resetGeneration: theoryState.resetGeneration
            });
        }
    } catch (err) {
        console.error('Day 1 theory gate error:', err);
        return res.status(500).json({ error: 'database_error' });
    }

    let reservedAttemptNumber = null;
    let reservedAttemptToken = null;
    try {
        // Reuse is resolved while holding the same user lock as resets/deletion.
        // A completed answer belongs to its cohort, not to a transient model/cache signature.
        const reservation = await reserveDay1Attempt(
            req.user.nickname,
            taskId,
            answerHash,
            cacheKey,
            req.body?.resetGeneration
        );
        if (reservation.existing) {
            const state = await safeComputeDay1State(req.user.nickname, 'reserved submission reuse');
            return res.json({
                ok: true,
                result: { ...serializeDay1Submission(reservation.existing), reused: true },
                state
            });
        }
        reservedAttemptNumber = reservation.attemptNumber;
        reservedAttemptToken = reservation.reservationToken;

        let cached = false;
        let verdict;
        const cachedResult = await pool.query(
            `SELECT result_json FROM training_v2_grade_cache WHERE cache_key=$1 LIMIT 1`,
            [cacheKey]
        );

        if (cachedResult.rows.length) {
            cached = true;
            verdict = cachedResult.rows[0].result_json;
        } else {
            if (!XAI_API_KEY) {
                const error = new Error('XAI_API_KEY is required');
                error.retryable = true;
                throw error;
            }

            let gradingPromise = day1GradingInFlight.get(cacheKey);
            if (!gradingPromise) {
                const rateLimit = consumeMemoryRateLimit(
                    DAY1_GRADE_RATE_LIMIT,
                    req.user?.nickname || req.ip
                );
                if (!rateLimit.allowed) {
                    const error = new Error(DAY1_GRADE_RATE_LIMIT.message);
                    error.code = 'rate_limited';
                    error.statusCode = 429;
                    error.retryAfterSeconds = rateLimit.retryAfterSeconds;
                    throw error;
                }
                gradingPromise = (async () => {
                    const modelResult = await callDay1GrokBounded(normalized, taskId);
                    const computed = gradingV2.computeVerdict(modelResult, taskId, normalized);
                    const canonical = await pool.query(
                        `INSERT INTO training_v2_grade_cache
                         (cache_key, program_id, program_version, task_id, rubric_version, model, answer_hash, result_json, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                         ON CONFLICT (cache_key) DO UPDATE SET cache_key=EXCLUDED.cache_key
                         RETURNING result_json`,
                        [cacheKey, DAY1_PROGRAM.id, DAY1_PROGRAM.version, taskId, DAY1_PROGRAM.rubricVersion,
                            gradingV2.MODEL, answerHash, computed, new Date()]
                    );
                    return canonical.rows[0].result_json;
                })();
                day1GradingInFlight.set(cacheKey, gradingPromise);
                gradingPromise.then(
                    () => day1GradingInFlight.delete(cacheKey),
                    () => day1GradingInFlight.delete(cacheKey)
                );
            } else {
                cached = true;
            }
            verdict = await gradingPromise;
        }

        const feedback = String(verdict.feedback || verdict.feedback_ru || '');
        const client = await pool.connect();
        let inserted;
        try {
            await client.query('BEGIN');
            await client.query(
                'SELECT nickname FROM user_registrations WHERE nickname=$1 FOR UPDATE',
                [req.user.nickname]
            );
            const completed = await client.query(
                `UPDATE training_v2_attempt_slots
                 SET status='completed', reserved_until=NULL, completed_at=$8
                 WHERE nickname=$1 AND program_id=$2 AND program_version=$3
                   AND rubric_version=$4 AND task_id=$5
                   AND attempt_number=$6 AND reservation_token=$7 AND status='reserved'`,
                [req.user.nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version, DAY1_PROGRAM.rubricVersion,
                    taskId, reservedAttemptNumber, reservedAttemptToken, new Date()]
            );
            if (completed.rowCount !== 1) {
                const error = new Error('Day 1 attempt reservation expired or was reset');
                error.code = 'attempt_reservation_lost';
                error.retryable = true;
                throw error;
            }
            inserted = await client.query(
                `INSERT INTO training_v2_submissions
                 (nickname, program_id, program_version, task_id, answer_text, answer_hash, cache_key,
                  rubric_version, score, pass, criteria, feedback, verdict, grader_model, cache_hit, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                 ON CONFLICT (nickname, program_id, program_version, task_id, cache_key)
                 DO UPDATE SET cache_hit=training_v2_submissions.cache_hit OR EXCLUDED.cache_hit
                 RETURNING id, task_id, answer_text, answer_hash, score, pass, criteria, feedback, verdict, grader_model, cache_hit, created_at`,
                [req.user.nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version, taskId, normalized, answerHash, cacheKey,
                    DAY1_PROGRAM.rubricVersion, verdict.score, !!verdict.pass, verdict.criteria || {}, feedback,
                    verdict, gradingV2.MODEL, cached, new Date()]
            );
            await client.query('COMMIT');
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            throw error;
        } finally {
            client.release();
        }

        const state = await safeComputeDay1State(req.user.nickname, 'successful grading');
        res.json({
            ok: true,
            result: serializeDay1Submission(inserted.rows[0]),
            state
        });
    } catch (err) {
        console.error('Day 1 grading error:', err);
        if (reservedAttemptNumber !== null) {
            try {
                await releaseDay1Attempt(
                    req.user.nickname,
                    taskId,
                    reservedAttemptNumber,
                    reservedAttemptToken
                );
            } catch (releaseError) {
                console.error('Day 1 attempt release error:', releaseError);
            }
        }
        const errorStatus = Number(err.statusCode);
        const upstreamXaiError = /^xai_/.test(String(err.code || ''));
        const status = upstreamXaiError
            ? 503
            : (errorStatus === 401
            ? 401
            : (errorStatus === 409
                ? 409
                : (errorStatus === 429 ? 429 : (err.retryable ? 503 : 500))));
        const publicError = status === 401
            ? 'login_required'
            : (status === 409
                ? (err.code || 'max_attempts_reached')
                : (status === 429
                    ? 'rate_limited'
                    : (status === 503
                        ? (['grader_busy', 'attempt_reservation_lost'].includes(err.code)
                            ? err.code
                            : 'grader_unavailable')
                        : (err.code === 'invalid_assessment' ? 'grading_error' : 'internal_error'))));
        if (status === 429 && err.retryAfterSeconds) {
            res.setHeader('Retry-After', String(err.retryAfterSeconds));
        }
        res.status(status).json({
            error: publicError,
            resetGeneration: err.resetGeneration,
            message: status === 503
                ? 'Grok сейчас занят или временно недоступен. Попытка не потрачена — повторите позже.'
                : (status === 429 ? DAY1_GRADE_RATE_LIMIT.message : undefined),
            retryable: status === 503 || status === 429,
            retryAfterSeconds: status === 429 ? Number(err.retryAfterSeconds || 0) : undefined
        });
    }
});

app.get('/api/training/v2/admin/day1-v1/results', requireAuthenticatedSession, requireLogAccess, async (req, res) => {
    try {
        const namesResult = await pool.query(
            `SELECT u.nickname, u.role, u.registered_at,
                    GREATEST(
                      COALESCE((
                        SELECT MAX(s.created_at)
                        FROM training_v2_submissions s
                        WHERE s.nickname=u.nickname AND s.program_id=$1
                          AND s.program_version=$2 AND s.rubric_version=$3
                      ), TIMESTAMP 'epoch'),
                      COALESCE((
                        SELECT MAX(t.completed_at)
                        FROM training_v2_theory_progress t
                        WHERE t.nickname=u.nickname AND t.program_id=$1
                          AND t.program_version=$2 AND t.theory_id=$4
                          AND t.theory_version=$5
                      ), TIMESTAMP 'epoch'),
                      COALESCE(u.registered_at, TIMESTAMP 'epoch')
                    ) AS last_activity
             FROM user_registrations u
             WHERE u.role='new'
                OR EXISTS (
                  SELECT 1 FROM training_v2_submissions s
                  WHERE s.nickname=u.nickname AND s.program_id=$1
                    AND s.program_version=$2 AND s.rubric_version=$3
                )
                OR EXISTS (
                  SELECT 1 FROM training_v2_theory_progress t
                  WHERE t.nickname=u.nickname AND t.program_id=$1
                    AND t.program_version=$2 AND t.theory_id=$4
                    AND t.theory_version=$5
                )
             ORDER BY last_activity DESC, u.nickname`,
            [DAY1_PROGRAM.id, DAY1_PROGRAM.version, DAY1_PROGRAM.rubricVersion,
                DAY1_THEORY.id, DAY1_THEORY.version]
        );
        const students = await Promise.all(namesResult.rows.map(async row => {
            const state = await computeDay1State(row.nickname, false);
            return {
                nickname: row.nickname,
                role: row.nickname === SUPER_ADMIN ? 'admin' : row.role,
                lastActivity: row.last_activity ? new Date(row.last_activity).getTime() : 0,
                state
            };
        }));
        students.sort((a, b) => b.lastActivity - a.lastActivity);
        res.json({ ok: true, program: getPublicDay1Program(), students });
    } catch (err) {
        console.error('Day 1 admin results error:', err);
        res.status(500).json({ error: 'database_error' });
    }
});

app.post('/api/training/v2/admin/day1-v1/reset', requireAuthenticatedSession, requireLogAccess, async (req, res) => {
    const nickname = String(req.body?.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'nickname_required' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userResult = await client.query(
            'SELECT nickname FROM user_registrations WHERE nickname=$1 FOR UPDATE',
            [nickname]
        );
        if (!userResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'user_not_found' });
        }
        await client.query(
            `DELETE FROM training_v2_attempt_slots
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version]
        );
        await client.query(
            `DELETE FROM training_v2_submissions
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version]
        );
        await client.query(
            `DELETE FROM training_v2_progress
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version]
        );
        await client.query(
            `DELETE FROM training_v2_theory_progress
             WHERE nickname=$1 AND program_id=$2 AND program_version=$3`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version]
        );
        const resetResult = await client.query(
            `INSERT INTO training_v2_reset_state
             (nickname, program_id, program_version, reset_generation, updated_at)
             VALUES ($1,$2,$3,1,$4)
             ON CONFLICT (nickname, program_id, program_version) DO UPDATE SET
               reset_generation=training_v2_reset_state.reset_generation + 1,
               updated_at=EXCLUDED.updated_at
             RETURNING reset_generation`,
            [nickname, DAY1_PROGRAM.id, DAY1_PROGRAM.version, new Date()]
        );
        await client.query('COMMIT');
        res.json({
            ok: true,
            resetGeneration: Number(resetResult.rows[0].reset_generation)
        });
    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (_) {}
        }
        console.error('Day 1 reset error:', err);
        res.status(500).json({ error: 'database_error' });
    } finally {
        if (client) client.release();
    }
});

// Legacy course endpoints are intentionally disabled. Their database tables are
// retained so historical data can still be inspected or migrated later.
app.all(/^\/api\/training\/(?!v2(?:\/|$)).*/, (req, res) => {
    return res.status(410).json({
        error: 'legacy_training_disabled',
        message: 'Старая обучалка отключена. Используйте День 1.'
    });
});

app.get('/api/voice/list', requireRegistration, (req, res) => {
    return res.json({ ok: true, voices: voiceMessages });
});

// Snippets API
app.get('/api/snippets/list', requireRegistration, async (req, res) => {
    try { return res.json({ ok: true, ...await backendState.readSnippets(pool) }); }
    catch (error) { console.error('Read snippets error:', error); return res.status(500).json({ error: 'database_error' }); }
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

async function handleSnippetSave(req, res, itemOnly) {
    if (!backendState.canEditSnippets(req.user)) return res.status(403).json({ error: 'readers_cannot_edit' });
    try {
        const saved = await backendState.saveSnippets(pool, req.user.nickname, req.body || {}, itemOnly);
        // The durable commit is authoritative; never publish a failed write.
        globalSnippets = saved.snippets;
        snippetsRevision = saved.revision;
        const payload = { snippets: saved.snippets, revision: saved.revision };
        io.to(STAFF_SOCKET_ROOM).emit('snippets-updated', payload);
        await detectAndLogChanges(saved.previous, saved.snippets, req.user.nickname);
        return res.json({ ok: true, ...payload });
    } catch (error) {
        if (error instanceof backendState.ApiError) {
            return res.status(error.statusCode).json({ error: error.code, ...error.extra });
        }
        console.error('Save snippets error:', error);
        return res.status(500).json({ error: 'database_error' });
    }
}
app.post('/api/snippets/save', requireRegistration, (req, res) => handleSnippetSave(req, res, false));
app.post('/api/snippets/item', requireRegistration, (req, res) => handleSnippetSave(req, res, true));

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

app.post('/api/wheel/create', requireRegistration, async (req, res) => {
    const code = backendState.normalizeWheelCode(req.body?.code);
    const prize = req.body?.prize;
    if (!code) return res.status(400).json({ error: 'invalid_code' });
    const validPrizes = ['Lovense', 'Threesome', 'Fucklist', 'Sexting', 'Custom', 'Videocall', 'Anal', 'Pussy', 'Nudes', 'Squirt'];
    if (!validPrizes.includes(prize)) return res.status(400).json({ error: 'invalid prize' });
    try {
        const result = await pool.query(`INSERT INTO wheel_codes (code,prize,created_by) VALUES ($1,$2,$3)
            ON CONFLICT (code) DO NOTHING RETURNING code`, [code, prize, req.user.nickname]);
        if (!result.rowCount) return res.status(409).json({ error: 'code_already_exists' });
        return res.json({ ok: true, code, prize });
    } catch (error) { console.error('Wheel create error:', error); return res.status(500).json({ error: 'database_error' }); }
});
const wheelRateLimit = memoryRateLimit({ name: 'wheel', windowMs: 60000, max: 60, key: req => req.ip, message: 'Too many requests' });
app.post('/api/wheel/check', wheelRateLimit, async (req, res) => {
    const code = backendState.normalizeWheelCode(req.body?.code);
    if (!code) return res.status(400).json({ error: 'invalid_code' });
    try {
        const result = await pool.query('SELECT prize,used_at FROM wheel_codes WHERE code=$1', [code]);
        if (!result.rows.length) return res.status(404).json({ error: 'invalid_code' });
        if (result.rows[0].used_at) return res.status(410).json({ error: 'code_already_used' });
        return res.json({ ok: true, targetPrize: result.rows[0].prize });
    } catch (error) { console.error('Wheel check error:', error); return res.status(500).json({ error: 'database_error' }); }
});
app.post('/api/wheel/result', wheelRateLimit, async (req, res) => {
    const code = backendState.normalizeWheelCode(req.body?.code);
    const prize = req.body?.prize;
    if (!code || typeof prize !== 'string') return res.status(400).json({ error: 'invalid_code' });
    try {
        const result = await pool.query(`UPDATE wheel_codes SET used_at=NOW()
            WHERE code=$1 AND prize=$2 AND used_at IS NULL RETURNING prize`, [code, prize]);
        if (!result.rowCount) {
            const previous = await pool.query('SELECT prize,used_at FROM wheel_codes WHERE code=$1', [code]);
            if (previous.rows[0]?.used_at && previous.rows[0].prize === prize) {
                return res.json({ ok: true, prize, reused: true });
            }
            return res.status(409).json({ error: 'code_unavailable_or_prize_mismatch' });
        }
        return res.json({ ok: true, prize: result.rows[0].prize });
    } catch (error) { console.error('Wheel result error:', error); return res.status(500).json({ error: 'database_error' }); }
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
    try {
        const result = await backendState.openCase(pool, req.user.nickname, req.body?.grantId);
        if (!result.reused) io.to('cases-admin').emit('cases-changed', { reason: 'opened' });
        return res.json(result);
    } catch (err) {
        if (err instanceof backendState.ApiError) return res.status(err.statusCode).json({ error: err.code });
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
        await backendState.transaction(pool, async client => {
            const userCheck = await client.query('SELECT nickname FROM user_registrations WHERE nickname=$1 FOR UPDATE', [workerNickname]);
            if (!userCheck.rows.length) throw new backendState.ApiError(404, 'worker_not_found');
            for (let i = 0; i < n; i++) {
                await client.query(`INSERT INTO case_grants (worker_nickname,tier,granted_by,source,granted_at)
                    VALUES ($1,$2,$3,'admin',NOW())`, [workerNickname, t, req.user.nickname]);
            }
        });
        console.log(`Cases granted: ${n}x tier ${t} to ${workerNickname} by ${req.user.nickname}`);
        io.to('user:' + workerNickname).emit('cases-changed', { reason: 'granted' });
        return res.json({ ok: true, granted: n });
    } catch (err) {
        if (err instanceof backendState.ApiError) return res.status(err.statusCode).json({ error: err.code });
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
             WHERE id = $2 AND delivered = false RETURNING id, worker_nickname`,
            [req.user.nickname, openingId]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_done' });
        io.to('user:' + r.rows[0].worker_nickname).emit('cases-changed', { reason: 'delivered' });
        io.to('cases-admin').emit('cases-changed', { reason: 'delivered' });
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
    name = typeof name === 'string' ? name.trim() : '';
    if (!name || name.length > 500) return res.status(400).json({ error: 'invalid_name' });
    if (id && (!Number.isSafeInteger(Number(id)) || Number(id) < 1)) return res.status(400).json({ error: 'invalid_id' });
    if (!['reward', 'task', 'case'].includes(kind)) kind = 'reward';
    if (!['common', 'rare', 'legendary'].includes(rarity)) rarity = 'common';
    icon = (icon || '🎁').toString().slice(0, 8);
    const ct = (kind === 'case' && [1, 2, 3].includes(parseInt(caseTier))) ? parseInt(caseTier) : null;
    if (kind === 'case' && ct === null) return res.status(400).json({ error: 'invalid_case_tier' });
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
        // FK ON DELETE CASCADE makes deletion of pool entries atomic.
        await pool.query('DELETE FROM case_prizes WHERE id = $1', [id]);
        return res.json({ ok: true });
    } catch (err) {
        console.error('Case prize delete error:', err);
        return res.status(500).json({ error: 'database_error' });
    }
});

// Задать вес приза в тире (вес 0 = убрать из тира) (админ)
app.post('/api/cases/admin/tier-prize', requireRegistration, requireLogAccess, async (req, res) => {
    const t = Number(req.body?.tier);
    const pid = Number(req.body?.prizeId);
    const w = Number(req.body?.weight);
    if (![1,2,3].includes(t) || !Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(w) || w < 0 || w > 1000000) {
        return res.status(400).json({ error: 'invalid_input' });
    }
    try {
        await backendState.transaction(pool, async client => {
            await client.query('SELECT pg_advisory_xact_lock($1)', [1936289393]);
            if (w > 0) {
                const prize = await client.query('SELECT id FROM case_prizes WHERE id=$1 FOR KEY SHARE', [pid]);
                if (!prize.rows.length) throw new backendState.ApiError(404, 'prize_not_found');
            }
            // Replacing the pair also repairs duplicates left by older concurrent saves.
            await client.query('DELETE FROM case_tier_prizes WHERE tier=$1 AND prize_id=$2', [t, pid]);
            if (w > 0) await client.query('INSERT INTO case_tier_prizes (tier,prize_id,weight) VALUES ($1,$2,$3)', [t,pid,w]);
        });
        return res.json({ ok: true, ...(w === 0 ? { removed: true } : {}) });
    } catch (err) {
        if (err instanceof backendState.ApiError) return res.status(err.statusCode).json({ error: err.code });
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
backgroundInterval(() => {
    const now = Date.now();
    for (const [key, limit] of socketRateLimits.entries()) {
        if (now > limit.resetAt + 60000) {
            socketRateLimits.delete(key);
        }
    }
}, 300000);

// Автоматическая очистка неактивных сессий из памяти каждые 10 минут
backgroundInterval(() => {
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

// Transactional retention cleanup, with children removed before their parent rows.
backgroundInterval(async () => {
    try {
        const before = new Date(Date.now() - 30 * 86400000);
        const result = await backendState.cleanupSessions(pool, { before });
        removeSessionsFromMemory(result.ids);
    } catch (err) { console.error('Auto-cleanup error:', err); }
}, 86400000);

// Keep consumed codes as tombstones so an old link cannot become valid again.


io.use(async (socket, next) => {
    socket.data.authenticatedUser = null;
    socket.data.authTokenHash = '';
    try {
        const token = readCookie({
            headers: socket.request?.headers || socket.handshake?.headers || {}
        }, AUTH_COOKIE_NAME);
        if (token) {
            const tokenHash = authTokenHash(token);
            const user = await getAuthenticatedUserFromTokenHash(tokenHash);
            if (user) {
                socket.data.authenticatedUser = user;
                socket.data.authTokenHash = tokenHash;
            }
        }
    } catch (err) {
        // A control-link visitor is intentionally allowed to connect without an
        // account. A database/auth lookup failure must never turn untrusted
        // handshake fields into a fallback identity.
        console.error('Socket session lookup error:', err.message);
    }
    next();
});

function normalizeSocketSessionId(value) {
    const sessionId = String(value || '').trim().toLowerCase();
    return /^[a-z0-9]{8}$/.test(sessionId) ? sessionId : '';
}

function expireSocketAuthentication(socket) {
    if (!socket.data.authenticatedUser) return;
    socket.data.authenticatedUser = null;
    socket.data.authTokenHash = '';
    socket.emit('authorization-error', { error: 'login_required' });
    socket.disconnect(true);
}

function scheduleSocketAuthenticationExpiry(socket) {
    if (socket.data.authExpiryTimer) {
        clearTimeout(socket.data.authExpiryTimer);
        socket.data.authExpiryTimer = null;
    }
    const expiresAt = Number(socket.data.authenticatedUser?.sessionExpiresAt || 0);
    if (!expiresAt) return;

    const armTimer = () => {
        if (!socket.connected || !socket.data.authenticatedUser) return;
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
            expireSocketAuthentication(socket);
            return;
        }
        // Re-arm at most daily instead of relying on Node's ~24.8-day timer cap.
        socket.data.authExpiryTimer = setTimeout(
            armTimer,
            Math.min(remaining, 24 * 60 * 60 * 1000)
        );
        if (typeof socket.data.authExpiryTimer.unref === 'function') {
            socket.data.authExpiryTimer.unref();
        }
    };
    armTimer();
}

function currentSocketAuthenticatedUser(socket) {
    const user = socket.data.authenticatedUser;
    if (!user) return null;
    const expiresAt = Number(user.sessionExpiresAt || 0);
    if (expiresAt && Date.now() >= expiresAt) {
        expireSocketAuthentication(socket);
        return null;
    }
    return user;
}

function onlineNicknames() {
    return Array.from(onlineUserSockets.keys());
}

function removeOnlineSocket(socket) {
    const nickname = socket.data.nickname;
    if (!nickname) return;
    const count = Number(onlineUserSockets.get(nickname) || 0);
    if (count <= 1) onlineUserSockets.delete(nickname);
    else onlineUserSockets.set(nickname, count - 1);
    socket.data.nickname = null;
}

function identifyOnlineSocket(socket, nickname) {
    if (socket.data.nickname === nickname) return;
    removeOnlineSocket(socket);
    socket.data.nickname = nickname;
    onlineUserSockets.set(nickname, Number(onlineUserSockets.get(nickname) || 0) + 1);
}

function rejectSocketSessionJoin(socket, channelRole, error) {
    if (channelRole === 'controller') {
        socket.emit('session-revoked');
        socket.disconnect(true);
        return;
    }
    socket.emit('session-error', { error });
}

function operatorSessionRoom(sessionId) {
    return `session-operators:${sessionId}`;
}

function serializeSocketMessage(sessionId, raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const from = ['admin', 'controller', 'system'].includes(source.from)
        ? source.from
        : 'system';
    const knownVoice = from === 'admin' && source.type === 'voice'
        ? voiceMessages.find(item => item.file === String(source.voiceFile || ''))
        : null;
    const timestamp = new Date(source.timestamp);
    return {
        id: String(source.id || crypto.randomUUID()).slice(0, 128),
        sessionId,
        from,
        type: knownVoice ? 'voice' : 'text',
        text: knownVoice ? null : String(source.text || '').slice(0, 1000),
        voiceFile: knownVoice ? knownVoice.file : null,
        duration: knownVoice ? knownVoice.duration : null,
        timestamp: Number.isFinite(timestamp.getTime()) ? timestamp : new Date(0)
    };
}

function publicSocketSessionData(sessionId, session, channelRole) {
    const normalizedMessages = (session.messages || [])
        .map(message => serializeSocketMessage(sessionId, message));
    const visibleMessages = channelRole === 'operator'
        ? normalizedMessages
        : normalizedMessages.filter(message => message.from !== 'system');
    return {
        sessionId,
        messages: visibleMessages,
        intensity: Number(session.intensity || 0),
        expiresAt: session.expiresAt || null
    };
}

function socketCurrentSession(socket, rawSessionId, requiredRole) {
    const sessionId = normalizeSocketSessionId(rawSessionId);
    if (!sessionId || socket.data.currentSession !== sessionId) return null;
    if (!socket.rooms.has(sessionId)) return null;
    if (requiredRole && socket.data.channelRole !== requiredRole) return null;
    const session = sessions.get(sessionId);
    if (!session || !session.wasCreated || !session.isActive || session.revoked) return null;
    if (session.expiresAt && Date.now() >= new Date(session.expiresAt).getTime()) return null;
    return { sessionId, session };
}

function recordControllerConnection(socket, sessionId, sessionData) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const ip = forwarded?.split(',')[0].trim() ||
        socket.handshake.headers['x-real-ip'] ||
        socket.handshake.address ||
        socket.conn.remoteAddress ||
        'Unknown';
    const userAgent = socket.handshake.headers['user-agent'] || 'Unknown';
    const isMobile = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
    const deviceType = isMobile ? '📱 Mobile' : '💻 Desktop';

    const appendConnectionMessage = async (locationInfo = '') => {
        if (socket.data.currentSession !== sessionId || socket.data.channelRole !== 'controller') {
            return;
        }
        const connectionMessage = {
            id: crypto.randomUUID(),
            sessionId,
            text: `👤 User connected\n${deviceType}\nIP: ${ip}${locationInfo}`,
            from: 'system',
            type: 'text',
            timestamp: new Date()
        };
        sessionData.messages.push(connectionMessage);
        try {
            await pool.query(
                `INSERT INTO messages
                 (session_id, message_id, from_user, message_type, text, voice_file, voice_duration, timestamp)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [sessionId, connectionMessage.id, 'system', 'text',
                    connectionMessage.text, null, null, connectionMessage.timestamp]
            );
        } catch (err) {
            console.error('Insert connection message error:', err);
        }
        io.to(operatorSessionRoom(sessionId)).emit('new-message', connectionMessage);
    };

    if (ip === 'Unknown' || ip.startsWith('127.') || ip.startsWith('::') || ip.includes('localhost')) {
        void appendConnectionMessage();
        return;
    }

    const request = https.get(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
            if (data.length < 64 * 1024) data += chunk;
        });
        response.on('end', () => {
            try {
                const geoData = JSON.parse(data);
                if (!geoData.country_code) {
                    void appendConnectionMessage();
                    return;
                }
                const countryFlag = String(geoData.country_code)
                    .toUpperCase()
                    .slice(0, 2)
                    .split('')
                    .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
                    .join('');
                const city = String(geoData.city || '').replace(/[\r\n]/g, ' ').slice(0, 80);
                const country = String(geoData.country_name || '').replace(/[\r\n]/g, ' ').slice(0, 80);
                void appendConnectionMessage(`\n${countryFlag} ${city ? city + ', ' : ''}${country}`);
            } catch (_) {
                void appendConnectionMessage();
            }
        });
    });
    request.setTimeout(5000, () => request.destroy());
    request.on('error', () => void appendConnectionMessage());
}

io.on('connection', (socket) => {
    const connectedUser = currentSocketAuthenticatedUser(socket);
    if (connectedUser) {
        if (backendState.isStaff(connectedUser)) socket.join(STAFF_SOCKET_ROOM);
        socket.join(authUserSocketRoom(connectedUser.nickname));
        socket.join(authSessionSocketRoom(socket.data.authTokenHash));
        scheduleSocketAuthenticationExpiry(socket);
    }

    socket.on('identify', (_claimedNickname, acknowledgement) => {
        const user = currentSocketAuthenticatedUser(socket);
        if (!backendState.isStaff(user)) {
            if (typeof acknowledgement === 'function') acknowledgement({ ok: false, error: 'login_required' });
            socket.emit('authorization-error', { error: 'login_required' });
            return;
        }
        if (socket.data.nickname && socket.data.nickname !== user.nickname) {
            socket.leave('user:' + socket.data.nickname);
        }
        identifyOnlineSocket(socket, user.nickname);
        socket.join('user:' + user.nickname);
        io.to(STAFF_SOCKET_ROOM).emit('online-update', onlineNicknames());
        if (typeof acknowledgement === 'function') acknowledgement({ ok: true, nickname: user.nickname });
    });

    socket.on('cases-admin-join', () => {
        if (currentSocketAuthenticatedUser(socket)?.role !== 'admin') {
            socket.emit('authorization-error', { error: 'admin_required' });
            return;
        }
        socket.join('cases-admin');
    });

    socket.on('join-session', (rawSessionId, requestedRole) => {
        const sessionId = normalizeSocketSessionId(rawSessionId);
        const channelRole = requestedRole === 'admin' || requestedRole === 'operator'
            ? 'operator'
            : 'controller';
        if (!sessionId) {
            rejectSocketSessionJoin(socket, channelRole, 'invalid_session');
            return;
        }

        const joinRequestId = crypto.randomUUID();
        socket.data.joinRequestId = joinRequestId;
        socket.data.pendingSession = sessionId;

        getOrCreateSessionInMemory(sessionId, async (err, sessionData) => {
            if (
                !socket.connected ||
                socket.data.joinRequestId !== joinRequestId ||
                socket.data.pendingSession !== sessionId
            ) return;
            const clearPendingJoin = () => {
                if (socket.data.joinRequestId === joinRequestId) {
                    socket.data.joinRequestId = null;
                    socket.data.pendingSession = null;
                }
            };
            if (err) {
                clearPendingJoin();
                rejectSocketSessionJoin(socket, channelRole, 'session_load_error');
                return;
            }
            if (!sessionData.wasCreated) {
                clearPendingJoin();
                rejectSocketSessionJoin(socket, channelRole, 'session_not_found');
                return;
            }

            if (sessionData.expiresAt && Date.now() >= new Date(sessionData.expiresAt).getTime()) {
                // The expiry job uses a conditional database write; an old join request
                // must never revoke a session that another request just renewed.
                setupExpiry(sessionId, sessionData.expiresAt);
                clearPendingJoin();
                rejectSocketSessionJoin(socket, channelRole, 'session_inactive');
                return;
            }
            if (
                !socket.connected ||
                socket.data.joinRequestId !== joinRequestId ||
                socket.data.pendingSession !== sessionId
            ) return;
            if (sessionData.revoked || !sessionData.isActive) {
                clearPendingJoin();
                rejectSocketSessionJoin(socket, channelRole, 'session_inactive');
                return;
            }

            if (channelRole === 'operator') {
                const user = currentSocketAuthenticatedUser(socket);
                if (!canManageControlSession(user, sessionData)) {
                    clearPendingJoin();
                    rejectSocketSessionJoin(socket, channelRole, 'permission_denied');
                    return;
                }
            }

            const previousSession = socket.data.currentSession;
            if (previousSession) {
                socket.leave(operatorSessionRoom(previousSession));
                if (previousSession !== sessionId) socket.leave(previousSession);
            }
            socket.join(sessionId);
            if (channelRole === 'operator') socket.join(operatorSessionRoom(sessionId));
            socket.data.currentSession = sessionId;
            socket.data.channelRole = channelRole;
            clearPendingJoin();

            socket.emit('session-data', publicSocketSessionData(sessionId, sessionData, channelRole));
            if (channelRole === 'controller') {
                recordControllerConnection(socket, sessionId, sessionData);
            }
        });
    });

    socket.on('leave-session', (rawSessionId) => {
        const sessionId = normalizeSocketSessionId(rawSessionId);
        if (!sessionId) return;
        if (socket.data.pendingSession === sessionId) {
            socket.data.joinRequestId = null;
            socket.data.pendingSession = null;
        }
        if (socket.data.currentSession !== sessionId) return;
        socket.leave(sessionId);
        socket.leave(operatorSessionRoom(sessionId));
        socket.data.currentSession = null;
        socket.data.channelRole = null;
    });

    socket.on('chat-message', async (data, acknowledgement) => {
        const reply = payload => { if (typeof acknowledgement === 'function') acknowledgement(payload); };
        if (!checkRateLimit(socket.id, 'chat-message', MAX_MESSAGES_PER_WINDOW)) return reply({ ok: false, error: 'rate_limited' });
        if (
            socket.data.channelRole === 'operator' &&
            !currentSocketAuthenticatedUser(socket)
        ) return reply({ ok: false, error: 'login_required' });
        const current = socketCurrentSession(socket, data?.sessionId);
        const input = data?.message;
        if (!current || !input || typeof input !== 'object' || Array.isArray(input)) return reply({ ok: false, error: 'invalid_session_or_message' });

        const from = socket.data.channelRole === 'operator' ? 'admin' : 'controller';
        const message = {
            id: crypto.randomUUID(),
            sessionId: current.sessionId,
            from,
            type: 'text',
            text: null,
            voiceFile: null,
            duration: null,
            timestamp: new Date()
        };

        if (input.type === 'voice') {
            if (socket.data.channelRole !== 'operator') return reply({ ok: false, error: 'permission_denied' });
            const voice = voiceMessages.find(item => item.file === String(input.voiceFile || ''));
            if (!voice) return reply({ ok: false, error: 'invalid_voice' });
            message.type = 'voice';
            message.voiceFile = voice.file;
            message.duration = voice.duration;
        } else {
            const text = typeof input.text === 'string' ? input.text.trim() : '';
            if (!text || text.length > 1000) return reply({ ok: false, error: 'invalid_message' });
            message.text = text;
        }

        try {
            await pool.query(
                `INSERT INTO messages
                 (session_id, message_id, from_user, message_type, text, voice_file, voice_duration, timestamp)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [current.sessionId, message.id, message.from, message.type,
                    message.text, message.voiceFile, message.duration, message.timestamp]
            );
        } catch (err) {
            console.error('Insert message error:', err);
            socket.emit('message-error', { error: 'database_error' });
            return reply({ ok: false, error: 'database_error' });
        }
        reply({ ok: true, messageId: message.id });
        if (sessions.get(current.sessionId) !== current.session) return;
        current.session.messages.push(message);
        io.to(current.sessionId).emit('new-message', message);
    });

    socket.on('intensity-update', (data) => {
        if (!checkRateLimit(socket.id, 'intensity-update', MAX_INTENSITY_UPDATES_PER_WINDOW)) return;
        const current = socketCurrentSession(socket, data?.sessionId, 'controller');
        const intensity = Number(data?.intensity);
        if (!current || !Number.isFinite(intensity) || intensity < 0 || intensity > 100) return;
        current.session.intensity = Math.round(intensity);
        io.to(current.sessionId).emit('intensity-changed', current.session.intensity);
    });

    socket.on('control-action', async (data) => {
        if (!checkRateLimit(socket.id, 'control-action', MAX_MESSAGES_PER_WINDOW)) return;
        const current = socketCurrentSession(socket, data?.sessionId, 'controller');
        if (!current || data?.action !== '▶️ Started') return;

        const message = {
            id: crypto.randomUUID(),
            sessionId: current.sessionId,
            text: '▶️ Started',
            from: 'system',
            type: 'text',
            timestamp: new Date()
        };
        try {
            await pool.query(
                `INSERT INTO messages
                 (session_id, message_id, from_user, message_type, text, voice_file, voice_duration, timestamp)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [current.sessionId, message.id, 'system', 'text', message.text,
                    null, null, message.timestamp]
            );
        } catch (err) {
            console.error('Insert control action error:', err);
            socket.emit('message-error', { error: 'database_error' });
            return;
        }
        if (sessions.get(current.sessionId) !== current.session) return;
        current.session.messages.push(message);
        io.to(current.sessionId).emit('new-message', message);
    });

    socket.on('disconnect', () => {
        if (socket.data.authExpiryTimer) {
            clearTimeout(socket.data.authExpiryTimer);
            socket.data.authExpiryTimer = null;
        }
        if (socket.data.nickname) {
            removeOnlineSocket(socket);
            io.to(STAFF_SOCKET_ROOM).emit('online-update', onlineNicknames());
        }
    });
});

// Return a stable API error shape without reflecting request content or stacks.
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.parse.failed' ? 400
        : error.type === 'entity.too.large' ? 413
        : (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500);
    if (status >= 500) console.error('Unhandled request error:', error.message);
    res.status(status).json({ error: status === 400 ? 'invalid_request'
        : status === 413 ? 'request_too_large' : status === 500 ? 'internal_error' : 'request_rejected' });
});

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Graceful shutdown: ${signal}`);
    for (const timer of backgroundTimers) clearInterval(timer);
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    const deadline = setTimeout(() => {
        console.error('Shutdown grace period exceeded');
        server.closeAllConnections();
        process.exit(1);
    }, 30000);
    deadline.unref();
    try {
        await new Promise(resolve => io.close(resolve));
        await pool.end();
        clearTimeout(deadline);
    } catch (error) {
        console.error('Shutdown error:', error.message);
        process.exit(1);
    }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

databaseReady.then(() => {
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Database: PostgreSQL (Railway)`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
}).catch(async err => {
    console.error('Server startup aborted because database initialization failed:', err.message);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
});
