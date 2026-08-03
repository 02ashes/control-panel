'use strict';

(function day1Dashboard() {
  const API_RESULTS = '/api/training/v2/admin/day1-v1/results';
  const API_RESET = '/api/training/v2/admin/day1-v1/reset';
  const NICKNAME = String(localStorage.getItem('nickname') || '').trim();

  const CRITERION_LABELS = {
    context_use: 'Использование контекста',
    reply_hook: 'Повод ответить',
    fact_fidelity: 'Точность фактов',
    commercial_restraint: 'Отсутствие ранней продажи',
    format_language: 'Формат и язык',
    nonverbal_channel: 'Реакция без печатного ответа',
    interest_use: 'Использование доступного интереса',
    no_silence_pressure: 'Нет давления за молчание',
    context_response: 'Ответ на сообщение Daniel',
    flirt_bridge: 'Переход во флирт',
    boundary_control: 'Контроль первого перехода',
    format_facts_language: 'Формат, факты и язык',
    fetish_match: 'Попадание в заявленный фетиш',
    watcher_role: 'Роль наблюдателя',
    profile_evidence: 'Доказательство чтения профиля',
    complaint_response: 'Реакция на жалобу Mark',
    continuation_hook: 'Продолжение фантазии',
    format_safety_commerce: 'Формат, согласованность и отсутствие продажи',
    personalization: 'Персонализация под Alex',
    content_accuracy: 'Точность описания контента',
    freshness_frame: 'Корректный live-эффект',
    teaser_transition: 'Переход от ответа к PPV',
    price_offer: 'Цена и понятный оффер',
    two_step_format: 'Тизер и платный шаг',
    objection_acknowledgement: 'Признание возражения',
    appropriate_offer: 'Подходящий следующий оффер',
    price_content_pair: 'Соответствие цены и контента',
    relevance_and_hook: 'Релевантность и продолжение',
    no_pressure_format: 'Без давления и скидок',
    profile_personalization: 'Персонализация под Chris',
    scenario_actions: 'Конкретный мини-сценарий',
    deliverable_accuracy: 'Точность формата кастома',
    personal_exclusivity: 'Персональность результата',
    price_close_format: 'Цена, закрытие и формат',
    direct_answer: 'Прямой ответ на возражение',
    upgrade_components: 'Состав допки',
    time_value: 'Обоснование ценности',
    price_accuracy: 'Точная дополнительная цена',
    close_no_pressure_format: 'Закрытие без давления'
  };

  const elements = {
    refreshButton: document.getElementById('refreshButton'),
    candidateCount: document.getElementById('candidateCount'),
    passedCount: document.getElementById('passedCount'),
    averageScore: document.getElementById('averageScore'),
    attentionCount: document.getElementById('attentionCount'),
    updatedAt: document.getElementById('updatedAt'),
    candidateSearch: document.getElementById('candidateSearch'),
    visibleCount: document.getElementById('visibleCount'),
    candidateList: document.getElementById('candidateList'),
    candidateDetails: document.getElementById('candidateDetails'),
    toast: document.getElementById('toast')
  };

  const state = {
    program: null,
    students: [],
    selectedNickname: '',
    search: '',
    loading: false,
    toastTimer: null
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatScore(value) {
    const number = finiteNumber(value, null);
    if (number === null) return '—';
    return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function formatDate(timestamp) {
    const value = finiteNumber(timestamp, 0);
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function pluralAttempts(value) {
    const count = finiteNumber(value, 0);
    const lastTwo = count % 100;
    const last = count % 10;
    if (lastTwo >= 11 && lastTwo <= 14) return `${count} попыток`;
    if (last === 1) return `${count} попытка`;
    if (last >= 2 && last <= 4) return `${count} попытки`;
    return `${count} попыток`;
  }

  function showToast(message, tone) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.dataset.tone = tone || 'default';
    elements.toast.dataset.visible = 'true';
    state.toastTimer = window.setTimeout(() => {
      elements.toast.dataset.visible = 'false';
    }, 3200);
  }

  async function requestJson(url, options) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        'X-Nickname': NICKNAME,
        ...(options && options.headers ? options.headers : {})
      }
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }

    if (!response.ok || !payload || payload.ok === false) {
      const error = new Error(payload && payload.error ? payload.error : `http_${response.status}`);
      error.status = response.status;
      error.code = payload && payload.error ? payload.error : '';
      throw error;
    }
    return payload;
  }

  function latestActivity(student) {
    return finiteNumber(student && student.lastActivity, 0);
  }

  function studentByNickname(nickname) {
    return state.students.find(student => student.nickname === nickname) || null;
  }

  function getFilteredStudents() {
    const query = state.search.trim().toLocaleLowerCase('ru-RU');
    if (!query) return state.students;
    return state.students.filter(student =>
      String(student.nickname || '').toLocaleLowerCase('ru-RU').includes(query)
    );
  }

  function renderSummary() {
    const total = state.students.length;
    const passed = state.students.filter(student => Boolean(student.state && student.state.passed)).length;
    const scores = state.students
      .map(student => finiteNumber(student.state && student.state.averageScore, null))
      .filter(score => score !== null);
    const average = scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : null;

    elements.candidateCount.textContent = String(total);
    elements.passedCount.textContent = String(passed);
    elements.averageScore.textContent = average === null ? '—' : `${formatScore(average)} / 100`;
    elements.attentionCount.textContent = String(total - passed);
  }

  function renderCandidateList() {
    const students = getFilteredStudents();
    elements.visibleCount.textContent = state.search
      ? `${students.length} из ${state.students.length}`
      : String(students.length);

    if (!students.length) {
      elements.candidateList.innerHTML = `
        <div class="list-empty">
          ${state.students.length ? 'По этому запросу никого нет.' : 'Пока нет ни одной отправленной работы.'}
        </div>
      `;
      return;
    }

    elements.candidateList.innerHTML = students.map((student, index) => {
      const progress = student.state || {};
      const completed = finiteNumber(progress.completedTasks, 0);
      const total = finiteNumber(progress.totalTasks, (state.program && state.program.tasks || []).length);
      const average = formatScore(progress.averageScore);
      const selected = student.nickname === state.selectedNickname;
      return `
        <button
          class="candidate-row"
          type="button"
          data-visible-index="${index}"
          aria-current="${selected ? 'true' : 'false'}"
        >
          <span class="candidate-row__main">
            <span class="candidate-row__name">${escapeHtml(student.nickname || 'Без ника')}</span>
            <span class="candidate-row__progress">${completed} / ${total} · ${escapeHtml(formatDate(latestActivity(student)))}</span>
          </span>
          <span class="candidate-row__score" data-passed="${Boolean(progress.passed)}">${average}</span>
        </button>
      `;
    }).join('');

    elements.candidateList.querySelectorAll('.candidate-row').forEach(button => {
      button.addEventListener('click', () => {
        const student = students[Number(button.dataset.visibleIndex)];
        if (!student) return;
        state.selectedNickname = student.nickname;
        renderCandidateList();
        renderCandidateDetails();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  function criterionEntries(criteria) {
    if (Array.isArray(criteria)) {
      return criteria.map((value, index) => [
        String(value && (value.id || value.key) || `criterion_${index + 1}`),
        value || {}
      ]);
    }
    if (!criteria || typeof criteria !== 'object') return [];
    return Object.entries(criteria);
  }

  function renderCriteria(criteria) {
    const entries = criterionEntries(criteria);
    if (!entries.length) {
      return '<p class="criterion__copy">Критерии для этой попытки не сохранены.</p>';
    }

    return `
      <div class="criteria-grid">
        ${entries.map(([id, criterion]) => {
          const rating = finiteNumber(criterion && (criterion.rating ?? criterion.score ?? criterion.value), null);
          const evidence = String(criterion && criterion.evidence || '').trim();
          const reason = String(criterion && (criterion.reason_ru || criterion.reason || criterion.explanation) || '').trim();
          const label = String(
            criterion && criterion.label ||
            CRITERION_LABELS[id] ||
            id.replace(/_/g, ' ')
          );
          return `
            <article class="criterion">
              <div class="criterion__top">
                <div class="criterion__name">
                  ${escapeHtml(label)}
                  <span class="criterion__id">${escapeHtml(id)}</span>
                </div>
                <span class="criterion__rating">${rating === null ? '—' : rating} / 4</span>
              </div>
              <p class="criterion__copy">
                <strong>Evidence:</strong> ${evidence ? `“${escapeHtml(evidence)}”` : 'нет цитаты'}
              </p>
              <p class="criterion__copy">
                <strong>reason_ru:</strong> ${reason ? escapeHtml(reason) : '—'}
              </p>
            </article>
          `;
        }).join('')}
      </div>
    `;
  }

  function sameAttempt(first, second) {
    if (!first || !second) return false;
    if (first.id !== undefined && second.id !== undefined) return Number(first.id) === Number(second.id);
    return first.createdAt === second.createdAt && first.answer === second.answer;
  }

  function attemptNumber(history, attempt) {
    const index = history.findIndex(item => sameAttempt(item, attempt));
    return index >= 0 ? index + 1 : '—';
  }

  function renderDecision(verdict) {
    if (!verdict || typeof verdict !== 'object' || !Object.keys(verdict).length) return '';
    const caps = Array.isArray(verdict.caps) ? verdict.caps : [];
    const failedCritical = Array.isArray(verdict.critical)
      ? verdict.critical.filter(item => item && item.ok === false)
      : [];
    const integrity = verdict.integrity && typeof verdict.integrity === 'object'
      ? verdict.integrity
      : {};
    const hardFailIds = Array.isArray(integrity.hard_fail_ids)
      ? integrity.hard_fail_ids
      : [];
    const language = verdict.language && typeof verdict.language === 'object'
      ? verdict.language
      : {};
    return `
      <section class="decision-section">
        <span class="section-label">Server decision</span>
        <div class="decision-grid">
          <span>Raw criteria score: <strong>${formatScore(verdict.rawScore)}</strong></span>
          <span>Critical gate: <strong>${verdict.criticalOk === false ? 'failed' : 'ok'}</strong></span>
          <span>Caps: <strong>${caps.length
            ? escapeHtml(caps.map(item => `${item.reason} ≤ ${item.maximum}`).join(', '))
            : 'none'}</strong></span>
          <span>Hard-fail IDs: <strong>${hardFailIds.length
            ? escapeHtml(hardFailIds.join(', '))
            : 'none'}</strong></span>
          <span>English: <strong>${language.is_english === false ? 'no' : 'yes'}</strong></span>
        </div>
        ${failedCritical.length
          ? `<p class="decision-copy">Failed critical: ${escapeHtml(failedCritical.map(item => item.id).join(', '))}</p>`
          : ''}
        ${integrity.hard_fail_evidence
          ? `<p class="decision-copy"><strong>Hard-fail evidence:</strong> “${escapeHtml(integrity.hard_fail_evidence)}”</p>`
          : ''}
        ${integrity.prompt_injection_evidence
          ? `<p class="decision-copy"><strong>Prompt-injection evidence:</strong> “${escapeHtml(integrity.prompt_injection_evidence)}”</p>`
          : ''}
        ${integrity.hostile_evidence
          ? `<p class="decision-copy"><strong>Hostile evidence:</strong> “${escapeHtml(integrity.hostile_evidence)}”</p>`
          : ''}
        ${integrity.reason_ru
          ? `<p class="decision-copy"><strong>Integrity:</strong> ${escapeHtml(integrity.reason_ru)}</p>`
          : ''}
        ${language.reason_ru
          ? `<p class="decision-copy"><strong>Language:</strong> ${escapeHtml(language.reason_ru)}</p>`
          : ''}
        ${language.non_english_evidence
          ? `<p class="decision-copy"><strong>Non-English evidence:</strong> “${escapeHtml(language.non_english_evidence)}”</p>`
          : ''}
      </section>
    `;
  }

  function renderAttempt(attempt, history, best, latest, reversedIndex) {
    const isBest = sameAttempt(attempt, best);
    const isLatest = sameAttempt(attempt, latest);
    const number = attemptNumber(history, attempt);
    const feedback = String(attempt.feedback || attempt.feedback_ru || '').trim();
    const model = String(attempt.model || '').trim();

    return `
      <details class="attempt" ${reversedIndex === 0 ? 'open' : ''}>
        <summary class="attempt__summary">
          <span class="attempt__title">
            <strong>Попытка ${escapeHtml(number)}</strong>
            <span class="score-pill" data-pass="${Boolean(attempt.pass)}">
              ${formatScore(attempt.score)} / 100 · ${attempt.pass ? 'зачёт' : 'не зачёт'}
            </span>
            ${isBest ? '<span class="attempt-badge attempt-badge--best">Best</span>' : ''}
            ${isLatest ? '<span class="attempt-badge attempt-badge--latest">Latest</span>' : ''}
            ${attempt.cacheHit ? '<span class="attempt-badge">Кэш</span>' : ''}
            <span class="attempt__time">${escapeHtml(formatDate(attempt.createdAt))}${model ? ` · ${escapeHtml(model)}` : ''}</span>
          </span>
        </summary>
        <div class="attempt__body">
          <section class="answer-section">
            <span class="section-label">Полный answer</span>
            <pre class="answer-text">${escapeHtml(attempt.answer || '')}</pre>
          </section>
          <section class="feedback-section">
            <span class="section-label">feedback_ru</span>
            <p class="feedback-text">${feedback ? escapeHtml(feedback) : 'Обратная связь не сохранена.'}</p>
          </section>
          ${renderDecision(attempt.verdict)}
          <section class="criteria-section">
            <span class="section-label">Criteria · rating / evidence / reason_ru</span>
            ${renderCriteria(attempt.criteria)}
          </section>
        </div>
      </details>
    `;
  }

  function renderStateSummary(label, attempt, history) {
    if (!attempt) {
      return `
        <div class="state-summary">
          <div>
            <span class="state-summary__label">${escapeHtml(label)}</span>
            <span class="state-summary__detail">Нет попытки</span>
          </div>
          <span class="state-summary__score">—</span>
        </div>
      `;
    }
    return `
      <div class="state-summary">
        <div>
          <span class="state-summary__label">${escapeHtml(label)}</span>
          <span class="state-summary__detail">
            Попытка ${escapeHtml(attemptNumber(history, attempt))} · ${attempt.pass ? 'зачёт' : 'не зачёт'}
          </span>
        </div>
        <span class="state-summary__score">${formatScore(attempt.score)}</span>
      </div>
    `;
  }

  function renderTask(task, index, taskState) {
    const history = Array.isArray(taskState && taskState.history) ? taskState.history : [];
    const best = taskState && taskState.best || null;
    const latest = taskState && taskState.latest || null;
    const attempts = finiteNumber(taskState && taskState.attempts, history.length);

    return `
      <article class="task-card">
        <header class="task-card__header">
          <span class="task-number">${index + 1}</span>
          <div>
            <h3>${escapeHtml(task.title || `Задание ${index + 1}`)}</h3>
            <span class="task-id">${escapeHtml(task.id)}</span>
          </div>
          <div class="task-status">
            <span class="attempt-count">${escapeHtml(pluralAttempts(attempts))}</span>
            <span class="score-pill" data-pass="${best ? Boolean(best.pass) : ''}">
              Best: ${best ? `${formatScore(best.score)} / 100` : '—'}
            </span>
          </div>
        </header>

        <details class="task-reference">
          <summary>Показать контекст и формулировку задания</summary>
          <div class="task-reference__body">
            <p class="reference-block"><strong>Context:</strong><br>${escapeHtml(task.context || '—')}</p>
            <p class="reference-block"><strong>Prompt:</strong><br>${escapeHtml(task.prompt || '—')}</p>
          </div>
        </details>

        <div class="task-state">
          ${renderStateSummary('Best', best, history)}
          ${renderStateSummary('Latest', latest, history)}
        </div>

        ${history.length ? `
          <section class="history">
            <h4>История попыток</h4>
            <div class="attempt-list">
              ${history.slice().reverse().map((attempt, reversedIndex) =>
                renderAttempt(attempt, history, best, latest, reversedIndex)
              ).join('')}
            </div>
          </section>
        ` : `
          <div class="task-empty">Кандидат ещё не отправлял это задание.</div>
        `}
      </article>
    `;
  }

  function renderCandidateDetails() {
    const student = studentByNickname(state.selectedNickname);
    if (!student) {
      elements.candidateDetails.innerHTML = `
        <div class="state-panel state-panel--empty">
          <h2>${state.students.length ? 'Выберите кандидата' : 'Результатов пока нет'}</h2>
          <p>
            ${state.students.length
              ? 'Нажмите на имя слева, чтобы открыть ответы и оценки по всем восьми заданиям.'
              : 'Кандидат появится здесь после первой отправленной работы Day 1.'}
          </p>
        </div>
      `;
      return;
    }

    const progress = student.state || {};
    const tasks = Array.isArray(state.program && state.program.tasks) ? state.program.tasks : [];
    const taskStates = progress.tasks && typeof progress.tasks === 'object' ? progress.tasks : {};
    const completed = finiteNumber(progress.completedTasks, 0);
    const total = finiteNumber(progress.totalTasks, tasks.length);
    const passingScore = finiteNumber(progress.passingScore, finiteNumber(state.program && state.program.passingScore, 85));
    const minimumTaskScore = finiteNumber(progress.minimumTaskScore, finiteNumber(state.program && state.program.minimumTaskScore, 60));

    elements.candidateDetails.innerHTML = `
      <section class="candidate-hero">
        <div>
          <div class="eyebrow">КАНДИДАТ</div>
          <h2>${escapeHtml(student.nickname || 'Без ника')}</h2>
          <p class="candidate-hero__meta">Последняя активность: ${escapeHtml(formatDate(latestActivity(student)))}</p>
        </div>
        <div class="candidate-hero__side">
          <div class="verdict" data-passed="${Boolean(progress.passed)}">
            ${progress.passed ? 'DAY 1 ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}
          </div>
          <button id="resetCandidateButton" class="danger-button" type="button">Сбросить Day 1</button>
        </div>
      </section>

      <section class="candidate-metrics" aria-label="Результат кандидата">
        <article class="candidate-metric">
          <span>Выполнено</span>
          <strong>${completed} / ${total}</strong>
        </article>
        <article class="candidate-metric">
          <span>Средний балл по best</span>
          <strong>${formatScore(progress.averageScore)} / 100</strong>
        </article>
        <article class="candidate-metric">
          <span>Порог программы</span>
          <strong>${formatScore(passingScore)} / 100</strong>
        </article>
        <article class="candidate-metric">
          <span>Минимум за задание</span>
          <strong>${formatScore(minimumTaskScore)} / 100</strong>
        </article>
      </section>

      <section class="task-stack">
        ${tasks.map((task, index) => renderTask(task, index, taskStates[task.id] || {})).join('')}
      </section>
    `;

    const resetButton = document.getElementById('resetCandidateButton');
    resetButton.addEventListener('click', () => resetCandidate(student.nickname, resetButton));
  }

  function renderError(error) {
    const forbidden = error && (error.status === 401 || error.status === 403);
    elements.candidateDetails.innerHTML = `
      <div class="state-panel state-panel--error">
        <h2>${forbidden ? 'Нет доступа к результатам' : 'Не удалось загрузить результаты'}</h2>
        <p>
          ${forbidden
            ? 'Эта страница доступна только администратору после входа в панель.'
            : 'Проверьте соединение и попробуйте обновить данные ещё раз.'}
        </p>
        <button id="retryLoadButton" class="primary-button" type="button">
          ${forbidden ? 'Проверить снова' : 'Повторить загрузку'}
        </button>
      </div>
    `;
    document.getElementById('retryLoadButton').addEventListener('click', () => loadResults());
  }

  function renderAll() {
    renderSummary();
    renderCandidateList();
    renderCandidateDetails();
  }

  async function loadResults(options) {
    if (state.loading) return;
    state.loading = true;
    elements.refreshButton.disabled = true;
    elements.refreshButton.dataset.loading = 'true';
    elements.updatedAt.textContent = 'Обновляю результаты…';

    try {
      const payload = await requestJson(API_RESULTS);
      state.program = payload.program || null;
      state.students = Array.isArray(payload.students)
        ? payload.students.slice().sort((a, b) => latestActivity(b) - latestActivity(a))
        : [];

      if (!studentByNickname(state.selectedNickname)) {
        state.selectedNickname = state.students[0] ? state.students[0].nickname : '';
      }
      renderAll();
      elements.updatedAt.textContent = `Обновлено ${new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(new Date())}`;
      if (options && options.notify) showToast('Результаты обновлены', 'success');
    } catch (error) {
      renderError(error);
      elements.updatedAt.textContent = 'Ошибка загрузки';
      if (options && options.notify) showToast('Не удалось обновить результаты', 'error');
    } finally {
      state.loading = false;
      elements.refreshButton.disabled = false;
      elements.refreshButton.dataset.loading = 'false';
    }
  }

  async function resetCandidate(nickname, button) {
    const confirmed = window.confirm(
      `Сбросить Day 1 для «${nickname}»?\n\nБудут удалены все ответы, оценки и прогресс этого кандидата. Отменить действие будет нельзя.`
    );
    if (!confirmed) return;

    button.disabled = true;
    button.textContent = 'Сбрасываю…';
    try {
      await requestJson(API_RESET, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname })
      });
      state.selectedNickname = '';
      showToast(`Day 1 для «${nickname}» сброшен`, 'success');
      await loadResults();
    } catch (_) {
      button.disabled = false;
      button.textContent = 'Сбросить Day 1';
      showToast('Не удалось сбросить результаты кандидата', 'error');
    }
  }

  elements.refreshButton.addEventListener('click', () => loadResults({ notify: true }));
  elements.candidateSearch.addEventListener('input', event => {
    state.search = event.target.value;
    renderCandidateList();
  });

  loadResults();
}());
