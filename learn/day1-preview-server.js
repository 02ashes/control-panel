'use strict';

// Local-only Day 1 preview. It deliberately avoids PostgreSQL and keeps all
// attempts in memory, while using the same Grok grader as the real server.
const express = require('express');
const fs = require('fs');
const path = require('path');
const DAY1_PROGRAM = require('./programs/day1-v1.js');
const DAY1_THEORY = require('./day1-theory.js');
const grading = require('./grading-v2.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = Number.parseInt(process.env.PREVIEW_PORT || '4173', 10);
const HOST = '127.0.0.1';
const app = express();
const histories = new Map();
const theoryProgress = new Map();
const resetGenerations = new Map();
const gradeCache = new Map();
const pendingGrades = new Map();
let nextSubmissionId = 1;

function readEnvValue(name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    const source = fs.readFileSync(path.join(ROOT_DIR, '.env'), 'utf8');
    const line = source.split(/\r?\n/).find(item => {
      return item.trim().startsWith(name + '=');
    });
    if (!line) return '';
    return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  } catch (_) {
    return '';
  }
}

const XAI_API_KEY = readEnvValue('XAI_API_KEY');

function publicProgram() {
  return {
    id: DAY1_PROGRAM.id,
    slug: DAY1_PROGRAM.slug,
    version: DAY1_PROGRAM.version,
    rubricVersion: DAY1_PROGRAM.rubricVersion,
    title: DAY1_PROGRAM.title,
    subtitle: DAY1_PROGRAM.subtitle,
    instructions: DAY1_PROGRAM.instructions,
    responseLanguage: DAY1_PROGRAM.responseLanguage,
    translatorAllowed: DAY1_PROGRAM.translatorAllowed,
    snippetsAllowed: DAY1_PROGRAM.snippetsAllowed,
    aiAllowed: DAY1_PROGRAM.aiAllowed,
    passingScore: DAY1_PROGRAM.passingScore,
    minimumTaskScore: DAY1_PROGRAM.minimumTaskScore,
    maxAttemptsPerTask: DAY1_PROGRAM.maxAttemptsPerTask,
    theoryRequired: true,
    serverTheoryProgress: true,
    theory: {
      id: DAY1_THEORY.id,
      version: DAY1_THEORY.version,
      totalModules: DAY1_THEORY.modules.length
    },
    tasks: DAY1_PROGRAM.tasks.map(task => ({
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

function completedTheory(name) {
  if (!theoryProgress.has(name)) theoryProgress.set(name, new Set());
  return theoryProgress.get(name);
}

function theoryStateFor(name) {
  const completedSet = completedTheory(name);
  const completed = DAY1_THEORY.modules
    .map(module => module.id)
    .filter(moduleId => completedSet.has(moduleId));
  return {
    completed,
    completedCount: completed.length,
    totalModules: DAY1_THEORY.modules.length,
    complete: DAY1_THEORY.modules.length > 0 &&
      completed.length === DAY1_THEORY.modules.length
  };
}

function nickname(req) {
  return String(req.get('X-Nickname') || 'preview-worker').trim().slice(0, 80) ||
    'preview-worker';
}

function checkResetGeneration(req, res, name) {
  const current = resetGenerations.get(name) || 0;
  if (req.body?.resetGeneration !== undefined && Number(req.body.resetGeneration) !== current) {
    res.status(409).json({ error: 'training_reset', resetGeneration: current });
    return false;
  }
  return true;
}

function userHistory(name) {
  if (!histories.has(name)) histories.set(name, new Map());
  return histories.get(name);
}

function taskHistory(name, taskId) {
  const user = userHistory(name);
  if (!user.has(taskId)) user.set(taskId, []);
  return user.get(taskId);
}

function bestAttempt(history) {
  return history.reduce((best, attempt) => {
    if (!best) return attempt;
    if (attempt.pass && !best.pass) return attempt;
    if (attempt.pass === best.pass && attempt.score > best.score) return attempt;
    if (
      attempt.pass === best.pass &&
      attempt.score === best.score &&
      attempt.createdAt > best.createdAt
    ) return attempt;
    return best;
  }, null);
}

function stateFor(name) {
  const tasks = {};
  let completedTasks = 0;
  let scoreSum = 0;
  let everyTaskPassed = true;

  DAY1_PROGRAM.tasks.forEach(task => {
    const history = taskHistory(name, task.id);
    const latest = history.length ? history[history.length - 1] : null;
    const best = bestAttempt(history);
    tasks[task.id] = {
      latest,
      best,
      attempts: history.length,
      history
    };

    if (best) {
      completedTasks++;
      scoreSum += best.score;
      if (!best.pass || best.score < DAY1_PROGRAM.minimumTaskScore) {
        everyTaskPassed = false;
      }
    } else {
      everyTaskPassed = false;
    }
  });

  const totalTasks = DAY1_PROGRAM.tasks.length;
  const averageScore = completedTasks
    ? Math.round((scoreSum / completedTasks) * 100) / 100
    : 0;
  return {
    programId: DAY1_PROGRAM.id,
    programVersion: DAY1_PROGRAM.version,
    rubricVersion: DAY1_PROGRAM.rubricVersion,
    completedTasks,
    totalTasks,
    averageScore,
    passingScore: DAY1_PROGRAM.passingScore,
    minimumTaskScore: DAY1_PROGRAM.minimumTaskScore,
    passed: theoryStateFor(name).complete && completedTasks === totalTasks &&
      averageScore >= DAY1_PROGRAM.passingScore && everyTaskPassed,
    theory: theoryStateFor(name),
    resetGeneration: resetGenerations.get(name) || 0,
    tasks
  };
}

function taskById(taskId) {
  return DAY1_PROGRAM.tasks.find(task => task.id === taskId) || null;
}

function validationError(task, answer) {
  const preflight = grading.preflightAnswer(answer);
  if (!preflight.ok) {
    if (preflight.flags.empty) return 'empty_answer';
    if (preflight.flags.too_short) return 'answer_too_short';
    return 'answer_too_long';
  }
  if (task.maxWords && preflight.wordCount > task.maxWords) {
    return 'word_limit_exceeded';
  }
  const messageCount = grading.messageCount(preflight.normalized);
  const minMessages = task.minMessages || 1;
  const maxMessages = task.maxMessages || minMessages;
  if (messageCount < minMessages || messageCount > maxMessages) {
    return 'message_count_mismatch';
  }
  return '';
}

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use('/api/training/v2', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/training/v2/programs/day1-v1', (req, res) => {
  res.json({ ok: true, program: publicProgram(), preview: true });
});

app.get('/api/training/v2/programs/day1-v1/state', (req, res) => {
  res.json({ ok: true, state: stateFor(nickname(req)), preview: true });
});

app.post('/api/training/v2/programs/day1-v1/theory', (req, res) => {
  const name = nickname(req);
  if (!checkResetGeneration(req, res, name)) return;
  const moduleId = String(req.body?.moduleId || '').trim();
  const theoryId = String(req.body?.theoryId || '').trim();
  const theoryVersion = Number(req.body?.theoryVersion);
  const selectedIndex = Number(req.body?.selectedIndex);
  const module = DAY1_THEORY.modules.find(item => item.id === moduleId);

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

  const completed = completedTheory(name);
  const moduleIndex = DAY1_THEORY.modules.findIndex(item => item.id === moduleId);
  const firstIncompleteIndex = DAY1_THEORY.modules.findIndex(item => !completed.has(item.id));
  if (!completed.has(moduleId) && firstIncompleteIndex !== moduleIndex) {
    return res.status(409).json({ error: 'theory_module_locked' });
  }
  if (selectedIndex !== Number(module.check?.correctIndex)) {
    const state = stateFor(name);
    return res.json({
      ok: true,
      correct: false,
      state,
      theory: state.theory,
      preview: true
    });
  }

  completed.add(moduleId);
  const state = stateFor(name);
  return res.json({
    ok: true,
    correct: true,
    state,
    theory: state.theory,
    preview: true
  });
});

app.post('/api/training/v2/programs/day1-v1/tasks/:taskId/grade', async (req, res) => {
  const taskId = String(req.params.taskId || '');
  const task = taskById(taskId);
  if (!task) return res.status(404).json({ error: 'unknown_task' });

  const answer = grading.normalizeAnswer(
    typeof req.body?.answer === 'string' ? req.body.answer : ''
  );
  const problem = validationError(task, answer);
  if (problem) return res.status(400).json({ error: problem });

  const name = nickname(req);
  if (!checkResetGeneration(req, res, name)) return;
  const history = taskHistory(name, taskId);
  const generation = resetGenerations.get(name) || 0;
  const pendingKey = JSON.stringify([name, taskId, generation]);
  const pending = pendingGrades.get(pendingKey) || new Set();
  const answerHash = grading.hashAnswer(answer);
  const existing = history.find(attempt => attempt.answerHash === answerHash);
  if (existing) {
    return res.json({
      ok: true,
      result: { ...existing, reused: true },
      state: stateFor(name),
      preview: true
    });
  }
  if (pending.has(answerHash)) {
    return res.status(409).json({ error: 'grading_in_progress' });
  }
  if (history.length + pending.size >= DAY1_PROGRAM.maxAttemptsPerTask) {
    return res.status(409).json({ error: 'max_attempts_reached' });
  }
  const theory = theoryStateFor(name);
  if (!theory.complete) {
    return res.status(409).json({
      error: 'theory_required',
      theory,
      resetGeneration: resetGenerations.get(name) || 0
    });
  }
  if (!XAI_API_KEY) {
    return res.status(503).json({
      error: 'grader_unavailable',
      message: 'Grok сейчас недоступен. Попытка не потрачена — повторите позже.',
      retryable: true
    });
  }

  const cacheKey = [DAY1_PROGRAM.rubricVersion, taskId, answerHash].join(':');
  pending.add(answerHash);
  pendingGrades.set(pendingKey, pending);
  try {
    let verdict = gradeCache.get(cacheKey);
    const cacheHit = Boolean(verdict);
    if (!verdict) {
      const assessment = await grading.callGrok(answer, taskId, XAI_API_KEY);
      verdict = grading.computeVerdict(assessment, taskId, answer);
      gradeCache.set(cacheKey, verdict);
    }

    if ((resetGenerations.get(name) || 0) !== generation) {
      return res.status(409).json({
        error: 'training_reset',
        resetGeneration: resetGenerations.get(name) || 0
      });
    }

    const result = {
      id: nextSubmissionId++,
      taskId,
      answer,
      answerHash,
      score: verdict.score,
      pass: verdict.pass,
      criteria: verdict.criteria,
      feedback: verdict.feedback_ru,
      verdict,
      model: grading.MODEL,
      cacheHit,
      createdAt: Date.now()
    };
    history.push(result);
    return res.json({
      ok: true,
      result,
      state: stateFor(name),
      preview: true
    });
  } catch (error) {
    console.error('Preview grading error:', error && error.message);
    const invalidAssessment = error && error.code === 'invalid_assessment';
    const retryable = Boolean(error && error.retryable);
    const status = invalidAssessment ? 500 : (retryable ? 503 : 500);
    return res.status(status).json({
      error: invalidAssessment
        ? 'grading_error'
        : (retryable ? 'grader_unavailable' : 'internal_error'),
      message: retryable
        ? 'Grok сейчас недоступен. Попытка не потрачена — повторите позже.'
        : undefined,
      retryable
    });
  } finally {
    pending.delete(answerHash);
    if (!pending.size) pendingGrades.delete(pendingKey);
  }
});

app.post('/api/training/v2/preview/reset', (req, res) => {
  const name = nickname(req);
  histories.delete(name);
  theoryProgress.delete(name);
  const resetGeneration = (resetGenerations.get(name) || 0) + 1;
  resetGenerations.set(name, resetGeneration);
  res.json({ ok: true, resetGeneration, preview: true });
});

app.get('/api/training/v2/preview/status', (req, res) => {
  res.json({
    ok: true,
    preview: true,
    grokConfigured: Boolean(XAI_API_KEY),
    model: grading.MODEL
  });
});

app.all(/^\/api\/training\/(?!v2(?:\/|$)).*/, (req, res) => {
  res.status(410).json({
    error: 'legacy_training_disabled',
    message: 'Старая обучалка отключена. Используйте День 1.',
    preview: true
  });
});

app.get('/', (req, res) => {
  res.redirect('/learn/day1.html?preview=1');
});

const PRIVATE_PATHS = new Set([
  '/.env',
  '/package.json',
  '/package-lock.json',
  '/server.js',
  '/clear-db.js',
  '/learn/lessons.js',
  '/learn/app.js',
  '/learn/styles.css',
  '/learn/dashboard.html',
  '/learn/grading.js',
  '/learn/grading-v2.js',
  '/learn/grading-v2.test.js',
  '/learn/day1-theory.test.js',
  '/learn/day1-preview-server.js',
  '/learn/server.js',
  '/learn/results.json',
  '/learn/programs/day1-v1.js',
  '/learn/programs/day1-v1-rubrics.js'
]);

app.use((req, res, next) => {
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(String(req.path || ''));
  } catch (_) {
    return res.status(404).send('not found');
  }
  const normalizedPath = path.posix
    .normalize('/' + decodedPath.replace(/\\/g, '/'))
    .toLowerCase();
  if (
    PRIVATE_PATHS.has(normalizedPath) ||
    normalizedPath === '/learn/evals' ||
    normalizedPath.startsWith('/learn/evals/') ||
    normalizedPath === '/learn/programs' ||
    normalizedPath.startsWith('/learn/programs/') ||
    (normalizedPath.startsWith('/learn/') && normalizedPath.endsWith('.test.js')) ||
    normalizedPath.startsWith('/.env.') ||
    normalizedPath === '/node_modules' ||
    normalizedPath.startsWith('/node_modules/') ||
    normalizedPath === '/.git' ||
    normalizedPath.startsWith('/.git/')
  ) {
    return res.status(404).send('not found');
  }
  next();
});

const WORKSPACE_THEME_ASSETS = new Map([
  ['/workspace-theme.css', 'public/workspace-theme.css'],
  ['/workspace-theme.js', 'public/workspace-theme.js'],
  ['/panel.css', 'public/panel.css']
]);
app.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  const file = WORKSPACE_THEME_ASSETS.get(req.path);
  if (!file) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(path.join(ROOT_DIR, file));
});

app.use(express.static(ROOT_DIR, {
  dotfiles: 'deny',
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

const server = app.listen(PORT, HOST, () => {
  console.log(`Day 1 preview: http://${HOST}:${PORT}/learn/day1.html?preview=1`);
  console.log(`Grok grading: ${XAI_API_KEY ? 'enabled' : 'disabled (missing XAI_API_KEY)'}`);
});

server.on('error', error => {
  console.error('Preview server failed:', error.message);
  process.exitCode = 1;
});
