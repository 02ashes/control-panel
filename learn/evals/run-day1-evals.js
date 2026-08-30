#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cases = require('./day1-eval-cases.js');
const {
  validateEvalCases,
  compareVerdict,
  matchedFeedbackConcepts
} = require('./day1-eval-utils.js');
const grading = require('../grading-v2.js');

function parseArgs(argv) {
  const options = {
    live: false,
    task: '',
    kind: '',
    caseId: '',
    limit: 0,
    json: '',
    repeats: 1,
    stabilityOnly: false
  };
  for (const arg of argv) {
    if (arg === '--live') options.live = true;
    else if (arg === '--dry-run') options.live = false;
    else if (arg.startsWith('--task=')) options.task = arg.slice('--task='.length);
    else if (arg.startsWith('--kind=')) options.kind = arg.slice('--kind='.length);
    else if (arg.startsWith('--case=')) options.caseId = arg.slice('--case='.length);
    else if (arg.startsWith('--limit=')) options.limit = Number.parseInt(arg.slice('--limit='.length), 10) || 0;
    else if (arg.startsWith('--json=')) options.json = arg.slice('--json='.length);
    else if (arg.startsWith('--repeats=')) {
      const repeats = Number.parseInt(arg.slice('--repeats='.length), 10);
      if (!Number.isFinite(repeats)) throw new Error('--repeats must be an integer from 1 to 5.');
      options.repeats = Math.max(1, Math.min(5, repeats));
    }
    else if (arg === '--stability-only') options.stabilityOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function selectedCases(options) {
  let selected = cases.slice();
  if (options.task) selected = selected.filter(entry => entry.taskId === options.task);
  if (options.kind) selected = selected.filter(entry => entry.kind === options.kind);
  if (options.caseId) selected = selected.filter(entry => entry.id === options.caseId);
  if (options.stabilityOnly) selected = selected.filter(entry => entry.expected.stability === true);
  if (options.limit > 0) selected = selected.slice(0, options.limit);
  return selected;
}

function loadApiKey() {
  const fromEnvironment = String(process.env.XAI_API_KEY || '').trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const source = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
    const match = source.match(/^\s*XAI_API_KEY\s*=\s*(.+?)\s*$/m);
    if (!match) return '';
    return match[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  } catch (_) {
    return '';
  }
}

function verdictSnapshot(verdict) {
  const criteria = {};
  for (const [criterionId, value] of Object.entries(verdict.criteria || {})) {
    criteria[criterionId] = Number(value && value.rating);
  }
  return {
    score: verdict.score,
    rawScore: verdict.rawScore,
    taskPass: verdict.pass,
    criticalOk: verdict.criticalOk,
    critical: Array.isArray(verdict.critical) ? verdict.critical : [],
    criteria,
    caps: verdict.caps,
    feedback_ru: verdict.feedback_ru,
    matchedFeedbackConcepts: matchedFeedbackConcepts(verdict.feedback_ru)
  };
}

function compareStability(verdicts) {
  if (verdicts.length < 2) {
    return { failures: [], scoreMin: null, scoreMax: null, scoreMean: null, scoreSpread: null, criterionSpreads: {} };
  }

  const scores = verdicts.map(verdict => Number(verdict.score));
  const scoreMin = Math.min(...scores);
  const scoreMax = Math.max(...scores);
  const failures = [];
  if (new Set(verdicts.map(verdict => verdict.pass)).size > 1) {
    failures.push('stability: per-task pass changed between runs');
  }
  if (new Set(verdicts.map(verdict => verdict.criticalOk)).size > 1) {
    failures.push('stability: criticalOk changed between runs');
  }
  if (scoreMax - scoreMin > 10) {
    failures.push(`stability: score spread ${scoreMax - scoreMin} exceeds 10`);
  }

  const criterionIds = new Set(verdicts.flatMap(verdict => Object.keys(verdict.criteria || {})));
  const criterionSpreads = {};
  for (const criterionId of criterionIds) {
    const ratings = verdicts
      .map(verdict => Number(verdict.criteria && verdict.criteria[criterionId] && verdict.criteria[criterionId].rating))
      .filter(Number.isInteger);
    if (!ratings.length) continue;
    const minimum = Math.min(...ratings);
    const maximum = Math.max(...ratings);
    criterionSpreads[criterionId] = { min: minimum, max: maximum, spread: maximum - minimum };
  }

  const criticalIds = new Set(verdicts.flatMap(verdict =>
    (Array.isArray(verdict.critical) ? verdict.critical : []).map(item => item.id)
  ));
  for (const criterionId of criticalIds) {
    const spread = criterionSpreads[criterionId];
    if (spread && spread.min < 2 && spread.max >= 2) {
      failures.push(`stability: critical criterion ${criterionId} crossed the pass boundary`);
    }
  }

  return {
    failures,
    scoreMin,
    scoreMax,
    scoreMean: Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100,
    scoreSpread: scoreMax - scoreMin,
    criterionSpreads
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const errors = validateEvalCases(cases);
  if (errors.length) {
    console.error(`Day 1 eval dataset is invalid (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const selected = selectedCases(options);
  if (!selected.length) throw new Error('No eval cases match the selected filters.');

  if (!options.live) {
    console.log(`Dry run passed: ${cases.length} valid cases, ${selected.length} selected, no xAI calls made.`);
    console.log('Use --live explicitly to run paid Grok grading. Filters: --task=..., --kind=..., --case=..., --limit=N, --stability-only, --repeats=1..5.');
    return;
  }

  const apiKey = loadApiKey();
  if (!apiKey) throw new Error('XAI_API_KEY is required with --live. No calls were made.');

  const results = [];
  let mismatches = 0;
  let completedCalls = 0;
  const callsPlanned = selected.reduce((sum, entry) =>
    sum + (entry.expected.stability === true ? options.repeats : 1), 0);
  for (const [index, entry] of selected.entries()) {
    const repeatCount = entry.expected.stability === true ? options.repeats : 1;
    const runs = [];
    const verdicts = [];
    const caseFailures = [];
    for (let runIndex = 0; runIndex < repeatCount; runIndex += 1) {
      process.stdout.write(
        `[${index + 1}/${selected.length} · call ${completedCalls + 1}/${callsPlanned}] ${entry.id}` +
        (repeatCount > 1 ? ` run ${runIndex + 1}/${repeatCount}` : '') + ' ... '
      );
      try {
        const assessment = await grading.callGrok(entry.answer, entry.taskId, apiKey);
        const verdict = grading.computeVerdict(assessment, entry.taskId, entry.answer);
        const failures = compareVerdict(entry, verdict);
        verdicts.push(verdict);
        runs.push({ actual: verdictSnapshot(verdict), failures });
        caseFailures.push(...failures.map(failure => `run ${runIndex + 1}: ${failure}`));
        console.log(failures.length ? `MISMATCH: ${failures.join('; ')}` : `ok (${verdict.score})`);
      } catch (error) {
        runs.push({ error: error.message });
        caseFailures.push(`run ${runIndex + 1}: ${error.message}`);
        console.log(`ERROR: ${error.message}`);
      }
      completedCalls += 1;
    }

    const stability = compareStability(verdicts);
    caseFailures.push(...stability.failures);
    if (caseFailures.length) mismatches += 1;
    results.push({
      id: entry.id,
      taskId: entry.taskId,
      kind: entry.kind,
      expected: entry.expected,
      repeats: repeatCount,
      runs,
      stability,
      failures: caseFailures
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    graderVersion: grading.GRADER_VERSION,
    model: grading.MODEL,
    semantics: 'taskPass is the per-task 60-point/critical-gate result, not final Day 1 pass (85 average across all 8 tasks).',
    selected: selected.length,
    calls: completedCalls,
    repeats: options.repeats,
    mismatches,
    results
  };
  if (options.json) {
    const outputPath = path.resolve(process.cwd(), options.json);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Report written to ${outputPath}`);
  }
  console.log(`Completed ${selected.length} live cases (${completedCalls} paid calls) with ${mismatches} mismatches.`);
  if (mismatches) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  selectedCases,
  loadApiKey,
  verdictSnapshot,
  compareStability,
  main
};
