import { randomUUID } from 'node:crypto';
import { readSelection, showCaption, cleanPage } from './page.js';
import { translate } from './translation.js';

export function sameSelection(a, b) {
  return !!a && !!b && a.page === b.page && a.frame === b.frame &&
    a.documentId === b.documentId && a.url === b.url && a.text === b.text;
}

export class SelectionWatcher {
  constructor(browser, options, report, translator = translate) {
    this.browser = browser;
    this.options = options;
    this.report = report;
    this.translator = translator;
    const id = randomUUID().replaceAll('-', '');
    this.captionId = `live-translator-${id}`;
    this.stateKey = `__liveTranslator_${id}`;
    this.touched = new Set();
    this.running = false;
    this.generation = 0;
    this.current = null;
    this.started = false;
  }

  start() {
    this.running = true;
    this.loop();
  }

  async loop() {
    while (this.running) {
      try { await this.tick(); }
      catch { if (this.running) this.report({ message: 'Waiting for an accessible Chrome tab…' }); }
      if (!this.running) break;
      await new Promise(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, 250); });
    }
  }

  async focusedSelection() {
    const pages = await this.browser.pages();
    for (const page of pages) {
      if (!/^https?:\/\//.test(page.url())) continue;
      let top;
      try { top = await page.mainFrame().isolatedRealm().evaluate(readSelection, this.stateKey); }
      catch { continue; }
      if (!top.focused) continue;
      this.touched.add(page);
      // Includes cross-origin frames; each is evaluated in its own execution context.
      for (const frame of page.frames()) {
        try {
          const selection = frame === page.mainFrame() ? top :
            await frame.isolatedRealm().evaluate(readSelection, this.stateKey);
          if (selection.focused && selection.text) return { ...selection, page, frame };
        } catch { /* Frame navigated or detached. */ }
      }
      return null;
    }
    return null;
  }

  async tick() {
    const selected = await this.focusedSelection();
    if (!this.running) return;
    if (!sameSelection(selected, this.current)) {
      if (!selected && !this.current) return;
      this.generation++;
      this.abort?.abort();
      if (this.current) await this.caption(this.current.page, '');
      if (!this.running) return;
      this.current = selected;
      this.changedAt = Date.now();
      this.started = false;
      this.report({ message: selected ? 'Selection detected…' : 'Select text in the active Chrome tab.', selection: '', translation: '' });
    }
    if (this.current && this.started && Date.now() - (this.lastHeartbeat || 0) > 2000) {
      this.lastHeartbeat = Date.now();
      await this.caption(this.current.page, null);
    }
    if (!this.running || !this.current || this.started || Date.now() - this.changedAt < 600) return;
    this.started = true;
    const snapshot = this.current;
    const generation = this.generation;
    if (snapshot.text.length > 10000) {
      await this.caption(snapshot.page, 'Select up to 10,000 characters.', true);
      this.report({ message: 'Selection is too long (maximum 10,000 characters).' });
      return;
    }
    this.abort = new AbortController();
    await this.caption(snapshot.page, 'Translating…');
    if (!this.running || generation !== this.generation) return;
    this.report({ message: 'Translating selected text…', selection: snapshot.text, translation: '' });
    this.translator({ ...this.options, text: snapshot.text, signal: this.abort.signal })
      .then(async text => {
        if (!await this.isCurrent(snapshot, generation)) return;
        await this.caption(snapshot.page, text);
        if (this.running && generation === this.generation) {
          this.report({ message: 'Caption displayed. Select another passage to translate.', translation: text });
        }
      })
      .catch(async error => {
        if (error.name === 'AbortError' || !await this.isCurrent(snapshot, generation)) return;
        await this.caption(snapshot.page, error.message, true);
        this.report({ message: error.message });
      });
  }

  async isCurrent(snapshot, generation) {
    if (!this.running || generation !== this.generation) return false;
    try {
      const now = await snapshot.frame.isolatedRealm().evaluate(readSelection, this.stateKey);
      return this.running && generation === this.generation && now.focused &&
        sameSelection(snapshot, { ...now, page: snapshot.page, frame: snapshot.frame });
    } catch { return false; }
  }

  async caption(page, text, error = false) {
    try { await page.mainFrame().isolatedRealm().evaluate(showCaption, this.captionId, text, error); }
    catch { /* Closed/navigated pages no longer need a caption. */ }
  }

  async stop() {
    this.running = false;
    this.generation++;
    this.abort?.abort();
    clearTimeout(this.timer);
    this.wake?.();
    await Promise.allSettled([...this.touched].flatMap(page => page.frames().map(frame =>
      frame.isolatedRealm().evaluate(cleanPage, this.captionId, this.stateKey))));
    this.touched.clear();
    this.current = null;
  }
}
