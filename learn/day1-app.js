(function () {
  'use strict';

  const PROGRAM_SLUG = 'day1-v1';
  const API_ROOT = '/api/training/v2/programs/' + PROGRAM_SLUG;
  const EXPECTED_TASKS = 8;
  const REQUIRED_AVERAGE = 85;
  const MAX_ATTEMPTS = 2;
  const PREVIEW_MODE = (
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === 'localhost'
  ) && new URLSearchParams(window.location.search).get('preview') === '1';
  let NICKNAME = PREVIEW_MODE ? 'preview-worker' : '';
  let resetGeneration = 0;
  const THEORY = window.DAY1_THEORY && typeof window.DAY1_THEORY === 'object'
    ? window.DAY1_THEORY
    : { id: 'day1-theory', version: 1, modules: [] };
  const THEORY_MODULES = Array.isArray(THEORY.modules) ? THEORY.modules : [];
  const TEXT = window.DAY1_TEXT && typeof window.DAY1_TEXT === 'object'
    ? window.DAY1_TEXT
    : null;
  if (!TEXT || typeof TEXT.normalizeAnswer !== 'function') {
    throw new Error('Day 1 text normalizer did not load.');
  }

  const dom = {
    title: document.getElementById('programTitle'),
    description: document.getElementById('programDescription'),
    completedLabel: document.getElementById('completedMetricLabel'),
    completed: document.getElementById('completedMetric'),
    averageLabel: document.getElementById('averageMetricLabel'),
    average: document.getElementById('averageMetric'),
    targetLabel: document.getElementById('targetMetricLabel'),
    target: document.getElementById('targetMetric'),
    overall: document.getElementById('overallStatus'),
    progress: document.getElementById('courseProgress'),
    progressBar: document.getElementById('courseProgressBar'),
    theoryStageButton: document.getElementById('theoryStageButton'),
    theoryStageMeta: document.querySelector('#theoryStageButton small'),
    practiceStageButton: document.getElementById('practiceStageButton'),
    courseSidebar: document.getElementById('courseSidebar'),
    briefingTitle: document.getElementById('briefingTitle'),
    briefingList: document.getElementById('briefingList'),
    stageNavigation: document.getElementById('stageNavigation'),
    navHeading: document.getElementById('navHeading'),
    navProgress: document.getElementById('navProgress'),
    navList: document.getElementById('taskNavList'),
    saveNote: document.getElementById('saveNote'),
    content: document.getElementById('taskContent'),
    toast: document.getElementById('toast')
  };

  let program = null;
  let tasks = [];
  let state = emptyState();
  let toastTimer = null;
  let activeStage = 'theory';
  let activeTheoryIndex = 0;
  let activeTaskIndex = 0;
  let theoryState = { completed: [] };
  const views = new Map();
  const navViews = new Map();
  const resultOverrides = new Map();
  const touchedTasks = new Set();
  const submissionErrors = new Map();

  function emptyState() {
    return {
      tasks: {},
      completedTasks: 0,
      totalTasks: EXPECTED_TASKS,
      averageScore: null,
      passed: false,
      theory: null,
      resetGeneration: 0
    };
  }

  function theoryStorageKey() {
    return [
      'training',
      PROGRAM_SLUG,
      'theory',
      encodeURIComponent(String(THEORY.id || 'day1-theory')),
      encodeURIComponent(String(THEORY.version || 1)),
      'generation',
      encodeURIComponent(String(resetGeneration || 0)),
      encodeURIComponent(NICKNAME)
    ].join(':');
  }

  function readTheoryState() {
    const fallback = { completed: [] };
    try {
      const parsed = JSON.parse(localStorage.getItem(theoryStorageKey()) || 'null');
      if (!parsed || !Array.isArray(parsed.completed)) return fallback;
      const validIds = new Set(THEORY_MODULES.map(function (module) {
        return String(module.id || '');
      }));
      return {
        completed: parsed.completed
          .map(String)
          .filter(function (id, index, all) {
            return validIds.has(id) && all.indexOf(id) === index;
          })
      };
    } catch (_) {
      return fallback;
    }
  }

  function writeTheoryState() {
    try {
      localStorage.setItem(theoryStorageKey(), JSON.stringify(theoryState));
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalizeTheoryProgress(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const source = Array.isArray(raw.completed)
      ? raw.completed
      : (Array.isArray(raw.completedModules)
        ? raw.completedModules
        : (Array.isArray(raw.moduleIds) ? raw.moduleIds : []));
    const validIds = new Set(THEORY_MODULES.map(function (module) {
      return String(module.id || '');
    }));
    return {
      completed: source.map(String).filter(function (id, index, all) {
        return validIds.has(id) && all.indexOf(id) === index;
      })
    };
  }

  function stateHasTheory(value) {
    return Boolean(value && typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, 'theory') && value.theory);
  }

  function cleanupStaleLocalGenerations(nextGeneration) {
    if (!NICKNAME) return;
    const encodedNickname = encodeURIComponent(NICKNAME);
    const generationMarker = ':generation:' + String(nextGeneration) + ':';
    const prefix = 'training:' + PROGRAM_SLUG + ':';
    try {
      const staleKeys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(prefix)) continue;
        const belongsToWorker = key.endsWith(':' + encodedNickname) ||
          key.includes(':draft:' + encodedNickname + ':task:');
        if (!belongsToWorker) continue;
        if (!key.includes(generationMarker)) staleKeys.push(key);
      }
      staleKeys.forEach(function (key) { localStorage.removeItem(key); });
    } catch (_) {}
  }

  function applyServerState(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const nextGeneration = finiteNumber(
      raw.resetGeneration !== undefined ? raw.resetGeneration : raw.reset_generation
    );
    if (nextGeneration !== null) {
      const normalizedGeneration = Math.max(0, Math.floor(nextGeneration));
      if (normalizedGeneration !== resetGeneration) {
        cleanupStaleLocalGenerations(normalizedGeneration);
      }
      resetGeneration = normalizedGeneration;
    }
    state = normalizeState(raw);
    state.resetGeneration = resetGeneration;

    if (stateHasTheory(raw)) {
      theoryState = normalizeTheoryProgress(raw.theory);
      writeTheoryState();
    } else {
      theoryState = readTheoryState();
    }
  }

  function completedTheoryCount() {
    return THEORY_MODULES.filter(function (module) {
      return theoryState.completed.includes(String(module.id || ''));
    }).length;
  }

  function isTheoryComplete() {
    return THEORY_MODULES.length > 0 &&
      completedTheoryCount() === THEORY_MODULES.length;
  }

  function theoryModuleComplete(module) {
    return theoryState.completed.includes(String(module.id || ''));
  }

  function firstIncompleteTheoryIndex() {
    const index = THEORY_MODULES.findIndex(function (module) {
      return !theoryModuleComplete(module);
    });
    return index === -1 ? Math.max(0, THEORY_MODULES.length - 1) : index;
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function finiteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatScore(value) {
    const score = finiteNumber(value);
    if (score === null) return '—';
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
  }

  function theoryMinutesLabel() {
    const value = String(THEORY.estimatedMinutes || '10–15').trim();
    return value ? value.replace(/\s*мин(?:ут[ыа]?)?\.?$/i, '') + ' мин' : '10–15 мин';
  }

  function normalizeAnswer(value) {
    return TEXT.normalizeAnswer(value);
  }

  function wordCount(value) {
    return TEXT.wordCount(value);
  }

  function messageCount(value) {
    return TEXT.messageCount(value);
  }

  function hasNonEnglishLetters(value) {
    const letters = String(value || '').match(/\p{L}/gu) || [];
    return letters.some(function (letter) {
      return !/\p{Script=Latin}/u.test(letter);
    });
  }

  function getTasksFromProgram(value) {
    if (value && Array.isArray(value.tasks)) return value.tasks.slice();
    if (value && Array.isArray(value.lessons)) {
      return value.lessons.reduce(function (all, lesson) {
        return all.concat(Array.isArray(lesson.tasks) ? lesson.tasks : []);
      }, []);
    }
    return [];
  }

  function normalizeState(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      tasks: raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {},
      completedTasks: finiteNumber(raw.completedTasks) || 0,
      totalTasks: finiteNumber(raw.totalTasks) || tasks.length || EXPECTED_TASKS,
      averageScore: finiteNumber(raw.averageScore),
      passed: raw.passed === true
    };
  }

  function taskState(taskId) {
    return state.tasks[taskId] && typeof state.tasks[taskId] === 'object'
      ? state.tasks[taskId]
      : {};
  }

  function attemptCount(value) {
    if (Array.isArray(value && value.attempts)) return value.attempts.length;
    const count = finiteNumber(value && value.attempts);
    return count === null ? 0 : Math.max(0, Math.floor(count));
  }

  function recordAnswer(record) {
    if (!record || typeof record !== 'object') return '';
    if (record.answer !== undefined) return String(record.answer || '');
    if (record.answerText !== undefined) return String(record.answerText || '');
    if (record.answer_text !== undefined) return String(record.answer_text || '');
    if (record.text !== undefined) return String(record.text || '');
    return '';
  }

  function recordScore(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.score !== undefined) return finiteNumber(record.score);
    if (record.averageScore !== undefined) return finiteNumber(record.averageScore);
    if (record.verdict && typeof record.verdict === 'object') return recordScore(record.verdict);
    if (record.result && typeof record.result === 'object') return recordScore(record.result);
    return null;
  }

  function recordFeedback(record) {
    if (!record || typeof record !== 'object') return '';
    if (typeof record.feedback_ru === 'string') return record.feedback_ru;
    const feedback = record.feedback;
    if (typeof feedback === 'string') return feedback;
    if (feedback && typeof feedback === 'object') {
      return String(feedback.text || feedback.summary || feedback.message || '');
    }
    if (record.verdict && typeof record.verdict === 'object') return recordFeedback(record.verdict);
    if (record.result && typeof record.result === 'object') return recordFeedback(record.result);
    return String(record.reason || '');
  }

  function recordPass(record) {
    if (!record || typeof record !== 'object') return null;
    if (typeof record.pass === 'boolean') return record.pass;
    if (record.verdict && typeof record.verdict === 'object') return recordPass(record.verdict);
    if (record.result && typeof record.result === 'object') return recordPass(record.result);
    return null;
  }

  function recordVerdict(record) {
    if (!record || typeof record !== 'object') return {};
    if (record.verdict && typeof record.verdict === 'object') return record.verdict;
    if (record.result && typeof record.result === 'object') return recordVerdict(record.result);
    return {};
  }

  function capLabel(reason) {
    const labels = {
      invalid_answer: 'некорректный формат ответа',
      non_english: 'ответ не на английском',
      off_task: 'ответ не выполняет задание',
      incoherent: 'ответ нельзя использовать как связное сообщение',
      task_hard_fail: 'нарушено критическое правило задания',
      prompt_injection: 'попытка повлиять на проверяющего',
      hostile: 'оскорбление или угроза клиенту',
      critical_gate: 'не выполнено обязательное требование задания'
    };
    return labels[reason] || String(reason || 'ограничение');
  }

  function isGraded(record) {
    if (!record || typeof record !== 'object') return false;
    return record.status === 'graded' || recordScore(record) !== null;
  }

  function recordTime(record) {
    if (!record || typeof record !== 'object') return 0;
    const raw = record.gradedAt || record.graded_at || record.updatedAt ||
      record.updated_at || record.createdAt || record.created_at;
    const time = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  function draftKey(taskId) {
    const programVersion = program && program.version !== undefined
      ? program.version
      : 'unknown';
    const rubricVersion = program && program.rubricVersion
      ? program.rubricVersion
      : 'unknown';
    return [
      'training',
      PROGRAM_SLUG,
      'program',
      encodeURIComponent(String(programVersion)),
      'rubric',
      encodeURIComponent(String(rubricVersion)),
      'generation',
      encodeURIComponent(String(resetGeneration || 0)),
      'draft',
      encodeURIComponent(NICKNAME),
      'task',
      encodeURIComponent(taskId)
    ].join(':');
  }

  // Production drafts created before reset generations were introduced use
  // this key. Generation zero migrates them once; a real admin reset does not.
  function legacyDraftKey(taskId) {
    const programVersion = program && program.version !== undefined
      ? program.version
      : 'unknown';
    const rubricVersion = program && program.rubricVersion
      ? program.rubricVersion
      : 'unknown';
    return [
      'training',
      PROGRAM_SLUG,
      'program',
      encodeURIComponent(String(programVersion)),
      'rubric',
      encodeURIComponent(String(rubricVersion)),
      'draft',
      encodeURIComponent(NICKNAME),
      'task',
      encodeURIComponent(taskId)
    ].join(':');
  }

  function readDraft(taskId) {
    try {
      const currentKey = draftKey(taskId);
      let value = localStorage.getItem(currentKey);
      if (value === null && resetGeneration === 0) {
        value = localStorage.getItem(legacyDraftKey(taskId));
        if (value !== null) {
          try { localStorage.setItem(currentKey, value); } catch (_) {}
        }
      }
      if (value === null) return null;
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && parsed.answer !== undefined) {
          return {
            answer: String(parsed.answer || ''),
            updatedAt: finiteNumber(parsed.updatedAt) || 0
          };
        }
      } catch (_) {}
      return { answer: value, updatedAt: 0 };
    } catch (_) {
      return null;
    }
  }

  function writeDraft(taskId, answer) {
    try {
      localStorage.setItem(draftKey(taskId), JSON.stringify({
        answer: String(answer || ''),
        updatedAt: Date.now()
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function initialAnswer(taskId) {
    const saved = taskState(taskId);
    const latest = saved.latest;
    const serverAnswer = recordAnswer(latest);
    const serverTime = recordTime(latest);
    const draft = readDraft(taskId);

    if (!draft) return serverAnswer;
    if (normalizeAnswer(draft.answer) === normalizeAnswer(serverAnswer)) return draft.answer;
    if (!serverAnswer || !serverTime || draft.updatedAt >= serverTime) return draft.answer;

    writeDraft(taskId, serverAnswer);
    return serverAnswer;
  }

  async function api(path, options) {
    const config = Object.assign({}, options || {});
    const headers = new Headers(config.headers || {});
    if (PREVIEW_MODE) headers.set('X-Nickname', NICKNAME || 'preview-worker');
    headers.set('Accept', 'application/json');
    if (config.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(path, Object.assign({}, config, {
      headers: headers,
      cache: 'no-store',
      credentials: 'same-origin'
    }));

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (!response.ok || data.ok === false) {
      const error = new Error(
        data.message || data.error || ('Сервер вернул ошибку ' + response.status)
      );
      error.status = response.status;
      error.data = data;
      const retryAfterHeader = Number(response.headers.get('Retry-After'));
      error.retryAfterSeconds = finiteNumber(data.retryAfterSeconds) ||
        (Number.isFinite(retryAfterHeader) ? retryAfterHeader : 0);
      throw error;
    }
    return data;
  }

  async function persistTheoryAnswer(module, selectedIndex) {
    const moduleId = String(module && module.id || '');
    if (!moduleId) return true;

    try {
      const response = await api(API_ROOT + '/theory', {
        method: 'POST',
        body: JSON.stringify({
          moduleId: moduleId,
          selectedIndex: selectedIndex,
          theoryId: String(THEORY.id || 'day1-theory'),
          theoryVersion: finiteNumber(THEORY.version) || 1
        })
      });

      if (response.correct === false) {
        if (response.state) applyServerState(response.state);
        const error = new Error('Сервер не принял ответ на мини-проверку.');
        error.status = 409;
        error.data = { error: 'incorrect_theory_answer' };
        throw error;
      }

      if (response.state && response.state.tasks) {
        applyServerState(response.state);
      } else if (response.state && response.state.theory) {
        theoryState = normalizeTheoryProgress(response.state.theory);
        const generation = finiteNumber(response.state.resetGeneration);
        if (generation !== null) resetGeneration = Math.max(0, Math.floor(generation));
        writeTheoryState();
      } else if (response.theory) {
        theoryState = normalizeTheoryProgress(response.theory);
        writeTheoryState();
      }
      return true;
    } catch (error) {
      const code = error && error.data && error.data.error;
      if (code === 'theory_module_locked' || code === 'theory_version_mismatch') {
        try { await refreshServerState(); } catch (_) {}
      }
      throw error;
    }
  }

  async function refreshServerState() {
    const response = await api(API_ROOT + '/state');
    if (response && response.state) applyServerState(response.state);
    return response && response.state;
  }

  function validationErrors(task, answer) {
    const errors = [];
    const normalized = normalizeAnswer(answer);
    const maxWords = finiteNumber(task.maxWords);
    const minMessages = finiteNumber(task.minMessages) || 1;
    const maxMessages = finiteNumber(task.maxMessages) || minMessages;
    const messages = messageCount(normalized);

    if (!normalized) errors.push('Напишите ответ перед отправкой.');
    if (normalized && hasNonEnglishLetters(normalized)) {
      errors.push('Ответ должен быть только на английском. Переводчиком пользоваться можно.');
    }
    if (maxWords !== null && wordCount(normalized) > maxWords) {
      errors.push('Сократите ответ до ' + maxWords + ' слов.');
    }
    if (normalized && (messages < minMessages || messages > maxMessages)) {
      errors.push(minMessages === maxMessages
        ? 'Нужно написать ровно ' + minMessages + ' ' + pluralMessage(minMessages) +
          ', разделяя сообщения переносом строки.'
        : 'Нужно написать от ' + minMessages + ' до ' + maxMessages +
          ' сообщений, разделяя их переносами строк.');
    }
    return errors;
  }

  function pluralMessage(count) {
    return count === 1 ? 'сообщение' : 'сообщения';
  }

  function sameAsKnownResult(taskId, answer) {
    const saved = taskState(taskId);
    const normalized = normalizeAnswer(answer);
    if (!normalized) return false;
    return [saved.latest, saved.best, resultOverrides.get(taskId)].some(function (record) {
      return isGraded(record) && normalizeAnswer(recordAnswer(record)) === normalized;
    });
  }

  function criteriaRows(record) {
    if (!record || typeof record !== 'object') return [];
    if (!record.criteria && record.verdict && typeof record.verdict === 'object') {
      return criteriaRows(record.verdict);
    }
    if (!record.criteria && record.result && typeof record.result === 'object') {
      return criteriaRows(record.result);
    }
    const criteria = record.criteria;
    const reasons = record.reasons && typeof record.reasons === 'object'
      ? record.reasons
      : {};

    if (Array.isArray(criteria)) {
      return criteria.map(function (criterion, index) {
        if (!criterion || typeof criterion !== 'object') {
          return {
            label: 'Критерий ' + (index + 1),
            score: criterion,
            max: null,
            reason: ''
          };
        }
        return {
          label: criterion.label || criterion.title || criterion.name ||
            criterion.key || ('Критерий ' + (index + 1)),
          score: criterion.rating !== undefined
            ? criterion.rating
            : (criterion.score !== undefined ? criterion.score : criterion.value),
          max: criterion.maxScore !== undefined
            ? criterion.maxScore
            : (criterion.max !== undefined ? criterion.max : (criterion.rating !== undefined ? 4 : null)),
          reason: criterion.reason_ru || criterion.reason || criterion.explanation ||
            criterion.feedback || '',
          evidence: criterion.evidence || ''
        };
      });
    }

    if (criteria && typeof criteria === 'object') {
      return Object.keys(criteria).map(function (key) {
        const value = criteria[key];
        if (value && typeof value === 'object') {
          return {
            label: value.label || value.title || value.name || key,
            score: value.rating !== undefined
              ? value.rating
              : (value.score !== undefined ? value.score : value.value),
            max: value.maxScore !== undefined
              ? value.maxScore
              : (value.max !== undefined ? value.max : (value.rating !== undefined ? 4 : null)),
            reason: value.reason_ru || value.reason || value.explanation || value.feedback ||
              reasons[key] || '',
            evidence: value.evidence || ''
          };
        }
        return {
          label: key,
          score: value,
          max: null,
          reason: reasons[key] || ''
        };
      });
    }
    return [];
  }

  function showToast(message, kind) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.dataset.kind = kind || 'info';
    dom.toast.classList.add('show');
    toastTimer = setTimeout(function () {
      dom.toast.classList.remove('show');
    }, 3600);
  }

  function scrollToStageContent() {
    const isNarrow = typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 860px)').matches;
    if (isNarrow && dom.content) {
      dom.content.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderSummary() {
    const theoryActive = activeStage === 'theory';
    dom.theoryStageButton.setAttribute(
      'aria-selected',
      theoryActive ? 'true' : 'false'
    );
    dom.practiceStageButton.setAttribute(
      'aria-selected',
      theoryActive ? 'false' : 'true'
    );
    dom.theoryStageButton.tabIndex = theoryActive ? 0 : -1;
    dom.practiceStageButton.tabIndex = theoryActive ? -1 : 0;
    dom.content.setAttribute(
      'aria-labelledby',
      theoryActive ? dom.theoryStageButton.id : dom.practiceStageButton.id
    );
    dom.content.dataset.stage = theoryActive ? 'theory' : 'practice';
    dom.theoryStageButton.dataset.complete = isTheoryComplete() ? 'true' : 'false';
    dom.practiceStageButton.dataset.complete = state.passed ? 'true' : 'false';
    dom.practiceStageButton.dataset.locked = isTheoryComplete() ? 'false' : 'true';
    dom.practiceStageButton.setAttribute(
      'aria-disabled',
      isTheoryComplete() ? 'false' : 'true'
    );

    if (activeStage === 'theory') {
      const totalTheory = THEORY_MODULES.length;
      const completedTheory = completedTheoryCount();
      const percentageTheory = totalTheory
        ? Math.round((completedTheory / totalTheory) * 100)
        : 0;

      dom.title.textContent = THEORY.title || 'День 1 — короткая база';
      dom.description.textContent = THEORY.subtitle ||
        'Как читать чат, держать лор и превращать контекст в живое сообщение.';
      document.title = 'Day 1 · Короткая база';
      dom.completedLabel.textContent = 'Темы';
      dom.completed.textContent = completedTheory + ' / ' + totalTheory;
      dom.averageLabel.textContent = 'Мини-проверки';
      dom.average.textContent = completedTheory + ' / ' + totalTheory;
      dom.targetLabel.textContent = 'Время';
      dom.target.textContent = theoryMinutesLabel();
      if (dom.theoryStageMeta) {
        dom.theoryStageMeta.textContent = totalTheory + ' тем · ' + theoryMinutesLabel();
      }
      dom.progress.setAttribute('aria-valuemax', String(totalTheory));
      dom.progress.setAttribute('aria-valuenow', String(completedTheory));
      dom.progressBar.style.width = percentageTheory + '%';

      if (!totalTheory) {
        dom.overall.textContent = 'Теория временно недоступна.';
        dom.overall.dataset.state = 'attention';
      } else if (isTheoryComplete()) {
        dom.overall.textContent = 'База пройдена. Можно переходить к письменной практике.';
        dom.overall.dataset.state = 'passed';
      } else {
        dom.overall.textContent = 'Коротко и по делу: одна тема и один простой вопрос за раз.';
        dom.overall.dataset.state = '';
      }
      return;
    }

    const total = state.totalTasks || tasks.length || EXPECTED_TASKS;
    const completed = Math.min(total, Math.max(0, state.completedTasks || 0));
    const percentage = total ? Math.round((completed / total) * 100) : 0;

    dom.title.textContent = program && program.title
      ? program.title
      : 'День 1 — письменная практика';
    dom.description.textContent = program && (
      program.subtitle || program.description
    ) || 'Восемь рабочих ответов на английском языке с индивидуальной проверкой.';
    document.title = (program && program.title ? program.title : 'Day 1') +
      ' · Обучение воркера';
    dom.completedLabel.textContent = 'Проверено';
    dom.completed.textContent = completed + ' / ' + total;
    dom.averageLabel.textContent = 'Средний балл';
    dom.average.textContent = completed === 0 || state.averageScore === null
      ? '—'
      : formatScore(state.averageScore) + ' / 100';
    dom.targetLabel.textContent = 'Порог';
    dom.target.textContent = (
      finiteNumber(program && program.passingScore) || REQUIRED_AVERAGE
    ) + ' / 100';
    dom.navProgress.textContent = completed + ' / ' + total;
    dom.progress.setAttribute('aria-valuemax', String(total));
    dom.progress.setAttribute('aria-valuenow', String(completed));
    dom.progressBar.style.width = percentage + '%';

    if (state.passed) {
      dom.overall.textContent = 'Day 1 пройден: все ответы проверены, средний балл не ниже 85.';
      dom.overall.dataset.state = 'passed';
    } else if (completed < total) {
      dom.overall.textContent = 'Нужно проверить ещё ' + (total - completed) +
        ' ' + pluralTask(total - completed) + '.';
      dom.overall.dataset.state = '';
    } else {
      const passingScore = finiteNumber(program && program.passingScore) || REQUIRED_AVERAGE;
      const minimumTaskScore = finiteNumber(program && program.minimumTaskScore) || 60;
      dom.overall.textContent = state.averageScore < passingScore
        ? 'Все ответы проверены. Поднимите средний балл до ' + passingScore + '.'
        : 'Средний балл набран, но за каждое задание нужно минимум ' + minimumTaskScore + '.';
      dom.overall.dataset.state = 'attention';
    }
  }

  function pluralTask(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'задание';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'задания';
    return 'заданий';
  }

  function renderNavigation() {
    dom.navList.replaceChildren();
    navViews.clear();

    if (activeStage === 'theory') {
      dom.courseSidebar.setAttribute('aria-label', 'Навигация по короткой базе');
      dom.stageNavigation.setAttribute('aria-label', 'Темы Day 1');
      dom.briefingTitle.textContent = 'Как пройти базу';
      replaceListItems(dom.briefingList, [
        'Читайте по одной короткой теме.',
        'Смотрите на логику чата, а не копируйте фразы.',
        'После каждой темы выберите один ответ.',
        'Ошибиться можно — попытки не ограничены.'
      ]);
      dom.navHeading.textContent = 'Короткая база';
      dom.navProgress.textContent = completedTheoryCount() + ' / ' + THEORY_MODULES.length;
      dom.saveNote.textContent = 'Прогресс теории сохраняется в рабочем аккаунте. К пройденным темам можно вернуться.';
      renderTheoryNavigation();
      return;
    }

    dom.courseSidebar.setAttribute('aria-label', 'Навигация по заданиям');
    dom.stageNavigation.setAttribute('aria-label', 'Задания Day 1');
    dom.briefingTitle.textContent = 'Перед практикой';
    replaceListItems(dom.briefingList, [
      'Ответ — только на английском.',
      'Переводчиком пользоваться можно.',
      'Готовые пасты и ИИ использовать нельзя.',
      'На каждое задание есть 2 попытки.',
      'Для зачёта нужны все 8 ответов, средний балл 85, минимум 60 и обязательные критерии каждого задания.'
    ]);
    dom.navHeading.textContent = 'Задания';
    dom.saveNote.textContent =
      'Черновики сохраняются на этом устройстве. Проверенные ответы и вердикты загружаются с сервера.';

    tasks.forEach(function (task, index) {
      const button = createElement('button', 'task-nav__item');
      button.type = 'button';
      button.dataset.active = index === activeTaskIndex ? 'true' : 'false';
      button.setAttribute('aria-current', index === activeTaskIndex ? 'step' : 'false');
      button.setAttribute('aria-label', 'Перейти к заданию ' + (index + 1) + ': ' + task.title);

      const number = createElement('span', 'task-nav__number', index + 1);
      const title = createElement('span', 'task-nav__title', task.title || ('Задание ' + (index + 1)));
      const status = createElement('span', 'task-nav__status');
      status.setAttribute('aria-hidden', 'true');

      button.append(number, title, status);
      button.addEventListener('click', function () {
        selectTask(index, true);
      });

      dom.navList.appendChild(button);
      navViews.set(task.id, button);
      const saved = taskState(task.id);
      if (isGraded(saved.best) || isGraded(saved.latest) || resultOverrides.has(task.id)) {
        button.dataset.status = 'checked';
      } else {
        const draft = readDraft(task.id);
        button.dataset.status = draft && normalizeAnswer(draft.answer) ? 'draft' : 'empty';
      }
    });
  }

  function replaceListItems(list, items) {
    list.replaceChildren();
    items.forEach(function (item) {
      list.appendChild(createElement('li', '', item));
    });
  }

  function renderTheoryNavigation() {
    const firstIncomplete = firstIncompleteTheoryIndex();

    THEORY_MODULES.forEach(function (module, index) {
      const moduleId = String(module.id || ('theory-' + index));
      const completed = theoryModuleComplete(module);
      const accessible = completed || index <= firstIncomplete;
      const button = createElement('button', 'task-nav__item');
      button.type = 'button';
      button.disabled = !accessible;
      button.dataset.status = completed
        ? 'checked'
        : (index === activeTheoryIndex ? 'draft' : 'empty');
      button.setAttribute(
        'aria-label',
        (accessible ? 'Открыть тему ' : 'Тема пока закрыта: ') +
          (index + 1) + ': ' + (module.title || '')
      );

      const number = createElement('span', 'task-nav__number', index + 1);
      const title = createElement(
        'span',
        'task-nav__title',
        module.title || ('Тема ' + (index + 1))
      );
      const status = createElement('span', 'task-nav__status');
      status.setAttribute('aria-hidden', 'true');
      button.append(number, title, status);

      if (accessible) {
        button.addEventListener('click', function () {
          activeTheoryIndex = index;
          renderTheory();
          renderNavigation();
          renderSummary();
          scrollToStageContent();
        });
      }

      dom.navList.appendChild(button);
      navViews.set(moduleId, button);
    });
  }

  function renderTheory() {
    views.clear();
    resultOverrides.clear();

    if (!THEORY_MODULES.length) {
      const panel = createElement('div', 'error-panel');
      panel.append(
        createElement('h2', '', 'Теория пока не загрузилась'),
        createElement(
          'p',
          '',
          'Обновите страницу. Письменная практика откроется после загрузки короткой базы.'
        )
      );
      const reloadButton = createElement(
        'button',
        'theory-primary',
        'Обновить страницу'
      );
      reloadButton.type = 'button';
      reloadButton.addEventListener('click', function () {
        window.location.reload();
      });
      panel.appendChild(reloadButton);
      dom.content.replaceChildren(panel);
      return;
    }

    activeTheoryIndex = Math.max(
      0,
      Math.min(activeTheoryIndex, THEORY_MODULES.length - 1)
    );
    const module = THEORY_MODULES[activeTheoryIndex];
    const shell = createElement('div', 'theory-shell');
    shell.appendChild(renderTheoryIntro());
    shell.appendChild(renderTheoryCard(module, activeTheoryIndex));
    dom.content.replaceChildren(shell);
  }

  function renderTheoryIntro() {
    const intro = createElement('section', 'theory-intro');
    const main = createElement('div', 'theory-intro__main');
    main.appendChild(createElement(
      'p',
      '',
      'Заранее знать модель не нужно: в каждой ситуации отдельно даны её факты, текущая сцена и доступный оффер. Реальные пасты ниже показывают манеру письма, но факты из одного примера нельзя переносить в другой.'
    ));

    const glossary = Array.isArray(THEORY.glossary) ? THEORY.glossary : [];
    if (glossary.length) {
      const details = createElement('details', 'theory-glossary');
      details.appendChild(createElement(
        'summary',
        '',
        'Рабочие термины · ' + glossary.length
      ));
      const list = createElement('dl', 'theory-glossary__list');
      glossary.forEach(function (item) {
        if (!item || !item.term || !item.definition) return;
        list.append(
          createElement('dt', '', item.term),
          createElement('dd', '', item.definition)
        );
      });
      details.appendChild(list);
      main.appendChild(details);
    }
    intro.appendChild(main);

    const cycle = createElement('div', 'theory-intro__cycle');
    ['Контекст', 'Реакция', 'Следующий ход'].forEach(function (label, index) {
      if (index) cycle.appendChild(createElement('b', 'theory-intro__arrow', '→'));
      cycle.appendChild(createElement('span', '', label));
    });
    intro.appendChild(cycle);
    return intro;
  }

  function renderTheoryCard(module, index) {
    const card = createElement('article', 'theory-card');
    card.id = 'theory-' + String(module.id || index);

    const header = createElement('header', 'theory-card__header');
    const number = createElement('span', 'theory-step', index + 1);
    const heading = createElement('div');
    heading.append(
      createElement('div', 'theory-kicker', module.kicker || 'База'),
      createElement('h2', '', module.title || ('Тема ' + (index + 1))),
      createElement('p', 'theory-lead', module.lead || '')
    );
    header.append(number, heading);
    card.appendChild(header);

    const media = Array.isArray(module.media) ? module.media : [];
    const body = createElement('div', 'theory-card__body');
    body.dataset.media = media.length ? 'true' : 'false';
    body.appendChild(renderTheoryCopy(module));
    if (media.length) body.appendChild(renderTheoryMedia(media));
    card.appendChild(body);
    card.appendChild(renderTheoryCheck(module, index));
    return card;
  }

  function renderTheoryCopy(module) {
    const copy = createElement('div', 'theory-copy');
    const points = Array.isArray(module.points) ? module.points : [];
    if (points.length) {
      const list = createElement('ul', 'theory-points');
      points.forEach(function (point) {
        list.appendChild(createElement('li', 'theory-point', point));
      });
      copy.appendChild(list);
    }

    if (module.rule) {
      copy.appendChild(createElement('div', 'theory-rule', module.rule));
    }

    const examples = Array.isArray(module.examples) ? module.examples : [];
    examples.forEach(function (example) {
      if (!example || !example.text) return;
      const box = createElement('section', 'theory-example');
      box.dataset.tone = example.tone || 'neutral';
      const labelRow = createElement('div', 'theory-example__heading');
      labelRow.appendChild(createElement(
        'div',
        'theory-example__label',
        example.label || 'Пример'
      ));
      const sourceLabels = {
        real: 'Реальная паста',
        adapted: 'Адаптировано из пасты',
        training: 'Учебный пример'
      };
      if (sourceLabels[example.sourceType]) {
        labelRow.appendChild(createElement(
          'span',
          'theory-example__source',
          sourceLabels[example.sourceType]
        ));
      }
      box.append(labelRow, createElement('blockquote', '', example.text));
      copy.appendChild(box);
    });

    return copy;
  }

  function renderTheoryMedia(media) {
    const container = createElement('div', 'theory-media-list');
    media.forEach(function (item) {
      if (!item || !item.src) return;
      const figure = createElement('figure', 'theory-media');
      const image = createElement('img');
      image.src = item.src;
      image.alt = item.alt || item.caption || 'Пример рабочего чата';
      image.decoding = 'async';
      const imageLink = createElement('a', 'theory-media__link');
      imageLink.href = item.src;
      imageLink.target = '_blank';
      imageLink.rel = 'noopener';
      imageLink.setAttribute('aria-label', 'Открыть скрин крупно: ' + image.alt);
      imageLink.appendChild(image);
      figure.appendChild(imageLink);
      if (item.caption) {
        figure.appendChild(createElement(
          'figcaption',
          '',
          item.caption + ' · нажмите на скрин, чтобы увеличить'
        ));
      }
      container.appendChild(figure);

      const callouts = Array.isArray(item.callouts) ? item.callouts : [];
      if (callouts.length) {
        const list = createElement('ul', 'theory-callouts');
        callouts.forEach(function (callout) {
          list.appendChild(createElement('li', '', callout));
        });
        container.appendChild(list);
      }
    });
    return container;
  }

  function renderTheoryCheck(module, index) {
    const check = module.check && typeof module.check === 'object'
      ? module.check
      : {};
    const completed = theoryModuleComplete(module);
    const section = createElement('section', 'theory-check');
    section.append(
      createElement('div', 'theory-check__eyebrow', 'Быстрая проверка'),
      createElement('h3', '', check.question || 'Тема понятна?')
    );

    const options = createElement('div', 'theory-options');
    const feedback = createElement('p', 'theory-feedback');
    const optionValues = Array.isArray(check.options) ? check.options : [];
    const correctIndex = finiteNumber(check.correctIndex);

    optionValues.forEach(function (option, optionIndex) {
      const button = createElement('button', 'theory-option', option);
      button.type = 'button';
      if (completed) {
        button.disabled = true;
        if (optionIndex === correctIndex) button.dataset.state = 'correct';
      } else {
        button.addEventListener('click', async function () {
          options.querySelectorAll('.theory-option').forEach(function (item) {
            item.dataset.state = '';
          });
          if (optionIndex !== correctIndex) {
            button.dataset.state = 'wrong';
            feedback.dataset.state = 'wrong';
            feedback.textContent = check.wrongFeedback ||
              'Не совсем. Посмотрите на правило выше и попробуйте ещё раз.';
            return;
          }

          button.dataset.state = 'correct';
          feedback.dataset.state = 'correct';
          feedback.textContent = check.explanation || 'Верно.';
          const moduleId = String(module.id || '');
          if (!theoryState.completed.includes(moduleId)) {
            theoryState.completed.push(moduleId);
            writeTheoryState();
          }
          button.disabled = true;
          feedback.textContent = 'Сохраняю прогресс…';
          try {
            await persistTheoryAnswer(module, optionIndex);
            renderTheory();
            renderNavigation();
            renderSummary();
          } catch (error) {
            theoryState.completed = theoryState.completed.filter(function (id) {
              return id !== moduleId;
            });
            writeTheoryState();
            activeTheoryIndex = firstIncompleteTheoryIndex();
            renderTheory();
            renderNavigation();
            renderSummary();
            showToast(friendlyError(error), 'error');
          }
        });
      }
      options.appendChild(button);
    });
    section.appendChild(options);

    const bottom = createElement('div', 'theory-check__bottom');
    if (completed) {
      feedback.dataset.state = 'correct';
      feedback.textContent = check.explanation || 'Верно.';
    } else {
      feedback.textContent = 'Выберите один вариант. Неверный ответ не считается попыткой.';
    }
    bottom.appendChild(feedback);

    if (completed) {
      const isLast = index === THEORY_MODULES.length - 1;
      const next = createElement(
        'button',
        'theory-next',
        isLast ? 'Перейти к практике' : 'Следующая тема'
      );
      next.type = 'button';
      next.addEventListener('click', function () {
        if (isLast) {
          switchStage('practice');
          return;
        }
        activeTheoryIndex = Math.min(THEORY_MODULES.length - 1, index + 1);
        renderTheory();
        renderNavigation();
        renderSummary();
        scrollToStageContent();
      });
      bottom.appendChild(next);
    }
    section.appendChild(bottom);
    return section;
  }

  function switchStage(stage, shouldScroll) {
    if (!program) {
      if (!NICKNAME) {
        renderLogin();
        showToast('Сначала войдите в рабочий аккаунт.', 'info');
      }
      return;
    }

    if (stage === 'practice' && !isTheoryComplete()) {
      showToast(
        THEORY_MODULES.length
          ? 'Сначала закончите шесть коротких тем.'
          : 'Теория не загрузилась. Обновите страницу.',
        'info'
      );
      activeStage = 'theory';
      activeTheoryIndex = firstIncompleteTheoryIndex();
    } else {
      activeStage = stage === 'practice' ? 'practice' : 'theory';
    }

    renderNavigation();
    if (activeStage === 'practice') {
      renderTasks();
    } else {
      renderTheory();
    }
    renderSummary();
    if (shouldScroll !== false) scrollToStageContent();
  }

  function selectTask(index, shouldScroll) {
    if (!tasks.length) return;
    activeTaskIndex = Math.max(0, Math.min(Number(index) || 0, tasks.length - 1));
    renderNavigation();
    renderTasks();
    renderSummary();
    if (shouldScroll !== false) scrollToStageContent();
  }

  function firstUnfinishedTaskIndex() {
    const index = tasks.findIndex(function (task) {
      const saved = taskState(task.id);
      return !isGraded(saved.best) && !isGraded(saved.latest);
    });
    return index === -1 ? 0 : index;
  }

  function renderProgramInstructions() {
    const raw = program && program.instructions;
    const lines = Array.isArray(raw)
      ? raw.map(String).filter(Boolean)
      : (typeof raw === 'string' && raw.trim() ? [raw.trim()] : []);
    if (!lines.length) return null;

    const details = createElement('details', 'practice-instructions');
    const summary = createElement('summary', '', 'Как читать условия практики');
    const body = createElement('div', 'practice-instructions__body');
    lines.forEach(function (line) {
      body.appendChild(createElement('p', '', line));
    });
    details.append(summary, body);
    return details;
  }

  function renderPracticeNavigation() {
    const nav = createElement('nav', 'practice-pagination');
    nav.setAttribute('aria-label', 'Переход между письменными заданиями');

    const position = createElement(
      'span',
      'practice-pagination__position',
      'Задание ' + (activeTaskIndex + 1) + ' из ' + tasks.length
    );
    const controls = createElement('div', 'practice-pagination__controls');
    const previous = createElement('button', 'practice-pagination__button', '← Предыдущее');
    previous.type = 'button';
    previous.disabled = activeTaskIndex === 0;
    previous.addEventListener('click', function () {
      selectTask(activeTaskIndex - 1, true);
    });

    const next = createElement(
      'button',
      'practice-pagination__button practice-pagination__button--primary',
      activeTaskIndex === tasks.length - 1 ? 'К первому заданию' : 'Следующее →'
    );
    next.type = 'button';
    next.addEventListener('click', function () {
      selectTask(activeTaskIndex === tasks.length - 1 ? 0 : activeTaskIndex + 1, true);
    });
    controls.append(previous, next);
    nav.append(position, controls);
    return nav;
  }

  function renderTasks() {
    const list = createElement('div', 'task-list');
    views.clear();

    if (!tasks.length) {
      list.appendChild(createElement('div', 'error-panel', 'Письменные задания не загрузились.'));
      dom.content.replaceChildren(list);
      return;
    }

    activeTaskIndex = Math.max(0, Math.min(activeTaskIndex, tasks.length - 1));
    const instructions = renderProgramInstructions();
    if (instructions) list.appendChild(instructions);
    list.appendChild(renderTaskCard(tasks[activeTaskIndex], activeTaskIndex));
    list.appendChild(renderPracticeNavigation());

    dom.content.replaceChildren(list);
    refreshAllViews();
  }

  function renderTaskCard(task, index) {
    const card = createElement('article', 'task-card');
    card.id = 'task-' + task.id;

    const header = createElement('header', 'task-card__header');
    const titleRow = createElement('div', 'task-title-row');
    const number = createElement('span', 'task-number', index + 1);
    const heading = createElement('h2', '', task.title || ('Задание ' + (index + 1)));
    heading.id = 'task-title-' + task.id;
    titleRow.append(number, heading);

    const attempts = createElement('span', 'task-attempts');
    header.append(titleRow, attempts);

    const brief = createElement('div', 'task-brief');
    if (task.context) brief.appendChild(createElement('p', 'task-context', task.context));
    brief.appendChild(createElement('p', 'task-prompt', task.prompt || ''));

    const workspace = createElement('div', 'task-workspace');
    const answerPanel = createElement('div', 'answer-panel');
    const inputId = 'answer-' + task.id;
    const label = createElement('label', 'answer-label');
    label.htmlFor = inputId;
    label.appendChild(document.createTextNode('Ответ на английском '));
    label.appendChild(createElement('span', '', '· переводчик разрешён'));

    const textarea = createElement('textarea', 'answer-input');
    textarea.id = inputId;
    textarea.rows = 7;
    textarea.spellcheck = true;
    textarea.autocomplete = 'off';
    textarea.placeholder = task.placeholder || 'Write your answer in English…';
    textarea.value = initialAnswer(task.id);

    const meta = createElement('div', 'answer-meta');
    const wordCounter = createElement('span', 'word-count');
    const messageCounter = createElement('span', 'message-count');
    const draftState = createElement('span', 'draft-state');
    meta.append(wordCounter, messageCounter, draftState);

    const validation = createElement('div', 'validation-message');
    validation.id = 'validation-' + task.id;
    const actions = createElement('div', 'answer-actions');
    const gradeButton = createElement('button', 'grade-button', 'Отправить на проверку');
    gradeButton.type = 'button';
    gradeButton.setAttribute('aria-describedby', validation.id);
    const buttonNote = createElement('span', 'button-note');
    actions.append(gradeButton, buttonNote);

    answerPanel.append(label, textarea, meta, validation, actions);

    const reviewPanel = createElement('aside', 'review-panel');
    reviewPanel.setAttribute('aria-label', 'Результат проверки задания ' + (index + 1));

    workspace.append(answerPanel, reviewPanel);
    card.append(header, brief, workspace);

    const view = {
      task: task,
      card: card,
      attempts: attempts,
      textarea: textarea,
      wordCounter: wordCounter,
      messageCounter: messageCounter,
      draftState: draftState,
      validation: validation,
      gradeButton: gradeButton,
      buttonNote: buttonNote,
      reviewPanel: reviewPanel,
      busy: false,
      touched: touchedTasks.has(task.id)
    };
    views.set(task.id, view);

    textarea.addEventListener('input', function () {
      touchedTasks.add(task.id);
      view.touched = true;
      const saved = writeDraft(task.id, textarea.value);
      draftState.textContent = saved ? 'Черновик сохранён' : 'Не удалось сохранить локально';
      draftState.dataset.saved = saved ? 'true' : 'false';
      resultOverrides.delete(task.id);
      submissionErrors.delete(task.id);
      refreshTaskView(task.id);
    });

    textarea.addEventListener('blur', function () {
      touchedTasks.add(task.id);
      view.touched = true;
      refreshTaskView(task.id);
    });

    gradeButton.addEventListener('click', function () {
      submitTask(task.id);
    });

    return card;
  }

  function refreshAllViews() {
    renderSummary();
    tasks.forEach(function (task) {
      refreshTaskView(task.id);
    });
  }

  function refreshTaskView(taskId) {
    const view = views.get(taskId);
    if (!view) return;

    const saved = taskState(taskId);
    const attempts = attemptCount(saved);
    const maxWords = finiteNumber(view.task.maxWords);
    const minMessages = finiteNumber(view.task.minMessages) || 1;
    const maxMessages = finiteNumber(view.task.maxMessages) || minMessages;
    const words = wordCount(view.textarea.value);
    const messages = messageCount(view.textarea.value);
    const errors = validationErrors(view.task, view.textarea.value);
    const known = sameAsKnownResult(taskId, view.textarea.value);
    const exhausted = attempts >= MAX_ATTEMPTS && !known;

    view.attempts.textContent = 'Попытки: ' + Math.min(attempts, MAX_ATTEMPTS) + ' / ' + MAX_ATTEMPTS;
    view.attempts.dataset.exhausted = exhausted ? 'true' : 'false';
    view.wordCounter.textContent = maxWords === null
      ? words + ' слов'
      : words + ' / ' + maxWords + ' слов';
    view.wordCounter.dataset.over = maxWords !== null && words > maxWords ? 'true' : 'false';
    if (minMessages > 1 || maxMessages > 1) {
      const expected = minMessages === maxMessages
        ? String(minMessages)
        : minMessages + '–' + maxMessages;
      view.messageCounter.textContent = 'Сообщения: ' + messages + ' / ' + expected;
      view.messageCounter.dataset.invalid = (
        messages < minMessages || messages > maxMessages
      ) ? 'true' : 'false';
    } else {
      view.messageCounter.textContent = '';
      view.messageCounter.dataset.invalid = 'false';
    }
    const submissionError = submissionErrors.get(taskId) || '';
    const visibleValidation = view.touched ? (errors[0] || '') : '';
    view.validation.textContent = submissionError || visibleValidation;
    view.validation.dataset.kind = submissionError ? 'connection' : (visibleValidation ? 'validation' : '');
    view.textarea.setAttribute(
      'aria-invalid',
      visibleValidation && !submissionError ? 'true' : 'false'
    );

    if (!view.draftState.textContent) {
      const local = readDraft(taskId);
      if (local !== null) {
        view.draftState.textContent = 'Черновик восстановлен';
        view.draftState.dataset.saved = 'true';
      }
    }

    view.gradeButton.disabled = view.busy || exhausted || known;
    view.gradeButton.replaceChildren();

    if (view.busy) {
      view.gradeButton.append(
        createElement('span', 'button-spinner'),
        document.createTextNode('Проверяю…')
      );
      view.buttonNote.textContent = 'Не закрывайте страницу до получения результата.';
    } else {
      view.gradeButton.textContent = known ? 'Ответ уже проверен' : 'Отправить на проверку';
      if (known) {
        view.buttonNote.textContent = 'Показываем сохранённый вердикт — повторный запрос не нужен.';
      } else if (exhausted) {
        view.buttonNote.textContent = 'Две попытки использованы. Обратитесь к наставнику.';
      } else {
        const left = MAX_ATTEMPTS - attempts;
        view.buttonNote.textContent = 'Осталось попыток: ' + left + '.';
      }
    }

    renderReview(taskId);
    updateNavItem(taskId);
  }

  function updateNavItem(taskId) {
    const nav = navViews.get(taskId);
    const view = views.get(taskId);
    if (!nav || !view) return;

    const saved = taskState(taskId);
    if (isGraded(saved.best) || isGraded(saved.latest) || resultOverrides.has(taskId)) {
      nav.dataset.status = 'checked';
    } else if (normalizeAnswer(view.textarea.value)) {
      nav.dataset.status = 'draft';
    } else {
      nav.dataset.status = 'empty';
    }
  }

  function sameResultRecord(first, second) {
    if (!first || !second) return false;
    if (first === second) return true;
    if (first.id !== undefined && second.id !== undefined) {
      return String(first.id) === String(second.id);
    }
    if (first.answerHash && second.answerHash) {
      return first.answerHash === second.answerHash && recordScore(first) === recordScore(second);
    }
    return normalizeAnswer(recordAnswer(first)) === normalizeAnswer(recordAnswer(second)) &&
      recordScore(first) === recordScore(second) && recordTime(first) === recordTime(second);
  }

  function appendCriteriaReview(container, record) {
    const criteria = criteriaRows(record);
    const feedback = recordFeedback(record);
    if (!criteria.length) {
      if (!feedback) container.appendChild(createElement(
        'div',
        'feedback-box',
        'Вердикт сохранён. Детализация критериев для этой попытки не передана.'
      ));
      return;
    }

    const list = createElement('div', 'criteria-list');
    criteria.forEach(function (criterion) {
      const item = createElement('div', 'criterion');
      const top = createElement('div', 'criterion__top');
      top.appendChild(createElement('span', 'criterion__label', criterion.label));

      const criterionScore = finiteNumber(criterion.score);
      const criterionMax = finiteNumber(criterion.max);
      let scoreText = '';
      if (criterionScore !== null) {
        scoreText = formatScore(criterionScore);
        if (criterionMax !== null) scoreText += ' / ' + formatScore(criterionMax);
      }
      if (scoreText) top.appendChild(createElement('span', 'criterion__score', scoreText));
      item.appendChild(top);
      if (criterion.reason) item.appendChild(createElement('p', 'criterion__reason', criterion.reason));
      if (criterion.evidence) {
        item.appendChild(createElement(
          'p',
          'criterion__evidence',
          'Фрагмент ответа: “' + criterion.evidence + '”'
        ));
      }
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  function renderReviewRecord(record, label) {
    const section = createElement('section', 'review-record');
    const summary = createElement('div', 'review-summary');
    const scoreBlock = createElement('div', 'score-block');
    const score = recordScore(record);
    const passed = recordPass(record);
    const minimum = finiteNumber(program && program.minimumTaskScore) || 60;
    const verdict = recordVerdict(record);
    const failedCritical = Array.isArray(verdict.critical)
      ? verdict.critical.filter(function (item) { return item && item.ok === false; })
      : [];
    const criticalFailed = verdict.criticalOk === false || failedCritical.length > 0;
    const capReason = String(verdict.scoreCapReasonRu || '').trim();

    const scoreValue = createElement('span', 'score-value', formatScore(score));
    scoreValue.dataset.passed = passed === true ? 'true' : 'false';
    scoreBlock.append(
      scoreValue,
      createElement('span', 'score-suffix', '/ 100 · ' + label.toLowerCase())
    );
    summary.appendChild(scoreBlock);

    const cached = record.cached === true || record.fromCache === true ||
      record.cacheHit === true || record.reused === true;
    summary.appendChild(createElement(
      'span',
      'result-origin',
      cached ? 'Из сохранённых' : 'Сохранено'
    ));
    section.appendChild(summary);

    const gate = createElement('div', 'gate-status');
    if (passed === true) {
      gate.dataset.state = 'passed';
      gate.textContent = 'Зачёт: балл и обязательные требования выполнены.';
    } else if (criticalFailed) {
      gate.dataset.state = 'failed';
      gate.textContent = capReason || (score !== null && score >= minimum
        ? 'Не зачёт: балл выше минимума, но провалено обязательное требование.'
        : 'Не зачёт: провалено обязательное требование задания.');
    } else {
      gate.dataset.state = 'failed';
      gate.textContent = 'Не зачёт. 60 баллов — только числовой минимум; обязательные требования тоже должны быть выполнены.';
    }
    section.appendChild(gate);

    const feedback = recordFeedback(record);
    if (feedback) section.appendChild(createElement('div', 'feedback-box', feedback));

    const caps = Array.isArray(verdict.caps) ? verdict.caps : [];
    if (caps.length || criticalFailed) {
      const reasons = [];
      if (capReason) {
        reasons.push(capReason);
      } else if (caps.length) {
        reasons.push('Оценка ограничена: ' + caps.map(function (item) {
          return String(item.reason_ru || '').trim() || capLabel(item.reason);
        }).join(', ') + '.');
      }
      if (criticalFailed) {
        reasons.push('Посмотрите критерии ниже: хотя бы один обязательный пункт не выполнен.');
      }
      if (verdict.integrity && verdict.integrity.reason_ru) {
        reasons.push(verdict.integrity.reason_ru);
      }
      if (verdict.language && verdict.language.is_english === false && verdict.language.reason_ru) {
        reasons.push(verdict.language.reason_ru);
      }
      section.appendChild(createElement('div', 'decision-box', reasons.join(' ')));
    }

    appendCriteriaReview(section, record);
    return section;
  }

  function renderReview(taskId) {
    const view = views.get(taskId);
    if (!view) return;

    const saved = taskState(taskId);
    const override = resultOverrides.get(taskId);
    const best = saved.best || override || saved.latest;
    const latest = override || saved.latest;
    const primary = best || latest;
    const panel = view.reviewPanel;
    panel.replaceChildren();
    panel.appendChild(createElement('span', 'review-heading', 'Сохранённый разбор'));

    if (!primary || !isGraded(primary)) {
      const empty = createElement('div', 'review-empty');
      empty.append(
        createElement('strong', '', 'Результата пока нет'),
        createElement('p', '', 'После отправки здесь появятся балл, критерии и причины оценки.')
      );
      panel.appendChild(empty);
      return;
    }

    if (best && latest && !sameResultRecord(best, latest)) {
      panel.appendChild(renderReviewRecord(latest, 'Последняя попытка'));
      panel.appendChild(renderReviewRecord(best, 'Лучший результат'));
    } else {
      panel.appendChild(renderReviewRecord(primary, 'Лучший результат'));
    }
  }

  function mergeFallbackResult(taskId, result, answer) {
    const previous = taskState(taskId);
    const attempts = attemptCount(previous);
    const enriched = Object.assign({}, result || {}, { answer: answer });
    const previousBest = previous.best;
    const previousBestScore = recordScore(previousBest);
    const resultScore = recordScore(enriched);
    const previousBestPass = recordPass(previousBest) === true;
    const resultPass = recordPass(enriched) === true;
    const best = previousBest && (
      (previousBestPass && !resultPass) ||
      (previousBestPass === resultPass &&
        previousBestScore !== null &&
        resultScore !== null &&
        previousBestScore >= resultScore)
    ) ? previousBest : enriched;

    state.tasks[taskId] = {
      latest: enriched,
      best: best,
      attempts: result && (
        result.cached === true ||
        result.cacheHit === true ||
        result.reused === true
      ) ? attempts : Math.min(MAX_ATTEMPTS, attempts + 1)
    };
  }

  async function submitTask(taskId) {
    const view = views.get(taskId);
    if (!view || view.busy) return;

    const answer = normalizeAnswer(view.textarea.value);
    const errors = validationErrors(view.task, answer);
    const attempts = attemptCount(taskState(taskId));
    touchedTasks.add(taskId);
    view.touched = true;
    submissionErrors.delete(taskId);
    if (errors.length) {
      view.validation.textContent = errors[0];
      view.validation.dataset.kind = 'validation';
      view.textarea.setAttribute('aria-invalid', 'true');
      view.textarea.focus();
      return;
    }
    if (attempts >= MAX_ATTEMPTS || sameAsKnownResult(taskId, answer)) {
      refreshTaskView(taskId);
      return;
    }

    view.busy = true;
    refreshTaskView(taskId);

    try {
      const response = await api(
        API_ROOT + '/tasks/' + encodeURIComponent(taskId) + '/grade',
        {
          method: 'POST',
          body: JSON.stringify({ answer: answer })
        }
      );

      if (response.state) {
        applyServerState(response.state);
      } else {
        mergeFallbackResult(taskId, response.result, answer);
      }

      const result = Object.assign({}, response.result || {}, {
        answer: recordAnswer(response.result) || answer
      });
      resultOverrides.set(taskId, result);
      submissionErrors.delete(taskId);
      writeDraft(taskId, answer);
      refreshAllViews();

      const score = recordScore(result);
      showToast(
        score === null
          ? 'Вердикт сохранён.'
          : 'Вердикт сохранён: ' + formatScore(score) + ' / 100.',
        'info'
      );
    } catch (error) {
      const message = friendlyError(error);
      const code = error && error.data && error.data.error;
      if (code === 'theory_required') {
        try { await refreshServerState(); } catch (_) {}
        submissionErrors.delete(taskId);
        activeStage = 'theory';
        activeTheoryIndex = firstIncompleteTheoryIndex();
        renderNavigation();
        renderTheory();
        renderSummary();
      } else {
        submissionErrors.set(taskId, message);
      }
      showToast(message, 'error');
    } finally {
      view.busy = false;
      refreshTaskView(taskId);
    }
  }

  function friendlyError(error) {
    if (!error) return 'Не удалось проверить ответ. Попробуйте ещё раз.';
    const code = error.data && error.data.error;
    if (code === 'grader_unavailable') return 'Grok сейчас недоступен. Попытка не потрачена — попробуйте ещё раз чуть позже.';
    if (code === 'grader_busy') return 'Сейчас слишком много проверок Grok. Попытка не потрачена — попробуйте ещё раз чуть позже.';
    if (code === 'rate_limited') {
      const wait = finiteNumber(error.retryAfterSeconds);
      return wait && wait <= 120
        ? 'Слишком много проверок подряд. Подождите ' + Math.ceil(wait) + ' сек.; попытка не потрачена.'
        : 'Слишком много проверок подряд. Подождите несколько минут; попытка не потрачена.';
    }
    if (code === 'word_limit_exceeded') return 'Ответ превышает лимит слов для этого задания.';
    if (code === 'message_count_mismatch') return 'Проверьте количество сообщений и разделите их переносами строк.';
    if (code === 'empty_answer' || code === 'answer_too_short') return 'Ответ слишком короткий для проверки.';
    if (code === 'answer_too_long') return 'Ответ слишком длинный для проверки.';
    if (code === 'max_attempts_reached') return 'Две попытки использованы. Обратитесь к наставнику.';
    if (code === 'grading_in_progress') return 'Этот ответ уже проверяется в другой вкладке. Подождите результат.';
    if (code === 'grading_error') return 'Grok не смог корректно разобрать ответ. Попытка не потрачена — отправьте ещё раз.';
    if (code === 'internal_error') return 'Внутренняя ошибка сайта. Черновик сохранён, попытка не потрачена; попробуйте чуть позже.';
    if (code === 'attempt_reservation_lost') return 'Состояние теста изменилось во время проверки. Попытка не потрачена — обновите страницу.';
    if (code === 'theory_required') return 'Прогресс Day 1 был сброшен. Сначала снова закончите короткую базу.';
    if (code === 'theory_module_locked') return 'Прогресс теории изменился. Открыта первая непройденная тема.';
    if (code === 'theory_version_mismatch') return 'Теория обновилась. Обновите страницу и пройдите актуальную версию.';
    if (code === 'incorrect_theory_answer') return 'Этот вариант не принят. Посмотрите правило и попробуйте ещё раз.';
    if (code === 'invalid_selected_index') return 'Не удалось сохранить вариант ответа. Обновите страницу.';
    if (error.status === 401) return 'Сессия не найдена. Снова войдите через панель.';
    if (error.status === 403) return 'Для этого аккаунта Day 1 недоступен.';
    if (error.status === 409) return 'Состояние теста изменилось. Обновите страницу и попробуйте ещё раз.';
    if (error.status === 429) return 'Слишком много проверок подряд. Подождите несколько минут и попробуйте ещё раз.';
    if (error.status >= 500) return 'Временная ошибка сайта. Черновик сохранён, попытка не потрачена; попробуйте чуть позже.';
    if (
      !error.status ||
      error instanceof TypeError ||
      /failed to fetch|network|load failed/i.test(String(error.message || ''))
    ) {
      return 'Соединение потеряно. Черновик сохранён, ошибка не расходует попытку. Проверьте интернет и отправьте ещё раз.';
    }
    return 'Не удалось проверить ответ. Черновик сохранён, попробуйте ещё раз.';
  }

  function renderLogin() {
    dom.title.textContent = 'Нужен вход';
    dom.description.textContent = 'Day 1 сохраняет ответы под вашим рабочим ником.';
    dom.overall.textContent = 'Сначала войдите в панель.';
    dom.content.replaceChildren();

    const panel = createElement('div', 'login-panel');
    panel.append(
      createElement('h2', '', 'Войдите в рабочий аккаунт'),
      createElement(
        'p',
        '',
        'Откройте панель, войдите под своим ником и вернитесь на эту страницу.'
      )
    );
    const link = createElement('a', 'login-link', 'Перейти в панель');
    link.href = '/admin';
    panel.appendChild(link);
    dom.content.appendChild(panel);
  }

  function renderLoadError(error) {
    dom.overall.textContent = 'Day 1 не загружен';
    dom.overall.dataset.state = 'attention';
    dom.content.replaceChildren();

    const panel = createElement('div', 'error-panel');
    panel.append(
      createElement('h2', '', 'Не удалось загрузить задания'),
      createElement('p', '', friendlyError(error))
    );
    const retry = createElement('button', 'retry-button', 'Попробовать снова');
    retry.type = 'button';
    retry.addEventListener('click', load);
    panel.appendChild(retry);
    dom.content.appendChild(panel);
  }

  async function bootstrapIdentity() {
    if (PREVIEW_MODE) {
      NICKNAME = 'preview-worker';
      return;
    }

    const identity = await api('/api/auth/check');
    NICKNAME = String(identity && identity.nickname || '').trim();
    if (!NICKNAME) {
      const error = new Error('Сессия не найдена.');
      error.status = 401;
      throw error;
    }
    try {
      localStorage.setItem('nickname', NICKNAME);
    } catch (_) {}
  }

  async function load() {
    dom.overall.textContent = 'Загрузка сохранённых результатов…';
    dom.overall.dataset.state = '';

    try {
      await bootstrapIdentity();
      const responses = await Promise.all([
        api(API_ROOT),
        api(API_ROOT + '/state')
      ]);
      program = responses[0].program;
      tasks = getTasksFromProgram(program);

      if (
        !program ||
        program.version === undefined ||
        !program.rubricVersion ||
        tasks.length !== EXPECTED_TASKS
      ) {
        throw new Error('Day 1 должен содержать ровно 8 письменных заданий.');
      }

      applyServerState(responses[1].state);
      activeTheoryIndex = firstIncompleteTheoryIndex();
      activeTaskIndex = firstUnfinishedTaskIndex();
      activeStage = isTheoryComplete() ? 'practice' : 'theory';
      switchStage(activeStage, false);
    } catch (error) {
      if (error && error.status === 401) {
        renderLogin();
      } else {
        renderLoadError(error);
      }
    }
  }

  dom.theoryStageButton.addEventListener('click', function () {
    switchStage('theory');
  });
  dom.practiceStageButton.addEventListener('click', function () {
    switchStage('practice');
  });
  [dom.theoryStageButton, dom.practiceStageButton].forEach(function (button) {
    button.addEventListener('keydown', function (event) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();

      const buttons = [dom.theoryStageButton, dom.practiceStageButton];
      const currentIndex = buttons.indexOf(event.currentTarget);
      let nextIndex = currentIndex;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = buttons.length - 1;
      if (event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      }
      if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % buttons.length;
      }

      const nextButton = buttons[nextIndex];
      nextButton.focus();
      if (nextButton === dom.practiceStageButton && !isTheoryComplete()) return;
      switchStage(nextButton === dom.practiceStageButton ? 'practice' : 'theory');
    });
  });

  load();
})();
