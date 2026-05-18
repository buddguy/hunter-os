/* ============================================================
   HUNTER OS — DAILY BRIEFING PIPELINE v1
   ============================================================
   Tier 1 Dispatch orchestration layer.

   What it does:
   1. Adds data.agent_state — persistent per-agent state reports
      that survive page reloads (saved with the rest of your data).
   2. Replaces Dispatch's system prompt with the spec-accurate one
      (the 🔴🟡🟢 three-priority briefing format with conflict rules).
   3. After every chat with a Tier 2 agent (Coach, Study, Forge,
      Anchor), silently fires a small Haiku call that extracts a
      single-word state report and stores it on data.agent_state.
   4. Adds a "TODAY'S BRIEFING" card at the top of the home screen.
      Tap GENERATE → builds a context blob from all agent_state +
      live data (today's classes, pending assignments, exams,
      streak, recovery, mental_load) → sends it to Dispatch on
      Sonnet 4.6 → renders the 3-priority briefing.
   5. Persists the latest briefing to localStorage so it shows on
      reload without re-spending API credits.

   Privacy: Anchor's notes/content NEVER enter the Dispatch context
   blob. Only the single-word mental_load level is shared (per spec).

   How to wire it into your existing index.html:
     <script src="briefing-pipeline.js"></script>
   Add it AFTER your existing agents script (the one that defines
   window.AGENTS and window.data). It will self-initialize.
   ============================================================ */

(function () {
  'use strict';

  // ---------- 1. SPEC-ACCURATE DISPATCH SYSTEM PROMPT ----------
  const DISPATCH_SYSTEM = `You are Dispatch, the Tier 1 chief of staff agent for Tobache's personal AI system.

Tobache is a 21-year-old FinTech student at Air University Islamabad. He runs multiple parallel tracks: university (6 subjects), gym (lean bulk goal), AI automation agency (jewelry client), Courtly (padel court booking app MVP), and mental health management. He gets scattered without structure.

YOUR JOB: Synthesise reports from 4 domain agents and produce a clear daily plan. Max 3 priorities per day. No filler.

DAILY BRIEFING FORMAT:
Good morning. Here's today.

🔴 {Domain emoji} {Domain} — {Task} ({why it matters today})
🟡 {Domain emoji} {Domain} — {Task} ({context})
🟢 {Domain emoji} {Domain} — {Task} (optional)

Status: {Fresh/Tired/Overtrained} · {Clear/Moderate/High/Critical mental load} · {On track/Stalled}

What's your top 1 thing?

DOMAIN EMOJIS: 🎓 UNI | 🏋️ FITNESS | 💼 AGENCY | 🎯 COURTLY | 🧠 MENTAL | 💸 MONEY

PRIORITY COLOURS: 🔴 must happen today | 🟡 should happen today | 🟢 if time allows

CONFLICT RULES (in order):
1. Hard deadline today → always 🔴, always first
2. Overtrained or critical mental load → cap day at 2 tasks
3. Client delivery at risk → bump to 🔴
4. Stalled priority project → give 🟡 slot
5. Default order: UNI → AGENCY → COURTLY → FITNESS → MENTAL → MONEY

HARD RULES:
- Never more than 3 priorities
- Never ask more than 1 question at a time
- No vague tasks — always a specific next action
- Never surface raw Anchor scores or specifics (privacy)
- If something is 3+ days pending, flag it ⚠️

TRIGGERS you respond to:
- "daily_briefing" → 3 priorities + status
- "weekly_plan" → 7-day table
- "brain_dump {text}" → sort by domain with urgency tags
- "decision {options}" → recommendation + 1-line reason
- "friday_review" → what shipped, what slipped, one adjustment`;

  // ---------- 2. STATE EXTRACTOR PROMPTS (per Tier 2 agent) ----------
  const STATE_EXTRACTORS = {
    coach: {
      stateKey: 'coach_zero',
      prompt: `Read the conversation below. Output ONLY a JSON object — no markdown, no commentary.
Schema:
{"recovery_status":"fresh|tired|overtrained","last_session_energy":<1-10 or null>,"summary":"one short sentence (max 18 words) capturing the current training state for Dispatch"}

Rules:
- fresh: last session 2+ days ago OR energy 7+
- tired: 3+ days in a row OR energy 4–6
- overtrained: 5+ sessions in 7 days with energy consistently below 5
- If conversation has no fitness signal, return {"recovery_status":"unknown","last_session_energy":null,"summary":"no recent fitness data"}`
    },
    study: {
      stateKey: 'study_dispatch',
      prompt: `Read the conversation below. Output ONLY a JSON object — no markdown, no commentary.
Schema:
{"exam_pressure_level":"low|medium|high","deadlines_this_week":<int>,"summary":"one short sentence (max 18 words) capturing the academic state for Dispatch"}

Rules:
- low: no exams or major submissions this week or next
- medium: 1–2 graded items due within 7 days
- high: exam or major submission within 3 days, OR 3+ graded items this week
- If no academic signal, return {"exam_pressure_level":"unknown","deadlines_this_week":0,"summary":"no recent academic data"}`
    },
    forge: {
      stateKey: 'the_forge',
      prompt: `Read the conversation below. Output ONLY a JSON object — no markdown, no commentary.
Schema:
{"momentum":"high|medium|low|stalled","priority_project":"jewelry_client|courtly|hunter_os|certification|other","summary":"one short sentence (max 18 words) capturing the current build state for Dispatch"}

If no build signal, return {"momentum":"unknown","priority_project":"jewelry_client","summary":"no recent build activity"}`
    },
    anchor: {
      stateKey: 'anchor',
      // CRITICAL: only the single-word level escapes. No summary, no specifics.
      prompt: `Read the conversation below. Output ONLY a JSON object — no markdown, no commentary.
Schema:
{"mental_load":"low|moderate|high|critical"}

Rules:
- low: energy and mood both 7+, no major stressors mentioned
- moderate: one domain under pressure, energy/mood 5–7
- high: multiple domains under pressure, energy/mood 4–6
- critical: energy/mood avg below 4 across recent messages, OR explicit inability-to-cope language
- If no clarity, return {"mental_load":"unknown"}

PRIVACY: do not include any summary, notes, or specifics. Only the level.`
    }
  };

  // ---------- 3. CLAUDE API HELPER ----------
  function getKey() {
    return window.CLAUDE_API_KEY || localStorage.getItem('hunterOS_claudeKey') || null;
  }
  async function callClaude(model, system, userMsg, maxTokens) {
    const key = getKey();
    if (!key) throw new Error('No API key — add one via ⚙️ on home');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens || 800,
        system: system,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    return d.content[0].text;
  }

  // ---------- 4. STATE INITIALIZATION ----------
  function ensureState() {
    if (!window.data) return false;
    if (!window.data.agent_state) {
      window.data.agent_state = {
        coach_zero: { recovery_status: 'unknown', last_session_energy: null, sessions_this_week: 0, summary: '', last_report: null },
        study_dispatch: { exam_pressure_level: 'unknown', deadlines_this_week: 0, summary: '', last_report: null },
        the_forge: { momentum: 'unknown', priority_project: 'jewelry_client', summary: '', last_report: null },
        anchor: { mental_load: 'unknown', last_report: null }
      };
    }
    if (!window.data.dailyBriefing) {
      window.data.dailyBriefing = { date: null, content: null, generatedAt: null };
    }
    if (typeof window.save === 'function') window.save();
    return true;
  }

  // ---------- 5. AUTO STATE EXTRACTION AFTER TIER 2 CHAT ----------
  async function extractStateFor(agentId) {
    const cfg = STATE_EXTRACTORS[agentId];
    if (!cfg) return;
    const hist = (window.agentChat && window.agentChat.history && window.agentChat.history[agentId]) || [];
    if (hist.length < 2) return; // need at least one exchange
    const recent = hist.slice(-8)
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');
    const fullPrompt = cfg.prompt + '\n\n--- CONVERSATION ---\n' + recent;
    try {
      const text = await callClaude('claude-haiku-4-5-20251001', '', fullPrompt, 200);
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return;
      const parsed = JSON.parse(m[0]);
      const slot = window.data.agent_state[cfg.stateKey];
      Object.assign(slot, parsed);
      slot.last_report = new Date().toISOString();
      if (typeof window.save === 'function') window.save();
    } catch (e) {
      console.warn('State extraction failed for ' + agentId + ':', e.message);
    }
  }

  // Wrap window.sendAgent so state is auto-extracted after each Tier 2 chat.
  function hookSendAgent() {
    if (!window.sendAgent || window.sendAgent.__briefingHooked) return;
    const original = window.sendAgent;
    window.sendAgent = async function () {
      await original.apply(this, arguments);
      const id = window.agentChat && window.agentChat.active;
      if (id && STATE_EXTRACTORS[id]) {
        // fire and forget — don't block UI
        extractStateFor(id);
      }
    };
    window.sendAgent.__briefingHooked = true;
  }

  // ---------- 6. CONTEXT BUILDER ----------
  function getGymSessionsThisWeek() {
    if (!window.data || !window.data.gym || !window.data.gym.weekLog) return 0;
    const today = new Date();
    const log = window.data.gym.weekLog;
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - today.getDay() + i);
      const key = d.toISOString().split('T')[0];
      if (log[key] && log[key] !== 'rest') count++;
    }
    return count;
  }

  function getTodayDayName() {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
  }

  function getCurrentRankName() {
    if (typeof window.getCurrentRank !== 'function' || !window.RANKS) return 'E-RANK';
    return window.RANKS[window.getCurrentRank()].full;
  }

  function daysSince(iso) {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  function buildDispatchContext() {
    const d = window.data;
    const s = d.agent_state;
    const today = new Date();
    const todayName = getTodayDayName();

    // Today's classes
    const todayClasses = (d.timetable || [])
      .filter(c => c.day === todayName)
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    // Pending assignments — include stale flag
    const pendingAssignments = [];
    (d.subjects || []).forEach(sub => {
      (sub.assignments || []).forEach(a => {
        if (!a.done) {
          pendingAssignments.push({
            subject: sub.name,
            text: a.text,
            due: a.due || null,
            staleDays: a.id ? daysSince(new Date(a.id).toISOString()) : null
          });
        }
      });
    });

    // Upcoming events next 14 days
    const upcoming = (d.events || [])
      .map(e => ({ ...e, daysLeft: Math.ceil((new Date(e.date) - today) / 86400000) }))
      .filter(e => e.daysLeft >= 0 && e.daysLeft <= 14)
      .sort((a, b) => a.daysLeft - b.daysLeft);

    const exams = upcoming.filter(e => e.type === 'exam');
    const deadlines = upcoming.filter(e => e.type === 'deadline');

    // Section completion today
    const sections = (d.player && d.player.sectionsToday) || {};
    const sectionsDone = Object.keys(sections).filter(k => sections[k]);

    // Recent state report ages
    const coachAge = daysSince(s.coach_zero.last_report);
    const studyAge = daysSince(s.study_dispatch.last_report);
    const forgeAge = daysSince(s.the_forge.last_report);
    const anchorAge = daysSince(s.anchor.last_report);

    const stale = (age) => age === null ? '⚠ no data ever' : age >= 3 ? `⚠ ${age}d stale` : `${age}d ago`;

    let ctx = `=== TIER 2 AGENT STATE REPORTS ===
COACH_ZERO: recovery=${s.coach_zero.recovery_status} | sessions_this_week=${getGymSessionsThisWeek()} | last_energy=${s.coach_zero.last_session_energy || 'n/a'} | last_report=${stale(coachAge)}
  summary: "${s.coach_zero.summary || 'no recent fitness data'}"

STUDY_DISPATCH: exam_pressure=${s.study_dispatch.exam_pressure_level} | pending_assignments=${pendingAssignments.length} | last_report=${stale(studyAge)}
  summary: "${s.study_dispatch.summary || 'no recent academic data'}"

THE_FORGE: momentum=${s.the_forge.momentum} | priority_project=${s.the_forge.priority_project} | last_report=${stale(forgeAge)}
  summary: "${s.the_forge.summary || 'no recent build activity'}"

ANCHOR: mental_load=${s.anchor.mental_load} | last_report=${stale(anchorAge)}
  (privacy: do NOT reveal specifics or scores — only the level above is visible to you)

=== LIVE DATA FROM HUNTER OS ===
Date: ${today.toDateString()} (${todayName})
Rank: ${getCurrentRankName()} · Streak: ${d.player.streak} days · Total XP: ${d.player.totalXp}
Sections completed today: ${sectionsDone.length ? sectionsDone.join(', ') : 'none yet'}

Today's classes (${todayClasses.length}):
${todayClasses.length ? todayClasses.map(c => `  - ${c.name} @ ${c.start || '?'}${c.room ? ' [' + c.room + ']' : ''}`).join('\n') : '  (none)'}

Pending assignments (${pendingAssignments.length}):
${pendingAssignments.length ? pendingAssignments.slice(0, 8).map(a => `  - [${a.subject}] ${a.text}${a.due ? ' — due ' + a.due : ''}${a.staleDays && a.staleDays >= 3 ? ' ⚠️' : ''}`).join('\n') : '  (none)'}

Upcoming exams (next 14 days, ${exams.length}):
${exams.length ? exams.map(e => `  - ${e.title} in ${e.daysLeft} days`).join('\n') : '  (none)'}

Upcoming deadlines (next 14 days, ${deadlines.length}):
${deadlines.length ? deadlines.map(e => `  - ${e.title} in ${e.daysLeft} days`).join('\n') : '  (none)'}`;

    return ctx;
  }

  // ---------- 7. BRIEFING GENERATION ----------
  async function generateDailyBriefing() {
    if (!getKey()) {
      window.showToast && window.showToast('Add your API key first (⚙️ on home)');
      return;
    }
    ensureState();
    const today = new Date().toISOString().split('T')[0];
    const ctxBlob = buildDispatchContext();
    const userMsg = `daily_briefing\n\n${ctxBlob}`;
    setBriefingLoading(true);
    try {
      const text = await callClaude('claude-sonnet-4-6', DISPATCH_SYSTEM, userMsg, 1024);
      window.data.dailyBriefing = {
        date: today,
        content: text,
        generatedAt: Date.now()
      };
      if (typeof window.save === 'function') window.save();
      renderBriefingCard();
      window.showToast && window.showToast('✅ Today\'s briefing ready');
    } catch (e) {
      const card = document.getElementById('briefingContent');
      if (card) {
        card.innerHTML = `<div style="color:var(--red);font-size:13px;padding:10px 0">⚠️ Briefing failed: ${escHtml(e.message)}</div>`;
      }
      window.showToast && window.showToast('Briefing failed: ' + e.message);
    } finally {
      setBriefingLoading(false);
    }
  }

  function setBriefingLoading(on) {
    const btn = document.getElementById('briefingGenBtn');
    const spinner = document.getElementById('briefingSpinner');
    if (btn) btn.disabled = on;
    if (spinner) spinner.style.display = on ? 'block' : 'none';
  }

  // ---------- 8. UI: BRIEFING CARD ON HOME SCREEN ----------
  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtBriefing(text) {
    // Light markdown-ish rendering — bold, bullets, priority colors
    return escHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--cyan)">$1</strong>')
      .replace(/^(🔴.+)$/gm, '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5"><span>$1</span></div>'.replace('$1', '$1'))
      .replace(/^(🟡.+)$/gm, '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5"><span>$1</span></div>')
      .replace(/^(🟢.+)$/gm, '<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5"><span>$1</span></div>')
      .replace(/^Status: (.+)$/gm, '<div style="margin-top:10px;padding:8px 12px;background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.2);border-radius:8px;font-family:Rajdhani,sans-serif;font-size:11px;letter-spacing:1px;color:var(--cyan)">📊 $1</div>')
      .replace(/^(What's your top 1 thing\?)$/gm, '<div style="margin-top:10px;font-family:Rajdhani,sans-serif;font-size:13px;font-weight:700;color:var(--gold);letter-spacing:1px">$1</div>')
      .replace(/^Good morning\. Here's today\./gm, '<div style="font-family:Rajdhani,sans-serif;font-size:12px;color:var(--text3);letter-spacing:2px;margin-bottom:8px">GOOD MORNING · HERE\'S TODAY</div>');
  }

  function injectBriefingCard() {
    if (document.getElementById('dispatchBriefingCard')) return;
    const home = document.getElementById('screen-home');
    if (!home) return;
    const header = home.querySelector('.page-header');
    const card = document.createElement('div');
    card.id = 'dispatchBriefingCard';
    card.style.cssText = 'margin:16px;background:linear-gradient(135deg,rgba(0,212,255,0.06),rgba(74,144,217,0.03));border:1px solid rgba(0,212,255,0.3);border-radius:16px;padding:16px;position:relative;overflow:hidden';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:20px">🎯</span>
        <div style="flex:1">
          <div style="font-family:Rajdhani,sans-serif;font-size:10px;color:var(--text3);letter-spacing:2px">TIER 1 DISPATCH</div>
          <div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:var(--cyan);letter-spacing:1px">TODAY'S BRIEFING</div>
        </div>
        <button id="briefingGenBtn" onclick="window.generateDailyBriefing()" style="background:rgba(0,212,255,0.15);border:1px solid var(--cyan);border-radius:8px;padding:6px 12px;color:var(--cyan);font-family:Rajdhani,sans-serif;font-weight:700;font-size:11px;letter-spacing:1px;cursor:pointer">⚡ GENERATE</button>
      </div>
      <div id="briefingSpinner" style="display:none;text-align:center;padding:14px;color:var(--cyan);font-family:Rajdhani,sans-serif;font-size:12px;letter-spacing:2px;animation:pulse 1s infinite">🤖 SYNTHESISING REPORTS...</div>
      <div id="briefingContent"></div>
      <div id="briefingMeta" style="margin-top:10px;font-family:Rajdhani,sans-serif;font-size:10px;color:var(--text3);letter-spacing:1px;text-align:right;display:none"></div>
    `;
    if (header && header.parentNode) {
      header.parentNode.insertBefore(card, header.nextSibling);
    } else {
      home.prepend(card);
    }
  }

  function renderBriefingCard() {
    const content = document.getElementById('briefingContent');
    const meta = document.getElementById('briefingMeta');
    const btn = document.getElementById('briefingGenBtn');
    if (!content) return;

    const b = window.data && window.data.dailyBriefing;
    const today = new Date().toISOString().split('T')[0];

    if (!b || !b.content) {
      content.innerHTML = `<div style="padding:14px;background:rgba(255,255,255,0.02);border:1px dashed var(--border);border-radius:10px;text-align:center;color:var(--text3);font-size:12px;line-height:1.6">No briefing yet. Hit <b style="color:var(--cyan)">⚡ GENERATE</b> to have Dispatch synthesise reports from your 4 Tier 2 agents.</div>`;
      meta.style.display = 'none';
      if (btn) btn.textContent = '⚡ GENERATE';
      return;
    }

    content.innerHTML = fmtBriefing(b.content);
    const isToday = b.date === today;
    const generated = new Date(b.generatedAt);
    const ago = Math.floor((Date.now() - b.generatedAt) / 60000);
    const agoStr = ago < 1 ? 'just now' : ago < 60 ? ago + 'm ago' : Math.floor(ago / 60) + 'h ago';
    meta.style.display = 'block';
    meta.innerHTML = `${isToday ? '✅ TODAY' : '⚠ STALE (' + b.date + ')'} · GENERATED ${agoStr}`;
    if (btn) btn.textContent = isToday ? '🔄 REFRESH' : '⚡ GENERATE';
  }

  // ---------- 9. EXPOSE PUBLIC API ----------
  window.generateDailyBriefing = generateDailyBriefing;
  window.renderBriefingCard = renderBriefingCard;
  window.buildDispatchContext = buildDispatchContext; // useful for debugging — type buildDispatchContext() in console

  // ---------- 10. PATCH DISPATCH SYSTEM PROMPT ----------
  function patchDispatchPrompt() {
    if (window.AGENTS && window.AGENTS.dispatch) {
      window.AGENTS.dispatch.system = DISPATCH_SYSTEM;
    }
  }

  // ---------- 11. INIT ----------
  let initAttempts = 0;
  function init() {
    initAttempts++;
    if (!window.data || !window.AGENTS) {
      if (initAttempts > 40) {
        console.error('🎯 Briefing pipeline: gave up waiting for Hunter OS (40 retries).');
        return;
      }
      return setTimeout(init, 150);
    }
    ensureState();
    patchDispatchPrompt();
    injectBriefingCard();
    hookSendAgent();
    renderBriefingCard();
    console.log('%c🎯 Daily Briefing Pipeline v1 — ready', 'color:#00d4ff;font-family:monospace;font-weight:bold');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 400));
  } else {
    setTimeout(init, 400);
  }
})();
