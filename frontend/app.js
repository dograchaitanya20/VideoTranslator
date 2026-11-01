/* SubStream.ai frontend — talks to the FastAPI backend (/api/...) */
const LANG_NAMES = { en: 'English', hi: 'Hindi', pa: 'Punjabi', ur: 'Urdu', auto: 'Auto' };
const $ = (id) => document.getElementById(id);

const state = { jobId: null, subs: [], sourceLang: null, lang: 'en', bilingual: false,
                active: -1, busy: false, poll: null, query: '' };

const video = $('video');

// ---------- helpers ----------
function toast(msg, ms = 4000) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(sec, sep) {
  const ms = Math.round(sec * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}
const clock = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const textOf = (s, lang) => s[lang] || '';
const STAGES = { queued: 'Queued…', downloading: 'Downloading video…', converting: 'Converting for playback…',
  extracting: 'Extracting audio…', loading_model: 'Loading speech model (first run is slow)…',
  transcribing: 'Transcribing speech…', done: 'Done' };

// ---------- ingestion ----------
function setupIngestion() {
  const file = $('localFileInput'), link = $('videoLinkInput');
  $('pillUploadLocal').onclick = $('navUpload').onclick = () => file.click();
  $('navLink').onclick = () => link.focus();
  $('emptyState').onclick = () => file.click();
  file.onchange = () => file.files[0] && start({ file: file.files[0] });
  $('btnMainAction').onclick = () => (link.value.trim() ? start({ url: link.value.trim() }) : file.click());
  link.addEventListener('keydown', (e) => { if (e.key === 'Enter' && link.value.trim()) start({ url: link.value.trim() }); });

  // drop a video anywhere on the page
  ['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f && (f.type.startsWith('video/') || f.type.startsWith('audio/'))) start({ file: f });
  });
}

async function start({ file, url }) {
  if (state.busy) return toast('Already working on a video — please wait.');
  state.busy = true; clearInterval(state.poll);
  resetUI(file ? file.name : url);
  const fd = new FormData();
  if (file) fd.append('file', file); else fd.append('url', url);
  fd.append('lang', $('spokenLang').value);
  showProgress('Uploading…', 1);
  try {
    const r = await fetch('/api/jobs', { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.json()).detail || 'Upload failed');
    state.jobId = (await r.json()).id;
    state.poll = setInterval(pollJob, 1000);
  } catch (e) { fail(e.message); }
}

async function pollJob() {
  try {
    const j = await (await fetch(`/api/jobs/${state.jobId}`)).json();
    $('sourceLabel').textContent = j.title || '—';
    if (j.status === 'error') return fail(j.error || 'Something went wrong');
    if (j.status !== 'done') {
      $('statusTag').textContent = 'Working';
      if (j.progress >= 18 && !video.src) attachVideo();
      return showProgress(STAGES[j.status] || j.status, j.progress);
    }
    clearInterval(state.poll); state.busy = false;
    $('progressWrap').hidden = true;
    state.subs = j.segments; state.sourceLang = j.source_lang;
    if (!video.src) attachVideo();
    $('statusTag').textContent = 'Subtitles ready';
    $('detectedLang').textContent = (LANG_NAMES[j.source_lang] || j.source_lang);
    $('heroScore').textContent = `${Math.round(j.confidence * 100)}%`;
    $('valCoverage').textContent = `${Math.round(j.coverage * 100)}%`;
    $('valLines').textContent = j.segments.length;
    $('statsBox').hidden = false;
    // show the language they spoke first, if we support it
    await setLanguage(['en', 'hi', 'pa'].includes(j.source_lang) ? j.source_lang : 'en');
  } catch (e) { /* transient network blip: keep polling */ }
}

function attachVideo() {
  video.src = `/api/jobs/${state.jobId}/media`;
  video.style.display = 'block'; $('emptyState').style.display = 'none';
}
function showProgress(text, pct) {
  $('progressWrap').hidden = false; $('progressText').style.color = '';
  $('progressText').textContent = text; $('progressPct').textContent = `${pct}%`;
  $('progressBar').style.width = `${pct}%`;
}
function fail(msg) {
  clearInterval(state.poll); state.busy = false;
  $('statusTag').textContent = 'Error';
  $('progressWrap').hidden = false;
  $('progressText').textContent = '⚠ ' + msg; $('progressText').style.color = '#f87171';
  $('progressPct').textContent = ''; $('progressBar').style.width = '0%';
}
function resetUI(label) {
  state.subs = []; state.active = -1;
  video.removeAttribute('src'); video.load(); video.style.display = 'none';
  $('emptyState').style.display = 'flex';
  $('transcriptGrid').innerHTML = ''; $('capPrimary').textContent = ''; $('statsBox').hidden = true;
  $('sourceLabel').textContent = label; $('heroScore').textContent = '—';
  $('valCoverage').textContent = $('valLines').textContent = '—';
  $('detectedLang').textContent = '—';
}

// ---------- languages ----------
async function ensureLang(lang) {
  if (!state.subs.length || state.subs.every((s) => s[lang])) return true;
  toast(`Translating to ${LANG_NAMES[lang]}…`, 20000);
  try {
    const r = await fetch(`/api/jobs/${state.jobId}/translate?target=${lang}`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).detail || 'Translation failed');
    state.subs = (await r.json()).segments;
    $('toast').hidden = true;
    return true;
  } catch (e) { toast(e.message, 7000); return false; }
}

async function setLanguage(lang) {
  if (state.subs.length && !(await ensureLang(lang))) return;
  state.lang = lang;
  document.querySelectorAll('.seg[data-lang]').forEach((p) => p.classList.toggle('active', p.dataset.lang === lang));
  if (state.bilingual) await ensureLang(secondaryLang());
  renderTranscript(); updateCaption(video.currentTime || 0, true);
}
function secondaryLang() {
  if (state.lang !== state.sourceLang && ['en', 'hi', 'pa'].includes(state.sourceLang)) return state.sourceLang;
  return state.lang === 'en' ? 'hi' : 'en';
}
function setupLanguagePills() {
  document.querySelectorAll('[data-lang]').forEach((p) => (p.onclick = () => setLanguage(p.dataset.lang)));
  $('pillBilingual').onclick = async () => {
    state.bilingual = !state.bilingual;
    $('pillBilingual').classList.toggle('on', state.bilingual);
    if (state.bilingual) await ensureLang(secondaryLang());
    renderTranscript(); updateCaption(video.currentTime || 0, true);
  };
}

// ---------- captions + transcript ----------
function updateCaption(t, force) {
  const i = state.subs.findIndex((s) => t >= s.start && t <= s.end);
  if (i === state.active && !force) return;
  state.active = i;
  const s = state.subs[i];
  const primaryText = s ? (textOf(s, state.lang) || s.orig || '') : '';
  $('capPrimary').textContent = primaryText;
  const sec = $('capSecondary');
  const secText = s && state.bilingual ? (textOf(s, secondaryLang()) || '') : '';
  sec.style.display = secText ? 'block' : 'none';
  sec.textContent = secText;
  $('captionBanner').style.opacity = (s && primaryText) ? '1' : '0';
  document.querySelectorAll('.transcript-line-card').forEach((c) => {
    const on = Number(c.dataset.i) === i;
    c.classList.toggle('active', on);
    if (on && $('autoScroll').checked) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function renderTranscript() {
  const grid = $('transcriptGrid'); grid.innerHTML = '';
  const q = state.query.toLowerCase();
  state.subs.forEach((s, i) => {
    if (q && !textOf(s, state.lang).toLowerCase().includes(q)) return;
    const card = document.createElement('div');
    card.className = 'transcript-line-card'; card.dataset.i = i;
    const tc = document.createElement('div');
    tc.className = 'line-timecode'; tc.textContent = `${clock(s.start)} – ${clock(s.end)}`;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'line-editable-text'; input.value = textOf(s, state.lang);
    input.onclick = (e) => e.stopPropagation();
    input.onchange = () => {
      s[state.lang] = input.value;
      fetch(`/api/jobs/${state.jobId}/segment/${s.id}?lang=${state.lang}&text=${encodeURIComponent(input.value)}`, { method: 'PUT' });
      updateCaption(video.currentTime, true);
    };
    card.append(tc, input);
    if (state.bilingual) {
      const sec = document.createElement('div');
      sec.className = 'line-trans-text'; sec.textContent = `↳ ${textOf(s, secondaryLang())}`;
      card.append(sec);
    }
    card.onclick = () => { video.currentTime = s.start; updateCaption(s.start, true); video.play(); };
    if (i === state.active) card.classList.add('active');
    grid.append(card);
  });
}

// ---------- fullscreen helpers ----------
const FS_ENTER_SVG = '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const FS_EXIT_SVG = '<path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}

function toggleFullscreen() {
  const elem = $('videoFrame');
  if (!isFullscreen()) {
    if (elem.requestFullscreen) elem.requestFullscreen();
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
    else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (document.msExitFullscreen) document.msExitFullscreen();
  }
}

let hideControlsTimer = null;
function handleFullscreenControls() {
  const frame = $('videoFrame');
  if (!frame || !isFullscreen()) return;
  frame.classList.remove('hide-controls');
  clearTimeout(hideControlsTimer);
  if (!video.paused) {
    hideControlsTimer = setTimeout(() => {
      if (isFullscreen() && !video.paused) {
        frame.classList.add('hide-controls');
      }
    }, 2800);
  }
}

function updateFullscreenUI() {
  const fs = isFullscreen();
  const frame = $('videoFrame');
  if (frame) frame.classList.toggle('is-fullscreen', fs);
  const icon = $('fullscreenIcon');
  if (icon) icon.innerHTML = fs ? FS_EXIT_SVG : FS_ENTER_SVG;
  const btn = $('btnFullscreen');
  if (btn) btn.title = fs ? 'Exit full screen (f)' : 'Full screen (f)';
  if (!fs && frame) {
    frame.classList.remove('hide-controls');
    clearTimeout(hideControlsTimer);
  } else {
    handleFullscreenControls();
  }
}

// ---------- player ----------
function setupPlayer() {
  const frame = $('videoFrame');
  $('btnPlay').onclick = () => (video.paused ? video.play() : video.pause());
  video.onplay = video.onpause = () => {
    $('playIcon').innerHTML = video.paused
      ? '<polygon points="5 3 19 12 5 21 5 3"></polygon>'
      : '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
    if (isFullscreen()) handleFullscreenControls();
  };
  video.ontimeupdate = video.onseeked = () => {
    const d = video.duration || 1;
    $('scrubFill').style.width = `${(video.currentTime / d) * 100}%`;
    $('timeReadout').textContent = `${clock(video.currentTime)} / ${clock(d)}`;
    updateCaption(video.currentTime);
  };
  $('scrubber').onclick = (e) => {
    const r = $('scrubber').getBoundingClientRect();
    if (video.duration) {
      video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
      updateCaption(video.currentTime, true);
    }
  };
  $('speed').onchange = (e) => (video.playbackRate = Number(e.target.value));
  video.onclick = $('btnPlay').onclick;
  video.ondblclick = toggleFullscreen;
  $('btnFullscreen').onclick = toggleFullscreen;

  document.addEventListener('fullscreenchange', updateFullscreenUI);
  document.addEventListener('webkitfullscreenchange', updateFullscreenUI);

  if (frame) {
    frame.addEventListener('mousemove', handleFullscreenControls);
    frame.addEventListener('click', handleFullscreenControls);
  }

  video.onerror = () => video.src && toast('This video format cannot be played in the browser.');

  window.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
    if (e.code === 'KeyF') { e.preventDefault(); toggleFullscreen(); }
    if (e.code === 'ArrowLeft') video.currentTime -= 5;
    if (e.code === 'ArrowRight') video.currentTime += 5;
  });
  $('navKeys').onclick = () => toast('Space: play/pause · F: full screen · ←/→: skip 5s · Click a line to jump to it · Edit any line to fix it', 7000);
  $('searchBox').oninput = (e) => { state.query = e.target.value; renderTranscript(); };
}

// ---------- export ----------
function cues(sep) {
  return state.subs.map((s, i) => {
    let text = textOf(s, state.lang);
    if (state.bilingual) text += `\n${textOf(s, secondaryLang())}`;
    return `${i + 1}\n${stamp(s.start, sep)} --> ${stamp(s.end, sep)}\n${text}\n`;
  }).join('\n');
}
function plainText() {
  return state.subs.map((s) => `[${clock(s.start)}] ${textOf(s, state.lang)}`).join('\n');
}
function download(content, name, type = 'text/plain') {
  if (!state.subs.length) return toast('Generate subtitles first.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + content], { type: type + ';charset=utf-8' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function setupExports() {
  const L = () => state.lang;
  $('expSRT').onclick = () => download(cues(','), `subtitles_${L()}.srt`);
  $('expVTT').onclick = () => download('WEBVTT\n\n' + cues('.'), `subtitles_${L()}.vtt`, 'text/vtt');
  $('expTXT').onclick = () => download(plainText(), `transcript_${L()}.txt`);
  $('expJSON').onclick = () => download(JSON.stringify(state.subs, null, 2), 'subtitles.json', 'application/json');
    $('btnCopy').onclick = async () => {
    const text = plainText();
    try { await navigator.clipboard.writeText(text); }
    catch (e) {  // plain http (e.g. phone on Wi-Fi) has no clipboard API
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove();
    }
    toast('Transcript copied');
  };
}

function setupPhone() {
  const modal = $('phoneModal');
  const close = () => (modal.hidden = true);
  $('navPhone').onclick = async () => {
    modal.hidden = false;
    $('qrBox').innerHTML = ''; $('phoneUrl').textContent = 'Loading…'; $('phoneNote').textContent = '';
    try {
      const j = await (await fetch('/api/connect')).json();
      $('phoneUrl').textContent = j.url;
      $('qrBox').innerHTML = j.svg;  // generated by our own server
      $('phoneNote').textContent = j.hosted
        ? 'Scan this with your phone camera, or share the link.'
        : (j.enabled
          ? 'Phone and computer must be on the same Wi-Fi.'
          : 'Phone access is turned off. Set ALLOW_PHONE=1 in config.bat and restart the app.');
    } catch (e) { $('phoneUrl').textContent = 'Could not get the address.'; }
  };
  $('phoneClose').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

document.addEventListener('DOMContentLoaded', () => {
  setupIngestion(); setupLanguagePills(); setupPlayer(); setupExports(); setupPhone();
});
