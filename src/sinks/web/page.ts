/**
 * The viewer page, as a string constant.
 *
 * Inlined rather than served from disk so the daemon has no runtime dependency
 * on its own source tree — launchd runs it from an absolute path, and a moved
 * or reinstalled checkout should not turn into a 404.
 */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>sd-connect</title>
<style>
  :root {
    --bezel: #2a2a2e;
    --gap: clamp(4px, 1.2vw, 10px);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: #0b0c0e;
    color: #c8ccd6;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 16px;
  }
  #deck {
    display: grid;
    gap: var(--gap);
    padding: var(--gap);
    background: var(--bezel);
    border-radius: clamp(6px, 1.5vw, 14px);
    box-shadow: 0 10px 40px rgba(0,0,0,.6);
    /* Sized so the whole deck fits whichever axis is tighter. */
    width: min(92vw, calc((100vh - 120px) * 5 / 3));
    aspect-ratio: 5 / 3;
  }
  .key {
    position: relative;
    padding: 0;
    border: 0;
    border-radius: clamp(3px, .8vw, 7px);
    background: #000;
    overflow: hidden;
    aspect-ratio: 1;
    /* The deck is a 72px display. Smoothing would show less than the hardware. */
    image-rendering: pixelated;
    cursor: default;
    -webkit-tap-highlight-color: transparent;
    transition: transform .08s ease, box-shadow .08s ease;
  }
  .key img { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
  .key.live { cursor: pointer; }
  .key.live:hover { box-shadow: inset 0 0 0 2px rgba(255,255,255,.35); }
  .key.live:active { transform: scale(.95); }
  .key.flash::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgba(255,255,255,.75);
    animation: fade .4s ease-out forwards;
  }
  @keyframes fade { to { opacity: 0; } }
  /* A running macro: pulsing ring so it reads as busy at a glance. */
  .key.running { box-shadow: inset 0 0 0 3px #22c55e; }
  .key.running::before {
    content: "";
    position: absolute;
    inset: 0;
    background: rgba(34,197,94,.25);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: .4; } }
  #status { display: flex; align-items: center; gap: 8px; height: 16px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; }
  #dot.on { background: #22c55e; }
  #dot.off { background: #ef4444; }
  #msg { color: #8a90a0; }
  @media (prefers-reduced-motion: reduce) {
    .key, .key.flash::after, .key.running::before { transition: none; animation: none; }
  }
</style>
</head>
<body>
  <div id="deck" role="group" aria-label="Stream Deck keys"></div>
  <div id="status"><span id="dot"></span><span id="msg">connecting…</span></div>

<script>
const deck = document.getElementById('deck');
const dot = document.getElementById('dot');
const msg = document.getElementById('msg');
let cols = 5;

function setStatus(state, text) {
  dot.className = state;
  msg.textContent = text;
}

function render(frame) {
  if (frame.columns !== cols || deck.children.length !== frame.keys.length) {
    cols = frame.columns;
    deck.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    deck.replaceChildren(...frame.keys.map(() => {
      const b = document.createElement('button');
      b.className = 'key';
      b.type = 'button';
      b.appendChild(document.createElement('img'));
      return b;
    }));
  }

  frame.keys.forEach((key, i) => {
    const el = deck.children[i];
    const img = el.firstChild;
    const src = '/tile/' + key.tile + '.png';
    // Content-addressed, so a differing src is the only repaint trigger.
    if (img.getAttribute('src') !== src) {
      img.src = src;
      img.alt = key.label || '';
    }
    el.classList.toggle('live', key.pressable);
    el.classList.toggle('running', !!key.running);
    el.setAttribute('aria-label', (key.label || 'empty key') + (key.running ? ' (running)' : ''));
    el.disabled = !key.pressable;
    el.onclick = key.pressable ? () => press(i, el) : null;
  });
}

async function press(index, el) {
  el.classList.remove('flash');
  // Reflow so the animation restarts on a repeat press.
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 400);
  try {
    const res = await fetch('/press/' + index, { method: 'POST' });
    const body = await res.json();
    if (!res.ok || body.error) setStatus('off', body.error || 'press failed');
  } catch (err) {
    setStatus('off', 'press failed: ' + err.message);
  }
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => setStatus('on', 'live');
  es.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    render(frame);
    const n = frame.keys.filter((k) => k.pressable).length;
    const extra = frame.dropped ? ' (+' + frame.dropped + ' not shown)' : '';
    setStatus('on', n + (n === 1 ? ' agent' : ' agents') + extra);
  };
  // EventSource reconnects on its own; this only reports the gap. A daemon
  // restart therefore recovers without a manual refresh.
  es.onerror = () => setStatus('off', 'disconnected, retrying…');
}

connect();
</script>
</body>
</html>
`
