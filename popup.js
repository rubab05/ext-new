// popup.js — Slot Booker v8. Talks to content.js via its onMessage listener.

const PAGE_LABELS = {
    'centre-search': 'Centre search',
    'centre-results': 'Centre results',
    'alternate-centre': 'No tests — alternate centres',
    'slot-picker': 'Slot picker',
    'your-details': 'Your details',
    'blocked': 'Blocked (Error 15)',
    'challenge': 'Human check',
    'manage-booking': 'View booking',
    'manage-intro': 'Choosing date and centre',
    'manage-date': 'Test date (change booking)',
    'unknown': 'Not a booking step'
};

const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const nextEl = $('next');
const messageEl = $('message');
const startBtn = $('startBtn');
const pauseBtn = $('pauseBtn');
const stopBtn = $('stopBtn');
const speedBtns = document.querySelectorAll('.speed-btn[data-mode]');
const changeBtns = document.querySelectorAll('.change-btn');
const filterInputs = $('filterInputs');
const dateTimeInputs = ['earliestISO', 'latestISO', 'earliestTime', 'latestTime'].map($);

// Written by content.js whenever it sees an Error 15 page: { at, loads60, loads120, loads300 }
// (a bare timestamp before v8.3). test-2's fresh session started ~1.5 min after
// test-1's block and was flagged from its first request; test-5's started ~1 min
// after one with new cookies and was blocked after 5 checks; test-3 started ~12 min
// after one and never was.
const LAST_BLOCK_KEY = 'sb8LastBlock';
const BLOCK_COOLDOWN_MS = 15 * 60 * 1000;
// The slot picker's dialog: "Please complete your booking within 15 minutes".
const HOLD_MS = 15 * 60 * 1000;
// Every captured block came at ~56–62 page loads per 2 min. Only a hint — Custom runs
// at what's entered.
const BLOCK_LOADS_2MIN = 56;
// A check is 2 page loads (the open and the page it redirects to); loading them and
// Imperva's sensor POST add ~0.7 s to the wait (test-5).
const CHECK_LOADS = 2;
// Changing the date at the same centre: back to the "Test date" form, then its
// POST and the picker it redirects to (har/change-date-refresh-no-earliest-date-found.har).
const DATE_CHECK_LOADS = 3;
const CHECK_OVERHEAD_MS = 700;

let tabId = null;
let modes = null;

// ---------- messaging ----------

async function send(action, data = {}) {
    if (tabId == null) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return null;
        tabId = tab.id;
    }
    try {
        return await chrome.tabs.sendMessage(tabId, { action, ...data });
    } catch (e) {
        return null; // content script not on this tab
    }
}

function readForm() {
    return {
        searchTerm: $('searchTerm').value.trim() || null,
        allowList: $('allowList').value.split(',').map((s) => s.trim()).filter(Boolean),
        manageCentres: $('manageCentres').value.split(',').map((s) => s.trim()).filter(Boolean),
        stickToCentre: $('stickToCentre').checked,
        customRefresh: { minMs: $('customMin').value, maxMs: $('customMax').value },
        filterEnabled: $('filterEnabled').checked,
        filter: {
            earliestISO: $('earliestISO').value || null,
            latestISO: $('latestISO').value || null,
            earliestTime: $('earliestTime').value || null,
            latestTime: $('latestTime').value || null
        }
    };
}

async function pushConfig(extra = {}) {
    await send('setConfig', { config: { ...readForm(), ...extra } });
}

// ---------- rendering ----------

function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function formatMs(ms) {
    return ms < 1000 ? `${ms}ms` : `${+(ms / 1000).toFixed(2)}s`;
}

function formatRange(min, max) {
    return min === max ? formatMs(min) : `${formatMs(min)}–${formatMs(max)}`;
}

function renderSpeed(mode, checkLoads = CHECK_LOADS) {
    speedBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('customRefresh').hidden = mode !== 'custom';
    const m = modes && modes[mode];
    if (!m) return;
    const wait = formatRange(m.refreshMin, m.refreshMax);
    if (mode !== 'custom') {
        $('speedHint').textContent = `Refresh every ${wait}, with occasional longer breaks`;
        $('speedHint').classList.remove('warn');
        return;
    }
    // content.js waits a random time in this range before each check.
    const perCheck = (m.refreshMin + m.refreshMax) / 2 + CHECK_OVERHEAD_MS;
    const loads = Math.round(checkLoads * 120000 / perCheck);
    const tight = loads >= BLOCK_LOADS_2MIN;
    $('speedHint').textContent = `A random ${wait} before each check, with occasional longer breaks — ` +
        `~${loads} page loads per 2 min` +
        (tight ? `; every Error 15 so far came at ${BLOCK_LOADS_2MIN}–62` : '');
    $('speedHint').classList.toggle('warn', tight);
}

function renderLoads(pace) {
    $('ctxLoads').textContent = pace ? `${pace.lastMin} last min · ${pace.last2Min} in 2 min` : '—';
    $('ctxLoads').className = 'ctx-value' + (pace && pace.last2Min ? '' : ' muted');
}

async function renderCooldown() {
    let rec = null;
    try {
        rec = (await chrome.storage.local.get(LAST_BLOCK_KEY))[LAST_BLOCK_KEY];
    } catch (e) { /* ignore */ }
    const at = rec && typeof rec === 'object' ? rec.at : rec;
    const left = at ? at + BLOCK_COOLDOWN_MS - Date.now() : 0;
    $('cooldownHint').hidden = left <= 0;
    if (left <= 0) return;
    const until = new Date(at + BLOCK_COOLDOWN_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const loads = rec && rec.loads120 != null ? ` (${rec.loads120} page loads in the 2 min before it)` : '';
    $('cooldownHint').textContent = `Error 15 was ${formatDuration(Date.now() - at)} ago${loads}. Until ${until} this ` +
        'browser gets blocked again after a few checks — new cookies only added a captcha in testing. ' +
        'Waiting is better.';
}

function renderFilterHint(cfg) {
    filterInputs.classList.toggle('disabled', !cfg.filterEnabled);
    $('filterHint').classList.remove('warn');
    if (!cfg.filterEnabled) {
        $('filterHint').textContent = 'Off — books the earliest available slot. Enter a date to turn it on.';
        return;
    }
    const f = cfg.filter || {};
    if (f.earliestISO && f.latestISO && f.earliestISO > f.latestISO) {
        $('filterHint').textContent = 'Earliest date is after the latest — no slot can match';
        $('filterHint').classList.add('warn');
        return;
    }
    const times = f.earliestTime || f.latestTime ? `, ${f.earliestTime || 'any'}–${f.latestTime || 'any'}` : '';
    $('filterHint').textContent = `On — only books ${f.earliestISO || 'any date'} → ${f.latestISO || 'any date'}${times}`;
}

function renderStickHint(cfg, run, manage) {
    if (!cfg.stickToCentre) {
        $('stickHint').textContent = 'Off — tries the centres near yours too, when yours has no tests';
        return;
    }
    const locked = run && run.stickCentre && run.stickCentre.name;
    $('stickHint').textContent = locked
        ? `On — watching ${locked} only, never other centres`
        : manage
            ? 'On — watches the first centre named under "Change existing booking"'
            : 'On — searching by centre name picks it; by postcode, name it above';
}

function renderChange(cfg, run) {
    const what = (run && run.running && run.manageMode) || cfg.changeWhat;
    changeBtns.forEach((b) => b.classList.toggle('active', b.dataset.change === what));
    $('manageCentresField').hidden = what !== 'centre';
    const named = cfg.manageCentres || [];
    $('changeHint').textContent = (what === 'centre'
        ? (named.length
            ? `Tries only ${named.join(', ')} of the centres sik lists near yours`
            : 'Tries every centre sik lists near yours')
        : 'Searches your centre again from the Test date page') +
        // content.js rangeDecides: a latest date → the range alone decides, in either mode.
        (cfg.filterEnabled && cfg.filter && cfg.filter.latestISO
            ? ' and takes any slot in your date range, even one after your current test.'
            : ' and only takes a slot earlier than your current test.') +
        ' Start on View booking; you confirm the change in the tab.';
}

function showMessage(text, kind) {
    messageEl.textContent = text || '';
    messageEl.className = 'message' + (text ? ` visible ${kind}` : '');
}

function render(s) {
    if (!s) {
        statusEl.className = 'status idle';
        statusEl.textContent = 'Open the booking site in this tab';
        startBtn.disabled = true;
        stopBtn.disabled = true;
        pauseBtn.style.display = 'none';
        nextEl.textContent = '';
        return;
    }

    const run = s.run || {};
    modes = s.modes;
    const dateChecks = s.page.manage && ((run.running && run.manageMode) || s.config.changeWhat) === 'date';
    renderSpeed(s.config.speedMode, dateChecks ? DATE_CHECK_LOADS : CHECK_LOADS);
    renderChange(s.config, run);
    renderLoads(s.pace);
    renderFilterHint(s.config);
    renderStickHint(s.config, run, s.page.manage);

    const page = s.page.type;
    $('ctxPage').textContent = PAGE_LABELS[page] || page;
    $('ctxPage').className = 'ctx-value' + (page === 'unknown' ? ' muted' : '');
    const stuck = run.stickCentre && run.stickCentre.name;
    const centre = stuck || s.page.centre || (run.centre && run.centre.name);
    $('ctxCentre').textContent = centre ? (stuck ? `📌 ${centre}` : centre) : '—';
    $('ctxCentre').className = 'ctx-value' + (centre ? ' good' : ' muted');
    const lr = run.lastResults;
    $('ctxResults').textContent = lr ? `${lr.total} centre(s), ${lr.available} available` : '—';
    $('ctxResults').className = 'ctx-value' + (lr && lr.available ? ' good' : ' muted');

    $('refreshValue').textContent = run.refreshCount || 0;
    const seen = run.lastSeen;
    $('slotsValue').textContent = !seen ? '—' : seen.matching != null ? `${seen.matching}/${seen.count}` : seen.count;
    $('slotsValue').title = seen && seen.matching != null ? `${seen.matching} of ${seen.count} it would take` : '';
    $('elapsedValue').textContent = run.startedAt ? formatDuration((run.running ? s.now : (run.stoppedAt || s.now)) - run.startedAt) : '—';

    if (run.running) {
        statusEl.className = run.paused ? 'status paused' : 'status running';
        statusEl.textContent = run.paused ? '⏸ Paused' : '🔄 Running';
        pauseBtn.style.display = 'block';
        pauseBtn.textContent = run.paused ? '▶ RESUME' : '⏸ PAUSE';
        startBtn.disabled = true;
        stopBtn.disabled = false;
        nextEl.textContent = !run.paused && run.nextActionAt
            ? `${run.nextActionLabel} in ${formatDuration(run.nextActionAt - Date.now())}`
            : (run.paused ? '' : 'Waiting for the page…');
        showMessage('', '');
        return;
    }

    pauseBtn.style.display = 'none';
    stopBtn.disabled = true;
    startBtn.disabled = false;
    nextEl.textContent = '';

    switch (run.stopKind) {
        case 'held': {
            // bookedAt is new; a run held by an older version only has stoppedAt.
            const since = s.now - (run.bookedAt || run.stoppedAt);
            const left = HOLD_MS - since;
            statusEl.className = 'status done';
            statusEl.textContent = `✅ Slot grabbed ${formatDuration(since)} ago`;
            nextEl.textContent = left > 0
                ? `About ${formatDuration(left)} left of sik's 15-minute hold — finish in the tab`
                : "Over 15 minutes — sik's hold may have lapsed";
            showMessage(run.stopReason, 'ok');
            break;
        }
        case 'blocked':
        case 'challenge':
            statusEl.className = 'status error';
            statusEl.textContent = run.stopKind === 'blocked' ? '🚫 Blocked by Imperva' : '🧩 Human check';
            showMessage(run.stopReason, 'warn');
            break;
        case 'loop':
            statusEl.className = 'status error';
            statusEl.textContent = '🔁 Stuck in a loop — stopped';
            showMessage(run.stopReason, 'warn');
            break;
        case undefined:
        case null:
            statusEl.className = 'status idle';
            statusEl.textContent = page === 'blocked' ? '🚫 This tab is blocked (Error 15)' : 'Ready';
            showMessage('', '');
            break;
        default:
            statusEl.className = 'status idle';
            statusEl.textContent = 'Stopped';
            showMessage(run.stopReason, 'warn');
    }
}

async function poll() {
    render(await send('getStatus'));
    renderCooldown();
}

// ---------- events ----------

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    await pushConfig();
    await send('start');
    poll();
});

stopBtn.addEventListener('click', async () => {
    await send('stop');
    poll();
});

pauseBtn.addEventListener('click', async () => {
    const s = await send('getStatus');
    await send(s && s.run && s.run.paused ? 'resume' : 'pause');
    poll();
});

$('resetBtn').addEventListener('click', async () => {
    await send('reset');
    poll();
});

speedBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
        await pushConfig({ speedMode: btn.dataset.mode });
        poll();
    });
});

changeBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
        await pushConfig({ changeWhat: btn.dataset.change });
        poll();
    });
});

let debounce = null;
[$('searchTerm'), $('allowList'), $('manageCentres'), $('customMin'), $('customMax')].forEach((el) => el.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(pushConfig, 400);
}));
[$('filterEnabled'), $('stickToCentre')].forEach((el) => el.addEventListener('change', () => {
    pushConfig().then(poll);
}));
// Entering a date or time is asking for the range, so it switches the filter on.
dateTimeInputs.forEach((el) => el.addEventListener('change', () => {
    if (el.value) $('filterEnabled').checked = true;
    pushConfig().then(poll);
}));

// ---------- init ----------

async function init() {
    const s = await send('getStatus');
    if (s) {
        const c = s.config;
        $('searchTerm').value = c.searchTerm || '';
        $('allowList').value = (c.allowList || []).join(', ');
        $('manageCentres').value = (c.manageCentres || []).join(', ');
        $('stickToCentre').checked = !!c.stickToCentre;
        $('customMin').value = c.customRefresh.minMs;
        $('customMax').value = c.customRefresh.maxMs === c.customRefresh.minMs ? '' : c.customRefresh.maxMs;
        $('filterEnabled').checked = !!c.filterEnabled;
        $('earliestISO').value = c.filter.earliestISO || '';
        $('latestISO').value = c.filter.latestISO || '';
        $('earliestTime').value = c.filter.earliestTime || '';
        $('latestTime').value = c.filter.latestTime || '';
    }
    render(s);
    renderCooldown();
    setInterval(poll, 1000);
}

init();
