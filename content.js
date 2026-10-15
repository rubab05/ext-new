// Fast Slot Booker v8 (new booking)
// =========================================================================
// Follows har/search-centre-and-book-latest.har step for step:
//
//   POST /application?execution=e1s45&_eventId=search         (search form)
//        _csrf, testCentreName=cardigan, testCentreSubmit=…    → 302 e1s46
//   GET  /application?execution=e1s46                          → centre results
//        … no centre available → submit the search again (the "refresh") …
//   GET  /application?execution=e1s46&_eventId=proceed&centreID=375
//                                                              → 302 e1s47 slot picker
//   POST /application?execution=e1s47&_eventId=proceed
//        _csrf, slotWarningAcknowledged=true, slotTime=<ms>    → 302 e1s48 "Your details"
//
// WHY EVERY STEP IS A REAL PAGE NAVIGATION (the "Error 15" fix)
// -------------------------------------------------------------
// Every page on this site loads Imperva's bot-protection script
// (/nions-to-vnse-the-Bewarfish-so-like-here-hoa-Mon). On each page load it
// POSTs browser sensor data and receives a fresh `reese84` token. v7 refreshed
// with background fetch() calls instead: those never run that script, carry
// fetch-style Sec-Fetch-* headers (cors/empty instead of navigate/document),
// and arrived every 1.5–3s. After enough of them Imperva blocks the session
// with "Error 15" (request blocked by security rules).
//
// v8 therefore drives the real tab: it fills and submits the page's own search
// form, clicks the centre link, and natively submits the slot-picker form.
// Every request is a genuine document navigation, the Imperva script runs on
// every page exactly as it does for a person, and the loop state survives
// navigations in sessionStorage (per tab). No synthetic mouse events are
// dispatched — untrusted events are themselves a bot signal.
//
// CHANGE AN EXISTING BOOKING (/manage) — swap to an earlier date
// --------------------------------------------------------------
// Same centre (har/change-date-refresh-no-earliest-date-found.har):
//   POST /manage?execution=e2s4&_eventId=proceed               ("Test date" form)
//        _csrf, testChoice=ASAP, preferredTestDate, drivingLicenceSubmit
//                                                              → 302 e2s15 slot picker
//   … nothing earlier than the current test (its radio is the checked one) …
//   GET  /manage?execution=e2s4      (back) → submit the form again → 302 e2s16
// Nearby centres (har/already-booked-change-date-or-centre.har):
//   GET  /manage?execution=e2s2&_eventId=editTestCentre        → 302 centre list
//   GET  /manage?execution=e2s12&_eventId=proceed&centreID=482 → picker or "no tests"
// — the new-booking centre loop, on a list it fills in (no search box, no
// availability markers). Either way only a slot earlier than the current test is
// taken, and the run stops on the page after the slot: the change is confirmed by hand.
// =========================================================================

(function () {
    'use strict';

    // ==================== SPEED MODES ====================
    // refresh*: wait on a results page before re-submitting the search.
    // breakEvery/breakMs: every N refreshes take a longer pause.

    const SPEED_MODES = {
        safe: {
            name: 'Safe',
            refreshMin: 15000, refreshMax: 30000,
            breakEvery: [12, 20], breakMs: [120000, 240000]
        },
        normal: {
            name: 'Normal',
            refreshMin: 8000, refreshMax: 15000,
            breakEvery: [20, 30], breakMs: [60000, 150000]
        },
        fast: {
            name: 'Fast',
            refreshMin: 5000, refreshMax: 9000,
            breakEvery: [30, 45], breakMs: [45000, 90000]
        },
        ultra: {
            name: 'Ultra',
            refreshMin: 1000, refreshMax: 3000,
            breakEvery: [20, 30], breakMs: [60000, 120000]
        },
        // refreshMin/refreshMax come from CONFIG.customRefresh (milliseconds, set in the popup).
        custom: {
            name: 'Custom',
            refreshMin: null, refreshMax: null,
            breakEvery: [20, 30], breakMs: [60000, 150000]
        }
    };

    const CUSTOM_REFRESH_LIMITS = [0, 600000]; // ms

    // START acts at once: the run's first navigation waits for nothing but Imperva's
    // sensor POST (see isKickoff). v8.1 held the first search back 1.2–2.5 s.
    // Time-critical actions — opening a centre that has just shown availability,
    // the run's first centre open, submitting a slot — race every other candidate
    // watching the same centre. They wait only this jitter plus, at most,
    // SENSOR_WAIT_CAP for Imperva's sensor POST (see afterSensor; submitting a slot
    // skips the jitter and waits at most BOOK_SENSOR_CAP), so the whole hop
    // is ~0.5 s instead of the old load-event wait + 1.2–2.5 s. These happen once
    // per real slot or per START, so they don't move the rate Error 15 polices.
    const FAST_DELAY = [150, 400];
    const SENSOR_WAIT_CAP = 2000;
    // Booking a slot waits for the sensor POST at most this long. The POST lands
    // ~0.3–0.4 s after the picker loads; the 2 s cap was for a failed first try and
    // its retry, and it put up to 2.4 s (with FAST_DELAY) between the picker and the
    // booking — the slot can go in that time. A booking happens once per run.
    const BOOK_SENSOR_CAP = 600;
    // Error 15 is a page-load rate limit over about two minutes. A "load" is one
    // document request, and a redirect hop (the 302 from …&_eventId=proceed or
    // …&_eventId=search) is one more:
    //   har/test-5-error-post-fix.har        3 loads a check, 52/min → blocked at 65 s,
    //                                         56 loads in the last 120 s
    //   har/error-15-sensitive-centre-name   2 loads a check, 48/min → blocked at 76 s,
    //                                         62 in 120 s; the reloads at 97–106 s stayed
    //                                         blocked with only 27–33 in the last 60 s but
    //                                         63–65 in the last 120 s
    //   har/test-3-…-error.har               test-5's exact cadence, reached its slot at
    //                                         55 in 120 s — luck, not headroom
    // So every re-check is kept to one navigation (2 loads) where the site allows it,
    // and the wait before it is the speed mode's range, drawn at random per check —
    // in Custom exactly what the popup says, nothing added. v8.3 drew a gap per page
    // load instead, so a 1–5 s range waited 2–10 s per check and 6–30 s on the
    // change → search → open path. The loads are still counted (recordPageLoad), for
    // the popup and the block record.
    const LOAD_LOG_MS = 10 * 60 * 1000;
    // Opening a centre (…&_eventId=proceed&centreID=) is the most heavily policed
    // request in the flow: har/error-15-sensitive-centre-name.har was blocked after
    // 31 of them in 76s. In Safe/Normal/Fast a blind open gets its own slower floor
    // (see floorsApply — Custom and Ultra run at the popup's speed instead).
    const CENTRE_OPEN_DELAY = [2500, 5000];
    const MAX_CENTRE_OPENS = 60;
    const MAX_REFRESHES = 500;
    // Every action this engine schedules ends in a real navigation. Counting them
    // bounds loops that never touch the search form (refreshCount misses those).
    const MAX_NAVIGATIONS = 600;
    const MAX_SLOT_ATTEMPTS = 5;
    // A centre whose slot picker had nothing matching the filter is ignored for
    // this many refreshes, so we don't bounce centre → picker → search forever.
    const CENTRE_SKIP_REFRESHES = 5;
    // Ping-pong guard: if the last CENTRE_LOOP_WINDOW centre opens only cycle over
    // CENTRE_LOOP_DISTINCT centres, we're in the 105 → 125 → 105 → 125 loop that
    // triggered Error 15. Stop instead of letting Imperva stop us.
    const CENTRE_LOOP_WINDOW = 6;
    const CENTRE_LOOP_DISTINCT = 2;

    // "Stick to one centre" (har/check-same-centre-on-loop.har). Instead of
    // re-running the search, re-open the same centre from the results page's link:
    // its execution=e1sN stays valid, so the same &_eventId=proceed&centreID= fires
    // again and again (e1s9 → e1s10 … e1s14 in the capture; test-2 still re-opened
    // e1s7 after e1s32). Every cycle is a centre open, so in Safe/Normal/Fast the
    // cycle gets its own floor on top of CENTRE_OPEN_DELAY; Custom and Ultra follow
    // the popup's speed.
    // Probe strategy (centre-name search, no availability marker): the link is opened
    // straight from the dead-end page, so the tab stays on the alternate-centre page
    // between checks. Going back to the results page first (v8.2) made every check
    // 3 page loads instead of 2 and showed nothing new — on a name search it carries
    // no availability — and at test-5's cadence that third load is what took it past
    // Imperva's limit.
    const STICK_MIN_CYCLE = 4000;
    // history.back() should land on the results page; if that entry is gone the
    // back is a no-op, so fall back to the saved URL after this long.
    const STICK_BACK_FALLBACK = 3000;

    const RUN_KEY = 'sb8Run';
    // /manage: the booked test, noted whenever this tab shows it (View booking, or the
    // checked radio on its centre's picker) — run or no run. Lets a run started on the
    // centre list or a picker know what "earlier" means.
    const BOOKING_KEY = 'sb8Booking';
    const CONFIG_KEY = 'sb8Config';
    // In chrome.storage (not the site's storage), so they survive cookie clears and
    // are shared by every tab: Imperva counts the browser, not the tab.
    const LAST_BLOCK_KEY = 'sb8LastBlock';
    const PACE_KEY = 'sb8Pace';

    const CONFIG = {
        speedMode: 'normal',
        customRefresh: { minMs: 5000, maxMs: 8000 },
        searchTerm: null,       // postcode or centre name
        allowList: [],          // optional: only these centre names/ids
        // Lock onto the first centre opened and re-check only that one, instead of
        // searching again and taking whatever the results page offers.
        stickToCentre: false,
        // /manage started on "View booking" or a slot picker: 'date' re-searches the
        // current centre from the "Test date" form, 'centre' tries the centre list.
        changeWhat: 'date',
        manageCentres: [],
        filterEnabled: false,
        filter: {
            earliestISO: null,  // 'YYYY-MM-DD' inclusive
            latestISO: null,
            earliestTime: null, // 'HH:MM' inclusive
            latestTime: null
        }
    };

    const CHANGE_MODES = ['date', 'centre'];

    const log = (...a) => console.log('[SlotBooker8]', ...a);
    const warn = (...a) => console.warn('[SlotBooker8]', ...a);

    // ==================== UTILITIES ====================

    function randInt(min, max) {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    function randRange([min, max]) {
        return randInt(min, max);
    }

    function modeFor(key) {
        const m = SPEED_MODES[key] || SPEED_MODES.normal;
        if (m !== SPEED_MODES.custom) return m;
        const { minMs, maxMs } = CONFIG.customRefresh;
        return { ...m, refreshMin: minMs, refreshMax: maxMs };
    }

    function mode() {
        return modeFor(CONFIG.speedMode);
    }

    /**
     * The Error-15 floors (CENTRE_OPEN_DELAY, STICK_MIN_CYCLE) must not override a
     * speed the user picked on purpose: they made Custom (and Ultra) always run at
     * ~4 s whatever was entered in the popup.
     */
    function floorsApply() {
        return CONFIG.speedMode !== 'custom' && CONFIG.speedMode !== 'ultra';
    }

    /**
     * { minMs, maxMs } from popup input, clamped and ordered; null if min is missing.
     * An empty max means a fixed delay. Configs saved before v8.2 are in seconds.
     */
    function parseCustomRefresh(c) {
        if (!c) return null;
        const legacy = c.minMs == null && c.minSec != null;
        const scale = legacy ? 1000 : 1;
        const rawMin = legacy ? c.minSec : c.minMs;
        const rawMaxIn = legacy ? c.maxSec : c.maxMs;
        if (rawMin == null || rawMin === '') return null;
        const min = Number(rawMin) * scale;
        if (!Number.isFinite(min)) return null;
        const rawMax = rawMaxIn == null || rawMaxIn === '' ? min : Number(rawMaxIn) * scale;
        const max = Number.isFinite(rawMax) ? rawMax : min;
        const [lo, hi] = CUSTOM_REFRESH_LIMITS;
        const clamp = (v) => Math.round(Math.min(hi, Math.max(lo, v)));
        return { minMs: clamp(Math.min(min, max)), maxMs: clamp(Math.max(min, max)) };
    }

    function clean(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    /** On the change-booking flow (/manage) rather than a new booking (/application). */
    function isManage() {
        return location.pathname.startsWith('/manage');
    }

    // ==================== CONFIG (chrome.storage.local) ====================

    async function loadConfig() {
        try {
            const r = await chrome.storage.local.get(CONFIG_KEY);
            const c = r[CONFIG_KEY];
            if (!c) return;
            if (SPEED_MODES[c.speedMode]) CONFIG.speedMode = c.speedMode;
            const custom = parseCustomRefresh(c.customRefresh);
            if (custom) CONFIG.customRefresh = custom;
            if ('searchTerm' in c) CONFIG.searchTerm = c.searchTerm;
            if (Array.isArray(c.allowList)) CONFIG.allowList = c.allowList;
            if (Array.isArray(c.manageCentres)) CONFIG.manageCentres = c.manageCentres;
            if (typeof c.stickToCentre === 'boolean') CONFIG.stickToCentre = c.stickToCentre;
            if (CHANGE_MODES.includes(c.changeWhat)) CONFIG.changeWhat = c.changeWhat;
            if (typeof c.filterEnabled === 'boolean') CONFIG.filterEnabled = c.filterEnabled;
            if (c.filter) Object.assign(CONFIG.filter, c.filter);
        } catch (e) {
            warn('loadConfig failed:', e);
        }
    }

    async function saveConfig() {
        try {
            await chrome.storage.local.set({ [CONFIG_KEY]: CONFIG });
        } catch (e) {
            warn('saveConfig failed:', e);
        }
    }

    // ==================== RUN STATE (sessionStorage — survives navigations) ====================

    function loadRun() {
        try {
            return JSON.parse(sessionStorage.getItem(RUN_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveRun(run) {
        try {
            sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
        } catch (e) {
            warn('saveRun failed:', e);
        }
    }

    function loadBooking() {
        try {
            return JSON.parse(sessionStorage.getItem(BOOKING_KEY)) || null;
        } catch (e) {
            return null;
        }
    }

    /** `slot` ({ label, dateISO, timeHHMM }) or null to forget it. */
    function saveBooking(slot) {
        try {
            if (slot) sessionStorage.setItem(BOOKING_KEY, JSON.stringify(slot));
            else sessionStorage.removeItem(BOOKING_KEY);
        } catch (e) {
            warn('saveBooking failed:', e);
        }
    }

    /** /manage: note the booked test if this page shows it. */
    function noteBooking(page) {
        if (!isManage()) return null;
        let slot = null;
        if (page.type === 'manage-booking') {
            slot = parseCurrentBooking();
        } else if (page.type === 'slot-picker') {
            const c = parseSlots().find((s) => s.isCurrent);
            if (c) slot = { label: c.label, dateISO: c.dateISO, timeHHMM: c.timeHHMM };
        }
        if (slotKey(slot)) saveBooking(slot);
        return slotKey(slot) ? slot : null;
    }

    function newRun() {
        return {
            running: true,
            paused: false,
            startedAt: Date.now(),
            refreshCount: 0,
            nextBreakAt: randRange(mode().breakEvery),
            navCount: 0,            // every navigation this engine causes
            term: null,             // last search term used (survives leaving the search page)
            fromSearch: false,
            centre: null,           // { id, name }
            probingCentre: null,    // centreId we opened and expect a slot picker for
            stickCentre: null,      // { id, name } locked centre in "stick to one centre"
            stickOpenUrl: null,     // its …&_eventId=proceed&centreID= link (probe strategy)
            resultsUrl: null,       // results page to go back to (…?execution=e1sN)
            centreOpens: 0,
            recentCentres: [],      // last few centreIds opened — ping-pong detection
            skipCentres: {},        // centreId → refreshCount until which it is skipped
            triedSlots: [],         // epochMs values already submitted
            slotAttempts: 0,
            pendingSlot: null,      // slot submitted, waiting to see "Your details"
            bookedSlot: null,
            bookedAt: null,         // when "Your details" confirmed the hold (epoch ms)
            // Stick toggle off: centres listed under "Other test centres near …" when a
            // centre from the search results had no tests — { centreId, name, href }.
            neighbours: [],
            probeFrom: null,        // 'results' | 'neighbour' — where probingCentre was opened from
            noTestsCentres: [],     // centreIds the last results page marked "– No tests found"
            lastResults: null,      // { total, available, at }
            lastSeen: null,         // { count, earliest }
            // /manage only: 'date' | 'centre' (see CONFIG.changeWhat), the test being
            // changed ({ label, dateISO, timeHHMM }) and the "Test date" form to go back to.
            manageMode: isManage() ? CONFIG.changeWhat : null,
            currentSlot: isManage() ? loadBooking() : null,
            dateFormUrl: null,
            nextActionAt: null,
            nextActionLabel: null,
            stopKind: null,
            stopReason: null
        };
    }

    // ==================== PAGE DETECTION ====================

    /**
     * @returns {{type:string, message?:string}}
     *   type: blocked | challenge | manage-booking | manage-intro | manage-date | slot-picker |
     *         centre-results | alternate-centre | centre-search | your-details | unknown
     */
    function detectPage(doc = document) {
        const title = clean(doc.title);
        const hasFlowForm = !!doc.querySelector('form[action*="execution="]');

        if (!hasFlowForm) {
            const text = clean(doc.body ? doc.body.textContent : '').slice(0, 5000);
            const html = (doc.documentElement ? doc.documentElement.outerHTML : '').slice(0, 30000);
            // Imperva serves the captcha and the hard block as the *same* tiny page:
            // an #main-iframe pointing at /_Incapsula_Resource, with the body text
            // "Request unsuccessful. Incapsula incident ID: …" either way. The only
            // reliable difference is edet= in that iframe URL (see the HARs):
            //   edet=12  SWUDNSAI=…  → hCaptcha challenge — solvable, run can resume
            //   edet=15  CWUDNSAI=…  → Error 15 block     — fatal for this identity
            // Testing the shared text first (as v8.0 did) reported every captcha as
            // a permanent block, so the challenge check has to come first.
            const frame = doc.querySelector('iframe[src*="_Incapsula_Resource"]');
            const edet = frame ? (frame.getAttribute('src').match(/[?&]edet=(\d+)/) || [])[1] : null;
            const hasCaptcha = !!doc.querySelector(
                'iframe[src*="hcaptcha"], iframe[src*="captcha"], .h-captcha, .g-recaptcha');

            if (edet === '12' || (!edet && hasCaptcha) ||
                /pardon our interruption|verify you are (?:a )?human|are you a robot/i.test(text)) {
                return {
                    type: 'challenge',
                    message: 'Imperva is showing a human check. Complete it in the tab, then wait a few ' +
                        'minutes before pressing START again — resuming straight away escalates to Error 15.'
                };
            }
            if (edet ||
                /\berror\s*(?:code\s*)?15\b/i.test(text) ||
                /blocked by (?:our|the|dvsa) security/i.test(text) ||
                /incident id/i.test(text) ||
                /request unsuccessful/i.test(text) ||
                /_Incapsula_Resource/i.test(html) ||
                /^access denied/i.test(title)) {
                return {
                    type: 'blocked',
                    message: 'Imperva blocked this request (Error 15): too many page loads in the last ' +
                        'two minutes. Don\'t reload — every reload counts and stays blocked. For ~15 min ' +
                        'this browser gets blocked again after a few checks, even with cleared ' +
                        'cookies (that only adds a captcha), so wait before starting again.'
                };
            }
        }

        const manage = isManage();
        if (manage) {
            // "Test date - Car test": the testChoice radios (ASAP / DATE).
            if (doc.querySelector('input[name="testChoice"]')) return { type: 'manage-date' };
            // "Choosing your date and test centre" (you can only change it twice): the
            // page between View booking's "Change date" and the "Test date" form.
            if (doc.querySelector('input[name="choosingDateTestCentreSubmit"]')) return { type: 'manage-intro' };
            // "View booking": a Change button per section, no form.
            if (doc.querySelector('#date-time-change, a[href*="_eventId=editTestDateTime"]')) return { type: 'manage-booking' };
        }
        if (doc.querySelector('#slot-picker-form, input.SlotPicker-slot[name="slotTime"]')) return { type: 'slot-picker' };
        // The "choose alternate centre" page (shown when the centre you opened has
        // no tests) reuses ul.test-centre-results, but has no search box and no
        // "– No tests found" markers, so every centre on it parses as available.
        // v8.0 treated it as a results page and clicked the first centre, which
        // landed on another alternate-centre page whose first centre was the one it
        // came from: the 105 → 125 → 105 ping-pong that earned an Error 15 in 76s.
        // A real results page always carries the search form; the alternate page
        // has no form at all. The banner text is a second, independent signal.
        if (doc.querySelector('ul.test-centre-results')) {
            const noTestsBanner = !!doc.querySelector('#change-test-centre, a[href*="_eventId=changeTestCentre"]') &&
                NO_TESTS_HERE_RE.test(clean(doc.body ? doc.body.textContent : ''));
            // The /manage centre list ("Test centre search and results") has no search
            // box: there it is the alternate page's header that tells them apart.
            const isResults = !noTestsBanner && (manage
                ? !doc.querySelector('#chosen-test-centre')
                : hasFlowForm && !!doc.querySelector('input[name="testCentreName"]'));
            return { type: isResults ? 'centre-results' : 'alternate-centre' };
        }
        if (doc.querySelector('input[name="testCentreName"]')) return { type: 'centre-search' };
        if (doc.querySelector('#candidate-details-form') || /your details/i.test(title)) return { type: 'your-details' };
        return { type: 'unknown' };
    }

    // ==================== PARSERS ====================

    const MONTHS = {
        january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };

    function parseDateISOFromLabel(label) {
        // 'Friday 4 September 2026 8:20am'
        const m = label.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
        if (!m) return null;
        const mon = MONTHS[m[2].toLowerCase()];
        if (mon == null) return null;
        return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }

    function parseTimeFromLabel(label) {
        const m = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const ap = (m[3] || '').toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:${m[2]}`;
    }

    /** Slot radios on the slot-picker page, ascending by time. */
    function parseSlots(doc = document) {
        const out = [];
        for (const r of doc.querySelectorAll('input[name="slotTime"]')) {
            const epochMs = parseInt(r.getAttribute('value'), 10);
            if (!Number.isFinite(epochMs)) continue;
            const label = r.getAttribute('data-datetime-label') || '';
            const dm = (r.getAttribute('aria-labelledby') || '').match(/SlotPicker-dayTitle-(\d{4}-\d{2}-\d{2})/);
            out.push({
                epochMs,
                label,
                dateISO: dm ? dm[1] : parseDateISOFromLabel(label),
                timeHHMM: parseTimeFromLabel(label),
                shortNotice: (r.getAttribute('data-short-notice') || '').toLowerCase() === 'true',
                isCurrent: r.hasAttribute('checked')
            });
        }
        out.sort((a, b) => a.epochMs - b.epochMs);
        return out;
    }

    // An unavailable centre carries <h5>&nbsp;&ndash;&nbsp;No tests found on any date</h5>
    // under its <h4>; an available one has no <h5> at all (Cardigan in the HAR).
    const NO_AVAIL_RE = /no tests?\s+(?:found|available)/i;

    // Banner on the "choose alternate centre" page (check-same-centre-on-loop.har /
    // error-15-sensitive-centre-name.har).
    const NO_TESTS_HERE_RE = /no tests that meet your requirements|searched all dates in this test centre/i;

    /**
     * Centre rows on the results page, in the site's order (nearest first). Also reads
     * the "Other test centres near …" list on the alternate-centre page, which names
     * each centre in an <h2> instead of an <h4> and never carries the <h5> marker.
     */
    function parseCentreResults(doc = document) {
        const out = [];
        for (const li of doc.querySelectorAll('ul.test-centre-results > li')) {
            const link = li.querySelector('a[href*="centreID="]');
            const centreId = link ? (link.getAttribute('href').match(/centreID=(\d+)/) || [])[1] : null;
            if (!centreId) continue;
            const availabilityText = clean(li.querySelector('h5') ? li.querySelector('h5').textContent : '')
                .replace(/^[-–—\s]+/, '');
            const heading = li.querySelector('h4') || li.querySelector('h2');
            out.push({
                centreId,
                name: clean(heading ? heading.textContent : ''),
                availabilityText,
                hasAvailability: !NO_AVAIL_RE.test(availabilityText),
                link
            });
        }
        return out;
    }

    /** The link for exactly this centre — `a[href*="centreID=10"]` would also match 105. */
    function centreLink(centreId, doc = document) {
        return [...doc.querySelectorAll('ul.test-centre-results a[href*="centreID="]')]
            .find((a) => (a.getAttribute('href').match(/centreID=(\d+)/) || [])[1] === centreId) || null;
    }

    /**
     * The test being changed, from "View booking": the first <dd> in the section
     * whose header holds #date-time-change ("Friday 19 February 2027 2:05pm"; the
     * next <dd> is "Last date to change or cancel").
     */
    function parseCurrentBooking(doc = document) {
        const change = doc.querySelector('#date-time-change, a[href*="_eventId=editTestDateTime"]');
        const section = change && change.closest('section');
        const dd = section && section.querySelector('dd');
        const label = clean(dd ? dd.textContent : '');
        const dateISO = parseDateISOFromLabel(label);
        const timeHHMM = parseTimeFromLabel(label);
        return dateISO && timeHHMM ? { label, dateISO, timeHHMM } : null;
    }

    /** Centre name from the slot-picker <h1> ("<span class=visuallyhidden>Test date / time</span>Cardigan"). */
    function parseCentreName(doc = document) {
        for (const h1 of doc.querySelectorAll('h1')) {
            const span = h1.querySelector('span.visuallyhidden, span.govuk-visually-hidden');
            if (span && /test date/i.test(span.textContent)) {
                const name = clean(h1.textContent.replace(span.textContent, ''));
                if (name) return name;
            }
        }
        return null;
    }

    /**
     * The centre a page is about, from <header id="chosen-test-centre"><h1>: "Test
     * centre - Goodmayes (London)" on the alternate-centre page, "<span visuallyhidden>
     * Test date / time</span> Goodmayes (London)" on a slot picker. Every one of the 86
     * such pages in the HARs names the centre that was opened.
     */
    function parseChosenCentre(doc = document) {
        const h1 = doc.querySelector('#chosen-test-centre h1');
        if (!h1) return parseCentreName(doc);
        const copy = h1.cloneNode(true);
        copy.querySelectorAll('.visuallyhidden, .govuk-visually-hidden').forEach((s) => s.remove());
        return clean(copy.textContent).replace(/^test centre\s*[-–—:]\s*/i, '') || null;
    }

    // ==================== SELECTION ====================

    // Taking the earliest slot every time is a fixed pattern — and every other
    // candidate watching the centre goes for that same slot (both lost races, in
    // test-2 and test-3, were on it). When the picker offers several acceptable slots
    // within SLOT_SPREAD_DAYS of the earliest, one of the first SLOT_POOL_MAX of them
    // is taken at random. A lone early slot is still taken: Cardigan's pickers went
    // 4 Sep, 11 Sep, then 19 Nov, so a wider pool would trade weeks for variety.
    const SLOT_SPREAD_DAYS = 7;
    const SLOT_POOL_MAX = 4;

    function activeFilter() {
        return CONFIG.filterEnabled ? { ...CONFIG.filter } : {};
    }

    /** 'YYYY-MM-DD HH:MM' — orders slots by local date and time, like the labels. */
    function slotKey(s) {
        return s && s.dateISO && s.timeHHMM ? `${s.dateISO} ${s.timeHHMM}` : null;
    }

    /**
     * The date range, plus — when changing a booking — `before`: only a slot earlier
     * than the current test is a swap worth making. Except with a range that has a
     * latest date (same centre or nearby): then the range is the whole ask, as in a
     * new booking — a later test can be the point of the move. A range open at the
     * end keeps `before`, so a run never drifts to any later date.
     */
    function slotFilter(run) {
        const f = activeFilter();
        if (run.manageMode && !rangeDecides(run, f)) f.before = slotKey(run.currentSlot);
        return f;
    }

    function rangeDecides(run, f = activeFilter()) {
        return !!run.manageMode && !!f.latestISO;
    }

    /** Whether a slot falls inside the date range (inclusive) and time window. */
    function slotMatches(s, f = {}) {
        if (s.isCurrent) return false;
        if (f.before) {
            const key = slotKey(s);
            if (!key || key >= f.before) return false;
        }
        if (f.earliestISO && s.dateISO && s.dateISO < f.earliestISO) return false;
        if (f.latestISO && s.dateISO && s.dateISO > f.latestISO) return false;
        if (f.earliestTime && s.timeHHMM && s.timeHHMM < f.earliestTime) return false;
        if (f.latestTime && s.timeHHMM && s.timeHHMM > f.latestTime) return false;
        return true;
    }

    /** Slots that satisfy the date/time filter, earliest first. */
    function matchingSlots(slots, f = {}) {
        return slots.filter((s) => slotMatches(s, f));
    }

    /** Earliest slot that satisfies the date/time filter. */
    function pickSlot(slots, f = {}) {
        return matchingSlots(slots, f)[0] || null;
    }

    /** Why nothing was booked on a picker, in the popup's words. */
    function noSlotWhy(bookable, f = activeFilter()) {
        if (!bookable.length) return f.before ? 'nothing earlier than your test' : 'no slots left';
        if (f.before && !bookable.some((s) => slotMatches(s, { before: f.before }))) return 'nothing earlier than your test';
        return f.earliestISO || f.latestISO ? 'no slot in your date range' : 'no slot matches the filter';
    }

    function addDaysISO(iso, days) {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
    }

    /** A random slot among the matching ones close to the earliest (see SLOT_SPREAD_DAYS). */
    function chooseSlot(slots, f = {}) {
        const matching = matchingSlots(slots, f);
        if (!matching.length) return null;
        const first = matching[0];
        const until = first.dateISO ? addDaysISO(first.dateISO, SLOT_SPREAD_DAYS) : null;
        const pool = matching
            .filter((s) => (until && s.dateISO ? s.dateISO <= until : s === first))
            .slice(0, SLOT_POOL_MAX);
        return pool[randInt(0, pool.length - 1)];
    }

    /**
     * The centres the user named, lower-cased: on /manage the "Nearby centres" box,
     * otherwise "Only these centres". Empty means any centre.
     */
    function namedCentres() {
        const raw = isManage() ? CONFIG.manageCentres : CONFIG.allowList;
        return (raw || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }

    function centreAllowed(centre) {
        const list = namedCentres();
        if (!list.length) return true;
        const name = centre.name.toLowerCase();
        return list.some((e) => e === centre.centreId || name.includes(e));
    }

    function sameCentre(a, b) {
        return clean(a).toLowerCase() === clean(b).toLowerCase();
    }

    function searchTerm(run) {
        const cfg = clean(CONFIG.searchTerm);
        if (cfg) return cfg;
        const input = document.querySelector('input[name="testCentreName"]');
        const typed = input ? clean(input.value) : '';
        return typed || (run && run.term) || null;
    }

    // ==================== SCHEDULER ====================

    let timer = null;

    function clearTimer() {
        if (timer) clearTimeout(timer);
        timer = null;
    }

    /** Wait `ms`, then run `fn` if the run is still active and unpaused. */
    function schedule(run, ms, label, fn) {
        clearTimer();
        run.nextActionAt = Date.now() + ms;
        run.nextActionLabel = label;
        saveRun(run);
        log(`${label} in ${(ms / 1000).toFixed(1)}s`);
        timer = setTimeout(() => {
            timer = null;
            const live = loadRun();
            if (!live.running || live.paused) return;
            live.nextActionAt = null;
            live.nextActionLabel = null;
            // Every scheduled action ends in a real navigation, so this counts them
            // all — including loops that never touch the search form and so never
            // move refreshCount.
            live.navCount = (live.navCount || 0) + 1;
            // A stick-mode cycle is two navigations by design (back, then open), so
            // the plain cap would halve the run without halving the request rate.
            // MAX_REFRESHES still bounds it at the same number of cycles as a search.
            const navCap = live.stickCentre ? MAX_NAVIGATIONS * 2 : MAX_NAVIGATIONS;
            if (live.navCount > navCap) {
                return stop(live, 'limit',
                    `Navigation limit reached (${navCap}) without booking — stopped before Imperva does.`);
            }
            // Persist here, not in fn: the centre-open and back-to-results callbacks
            // navigate without saving, so the count used to only survive on the
            // search path — leaving the cap tracking refreshCount, not navigations.
            saveRun(live);
            fn(live);
        }, ms);
    }

    function stop(run, kind, reason) {
        clearTimer();
        run.running = false;
        run.paused = false;
        run.stoppedAt = Date.now();
        run.nextActionAt = null;
        run.nextActionLabel = null;
        run.stopKind = kind;
        run.stopReason = reason;
        saveRun(run);
        log(`STOP [${kind}] ${reason}`);
        if (kind === 'held') showHeldClock(run);
        if (kind === 'blocked') noteBlock();
    }

    // The slot picker's confirm dialog: "Please complete your booking within 15
    // minutes. If you don't, you may lose your chosen test" (every picker in the HARs).
    const HOLD_MS = 15 * 60 * 1000;
    let heldClock = null;

    /**
     * Tab title "✅ Held 3:12 ago — …" on every page after the grab, so the time is
     * visible while filling in the details without opening the popup.
     */
    function showHeldClock(run) {
        const at = run.bookedAt || run.stoppedAt;
        // An hour on, the hold is long gone either way — stop decorating the title.
        if (!at || heldClock || Date.now() - at > 4 * HOLD_MS) return;
        const base = document.title;
        const tick = () => {
            const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
            const since = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            if (s * 1000 >= HOLD_MS) {
                clearInterval(heldClock);
                document.title = `⌛ Held ${Math.floor(s / 60)} min ago — ${base}`;
                return;
            }
            document.title = `✅ Held ${since} ago — ${base}`;
        };
        tick();
        heldClock = setInterval(tick, 1000);
    }

    // ==================== PAGE-LOAD COUNT ====================
    // pace.log: when each page load of this site started (epoch ms, redirect hops
    // included), for the popup and the block record. It never delays anything.

    let pace = { log: [] };

    async function loadPace() {
        try {
            const p = (await chrome.storage.local.get(PACE_KEY))[PACE_KEY];
            if (p && Array.isArray(p.log)) pace = { log: p.log };
        } catch (e) {
            warn('loadPace failed:', e);
        }
    }

    function savePace() {
        try {
            chrome.storage.local.set({ [PACE_KEY]: pace });
        } catch (e) {
            warn('savePace failed:', e);
        }
    }

    /**
     * Counts this page load — including one the user made, since Imperva counts those
     * too — once per document, at init. A redirect hop that led here is its own request.
     */
    function recordPageLoad() {
        const nav = performance.getEntriesByType('navigation')[0];
        const loads = 1 + (nav ? nav.redirectCount : 0);
        const at = Math.round(performance.timeOrigin);
        const now = Date.now();
        pace.log = pace.log.filter((t) => now - t < LOAD_LOG_MS);
        for (let i = 0; i < loads; i++) pace.log.push(at);
        savePace();
    }

    function loadsWithin(ms, now = Date.now()) {
        return pace.log.filter((t) => now - t < ms).length;
    }

    /**
     * The popup warns against starting again too soon: test-2's fresh session began
     * ~1.5 min after test-1's block and carried Imperva's flag; test-5's began ~1 min
     * after one with new cookies and was blocked after 5 checks; test-3 began ~12 min
     * after a block and never was. The load counts are kept so the limit can be
     * checked against real blocks without a HAR.
     */
    function noteBlock() {
        const now = Date.now();
        const record = { at: now, loads60: loadsWithin(60000, now), loads120: loadsWithin(120000, now), loads300: loadsWithin(300000, now) };
        log(`blocked with ${record.loads60} page loads in the last minute, ${record.loads120} in 2 min`);
        try {
            chrome.storage.local.set({ [LAST_BLOCK_KEY]: record });
        } catch (e) {
            warn('noteBlock failed:', e);
        }
    }

    /** Nothing has navigated yet this run: START means "go now". */
    function isKickoff(run) {
        return !run.navCount;
    }

    /**
     * Throttled delay for any engine-initiated navigation (search refresh, opening
     * a centre, leaving an empty centre or a picker): a random wait in the speed
     * mode's range — in Custom, the popup's — with periodic longer breaks. Mutates
     * run.nextBreakAt when a break is due.
     */
    function pacedDelay(run) {
        if (isKickoff(run)) return { ms: 0, onBreak: false };
        const m = mode();
        if (run.refreshCount >= run.nextBreakAt) {
            run.nextBreakAt = run.refreshCount + randRange(m.breakEvery);
            return { ms: randRange(m.breakMs), onBreak: true };
        }
        return { ms: randInt(m.refreshMin, m.refreshMax), onBreak: false };
    }

    // Imperva's script POSTs its sensor data to its own endpoint (…?d=<host>)
    // ~0.3 s after every page load (0.28 s on the slot picker in the reference
    // HAR). Navigating before it finishes aborts it (status 0 in the Error 15
    // capture), so a time-critical action waits for that POST to appear in the
    // resource timeline — but never longer than SENSOR_WAIT_CAP.
    // A failed POST is in the timeline too: in har/quick-loader-test.har the first
    // one failed (net::ERR_CONNECTION_CLOSED) on 4 of 6 pages and the script retried
    // ~0.4 s later, but the search after "Change test centre" went 25 ms after the
    // failure, before the retry. So only a completed one counts (responseStatus,
    // Chrome 109+; without it, any entry does).
    function isSensorPost(entry) {
        if (!/^(xmlhttprequest|fetch|beacon)$/.test(entry.initiatorType || '') ||
            !/[?&]d=/.test(entry.name) || !entry.name.startsWith(location.origin)) return false;
        return !('responseStatus' in entry) || (entry.responseStatus >= 200 && entry.responseStatus < 400);
    }

    function afterSensor(fn, cap = SENSOR_WAIT_CAP) {
        let done = false;
        const go = () => { if (!done) { done = true; fn(); } };
        try {
            if (performance.getEntriesByType('resource').some(isSensorPost)) return go();
            if (typeof PerformanceObserver !== 'function') return go();
            const obs = new PerformanceObserver((list) => {
                if (list.getEntries().some(isSensorPost)) { obs.disconnect(); go(); }
            });
            obs.observe({ type: 'resource', buffered: true });
            setTimeout(() => { obs.disconnect(); go(); }, cap);
        } catch (e) {
            go();
        }
    }

    /**
     * Every engine navigation goes through this: wait for the sensor POST, then run
     * `fn` with the current run state — unless STOP or PAUSE was pressed meanwhile.
     */
    function whenSensorDone(fn, cap) {
        afterSensor(() => {
            const live = loadRun();
            if (live.running && !live.paused) fn(live);
        }, cap);
    }

    // ==================== STEP ENGINE ====================
    // Runs once per page load (and on START / RESUME). Looks at the page the tab
    // is on and schedules exactly one real user action.

    function step() {
        const run = loadRun();
        if (!run.running || run.paused) return;
        clearTimer();

        const page = detectPage();
        log(`step: page=${page.type} refreshes=${run.refreshCount}`);
        // Set by leaveDeadEnd as it clicks "Change test centre": good for this page only.
        const afterChange = !!run.afterChange;
        run.afterChange = false;

        // /manage after submitting a slot: no capture has a successful one (both in
        // har/already-booked-… were taken first), so a picker or the "no longer
        // available" page means it was taken and anything else ends the run here.
        if (run.pendingSlot && run.manageMode && !/^(blocked|challenge|slot-picker|alternate-centre)$/.test(page.type)) {
            return onChangeSubmitted(run, page);
        }

        switch (page.type) {
            case 'blocked':
                return stop(run, 'blocked', page.message);
            case 'challenge':
                return stop(run, 'challenge', page.message);
            case 'manage-booking':
                return onManageBooking(run);
            case 'manage-intro':
                return onManageIntro(run, afterChange);
            case 'manage-date':
                return onManageDate(run, afterChange);
            case 'centre-results':
                return onResults(run);
            case 'alternate-centre':
                return onAlternateCentre(run);
            case 'centre-search':
                return onSearch(run, afterChange);
            case 'slot-picker':
                return onSlotPicker(run);
            case 'your-details':
                return onYourDetails(run);
            default:
                return stop(run, 'wrongpage',
                    `Landed on an unexpected page ("${clean(document.title) || location.pathname}").`);
        }
    }

    // ---- centre results: pick an available centre, or refresh the search ----

    function onResults(run) {
        // /manage: START on the centre list means "try the centres", whatever the
        // popup says. Reaching it while re-searching one centre's dates is off course.
        if (run.manageMode && isKickoff(run)) run.manageMode = 'centre';
        if (run.manageMode === 'date') return scheduleDateRecheck(run, 'On the centre list');
        // A centre we opened that lands back on a results page (rather than a slot
        // picker or the alternate-centre page) had nothing bookable — skip it for a
        // while so we don't reopen the same empty centre every cycle.
        if (run.probingCentre && !run.stickCentre) {
            run.skipCentres = run.skipCentres || {};
            run.skipCentres[run.probingCentre] = run.refreshCount + CENTRE_SKIP_REFRESHES;
        }
        run.probingCentre = null;

        const results = parseCentreResults();
        const available = results.filter((c) => c.hasAvailability);
        run.lastResults = { total: results.length, available: available.length, at: Date.now() };
        // This page is what "stick to one centre" comes back to: its execution=e1sN
        // stays valid for repeated centre opens (five in a row in the capture).
        run.resultsUrl = location.href;

        // The "– No tests found" marker is only rendered when the site has checked
        // availability (postcode searches). If any centre on this page carries it,
        // a centre without it has genuinely just shown tests — a race we must win,
        // so that open is fast. With no marker anywhere (centre-name searches) an
        // open is a blind probe and stays paced.
        const signal = results.some((c) => !c.hasAvailability);
        // Nearby centres the search already reported as empty aren't worth a blind open.
        run.noTestsCentres = results.filter((c) => !c.hasAvailability).map((c) => c.centreId);
        // With no marker, searching again can never show anything new, so a dead end
        // re-opens a centre from these saved links instead (see leaveDeadEnd).
        run.reopenCentres = signal ? null : results.map((c) => ({
            centreId: c.centreId, name: c.name, hasAvailability: c.hasAvailability, href: c.link.href
        }));
        // Lock the target from the first results page, before anything is opened: a
        // postcode search may show nothing available for a long time, and locking on
        // "whichever centre frees up first" would watch the wrong one.
        if (CONFIG.stickToCentre && !run.stickCentre) {
            const target = resolveStickTarget(run, results);
            if (!target) return;
            run.stickCentre = { id: target.centreId, name: target.name };
            log(`sticking to ${target.name} (${target.centreId})`);
        }
        // /manage has no search box to refresh: a name that isn't on its list can
        // never be opened, so say so instead of "no search box on this page".
        if (run.manageMode === 'centre' && !run.stickCentre && results.length && !results.some(centreAllowed)) {
            return stop(run, 'config', noNamedCentreWhy(results));
        }

        if (!openCentre(run, results, signal)) scheduleSearch(run);
    }

    /**
     * Picks a centre from `results` and schedules opening it. Called on the results
     * page (each result carries its live `link`) and from a dead end with the saved
     * results (`href` only — see leaveDeadEnd). Returns false if there is nothing to
     * open; true once it has scheduled something or stopped the run.
     */
    function openCentre(run, results, signal, why) {
        const available = results.filter((c) => c.hasAvailability);
        const skip = run.skipCentres || {};
        let hit;
        // True when every candidate is skipped and we re-open the one skipped
        // longest ago: intentional repetition, like stick mode.
        let rotating = false;
        // The only centre this search offers: re-opening it after each sweep of its
        // nearby centres is the point too, not a ping-pong. Neighbour opens don't
        // enter recentCentres, so without this six sweeps would read as a loop.
        let onlyChoice = false;
        if (run.stickCentre) {
            hit = results.find((c) => c.centreId === run.stickCentre.id);
            if (!hit) {
                stop(run, 'config',
                    `${run.stickCentre.name} is not in these results any more — stopped. ` +
                    'Check the search term, then start again.');
                return true;
            }
            // The marker is only rendered for a postcode search: "rm1" gave all four
            // centres "– No tests found on any date", while "goodmay" and "cardigan"
            // gave a single centre with no <h5> at all — Cardigan had slots, Goodmayes
            // had none. So its *presence* is a reliable "not yet" and its absence says
            // nothing.
            //   postcode  → refresh the search and save the policed centreID= open
            //               for when the marker clears.
            //   by name   → no signal exists, so open the centre to find out. That is
            //               the har/check-same-centre-on-loop.har loop.
            if (!hit.hasAvailability) {
                log(`${hit.name}: ${hit.availabilityText} — refreshing instead of opening`);
                return false;
            }
        } else {
            const candidates = available.filter(centreAllowed);
            // Several centres with tests at once: any of them, not always the first
            // listed (the results page puts the nearest first, every time).
            const open = candidates.filter((c) => !((skip[c.centreId] || 0) > run.refreshCount));
            hit = open.length ? open[randInt(0, open.length - 1)] : null;
            onlyChoice = candidates.length === 1;
            if (!hit && candidates.length) {
                // Every candidate is skipped. On a centre-name search the results list
                // never shows availability, so re-submitting the search can't learn
                // anything — opening the centre is the only informative action and it
                // is paced exactly like a refresh. Rotate to the one skipped longest ago.
                hit = candidates.reduce((a, c) => ((skip[c.centreId] || 0) < (skip[a.centreId] || 0) ? c : a));
                rotating = true;
            }
        }
        log((why ? `${why}: ` : `results: ${results.length} centre(s), ${available.length} available`) +
            (hit ? ` → ${hit.name}` : ''));
        if (!hit) return false;

        // Both guards below police *unintended* repetition. In stick mode, when
        // rotating over skipped centres, and when re-opening the only candidate the
        // repetition is the point, and refreshCount/navCount still bound the run.
        if (!run.stickCentre && !rotating && !onlyChoice) {
            const recent = [...(run.recentCentres || []), hit.centreId].slice(-CENTRE_LOOP_WINDOW);
            const distinct = new Set(recent).size;
            if (recent.length >= CENTRE_LOOP_WINDOW && distinct <= CENTRE_LOOP_DISTINCT) {
                stop(run, 'loop',
                    `Stuck opening the same ${distinct} centre(s) over and over (${recent.join(' → ')}). ` +
                    'Stopped before Imperva blocks the session — check the centre filter and start again.');
                return true;
            }
            if ((run.centreOpens || 0) >= MAX_CENTRE_OPENS) {
                stop(run, 'limit', `Opened ${MAX_CENTRE_OPENS} centres without finding a bookable slot — stopped.`);
                return true;
            }
            run.recentCentres = recent;
        }
        run.centreOpens = (run.centreOpens || 0) + 1;
        if (!run.stickCentre && run.refreshCount >= MAX_REFRESHES) {
            stop(run, 'limit', `Refresh limit reached (${MAX_REFRESHES}) with no availability.`);
            return true;
        }
        run.term = searchTerm(run);
        run.fromSearch = true;
        run.centre = { id: hit.centreId, name: hit.name };
        run.triedSlots = [];
        run.slotAttempts = 0;
        // Probe strategy (no marker anywhere on this page): later cycles open this
        // link straight from the dead-end page — see scheduleStickRecheck — unless
        // a direct open has already landed on another centre (see offCentre). Watch
        // strategy: they come back here, since the marker is the signal.
        if (run.stickCentre) run.stickOpenUrl = signal || run.directOpenOff ? null : hit.link.href;
        // A marker that has just cleared is a race against every other candidate,
        // so that open is fast. So is the run's first open: it follows straight on
        // from START, or from the search START submitted, like a person clicking
        // the centre they just searched for (centreOpens was counted above). On a
        // centre-name search the results list carries no availability info, so an
        // empty centre bounces straight back — pacing any other open like a
        // refresh keeps a bounce from becoming a fast loop. In stick mode the
        // cycle was already paced on the page we came back from.
        const urgent = (signal && !rotating) || run.centreOpens === 1;
        let ms, label;
        if (urgent) {
            ms = isKickoff(run) ? 0 : randRange(FAST_DELAY);
            label = signal ? `Opening ${hit.name} (tests available)` : `Opening ${hit.name}`;
        } else if (run.stickCentre) {
            ms = randRange(floorsApply() ? CENTRE_OPEN_DELAY : FAST_DELAY);
            label = `Re-checking ${hit.name}`;
        } else {
            const p = pacedDelay(run);
            ms = floorsApply() ? Math.max(p.ms, randRange(CENTRE_OPEN_DELAY)) : p.ms;
            label = (p.onBreak ? 'Taking a short break, then ' : why ? `${why} — ` : '') +
                `${p.onBreak || why ? 'opening' : 'Opening'} ${hit.name}`;
        }
        schedule(run, ms, label, (live) => {
            if (!live.stickCentre) live.refreshCount++;
            saveRun(live);
            whenSensorDone((cur) => {
                // GET …&_eventId=proceed&centreID=<id> — same as clicking it. From a
                // dead end, the saved link of the results page: never a link on the
                // alternate-centre page itself (that is the ping-pong).
                const link = hit.link ? centreLink(hit.centreId) : null;
                if (hit.link && !link) return step();
                cur.probingCentre = hit.centreId;
                cur.probeFrom = 'results';
                saveRun(cur);
                if (link) link.click();
                else location.assign(hit.href);
            });
        });
        return true;
    }

    // ---- stick mode: back to the results page, then open the same centre again ----

    /**
     * Which centre to watch. A centre-name search returns exactly one, so that is the
     * one; a postcode search returns several, so the user has to name it in
     * "only these centres". Calls stop() and returns null if it cannot tell.
     */
    function resolveStickTarget(run, results) {
        if (!results.length) return null;   // caller falls through to a search refresh
        if (namedCentres().length) {
            const target = results.find((c) => centreAllowed(c));
            if (target) return target;
            stop(run, 'config', isManage()
                ? noNamedCentreWhy(results)
                : 'None of the centres in "only these centres" came back in this search — ' +
                  'check the spelling against the results, then start again.');
            return null;
        }
        if (results.length === 1) return results[0];
        stop(run, 'config', isManage()
            ? `"Stick to one centre" needs to know which one — sik lists ${results.length} centres near your booking. ` +
              'Name it under "Change existing booking".'
            : `"Stick to one centre" needs to know which one — this search returned ${results.length} centres. ` +
              'Search by centre name instead, or name the centre in "only these centres".');
        return null;
    }

    function noNamedCentreWhy(results) {
        return `None of the centres you named (${(CONFIG.manageCentres || []).join(', ')}) is on sik's list ` +
            `near your booking: ${results.map((c) => c.name).join(', ')}. ` +
            'Check the spelling, or clear the box to try them all.';
    }

    /**
     * Schedules one re-check cycle; `why` explains what the centre just showed.
     *
     * Probe strategy: open the centre's link straight from this dead-end page — one
     * check, two page loads (the proceed and its 302 target). The results page's
     * execution=e1sN stays valid whatever page we are on (e1s7 was re-opened after
     * e1s8 … e1s32 in test-2), and fetching it again first taught us nothing.
     * Watch strategy: go back to the results page, whose marker decides what's next.
     */
    function scheduleStickRecheck(run, why) {
        if (run.refreshCount >= MAX_REFRESHES) {
            return stop(run, 'limit', `Refresh limit reached (${MAX_REFRESHES}) with no slot at ${run.stickCentre.name}.`);
        }
        const m = mode();
        // A centre open is the whole cycle here, so in Safe/Normal/Fast never go
        // below STICK_MIN_CYCLE. Custom and Ultra wait exactly their range.
        let delay = randInt(m.refreshMin, m.refreshMax);
        if (floorsApply()) delay = Math.max(delay, STICK_MIN_CYCLE);
        let label = `${run.stickCentre.name}: ${why} — re-checking`;
        if (run.refreshCount >= run.nextBreakAt) {
            delay = randRange(m.breakMs);
            label = `${run.stickCentre.name}: ${why} — short break first`;
            run.nextBreakAt = run.refreshCount + randRange(m.breakEvery);
        }
        schedule(run, delay, label, (live) => {
            live.refreshCount++;
            saveRun(live);
            const url = live.stickOpenUrl;
            if (!url) return whenSensorDone(backToResults);
            whenSensorDone((cur) => {
                // GET …&_eventId=proceed&centreID=<locked centre> — the same request
                // the results page's link makes.
                cur.probingCentre = cur.stickCentre.id;
                cur.centre = { id: cur.stickCentre.id, name: cur.stickCentre.name };
                cur.triedSlots = [];
                cur.slotAttempts = 0;
                cur.centreOpens = (cur.centreOpens || 0) + 1;
                saveRun(cur);
                location.assign(url);
            });
        });
    }

    function backToResults(run) {
        // The capture goes back in history: the results page is Cache-Control:
        // no-store, so the browser refetches it, Imperva's script runs on it again,
        // and execution=e1sN is still good for the next open.
        const url = run.resultsUrl;
        if (!url || url === location.href) return step();
        goBackTo(url);
    }

    function goBackTo(url) {
        // Back only reaches `url` if we came from it. After direct re-opens the entry
        // behind us is another alternate-centre page, and each back would cost a page
        // load without getting anywhere — so load it outright.
        if (document.referrer !== url) return location.assign(url);
        history.back();
        // If that history entry is gone, back() did nothing and this still fires.
        setTimeout(() => {
            if (location.href !== url) location.href = url;
        }, STICK_BACK_FALLBACK);
    }

    /**
     * Stick mode landed on a page about another centre than the locked one. No
     * capture shows it, but the 2-load re-open — the saved link fired from the
     * alternate-centre page — is the one request no capture exercises, so every
     * landing is checked. First time: stop using the saved link for this run and
     * re-open from the results page, as every capture did (3 loads a check). If
     * even that lands elsewhere, stop rather than refresh the wrong centre.
     */
    function offCentre(run, shown, isPicker) {
        warn(`landed on ${shown}, not ${run.stickCentre.name}` + (isPicker ? ' — not booking here' : ''));
        run.pendingSlot = null;
        if (!run.directOpenOff) {
            run.directOpenOff = true;
            run.stickOpenUrl = null;
            return scheduleStickRecheck(run,
                `opened ${shown} instead` + (isPicker ? ' — not booking there,' : ' —') + ' re-opening from the results page');
        }
        return stop(run, 'wrongcentre',
            `sik opened ${shown} instead of ${run.stickCentre.name}, even from the results page. ` +
            'Stopped rather than refresh the wrong centre — search again and start again.');
    }

    // ---- nearby centres (stick toggle off) ----
    // A centre-name search returns one centre, so the quick re-open only ever
    // re-opened that one — "stick to one centre" whether the toggle was on or not.
    // The alternate-centre page lists the centres near it; trying those is the
    // "search the neighbours" behaviour from before v8.1.
    //
    // v8.0's ping-pong (105 → 125 → 105 … , Error 15 in 76 s) came from clicking the
    // *first* centre on every alternate page, unpaced and with nothing skipped. Here:
    //   - every centre opened is skipped for CENTRE_SKIP_REFRESHES refreshes, and a
    //     skipped centre is never opened from this list, so A → B → A can't happen;
    //   - only the list shown for a centre from the search results is used — a
    //     neighbour's own neighbours are not added, so the sweep stays local;
    //   - each open is one navigation straight from the dead-end page (2 page loads),
    //     paced exactly like the quick re-open and counted as a refresh, so
    //     MAX_REFRESHES / MAX_NAVIGATIONS still bound it;
    //   - once every neighbour is skipped, leaveDeadEnd re-opens the searched centre
    //     from its saved link as before.

    /** Adds the centres this page lists, or refreshes their links if already known. */
    function noteNeighbours(run, fromHome) {
        const known = run.neighbours || [];
        for (const c of parseCentreResults()) {
            const prev = known.find((n) => n.centreId === c.centreId);
            if (prev) prev.href = c.link.href;          // newer execution=e1sN
            else if (fromHome) known.push({ centreId: c.centreId, name: c.name, href: c.link.href });
        }
        run.neighbours = known;
    }

    /** First nearby centre (nearest first) that is allowed, not known empty and not skipped. */
    function nextNeighbour(run) {
        if (CONFIG.stickToCentre || run.stickCentre) return null;
        const skip = run.skipCentres || {};
        const empty = new Set(run.noTestsCentres || []);
        return (run.neighbours || []).find((c) => centreAllowed(c) && !empty.has(c.centreId) &&
            !((skip[c.centreId] || 0) > run.refreshCount)) || null;
    }

    function scheduleNeighbourOpen(run, n, why) {
        const p = pacedDelay(run);
        const ms = floorsApply() ? Math.max(p.ms, randRange(CENTRE_OPEN_DELAY)) : p.ms;
        const label = p.onBreak ? `Taking a short break, then trying ${n.name}` : `${why} — trying ${n.name} nearby`;
        return schedule(run, ms, label, (live) => {
            live.refreshCount++;
            saveRun(live);
            whenSensorDone((cur) => {
                cur.probingCentre = n.centreId;
                cur.probeFrom = 'neighbour';
                cur.fromSearch = true;
                cur.centre = { id: n.centreId, name: n.name };
                cur.triedSlots = [];
                cur.slotAttempts = 0;
                cur.centreOpens = (cur.centreOpens || 0) + 1;
                cur.skipCentres = cur.skipCentres || {};
                cur.skipCentres[n.centreId] = cur.refreshCount + CENTRE_SKIP_REFRESHES;
                saveRun(cur);
                // GET …&_eventId=proceed&centreID=<id>: its link on this page if it is
                // listed here, else the one saved from the page that listed it.
                const link = centreLink(n.centreId);
                if (link) link.click();
                else location.assign(n.href);
            });
        });
    }

    // ---- "choose alternate centre": the centre we opened has no tests ----
    // Never click the first centre it offers blindly — that is the ping-pong. Mark
    // the centre we just tried as skipped and move on to the next check (see
    // leaveDeadEnd): a nearby centre that isn't skipped (stick toggle off), else the
    // searched centre again. Each increments refreshCount and so stays bounded.

    function onAlternateCentre(run) {
        const fromHome = run.probeFrom !== 'neighbour';
        run.probeFrom = null;
        const centreId = run.probingCentre || (run.centre && run.centre.id);
        run.probingCentre = null;
        // A slot we submitted also lands here, as "The time chosen is no longer
        // available. Please choose another." (test-2 e1s29, test-3 e1s9): another
        // candidate booked it first. A lost race, not an error.
        const lost = run.pendingSlot;
        run.pendingSlot = null;
        if (lost) warn(`slot ${lost.label} was booked by someone else first`);
        if (run.manageMode === 'date') {
            const shown = parseChosenCentre() || 'your centre';
            return scheduleDateRecheck(run, lost ? 'Slot taken by someone else' : `No tests at ${shown}`);
        }
        // Stick mode: this page is the "not yet" answer for the locked centre, and it
        // never lists that centre among the alternates (105/121/125/143 in the
        // capture, no 482). Ask it again — once its heading confirms it is about ours.
        if (run.stickCentre && run.resultsUrl) {
            const shown = parseChosenCentre();
            if (shown && !sameCentre(shown, run.stickCentre.name)) return offCentre(run, shown, false);
            return scheduleStickRecheck(run, lost ? 'slot taken by someone else' : 'no tests yet');
        }
        if (centreId) {
            run.skipCentres = run.skipCentres || {};
            run.skipCentres[centreId] = run.refreshCount + CENTRE_SKIP_REFRESHES;
        }
        const where = run.centre && run.centre.name ? run.centre.name : 'that centre';
        if (!CONFIG.stickToCentre) noteNeighbours(run, fromHome);
        return leaveDeadEnd(run, `${lost ? 'Slot taken at' : 'No tests at'} ${where}`);
    }

    /**
     * Outside stick mode, a centre we opened was a dead end: the alternate-centre page,
     * or a slot picker with nothing to take. The fastest way to the next check:
     *   stick toggle off, a nearby centre not yet tried → open it straight from
     *     here: one navigation, 2 page loads (see nextNeighbour).
     *   centre-name search → re-open a centre from the saved results links, straight
     *     from here: one navigation, 2 page loads. The search would show nothing new.
     *   postcode search → "Change test centre", then search again at once. The
     *     availability markers are only read on a fresh results page.
     * Either way one pause (the speed mode's) per check, never one between clicks.
     */
    function leaveDeadEnd(run, why) {
        if (run.refreshCount >= MAX_REFRESHES) {
            return stop(run, 'limit', `Refresh limit reached (${MAX_REFRESHES}) with no availability.`);
        }
        const n = nextNeighbour(run);
        if (n) return scheduleNeighbourOpen(run, n, why);
        if (run.reopenCentres && openCentre(run, run.reopenCentres, false, why)) return;
        const back = document.querySelector('#change-test-centre, a[href*="_eventId=changeTestCentre"]');
        if (!back) {
            return stop(run, 'wrongpage',
                `${why}, and no "Change test centre" link to get back to the search.`);
        }
        const p = pacedDelay(run);
        const label = (p.onBreak ? `Taking a short break — ${why}` : why) + ' — back to search';
        return schedule(run, p.ms, label, (live) => {
            // The search that follows counts the refresh.
            live.afterChange = true;
            saveRun(live);
            whenSensorDone(() => back.click());
        });
    }

    // ---- centre search form with no results list ----

    function onSearch(run, afterChange) {
        // First action of a run: search straight away (isKickoff). Straight after
        // "Change test centre" too: the dead end's pause was this check's pause.
        // Otherwise it's a refresh.
        scheduleSearch(run, afterChange);
    }

    function scheduleSearch(run, afterChange = false) {
        const term = searchTerm(run);
        if (!term) {
            return stop(run, 'config', 'No search term — enter a postcode or centre name in the popup or the search box.');
        }
        run.term = term;
        if (run.refreshCount >= MAX_REFRESHES) {
            return stop(run, 'limit', `Refresh limit reached (${MAX_REFRESHES}) with no availability.`);
        }

        const searchInput = document.querySelector('input[name="testCentreName"]');
        if (!searchInput || !searchInput.form) {
            // Scheduling here would fire, find no form, call step() and land right
            // back here — an endless no-op loop. Stop with a clear reason instead.
            return stop(run, 'wrongpage',
                `No test-centre search box on this page ("${clean(document.title) || location.pathname}").`);
        }

        const p = afterChange ? { ms: 0, onBreak: false } : pacedDelay(run);
        const label = p.onBreak ? 'Taking a short break, then refreshing' : afterChange ? 'Searching again' : 'Refreshing search';

        schedule(run, p.ms, label, () => whenSensorDone((live) => {
            const input = document.querySelector('input[name="testCentreName"]');
            const form = input && input.form;
            if (!form) return step();
            input.value = term;
            live.refreshCount++;
            saveRun(live);
            // POST …&_eventId=search with _csrf, testCentreName, testCentreSubmit.
            const submit = form.querySelector('input[name="testCentreSubmit"], [type="submit"]');
            if (submit) submit.click();
            else form.requestSubmit();
        }));
    }

    // ---- slot picker: book the best matching slot ----

    function onSlotPicker(run) {
        // Reaching a slot picker means the centre we opened had tests — the probe
        // succeeded, so it wasn't a bounce.
        run.probingCentre = null;

        const name = parseChosenCentre();
        // Stick mode only ever books at the locked centre. The picker carries no
        // centre ID, but its <h1> name matches the results row exactly ("Goodmayes
        // (London)", "Cardigan" in the HARs). A different centre's picker means the
        // open went somewhere we didn't choose: take nothing.
        if (run.stickCentre && run.resultsUrl && name && !sameCentre(name, run.stickCentre.name)) {
            return offCentre(run, name, true);
        }
        if (name) run.centre = { id: run.centre ? run.centre.id : null, name };

        const slots = parseSlots();
        const bookable = slots.filter((s) => !s.isCurrent);
        // /manage: the current test is the radio the picker renders checked (3 Dec in
        // har/change-date-…, 19 Feb in har/already-booked-…), in either mode. Only the
        // booked centre's picker has one — for any other, View booking or that picker
        // must have been seen in this tab first (noteBooking).
        const current = slots.find((s) => s.isCurrent);
        if (run.manageMode && current && !run.currentSlot) {
            run.currentSlot = { label: current.label, dateISO: current.dateISO, timeHHMM: current.timeHHMM };
        }
        if (run.manageMode && !rangeDecides(run) && !slotKey(run.currentSlot)) {
            return stop(run, 'config',
                'Can\'t tell when your current test is, so can\'t tell which slots are earlier — ' +
                'open "View booking" in this tab once (or press START there), then start again.');
        }
        const f = slotFilter(run);
        run.lastSeen = {
            count: bookable.length,
            earliest: bookable[0] ? bookable[0].label : null,
            // null when nothing filters, so the popup can show "4 in range" only when it applies.
            matching: CONFIG.filterEnabled || f.before ? bookable.filter((s) => slotMatches(s, f)).length : null
        };
        run.probeFrom = null;

        if (run.pendingSlot) {
            // We submitted a slot but came back to a picker — it was taken.
            warn(`slot ${run.pendingSlot.label} was not accepted`);
            run.pendingSlot = null;
        }

        const tried = new Set(run.triedSlots || []);
        const slot = run.slotAttempts < MAX_SLOT_ATTEMPTS
            ? chooseSlot(bookable.filter((s) => !tried.has(s.epochMs)), f)
            : null;

        if (slot) {
            // The race: every candidate watching this centre sees the same slot. Every
            // month's slots are already in this page (the calendar's month arrows are
            // display only), so a slot weeks after the earliest is booked as fast as
            // the earliest: no jitter, and only a short wait for the sensor POST.
            const at = Date.now();
            return schedule(run, 0, `Booking ${slot.label}`, () => whenSensorDone((live) => {
                log(`booking after ${Date.now() - at} ms`);
                submitSlot(live, slot);
            }, BOOK_SENSOR_CAP));
        }

        const why = noSlotWhy(bookable, f);
        // /manage, same centre: back to the "Test date" form and search again.
        if (run.manageMode === 'date') {
            return scheduleDateRecheck(run, `${run.centre ? run.centre.name : 'Your centre'}: ${why}`);
        }

        // Stick mode: the centre had slots but none we can take. Don't leave it —
        // re-open it next cycle.
        if (run.stickCentre && run.resultsUrl) {
            return scheduleStickRecheck(run, why);
        }

        // /manage has no search term: its centre list comes from the booking.
        if ((run.fromSearch && searchTerm(run)) || run.manageMode === 'centre') {
            const back = document.querySelector('#change-test-centre, a[href*="_eventId=changeTestCentre"]');
            if (back || run.reopenCentres || nextNeighbour(run)) {
                if (run.centre && run.centre.id) {
                    run.skipCentres = run.skipCentres || {};
                    run.skipCentres[run.centre.id] = run.refreshCount + CENTRE_SKIP_REFRESHES;
                }
                // Leaving the picker is an engine navigation like any other: paced,
                // so a centre whose slots never match the filter can't turn into a
                // fast picker → search → picker loop.
                return leaveDeadEnd(run, `${run.centre ? run.centre.name : 'Centre'}: ${why}`);
            }
        }

        stop(run, 'nomatch', bookable.length
            ? `${bookable.length} slot(s) here, none in your date/time range.`
            : 'No bookable slots on this page.');
    }

    // ---- /manage: change the date (or centre) of an existing booking ----

    /** "View booking": note the current test, then take the Change button for the mode. */
    function onManageBooking(run) {
        const current = parseCurrentBooking();
        if (current) run.currentSlot = current;
        const centre = run.manageMode === 'centre';
        const link = document.querySelector(centre
            ? '#test-centre-change, a[href*="_eventId=editTestCentre"]'
            : '#date-time-change, a[href*="_eventId=editTestDateTime"]');
        if (!link) {
            return stop(run, 'wrongpage', `No "Change ${centre ? 'test centre' : 'date and time'}" button on View booking.`);
        }
        const p = pacedDelay(run);
        const what = centre ? 'Changing test centre' : 'Changing date';
        schedule(run, p.ms, p.onBreak ? `Taking a short break, then ${what.toLowerCase()}` : what, (live) => {
            // Its page is part of this check: act on it at once.
            live.afterChange = true;
            saveRun(live);
            whenSensorDone(() => link.click());
        });
    }

    /** "Choosing your date and test centre": Continue (POST …&_eventId=proceed). */
    function onManageIntro(run, afterChange) {
        const p = afterChange ? { ms: 0, onBreak: false } : pacedDelay(run);
        schedule(run, p.ms, p.onBreak ? 'Taking a short break, then continuing' : 'Continuing to the Test date page', (live) => {
            live.afterChange = true;
            saveRun(live);
            whenSensorDone(() => {
                const submit = document.querySelector('input[name="choosingDateTestCentreSubmit"]');
                if (submit) submit.click();
                else step();
            });
        });
    }

    /**
     * "Test date - Car test": "Show earliest available date" and Continue. The site
     * still shows every date, cancellations included, so this is the whole search.
     */
    function onManageDate(run, afterChange) {
        run.manageMode = 'date';
        run.dateFormUrl = location.href;
        if (run.refreshCount >= MAX_REFRESHES) {
            return stop(run, 'limit', `Refresh limit reached (${MAX_REFRESHES}) with nothing earlier.`);
        }
        // Coming back from a picker, its pause was this check's pause.
        const p = afterChange ? { ms: 0, onBreak: false } : pacedDelay(run);
        const label = p.onBreak ? 'Taking a short break, then searching' : 'Searching for an earlier date';
        schedule(run, p.ms, label, () => whenSensorDone((live) => {
            const asap = document.querySelector('#test-choice-earliest, input[name="testChoice"][value="ASAP"]');
            const form = asap && asap.form;
            if (!form) return step();
            asap.checked = true;
            live.refreshCount++;
            live.triedSlots = [];
            live.slotAttempts = 0;
            saveRun(live);
            // POST …&_eventId=proceed with _csrf, testChoice=ASAP, preferredTestDate,
            // drivingLicenceSubmit — the body in the HAR.
            const submit = form.querySelector('#driving-licence-submit, [type="submit"]');
            if (submit) submit.click();
            else form.requestSubmit();
        }));
    }

    /**
     * Nothing earlier on this check: wait the speed mode's pause, then go back to the
     * "Test date" form, as the capture does (GET e2s4 again, Referer e2s3: a history
     * back). Its execution stays valid: e2s4 was submitted twice, e2s7 four times.
     */
    function scheduleDateRecheck(run, why) {
        if (run.refreshCount >= MAX_REFRESHES) {
            return stop(run, 'limit', `Refresh limit reached (${MAX_REFRESHES}) with nothing earlier.`);
        }
        // START on a picker: the form is the page we came from.
        const fromForm = /\/manage\?execution=e\d+s\d+$/.test(document.referrer) ? document.referrer : null;
        const url = run.dateFormUrl || fromForm;
        if (!url) {
            return stop(run, 'wrongpage', `${why}, and no "Test date" page to go back to — open it and start again.`);
        }
        const p = pacedDelay(run);
        const label = (p.onBreak ? `Taking a short break — ${why}` : why) + ' — searching again';
        schedule(run, p.ms, label, (live) => {
            live.dateFormUrl = url;
            live.afterChange = true;
            saveRun(live);
            whenSensorDone(() => goBackTo(url));
        });
    }

    /** The page after a submitted slot on /manage — nothing in the HARs shows it. */
    function onChangeSubmitted(run, page) {
        const slot = run.pendingSlot;
        run.pendingSlot = null;
        if (page.type !== 'unknown') {
            return stop(run, 'wrongpage',
                `Submitted ${slot.label}, then landed on ${page.type} — check the tab.`);
        }
        run.bookedSlot = slot;
        run.bookedAt = Date.now();
        // Once confirmed the booked test is this one: the noted one is stale until
        // View booking shows it again.
        saveBooking(null);
        const where = run.centre && run.centre.name ? ` at ${run.centre.name}` : '';
        // No current test when the date range decided (see rangeDecides).
        const was = run.currentSlot ? ` (was ${run.currentSlot.label})` : '';
        stop(run, 'held', `Slot held: ${slot.label}${where}${was}. ` +
            'Confirm the change in the tab.');
    }

    function submitSlot(run, slot) {
        const form = document.getElementById('slot-picker-form') ||
            document.querySelector('input[name="slotTime"]')?.form;
        const radio = form && form.querySelector(`input[name="slotTime"][value="${slot.epochMs}"]`);
        if (!radio) return step();

        radio.click();          // lets the page's slot-picker JS mark the choice
        radio.checked = true;
        let ack = form.querySelector('input[name="slotWarningAcknowledged"]');
        if (!ack) {
            ack = document.createElement('input');
            ack.type = 'hidden';
            ack.name = 'slotWarningAcknowledged';
            form.appendChild(ack);
        }
        // Same as pressing Continue in the site's "hold this slot?" dialog.
        ack.value = 'true';

        run.pendingSlot = slot;
        run.triedSlots = [...(run.triedSlots || []), slot.epochMs];
        run.slotAttempts = (run.slotAttempts || 0) + 1;
        saveRun(run);
        log(`submitting slot ${slot.label} (attempt ${run.slotAttempts})`);

        // Native submit: POST _csrf, slotWarningAcknowledged=true, slotTime — the
        // exact body in the HAR. Bypasses the page's jQuery submit handler, which
        // would otherwise open the confirmation dialog.
        HTMLFormElement.prototype.submit.call(form);
    }

    // ---- "Your details": the slot is held ----

    function onYourDetails(run) {
        if (!run.pendingSlot) {
            return stop(run, 'wrongpage', 'Already past the slot step.');
        }
        run.bookedSlot = run.pendingSlot;
        run.bookedAt = Date.now();
        run.pendingSlot = null;
        const where = run.centre && run.centre.name ? ` at ${run.centre.name}` : '';
        stop(run, 'held', `Slot held: ${run.bookedSlot.label}${where}. Finish your details in the tab.`);
    }

    // ==================== STATUS / MESSAGING ====================

    function buildStatus() {
        const run = loadRun();
        const page = detectPage();
        const centre = page.type === 'slot-picker' ? parseCentreName() : null;
        return {
            run,
            config: CONFIG,
            modes: Object.fromEntries(Object.keys(SPEED_MODES).map((k) => {
                const v = modeFor(k);
                return [k, { name: v.name, refreshMin: v.refreshMin, refreshMax: v.refreshMax }];
            })),
            page: { type: page.type, centre, manage: isManage() },
            pace: {
                lastMin: loadsWithin(60000),
                last2Min: loadsWithin(120000)
            },
            now: Date.now()
        };
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        switch (request.action) {
            case 'start': {
                const prev = loadRun();
                if (prev.running) {
                    sendResponse({ status: 'already_running' });
                    break;
                }
                clearInterval(heldClock);
                heldClock = null;
                loadConfig().then(() => {
                    saveRun(newRun());
                    step();
                    sendResponse({ status: 'started' });
                });
                return true;
            }

            case 'stop': {
                const run = loadRun();
                if (run.running) stop(run, 'user', 'Stopped by you.');
                sendResponse({ status: 'stopped' });
                break;
            }

            case 'pause': {
                const run = loadRun();
                if (run.running) {
                    clearTimer();
                    run.paused = true;
                    run.nextActionAt = null;
                    run.nextActionLabel = null;
                    saveRun(run);
                }
                sendResponse({ status: 'paused' });
                break;
            }

            case 'resume': {
                const run = loadRun();
                if (run.running) {
                    run.paused = false;
                    saveRun(run);
                    step();
                }
                sendResponse({ status: 'resumed' });
                break;
            }

            case 'reset': {
                const run = loadRun();
                if (!run.running) {
                    try { sessionStorage.removeItem(RUN_KEY); } catch (e) { /* ignore */ }
                }
                sendResponse({ status: 'reset' });
                break;
            }

            case 'getStatus':
                sendResponse(buildStatus());
                break;

            case 'setConfig': {
                const c = request.config || {};
                if (SPEED_MODES[c.speedMode]) CONFIG.speedMode = c.speedMode;
                const custom = parseCustomRefresh(c.customRefresh);
                if (custom) CONFIG.customRefresh = custom;
                if ('searchTerm' in c) CONFIG.searchTerm = c.searchTerm || null;
                if (Array.isArray(c.allowList)) CONFIG.allowList = c.allowList;
                if (Array.isArray(c.manageCentres)) CONFIG.manageCentres = c.manageCentres;
                if (typeof c.stickToCentre === 'boolean') CONFIG.stickToCentre = c.stickToCentre;
                if (CHANGE_MODES.includes(c.changeWhat)) CONFIG.changeWhat = c.changeWhat;
                if (typeof c.filterEnabled === 'boolean') CONFIG.filterEnabled = c.filterEnabled;
                if (c.filter) Object.assign(CONFIG.filter, c.filter);
                saveConfig().then(() => sendResponse({ status: 'ok', config: CONFIG }));
                return true;
            }
        }
        return false;
    });

    // ==================== INIT ====================

    async function init() {
        await Promise.all([loadConfig(), loadPace()]);
        recordPageLoad();
        const run = loadRun();
        const page = detectPage();
        log(`v8 loaded — page=${page.type}` + (run.running ? ` (run active, ${run.refreshCount} refreshes)` : ''));
        // Also when no run is active: the popup's cool-down warning needs every block.
        if (page.type === 'blocked') noteBlock();
        // Also when no run is active: START may come later, on the centre list.
        noteBooking(page);
        if (!run.running && run.stopKind === 'held') showHeldClock(run);
        step();
    }

    // The content script runs at document_end (DOM parsed). Don't wait for the
    // window load event: it hangs on Google Analytics / gtag for seconds on some
    // loads, and every form, link and slot radio we act on is already in the DOM.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();

    window.addEventListener('pageshow', (e) => {
        if (e.persisted) step();
    });

    // Another tab on this site spends the same Imperva budget.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[PACE_KEY] && changes[PACE_KEY].newValue) pace = changes[PACE_KEY].newValue;
    });

    // Exposed for tests (the page's own scripts cannot see the content-script world).
    globalThis.__slotBooker8 = { detectPage, parseSlots, parseCentreResults, parseCentreName, parseChosenCentre, parseCurrentBooking, pickSlot, chooseSlot, slotMatches };
})();
