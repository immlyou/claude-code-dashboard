'use strict';

// Plain-node invariant checks for collector.js's JSONL-backed date stats fix.
// Run with: node scripts/check-collector.js
// Exits non-zero on any failed assertion.

const assert = require('assert');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const COLLECTOR_PATH = path.join(__dirname, '..', 'collector.js');

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function main() {
  const failures = [];

  // --- A: today/month are populated from real JSONL data, dailyHistory ends "today" ---
  {
    delete require.cache[require.resolve(COLLECTOR_PATH)];
    const { collect } = require(COLLECTOR_PATH);
    const today = localDateStr(new Date());
    const d = collect();

    try {
      assert.strictEqual(d.today && typeof d.today === 'object', true, 'today must be an object');
      assert.strictEqual(typeof d.today.messages, 'number');
      assert.strictEqual(typeof d.today.tokens, 'number');
      assert.strictEqual(Array.isArray(d.dailyHistory), true, 'dailyHistory must be an array');

      if (d.dailyHistory.length > 0) {
        const last = d.dailyHistory[d.dailyHistory.length - 1];
        // History only contains days with activity, so it ends today only once today has messages
        assert.ok(last.date <= today, `dailyHistory must not contain future dates (${today}), got ${last.date}`);
        if (d.today.messages > 0) {
          assert.strictEqual(last.date, today, `today has messages, so dailyHistory should end on ${today}, got ${last.date}`);
        }
      }
    } catch (e) {
      failures.push(`[A] ${e.message}`);
    }

    // --- C: second collect() call must be meaningfully faster (cache hit) ---
    const t0 = Date.now();
    collect();
    const t1 = Date.now();
    collect();
    const t2 = Date.now();
    const firstMs = t1 - t0;
    const secondMs = t2 - t1;
    console.log(`[C] collect() timing: first=${firstMs}ms second=${secondMs}ms`);
    try {
      assert.ok(secondMs <= firstMs + 5, `second collect() (${secondMs}ms) should not be slower than the first (${firstMs}ms) beyond noise`);
    } catch (e) {
      failures.push(`[C] ${e.message}`);
    }
  }

  // --- B: same top-level keys + value types as the pre-fix shape ---
  {
    const BASELINE_SHAPE = {
      sessions: 'array', cleanedUp: 'number', today: 'object', month: 'object',
      aggregate: 'object', efficiency: 'object', account: 'object',
      dailyHistory: 'array', dailyTokenHistory: 'array', dailyMsgHistory: 'array',
      hourCounts: 'array', weekdayHourCounts: 'array', longestSession: 'object',
      firstSessionDate: 'string', numStartups: 'number', webSearches: 'number',
      projectStats: 'array', desktopInfo: 'object', allProjects: 'array',
      errors: 'array', timestamp: 'number',
    };
    delete require.cache[require.resolve(COLLECTOR_PATH)];
    const { collect } = require(COLLECTOR_PATH);
    const d = collect();
    function shape(o) {
      const out = {};
      for (const k of Object.keys(o)) out[k] = Array.isArray(o[k]) ? 'array' : typeof o[k];
      return out;
    }
    const actual = shape(d);
    try {
      assert.deepStrictEqual(actual, BASELINE_SHAPE, 'collect() output shape must match the pre-fix baseline');
    } catch (e) {
      failures.push(`[B] ${e.message}`);
    }
  }

  // --- D: with an empty HOME, collect() must not throw ---
  {
    let out;
    try {
      const tmpHome = require('fs').mkdtempSync(path.join(os.tmpdir(), 'collector-check-'));
      out = execFileSync(process.execPath, ['-e', `
        const { collect } = require(${JSON.stringify(COLLECTOR_PATH)});
        const d = collect();
        console.log(JSON.stringify({ ok: true, todayMessages: d.today.messages, allProjectsLen: d.allProjects.length }));
      `], { env: { ...process.env, HOME: tmpHome }, encoding: 'utf-8' });
      const parsed = JSON.parse(out.trim());
      assert.strictEqual(parsed.ok, true);
    } catch (e) {
      failures.push(`[D] collect() with empty HOME must not throw: ${e.message}`);
    }
  }

  // --- E: fixture JSONL — local-date bucketing, usage dedup, tool_use counting, bad lines ---
  {
    try {
      const fs = require('fs');
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-fixture-'));
      const projDir = path.join(tmpHome, '.claude', 'projects', '-tmp-fixture');
      fs.mkdirSync(projDir, { recursive: true });
      const usage = { input_tokens: 10, output_tokens: 5 };
      const asst = (ts, content) => ({
        type: 'assistant', timestamp: ts, requestId: 'r1',
        message: { id: 'm1', model: 'claude-sonnet-4-5', usage, content },
      });
      const toolLine = asst('2026-09-25T17:30:07Z', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]);
      const lines = [
        // 17:30Z is 2026-09-26 01:30 in Asia/Taipei
        { type: 'user', timestamp: '2026-09-25T17:30:00Z', message: { role: 'user', content: 'hi' } },
        // One logical turn split across lines with repeated usage; tool_use only on the last line
        asst('2026-09-25T17:30:05Z', [{ type: 'thinking', thinking: '' }]),
        asst('2026-09-25T17:30:06Z', [{ type: 'text', text: 'ok' }]),
        toolLine,
        toolLine, // exact replay of the same line
      ].map(l => JSON.stringify(l));
      lines.push('', '{not json');
      fs.writeFileSync(path.join(projDir, 's.jsonl'), lines.join('\n') + '\n');

      const out = execFileSync(process.execPath, ['-e', `
        const { collect } = require(${JSON.stringify(COLLECTOR_PATH)});
        const d = collect();
        const day = d.dailyHistory.find(x => x.date === '2026-09-26') || null;
        const tok = d.dailyTokenHistory.find(x => x.date === '2026-09-26') || null;
        const utcDay = d.dailyHistory.find(x => x.date === '2026-09-25') || null;
        console.log(JSON.stringify({ day, tok, utcDay }));
      `], { env: { ...process.env, HOME: tmpHome, TZ: 'Asia/Taipei' }, encoding: 'utf-8' });
      const { day, tok, utcDay } = JSON.parse(out.trim());
      assert.ok(day, 'entries at 2026-09-25T17:30Z must bucket to local 2026-09-26 (Asia/Taipei)');
      assert.strictEqual(utcDay, null, 'no entries should land on the UTC date 2026-09-25');
      assert.strictEqual(day.messages, 1, 'one user entry');
      assert.strictEqual(day.tools, 1, 'tool_use on a later split line counts once, replayed line not twice');
      assert.strictEqual(tok.tokens, 15, 'usage repeated across split lines counts once');
    } catch (e) {
      failures.push(`[E] fixture: ${e.message}`);
    }
  }

  if (failures.length > 0) {
    console.error('FAILED:\n' + failures.map(f => ' - ' + f).join('\n'));
    process.exit(1);
  }

  console.log('All collector.js invariant checks passed.');
}

main();
