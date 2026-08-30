'use strict';

const DAY1 = require('../programs/day1-v1.js');
const RUBRICS = require('../programs/day1-v1-rubrics.js');
const grading = require('../grading-v2.js');

const REQUIRED_KINDS = ['good', 'borderline', 'bad', 'unusual'];
const FEEDBACK_CONCEPTS = Object.freeze({
  context_detail: /контекст|карточк|детал|данн.{0,20}Ethan|профил|факт.{0,15}(?:фан|Ethan)|информац.{0,15}(?:фан|карточ)|парамедик|ночн.{0,12}смен|тренир|gym/i,
  live_action: /прямо сейчас|действи|live|момент|зеркал|поз|снима|подготов|свеж/i,
  greeting_formula: /(?:(?<!не\s)(?:обязательн|нужно|следовал|стоил|должен).{0,45}(?:приветств|приветк|нача.{0,15}(?:имя|стран|хобби)|сначала.{0,15}(?:имя|стран|хобби))|сначала.{0,12}(?:спрос(?:и|ите)|узна(?:й|йте)|назов(?:и|ите)).{0,25}(?:имя|стран|хобби))/i,
  persona_marker: /(?:(?<!не\s)(?:не хватает|нужно|следовал|стоил).{0,35}|(?:добавь|добавьте).{0,20})(?:haha|:3|>_<|эмодзи|смайл|многоточ)/i,
  permission_for_light_flirt: /(?:(?<!не\s)(?:нужно|следовал|сначала\s+(?:нужно|следовал|спрос|получ)).{0,40}(?:разрешен|согласие).{0,30}(?:флирт|нам[eё]к|suggestive)|(?:флирт|нам[eё]к|suggestive).{0,40}(?<!не\s)(?:нужно|следовал|сначала\s+(?:нужно|следовал|спрос|получ)).{0,35}(?:разрешен|согласие))/i,
  cheaper_offer_forbidden: /(?:не следовало|нельзя|ошибк).{0,35}(?:дешев|другой оффер|вариант)/i,
  custom_stages_called_spam: /(?:спам|одним залпом|слишком много сообщен)/i,
  forced_rewrite: /(?:(?<!не\s)(?:нужно|следует|стоит|необходимо|можно было бы).{0,60}(?:добав|перепис|уточн|улучш|замен|сократ|усил|сдела)|(?:добав(?:ь|ьте)|перепиш(?:и|ите)|уточн(?:и|ите)|улучш(?:и|ите)|замен(?:и|ите)|сократ(?:и|ите)|усил(?:ь|ьте)|сдела(?:й|йте)))/i
});

function messageCount(answer) {
  return grading.normalizeAnswer(answer).split(/\n+/).filter(Boolean).length;
}

function wordCount(answer) {
  return (grading.normalizeAnswer(answer).match(/\S+/gu) || []).length;
}

function criterionIdsForTask(taskId) {
  const rubric = RUBRICS.tasks && RUBRICS.tasks[taskId];
  return new Set(Array.isArray(rubric && rubric.criteria)
    ? rubric.criteria.map(criterion => String(criterion.id || ''))
    : []);
}

function matchedFeedbackConcepts(feedback) {
  const text = String(feedback || '');
  return Object.entries(FEEDBACK_CONCEPTS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

function validateEvalCases(cases) {
  const errors = [];
  const taskIds = new Set(DAY1.tasks.map(task => task.id));
  const taskById = new Map(DAY1.tasks.map(task => [task.id, task]));
  const ids = new Set();
  const counts = new Map(DAY1.tasks.map(task => [
    task.id,
    new Map(REQUIRED_KINDS.map(kind => [kind, 0]))
  ]));

  if (!Array.isArray(cases)) return ['Eval dataset must export an array.'];

  cases.forEach((entry, index) => {
    const path = `case[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${path} must be an object.`);
      return;
    }
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      errors.push(`${path}.id is required.`);
    } else if (ids.has(entry.id)) {
      errors.push(`${path}.id duplicates ${entry.id}.`);
    } else {
      ids.add(entry.id);
    }

    if (!taskIds.has(entry.taskId)) {
      errors.push(`${path}.taskId is unknown: ${entry.taskId}.`);
    }
    if (!REQUIRED_KINDS.includes(entry.kind)) {
      errors.push(`${path}.kind must be one of ${REQUIRED_KINDS.join(', ')}.`);
    } else if (counts.has(entry.taskId)) {
      const taskCounts = counts.get(entry.taskId);
      taskCounts.set(entry.kind, taskCounts.get(entry.kind) + 1);
    }

    if (typeof entry.answer !== 'string' || entry.answer.trim().length < 4) {
      errors.push(`${path}.answer must be a non-empty candidate answer.`);
    } else {
      const preflight = grading.preflightAnswer(entry.answer);
      if (preflight.flags.non_english) errors.push(`${path}.answer must be predominantly English.`);
      const task = taskById.get(entry.taskId);
      if (task && (entry.kind === 'good' || entry.kind === 'unusual')) {
        const messages = messageCount(entry.answer);
        const words = wordCount(entry.answer);
        if (messages < task.minMessages || messages > task.maxMessages) {
          errors.push(`${path}.answer has ${messages} messages; expected ${task.minMessages}-${task.maxMessages}.`);
        }
        if (words > task.maxWords) {
          errors.push(`${path}.answer has ${words} words; maximum is ${task.maxWords}.`);
        }
      }
    }

    const expected = entry.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
      errors.push(`${path}.expected is required.`);
      return;
    }
    const band = expected.band;
    if (
      !band || typeof band !== 'object' ||
      typeof band.label !== 'string' || !band.label.trim() ||
      !Number.isInteger(band.min) || !Number.isInteger(band.max) ||
      band.min < 0 || band.max > 100 || band.min > band.max
    ) {
      errors.push(`${path}.expected.band must have label and integer min/max in 0..100.`);
    }
    if (typeof expected.taskPass !== 'boolean') errors.push(`${path}.expected.taskPass must be boolean.`);
    if (typeof expected.criticalOk !== 'boolean') errors.push(`${path}.expected.criticalOk must be boolean.`);
    if (expected.stability !== undefined && typeof expected.stability !== 'boolean') {
      errors.push(`${path}.expected.stability must be boolean when present.`);
    }

    if (expected.criteria !== undefined) {
      if (!expected.criteria || typeof expected.criteria !== 'object' || Array.isArray(expected.criteria)) {
        errors.push(`${path}.expected.criteria must be an object.`);
      } else {
        const allowedCriteria = criterionIdsForTask(entry.taskId);
        for (const [criterionId, range] of Object.entries(expected.criteria)) {
          if (!allowedCriteria.has(criterionId)) {
            errors.push(`${path}.expected.criteria has unknown criterion ${criterionId}.`);
          }
          if (
            !range || typeof range !== 'object' || Array.isArray(range) ||
            !Number.isInteger(range.min) || !Number.isInteger(range.max) ||
            range.min < 0 || range.max > 4 || range.min > range.max
          ) {
            errors.push(`${path}.expected.criteria.${criterionId} must have integer min/max in 0..4.`);
          }
        }
      }
    }

    if (expected.feedback !== undefined) {
      const feedback = expected.feedback;
      if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) {
        errors.push(`${path}.expected.feedback must be an object.`);
      } else {
        for (const key of ['mustMentionAny', 'forbidden']) {
          if (feedback[key] === undefined) continue;
          if (!Array.isArray(feedback[key]) || !feedback[key].length) {
            errors.push(`${path}.expected.feedback.${key} must be a non-empty array.`);
            continue;
          }
          for (const concept of feedback[key]) {
            if (!Object.prototype.hasOwnProperty.call(FEEDBACK_CONCEPTS, concept)) {
              errors.push(`${path}.expected.feedback.${key} has unknown concept ${concept}.`);
            }
          }
        }
      }
    }
  });

  for (const [taskId, taskCounts] of counts) {
    for (const kind of REQUIRED_KINDS) {
      if (taskCounts.get(kind) !== 1) {
        errors.push(`${taskId} must have exactly one ${kind} case; found ${taskCounts.get(kind)}.`);
      }
    }
  }

  return errors;
}

function compareVerdict(entry, verdict) {
  const failures = [];
  const band = entry.expected.band;
  if (verdict.score < band.min || verdict.score > band.max) {
    failures.push(`score ${verdict.score} is outside ${band.label} band ${band.min}-${band.max}`);
  }
  if (verdict.pass !== entry.expected.taskPass) {
    failures.push(`taskPass=${verdict.pass}; expected ${entry.expected.taskPass}`);
  }
  if (verdict.criticalOk !== entry.expected.criticalOk) {
    failures.push(`criticalOk=${verdict.criticalOk}; expected ${entry.expected.criticalOk}`);
  }
  const expectedCriteria = entry.expected.criteria || {};
  const actualCriteria = verdict.criteria && typeof verdict.criteria === 'object'
    ? verdict.criteria
    : {};
  for (const [criterionId, range] of Object.entries(expectedCriteria)) {
    const rating = Number(actualCriteria[criterionId] && actualCriteria[criterionId].rating);
    if (!Number.isInteger(rating)) {
      failures.push(`criterion ${criterionId} is missing a rating`);
    } else if (rating < range.min || rating > range.max) {
      failures.push(`criterion ${criterionId}=${rating}; expected ${range.min}-${range.max}`);
    }
  }

  const feedback = String(verdict.feedback_ru || verdict.feedback || '');
  const matched = new Set(matchedFeedbackConcepts(feedback));
  const feedbackExpected = entry.expected.feedback || {};
  if (
    Array.isArray(feedbackExpected.mustMentionAny) &&
    !feedbackExpected.mustMentionAny.some(concept => matched.has(concept))
  ) {
    failures.push(`feedback misses every required concept: ${feedbackExpected.mustMentionAny.join(', ')}`);
  }
  for (const concept of feedbackExpected.forbidden || []) {
    if (matched.has(concept)) failures.push(`feedback contains forbidden criticism: ${concept}`);
  }
  return failures;
}

module.exports = {
  REQUIRED_KINDS,
  FEEDBACK_CONCEPTS,
  messageCount,
  wordCount,
  matchedFeedbackConcepts,
  validateEvalCases,
  compareVerdict
};
