#!/usr/bin/env node
'use strict';

/**
 * benchmark-local-ai.js
 *
 * Diagnoses whether the local AI model is inherently slow or whether the app
 * is sending oversized prompts, injecting too much RAG, or retrying the model
 * unnecessarily.
 *
 * Usage:
 *   node server/scripts/benchmark-local-ai.js
 *   node server/scripts/benchmark-local-ai.js --json          (machine-readable output only)
 *   node server/scripts/benchmark-local-ai.js --no-model      (config + prompt analysis only)
 *
 * Providers:
 *   ACTIVE_MODEL_PROVIDER=local   (default — loads llama.cpp model in-process)
 *   ACTIVE_MODEL_PROVIDER=ollama  (benchmarks running Ollama server, already warm)
 *   ACTIVE_MODEL_PROVIDER=mock    (config analysis only, no model calls)
 */

const path = require('path');
const fs   = require('fs');

// ── Bootstrap ─────────────────────────────────────────────────────────────────

try {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch { /* dotenv optional */ }

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const ARGS       = new Set(process.argv.slice(2));
const JSON_ONLY  = ARGS.has('--json');
const NO_MODEL   = ARGS.has('--no-model');

// ── Safe print helpers ────────────────────────────────────────────────────────

const print   = (...args) => { if (!JSON_ONLY) console.log(...args); };
const printWarn = (msg)   => { if (!JSON_ONLY) console.warn(`\x1b[33m⚠  ${msg}\x1b[0m`); };
const printErr  = (msg)   => { if (!JSON_ONLY) console.error(`\x1b[31m✗  ${msg}\x1b[0m`); };
const printOk   = (msg)   => { if (!JSON_ONLY) console.log(`\x1b[32m✓  ${msg}\x1b[0m`); };
const printInfo = (msg)   => { if (!JSON_ONLY) console.log(`   ${msg}`); };
const printHead = (msg)   => { if (!JSON_ONLY) console.log(`\n\x1b[1m── ${msg}\x1b[0m`); };

const estTokens = (chars) => Math.round(chars / 4); // ~4 chars per token (rough)
const fmtMs     = (ms)    => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
const fmtTps    = (tps)   => tps === null ? 'N/A' : `${tps.toFixed(1)} tok/s`;

// ── Load app modules ──────────────────────────────────────────────────────────

let ModelRegistry, getModelPath, modelExists, PromptBuilder, ToolRegistry;

try {
  ({ ModelRegistry }       = require('../src/ai/runtime/ModelRegistry'));
  ({ getModelPath, modelExists } = require('../src/ai/runtime/ModelStorage'));
  ({ PromptBuilder }       = require('../src/ai/orchestrator/PromptBuilder'));
  ({ ToolRegistry }        = require('../src/ai/tools/ToolRegistry'));
} catch (err) {
  console.error('Failed to load app modules:', err.message);
  process.exit(1);
}

// ── Configuration collection ──────────────────────────────────────────────────

function collectConfig() {
  const providerName = (process.env.ACTIVE_MODEL_PROVIDER || 'local').toLowerCase();
  const model        = ModelRegistry.getActiveModel();

  const localContextTokens    = clampInt('LOCAL_AI_CONTEXT_TOKENS',    3072, 1024, 8192);
  const localMaxOutputTokens  = clampInt('LOCAL_AI_MAX_OUTPUT_TOKENS',  192,  32,   2048);
  const localBatchSize        = clampInt('LOCAL_AI_BATCH_SIZE',         512,  128,  2048);
  const localThreads          = process.env.LOCAL_AI_THREADS === undefined
    ? 0
    : clampInt('LOCAL_AI_THREADS', 0, 0, 256);
  const fallbackMaxTokens     = clampInt('AI_FALLBACK_MAX_TOKENS',      512,  64,   2048);
  const ragMaxTokens          = Math.max(fallbackMaxTokens, clampInt('AI_RAG_MAX_TOKENS', 512, 64, 2048));
  const modelTimeoutMs        = clampInt('AI_MODEL_TIMEOUT_MS',         20000, 1000, 300000);
  const retryTimeoutMs        = clampInt('AI_MODEL_RETRY_TIMEOUT_MS',   10000, 1000, 300000);
  const temperature           = Number.isFinite(Number(process.env.AI_FALLBACK_TEMPERATURE))
    ? Number(process.env.AI_FALLBACK_TEMPERATURE)
    : 0;

  const effectiveContextTokens = model
    ? Math.min(model.contextWindow || localContextTokens, localContextTokens)
    : localContextTokens;

  const ollamaBaseUrl = process.env.ACTIVE_MODEL_BASE_URL || 'http://localhost:11434';
  const ollamaModelName = process.env.ACTIVE_MODEL_NAME || 'qwen2.5:1.5b-instruct';

  let modelFilePath = null;
  let modelFileExists = null;
  let modelFileSizeBytes = null;
  if (model && (providerName === 'local' || providerName === 'llama_cpp')) {
    modelFilePath = getModelPath(model.fileName);
    modelFileExists = modelExists(model.fileName);
    if (modelFileExists) {
      try { modelFileSizeBytes = fs.statSync(modelFilePath).size; } catch { /* ok */ }
    }
  }

  return {
    providerName,
    model: model ? {
      id: model.id,
      displayName: model.displayName,
      parameterSize: model.parameterSize,
      quantization: model.quantization,
      runtime: model.runtime || process.env.LOCAL_MODEL_RUNTIME,
      contextWindow: model.contextWindow,
      fileName: model.fileName,
    } : null,
    localContextTokens,
    effectiveContextTokens,
    localMaxOutputTokens,
    localBatchSize,
    localThreads,
    fallbackMaxTokens,
    ragMaxTokens,
    modelTimeoutMs,
    retryTimeoutMs,
    temperature,
    ollamaBaseUrl,
    ollamaModelName,
    modelFilePath,
    modelFileExists,
    modelFileSizeBytes,
  };
}

function clampInt(envKey, fallback, min, max) {
  const parsed = parseInt(process.env[envKey] || `${fallback}`, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// ── Prompt size analysis ──────────────────────────────────────────────────────

function analysePrompts() {
  const registry   = new ToolRegistry();
  const builder    = new PromptBuilder(registry);
  const toolCount  = registry.all().length;
  const toolList   = registry.toPromptList().map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const mockUser   = { name: 'Benchmark', role: 'admin', _id: 'bench-user' };

  // Worst-case RAG sizes derived from env/default constants
  const maxRagChunks    = parseInt(process.env.AI_RAG_MAX_CONTEXT_SNIPPETS    || '6',  10);
  const maxRagChunkSize = parseInt(process.env.AI_RAG_CHUNK_CHARS             || '1400', 10);
  const maxBkChunks     = parseInt(process.env.AI_BACKEND_RAG_MAX_CONTEXT_SNIPPETS || '8', 10);
  const maxBkChunkSize  = parseInt(process.env.AI_BACKEND_RAG_CHUNK_CHARS         || '1800', 10);
  const maxLegalRagChars   = maxRagChunks * maxRagChunkSize;
  const maxBackendRagChars = maxBkChunks  * maxBkChunkSize;

  // Measure actual prompt sizes by calling PromptBuilder with synthetic RAG
  const basePrompt = builder.buildSystemPrompt(mockUser, {});
  const withLegalPrompt = builder.buildSystemPrompt(mockUser, {
    legalFolder: 'x'.repeat(maxLegalRagChars),
  });
  const withBackendPrompt = builder.buildSystemPrompt(mockUser, {
    backendKnowledge: 'x'.repeat(maxBackendRagChars),
  });
  const withBothPrompt = builder.buildSystemPrompt(mockUser, {
    legalFolder:      'x'.repeat(maxLegalRagChars),
    backendKnowledge: 'x'.repeat(maxBackendRagChars),
  });

  // Decompose the base prompt to identify the largest sections
  const toolSelectionGuide  = toolList.length;
  const examplesApprox      = basePrompt.length - toolSelectionGuide - 2500; // header + user ctx

  return {
    toolCount,
    toolListChars:       toolList.length,
    toolListTokens:      estTokens(toolList.length),
    basePromptChars:     basePrompt.length,
    basePromptTokens:    estTokens(basePrompt.length),
    withLegalRagChars:   withLegalPrompt.length,
    withLegalRagTokens:  estTokens(withLegalPrompt.length),
    withBackendRagChars: withBackendPrompt.length,
    withBackendRagTokens:estTokens(withBackendPrompt.length),
    withBothRagChars:    withBothPrompt.length,
    withBothRagTokens:   estTokens(withBothPrompt.length),
    maxLegalRagChars,
    maxBackendRagChars,
    examplesApproxChars: Math.max(0, examplesApprox),
  };
}

// ── Ollama timing tests ───────────────────────────────────────────────────────

async function runOllamaTests(cfg, promptAnalysis) {
  let fetch;
  try { fetch = require('node-fetch'); } catch {
    throw new Error('node-fetch not available. Run: npm install node-fetch');
  }

  const { ollamaBaseUrl, ollamaModelName } = cfg;
  const registry = new ToolRegistry();
  const builder  = new PromptBuilder(registry);
  const mockUser = { name: 'Benchmark', role: 'admin', _id: 'bench-user' };

  const TESTS = buildTestCases(builder, mockUser, promptAnalysis);
  const results = [];

  for (const tc of TESTS) {
    print(`   Running "${tc.name}"...`);
    try {
      const payload = {
        model: ollamaModelName,
        messages: tc.messages,
        stream: false,
        options: {
          temperature: 0,
          num_predict: tc.maxTokens,
          stop: ['\n\n', '```'],
        },
      };
      if (tc.systemPrompt) {
        payload.messages = [
          { role: 'system', content: tc.systemPrompt },
          ...tc.messages,
        ];
      }

      const t0  = Date.now();
      const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
      });
      const durationMs = Date.now() - t0;

      if (!res.ok) {
        results.push({ name: tc.name, passed: false, error: `HTTP ${res.status}` });
        printErr(`"${tc.name}" — HTTP ${res.status}`);
        continue;
      }

      const data        = await res.json();
      const content     = data.message?.content || '';
      const evalTokens  = data.eval_count    || null; // output tokens (Ollama exact)
      const promptTokens= data.prompt_eval_count || null;
      const evalDurNs   = data.eval_duration || null;
      const tps = evalTokens && evalDurNs
        ? evalTokens / (evalDurNs / 1e9)
        : null;

      const result = {
        name:           tc.name,
        promptChars:    tc.promptChars,
        promptTokensEst:tc.promptTokensEst,
        promptTokensActual: promptTokens,
        completionChars:content.length,
        completionTokens: evalTokens,
        durationMs,
        tokensPerSecond: tps,
        maxTokens:      tc.maxTokens,
        passed:         true,
      };
      results.push(result);
      printOk(`"${tc.name}" — ${fmtMs(durationMs)} | output ~${evalTokens ?? '?'} tok${tps ? ` | ${fmtTps(tps)}` : ''}`);
    } catch (err) {
      results.push({ name: tc.name, passed: false, error: err.message });
      printErr(`"${tc.name}" — ${err.message}`);
    }
  }

  return results;
}

// ── LlamaCpp timing tests ─────────────────────────────────────────────────────

async function runLlamaCppTests(cfg, promptAnalysis) {
  const { model, modelFilePath } = cfg;
  if (!model) throw new Error('No active model configured.');
  if (!cfg.modelFileExists) throw new Error(`Model file not found: ${modelFilePath}`);

  let LlamaCppRuntimeClient;
  try {
    ({ LlamaCppRuntimeClient } = require('../src/ai/runtime/LlamaCppRuntimeClient'));
  } catch (err) {
    throw new Error(`Cannot load LlamaCppRuntimeClient: ${err.message}`);
  }

  const registry = new ToolRegistry();
  const builder  = new PromptBuilder(registry);
  const mockUser = { name: 'Benchmark', role: 'admin', _id: 'bench-user' };

  print('   Loading model into memory (this may take 30–120s for a 7B model)…');
  const client   = new LlamaCppRuntimeClient();
  const loadStart = Date.now();
  try {
    await client.start(model, modelFilePath);
  } catch (err) {
    throw new Error(`Model failed to load: ${err.message}`);
  }
  const loadMs = Date.now() - loadStart;
  printOk(`Model loaded in ${fmtMs(loadMs)}`);

  const TESTS = buildTestCases(builder, mockUser, promptAnalysis);
  const results = [];

  for (const tc of TESTS) {
    print(`   Running "${tc.name}"…`);
    const input = {
      systemPrompt: tc.systemPrompt || undefined,
      messages:     tc.messages,
      maxTokens:    tc.maxTokens,
      temperature:  0,
    };

    try {
      const t0    = Date.now();
      const out   = await client.generate(input);
      const durationMs = Date.now() - t0;

      const content        = out?.content || out?.question || '';
      const completionChars = content.length;
      const completionTokEst = estTokens(completionChars);
      const tps = completionTokEst > 0 ? completionTokEst / (durationMs / 1000) : null;

      const result = {
        name:            tc.name,
        promptChars:     tc.promptChars,
        promptTokensEst: tc.promptTokensEst,
        completionChars,
        completionTokensEst: completionTokEst,
        durationMs,
        tokensPerSecond: tps,
        maxTokens:       tc.maxTokens,
        outputType:      out?.type || 'unknown',
        passed:          true,
      };
      results.push(result);
      printOk(`"${tc.name}" — ${fmtMs(durationMs)} | ~${completionTokEst} tok out${tps ? ` | ${fmtTps(tps)}` : ''}`);
    } catch (err) {
      results.push({ name: tc.name, passed: false, error: err.message });
      printErr(`"${tc.name}" — ${err.message}`);
    }
  }

  try { await client.stop(); } catch { /* ok */ }
  return { loadMs, tests: results };
}

// ── Test case definitions ─────────────────────────────────────────────────────

function buildTestCases(builder, mockUser, promptAnalysis) {
  const baseSystemPrompt = builder.buildSystemPrompt(mockUser, {});

  return [
    {
      name: 'tiny (no system prompt)',
      systemPrompt: null,
      messages: [{ role: 'user', content: 'Say READY' }],
      maxTokens: 10,
      promptChars: 10,
      promptTokensEst: estTokens(10),
    },
    {
      name: 'json (no system prompt)',
      systemPrompt: null,
      messages: [{ role: 'user', content: '{"ok":true}' }],
      maxTokens: 20,
      promptChars: 11,
      promptTokensEst: estTokens(11),
    },
    {
      name: 'tool-call json (no system prompt)',
      systemPrompt: null,
      messages: [{ role: 'user', content: '{"type":"tool_call","toolName":"get_due_today","arguments":{}}' }],
      maxTokens: 50,
      promptChars: 59,
      promptTokensEst: estTokens(59),
    },
    {
      name: 'full system prompt, no RAG, short query',
      systemPrompt: baseSystemPrompt,
      messages: [{ role: 'user', content: 'What is overdue?' }],
      maxTokens: 80,
      promptChars: baseSystemPrompt.length + 16,
      promptTokensEst: promptAnalysis.basePromptTokens + 4,
    },
    {
      name: 'full system prompt, no RAG, operational query',
      systemPrompt: baseSystemPrompt,
      messages: [{ role: 'user', content: 'What legal requests were submitted this week?' }],
      maxTokens: 100,
      promptChars: baseSystemPrompt.length + 45,
      promptTokensEst: promptAnalysis.basePromptTokens + 12,
    },
  ];
}

// ── Diagnosis ─────────────────────────────────────────────────────────────────

function diagnose(cfg, promptAnalysis, modelTests) {
  const issues = [];
  const warnings = [];
  const notes = [];

  const ectx = cfg.effectiveContextTokens;
  const base = promptAnalysis.basePromptTokens;
  const withLegal = promptAnalysis.withLegalRagTokens;
  const withBackend = promptAnalysis.withBackendRagTokens;

  // Context window vs prompt size
  if (base >= ectx) {
    issues.push(
      `CRITICAL: base system prompt (~${base} tok) >= effective context window (${ectx} tok). ` +
      `The model is receiving more input than its configured context can hold. ` +
      `Set LOCAL_AI_CONTEXT_TOKENS=${Math.ceil(base * 1.5)} or higher in .env.`
    );
  } else if (base > ectx * 0.7) {
    warnings.push(
      `System prompt (~${base} tok) uses ${Math.round(base / ectx * 100)}% of the context window (${ectx} tok). ` +
      `Less than ${ectx - base} tokens remain for user messages + output. ` +
      `Consider setting LOCAL_AI_CONTEXT_TOKENS=${Math.ceil(base * 2)}.`
    );
  }

  if (withLegal >= ectx) {
    issues.push(
      `CRITICAL: system prompt + max legal RAG (~${withLegal} tok) exceeds context window (${ectx} tok). ` +
      `RAG content is being silently truncated, producing unreliable answers.`
    );
  }
  if (withBackend >= ectx) {
    issues.push(
      `CRITICAL: system prompt + max backend RAG (~${withBackend} tok) exceeds context window (${ectx} tok).`
    );
  }

  // Recommended context size
  const neededCtx = Math.ceil(withLegal * 1.2 / 512) * 512; // round to 512
  if (ectx < neededCtx) {
    notes.push(
      `Recommended LOCAL_AI_CONTEXT_TOKENS: ${Math.min(neededCtx, 8192)} ` +
      `(fits base prompt + legal RAG + 20% headroom, capped at 8192).`
    );
  }

  // Max output tokens vs context
  const outputBudget = ectx - base - 50;
  if (cfg.fallbackMaxTokens > outputBudget && outputBudget > 0) {
    warnings.push(
      `AI_FALLBACK_MAX_TOKENS=${cfg.fallbackMaxTokens} but only ~${outputBudget} tokens remain after the system prompt. ` +
      `Actual output is limited to ~${outputBudget} tokens.`
    );
  }

  // Model timeout vs expected speed
  if (cfg.model?.parameterSize === '7B') {
    const minGenSec = Math.round(cfg.fallbackMaxTokens / 12); // optimistic 12 tok/s (GPU)
    const maxGenSec = Math.round(cfg.fallbackMaxTokens / 1.5); // pessimistic 1.5 tok/s (CPU only)
    const prefillSec = Math.round(base / 30); // CPU prefill ~30 tok/s
    notes.push(
      `7B Q4 model: expected generation 1–12 tok/s depending on hardware. ` +
      `At CPU-only speeds (~2 tok/s): prefill ${prefillSec}s + output ~${Math.round(cfg.fallbackMaxTokens / 2)}s ≈ ${prefillSec + Math.round(cfg.fallbackMaxTokens / 2)}s per query. ` +
      `AI_MODEL_TIMEOUT_MS=${cfg.modelTimeoutMs}ms (${fmtMs(cfg.modelTimeoutMs)}).`
    );
    if (cfg.modelTimeoutMs < (prefillSec + 30) * 1000) {
      warnings.push(
        `AI_MODEL_TIMEOUT_MS=${cfg.modelTimeoutMs}ms may be too short for CPU-only 7B inference. ` +
        `Consider AI_MODEL_TIMEOUT_MS=120000 (2 minutes) for CPU use.`
      );
    }
  }

  // Generation speed from test results
  if (modelTests) {
    const tests = (modelTests.tests || modelTests).filter((t) => t.passed && t.tokensPerSecond);
    if (tests.length > 0) {
      const avgTps = tests.reduce((s, t) => s + t.tokensPerSecond, 0) / tests.length;
      const prefillTokens = promptAnalysis.basePromptTokens;
      const prefillSec = Math.round(prefillTokens / (avgTps * 2)); // prefill ~2× gen speed
      const genSec = Math.round(cfg.fallbackMaxTokens / avgTps);
      notes.push(
        `Measured generation speed: ${fmtTps(avgTps)} (avg over ${tests.length} tests). ` +
        `Estimated full-query time: prefill ~${prefillSec}s + generation ~${genSec}s = ~${prefillSec + genSec}s.`
      );
      if (avgTps < 3) {
        issues.push(
          `Very slow generation (${fmtTps(avgTps)}). Enable GPU acceleration (CUDA/Metal) via ` +
          `ACTIVE_MODEL_PROVIDER=ollama with a GPU-enabled Ollama build, or switch to the 1.5B model.`
        );
      } else if (avgTps < 8) {
        warnings.push(
          `Moderate generation speed (${fmtTps(avgTps)}). Consider GPU acceleration or the 1.5B model for faster responses.`
        );
      }
    }
  }

  // Tool list bloat
  if (promptAnalysis.toolListTokens > 600) {
    warnings.push(
      `Tool list in system prompt: ${promptAnalysis.toolCount} tools = ~${promptAnalysis.toolListTokens} tokens. ` +
      `Consider only injecting tools relevant to the query (dynamic tool selection).`
    );
  }

  return { issues, warnings, notes };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  print('\n\x1b[1mLocal AI Benchmark & Prompt Diagnostics\x1b[0m');
  print('Run with --json for machine-readable output; --no-model to skip inference tests.\n');

  // 1. Configuration
  printHead('Configuration');
  let cfg;
  try {
    cfg = collectConfig();
  } catch (err) {
    printErr(`Config collection failed: ${err.message}`);
    process.exit(1);
  }

  const providerLabel = {
    local: 'local (llama.cpp)',
    ollama: 'ollama',
    mock: 'mock (no inference)',
    huggingface: 'huggingface (cloud)',
    hf: 'huggingface (cloud)',
  }[cfg.providerName] || cfg.providerName;

  printInfo(`Provider:              ${providerLabel}`);
  if (cfg.model) {
    printInfo(`Model:                 ${cfg.model.displayName}`);
    printInfo(`Parameters / quant:    ${cfg.model.parameterSize} ${cfg.model.quantization}`);
    printInfo(`Runtime:               ${cfg.model.runtime || 'unknown'}`);
    printInfo(`Config context window: ${cfg.model.contextWindow?.toLocaleString()} tokens`);
  }
  printInfo(`Effective ctx tokens:  ${cfg.effectiveContextTokens.toLocaleString()} (LOCAL_AI_CONTEXT_TOKENS)`);
  printInfo(`Max output tokens:     ${cfg.fallbackMaxTokens} (AI_FALLBACK_MAX_TOKENS, overrides runtime default of ${cfg.localMaxOutputTokens})`);
  printInfo(`RAG max tokens:        ${cfg.ragMaxTokens}`);
  printInfo(`Temperature:           ${cfg.temperature}`);
  printInfo(`Model timeout:         ${fmtMs(cfg.modelTimeoutMs)}`);
  printInfo(`Retry timeout:         ${fmtMs(cfg.retryTimeoutMs)}`);

  if (cfg.providerName === 'local' || cfg.providerName === 'llama_cpp') {
    printInfo(`Model file:            ${cfg.modelFilePath}`);
    if (cfg.modelFileExists) {
      const mb = cfg.modelFileSizeBytes ? `(${(cfg.modelFileSizeBytes / 1e9).toFixed(2)} GB)` : '';
      printOk(`Model file present ${mb}`);
    } else {
      printErr('Model file NOT found — cannot run inference tests');
    }
  }

  if (cfg.providerName === 'ollama') {
    printInfo(`Ollama URL:            ${cfg.ollamaBaseUrl}`);
    printInfo(`Ollama model name:     ${cfg.ollamaModelName}`);
  }

  // 2. Prompt analysis
  printHead('Prompt Size Analysis');
  let promptAnalysis;
  try {
    promptAnalysis = analysePrompts();
  } catch (err) {
    printErr(`Prompt analysis failed: ${err.message}`);
    process.exit(1);
  }

  const ectx = cfg.effectiveContextTokens;

  printInfo(`Tool count:            ${promptAnalysis.toolCount} tools`);
  printInfo(`Tool list:             ${promptAnalysis.toolListChars.toLocaleString()} chars ≈ ${promptAnalysis.toolListTokens} tokens`);
  print('');
  print('   System prompt sizes (chars / estimated tokens):');

  const flag = (tokens) => {
    if (tokens >= ectx)         return '\x1b[31m OVERFLOW\x1b[0m';
    if (tokens >= ectx * 0.8)   return '\x1b[33m WARNING\x1b[0m';
    if (tokens >= ectx * 0.5)   return '\x1b[33m TIGHT\x1b[0m';
    return '\x1b[32m OK\x1b[0m';
  };

  printInfo(`  Base (no RAG):        ${promptAnalysis.basePromptChars.toLocaleString()} chars ≈ ${promptAnalysis.basePromptTokens} tokens${flag(promptAnalysis.basePromptTokens)}`);
  printInfo(`  + legal folder RAG:   ${promptAnalysis.withLegalRagChars.toLocaleString()} chars ≈ ${promptAnalysis.withLegalRagTokens} tokens${flag(promptAnalysis.withLegalRagTokens)}`);
  printInfo(`  + backend RAG:        ${promptAnalysis.withBackendRagChars.toLocaleString()} chars ≈ ${promptAnalysis.withBackendRagTokens} tokens${flag(promptAnalysis.withBackendRagTokens)}`);
  printInfo(`  + both RAG sources:   ${promptAnalysis.withBothRagChars.toLocaleString()} chars ≈ ${promptAnalysis.withBothRagTokens} tokens${flag(promptAnalysis.withBothRagTokens)}`);
  print('');
  printInfo(`  Context window:       ${ectx} tokens (LOCAL_AI_CONTEXT_TOKENS)`);
  printInfo(`  Max RAG injection:    legal ${promptAnalysis.maxLegalRagChars.toLocaleString()} chars + backend ${promptAnalysis.maxBackendRagChars.toLocaleString()} chars`);

  // 3. Model timing tests
  let modelTestResults = null;
  let loadMs = null;

  if (!NO_MODEL && cfg.providerName !== 'mock') {
    printHead('Model Timing Tests');

    if (cfg.providerName === 'ollama') {
      try {
        modelTestResults = await runOllamaTests(cfg, promptAnalysis);
      } catch (err) {
        printErr(`Ollama tests failed: ${err.message}`);
      }
    } else if (cfg.providerName === 'local' && cfg.modelFileExists) {
      try {
        const r = await runLlamaCppTests(cfg, promptAnalysis);
        loadMs           = r.loadMs;
        modelTestResults = r.tests;
      } catch (err) {
        printErr(`LlamaCpp tests failed: ${err.message}`);
      }
    } else if (!cfg.modelFileExists) {
      printWarn('Skipping inference tests — model file not present.');
    }
  } else if (NO_MODEL) {
    print('\n   (Inference tests skipped — --no-model flag set)');
  }

  // 4. Diagnosis
  printHead('Diagnosis');
  const dx = diagnose(cfg, promptAnalysis, modelTestResults);

  if (dx.issues.length === 0 && dx.warnings.length === 0 && dx.notes.length === 0) {
    printOk('No issues detected.');
  }
  for (const issue of dx.issues)   { printErr(issue); }
  for (const warn  of dx.warnings) { printWarn(warn); }
  for (const note  of dx.notes)    { printInfo(note); }

  // 5. JSON output
  const report = {
    timestamp: new Date().toISOString(),
    provider: cfg.providerName,
    runtime: cfg.model?.runtime || cfg.providerName,
    model: cfg.model?.displayName || null,
    modelId: cfg.model?.id || null,
    modelParams: cfg.model?.parameterSize || null,
    modelQuant: cfg.model?.quantization || null,
    config: {
      effectiveContextTokens: cfg.effectiveContextTokens,
      configuredContextTokens: cfg.model?.contextWindow || null,
      localContextTokens: cfg.localContextTokens,
      fallbackMaxTokens: cfg.fallbackMaxTokens,
      ragMaxTokens: cfg.ragMaxTokens,
      temperature: cfg.temperature,
      modelTimeoutMs: cfg.modelTimeoutMs,
      retryTimeoutMs: cfg.retryTimeoutMs,
      localThreads: cfg.localThreads,
      localBatchSize: cfg.localBatchSize,
      modelFileSizeBytes: cfg.modelFileSizeBytes || null,
    },
    promptAnalysis: {
      toolCount: promptAnalysis.toolCount,
      toolListChars: promptAnalysis.toolListChars,
      toolListTokensEst: promptAnalysis.toolListTokens,
      basePromptChars: promptAnalysis.basePromptChars,
      basePromptTokensEst: promptAnalysis.basePromptTokens,
      withLegalRagChars: promptAnalysis.withLegalRagChars,
      withLegalRagTokensEst: promptAnalysis.withLegalRagTokens,
      withBackendRagChars: promptAnalysis.withBackendRagChars,
      withBackendRagTokensEst: promptAnalysis.withBackendRagTokens,
      withBothRagChars: promptAnalysis.withBothRagChars,
      withBothRagTokensEst: promptAnalysis.withBothRagTokens,
      contextOverflow: promptAnalysis.basePromptTokens >= cfg.effectiveContextTokens,
    },
    ...(loadMs !== null ? { modelLoadMs: loadMs } : {}),
    tests: modelTestResults
      ? modelTestResults.map((t) => ({
        name:             t.name,
        promptChars:      t.promptChars,
        promptTokensEst:  t.promptTokensEst,
        ...(t.promptTokensActual != null ? { promptTokensActual: t.promptTokensActual } : {}),
        completionChars:  t.completionChars,
        ...(t.completionTokens     != null ? { completionTokens:     t.completionTokens }     : {}),
        ...(t.completionTokensEst  != null ? { completionTokensEst:  t.completionTokensEst }  : {}),
        durationMs:       t.durationMs,
        tokensPerSecond:  t.tokensPerSecond ?? null,
        maxTokens:        t.maxTokens,
        passed:           t.passed,
        ...(t.error ? { error: t.error } : {}),
      }))
      : null,
    diagnosis: {
      issues:   dx.issues,
      warnings: dx.warnings,
      notes:    dx.notes,
    },
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHead('JSON Report');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
