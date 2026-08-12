/**
 * Subtitles painted over whatever page is being translated.
 *
 * Ported from the rolling three-line overlay in `app/static/caption.html`,
 * with two changes forced by living inside someone else's document:
 *
 * - Everything is in a shadow root, so the page's stylesheet cannot restyle
 *   the captions and ours cannot leak into the page.
 * - Going fullscreen on a video puts that element alone on screen and hides
 *   the rest of the document, so the host element has to be re-parented into
 *   `document.fullscreenElement` when that happens, and back out afterwards.
 *
 * Injected on demand with `chrome.scripting.executeScript` under `activeTab`,
 * so the extension needs no host permission for the sites it captions. That
 * also means it can be injected twice — the guard below makes the second one
 * a no-op rather than a duplicate overlay.
 */

(() => {
  const MARK = "__liveTranslatorCaptions";
  if (window[MARK]) return;
  window[MARK] = true;

  const MAX_LINES = 3;
  const FADE_DELAY_MS = 8000;

  const host = document.createElement("div");
  host.id = "live-translator-captions";
  // The page's own stacking contexts routinely go into the millions.
  host.style.cssText =
    "position:fixed;inset:auto 0 0 0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; --max-rows: 3; }
      #lines {
        display: flex; flex-direction: column; align-items: center;
        gap: 0.3rem; padding: 0 2rem 2.5rem; pointer-events: none;
        font-family: "Google Sans", "Noto Sans", "Noto Sans JP", sans-serif;
      }
      .line {
        font-size: 1.6rem; line-height: 1.4; color: #fff;
        background: rgba(0, 0, 0, 0.72);
        padding: 0.25rem 0.8rem; border-radius: 0.4rem;
        max-width: 90%; text-align: center; word-wrap: break-word;
        animation: line-in 0.25s ease-out;
        /* A single sentence still has to fit on someone's video. The cap is on
           wrapped rows, not on characters, and the text is bottom-aligned so
           what overflows is the part already read — the newest words stay on
           screen. Hiding the overflow is what turns it into a clip. */
        display: flex; align-items: flex-end; overflow: hidden;
        max-height: calc(var(--max-rows) * 1.4em);
      }
      /* One flex item, so the clip above applies to the wrapped block as a
         whole rather than to a bare text node and the dot separately. */
      .text { flex: 1 1 auto; min-width: 0; }
      .line.fade-out { animation: line-out 0.8s ease-in forwards; }
      .dot {
        display: inline-block; width: 0.5rem; height: 0.5rem;
        background: rgba(255, 255, 255, 0.7); border-radius: 50%;
        margin-left: 0.3rem; vertical-align: middle;
        animation: blink 0.8s infinite;
      }
      @keyframes blink { 0%, 100% { opacity: 1 } 50% { opacity: 0.2 } }
      @keyframes line-in { from { opacity: 0; transform: translateY(0.5rem) } to { opacity: 1; transform: none } }
      @keyframes line-out { from { opacity: 1 } to { opacity: 0 } }
    </style>
    <div id="lines"></div>
  `;
  const linesEl = root.getElementById("lines");
  document.documentElement.appendChild(host);

  let currentLine = null;

  function addLine(text, partial) {
    const div = document.createElement("div");
    div.className = "line";
    const span = document.createElement("span");
    span.className = "text";
    div.appendChild(span);
    linesEl.appendChild(div);
    currentLine = div;
    while (linesEl.children.length > MAX_LINES) linesEl.removeChild(linesEl.firstChild);
    setText(div, text, partial);
    if (!partial) scheduleFade(div);
  }

  function updateLine(text, partial) {
    if (!currentLine) return addLine(text, partial);
    setText(currentLine, text, partial);
    if (!partial) scheduleFade(currentLine);
  }

  function setText(line, text, partial) {
    const span = line.querySelector(".text");
    span.textContent = text;
    if (partial) span.appendChild(dot());
  }

  function dot() {
    const d = document.createElement("span");
    d.className = "dot";
    return d;
  }

  function finalize() {
    if (currentLine) {
      currentLine.querySelector(".dot")?.remove();
      scheduleFade(currentLine);
    }
    currentLine = null;
  }

  function scheduleFade(el) {
    setTimeout(() => {
      el.classList.add("fade-out");
      el.addEventListener("animationend", () => el.remove());
    }, FADE_DELAY_MS);
  }

  function teardown() {
    host.remove();
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    chrome.runtime.onMessage.removeListener(onMessage);
    delete window[MARK];
  }

  // Only the fullscreen element and its descendants are rendered, so a caption
  // parented to <html> vanishes the moment a video is made fullscreen.
  function onFullscreenChange() {
    (document.fullscreenElement || document.documentElement).appendChild(host);
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);

  function onMessage(msg) {
    if (msg?.target !== "captions") return;
    if (msg.type === "teardown" || (msg.type === "state" && msg.running === false)) {
      teardown();
    } else if (msg.type === "turnComplete") {
      finalize();
    } else if (msg.type === "transcript") {
      if (currentLine) updateLine(msg.text, !msg.finished);
      else addLine(msg.text, !msg.finished);
      if (msg.finished) currentLine = null;
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);
})();
