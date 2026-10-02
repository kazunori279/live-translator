// Renderer focus can be emulated by another debugging client. Chrome's tab-strip
// metadata is authoritative for which tab is selected (Chrome 150+).
export class ActiveTabs {
  constructor(browser) {
    this.browser = browser;
    this.tabs = new Map();
    this.pageIds = new WeakMap();
  }

  activePageIds() {
    const request = (this.pending || Promise.resolve()).then(() => this.readActivePageIds());
    this.pending = request.catch(() => {});
    return request;
  }

  async readActivePageIds() {
    this.session ??= await this.browser.target().createCDPSession();
    const { targetInfos } = await this.session.send('Target.getTargets', {
      filter: [{ type: 'tab' }, { exclude: true }],
    });
    if (!targetInfos.some(t => typeof t.embedderData?.tabActive === 'boolean')) return null;
    const live = new Set(targetInfos.map(t => t.targetId));
    for (const [id, tab] of this.tabs) {
      if (!live.has(id)) {
        this.tabs.delete(id);
        await this.session.send('Target.detachFromTarget', { sessionId: tab.sessionId }).catch(() => {});
      }
    }
    const active = targetInfos.filter(t => t.embedderData?.tabActive);
    const ids = new Set();
    for (const info of active) {
      let tab = this.tabs.get(info.targetId);
      if (!tab) {
        const { sessionId } = await this.session.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        const child = this.session.connection().session(sessionId);
        tab = { sessionId, pages: new Map() };
        this.tabs.set(info.targetId, tab);
        child.on('Target.attachedToTarget', event => {
          if (event.targetInfo.type === 'page' && !event.targetInfo.subtype) {
            tab.pages.set(event.sessionId, event.targetInfo.targetId);
          }
        });
        child.on('Target.detachedFromTarget', event => tab.pages.delete(event.sessionId));
        try {
          await child.send('Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
            filter: [{ type: 'page' }, { exclude: true }],
          });
        } catch (error) {
          this.tabs.delete(info.targetId);
          await this.session.send('Target.detachFromTarget', { sessionId }).catch(() => {});
          throw error;
        }
      }
      for (const id of tab.pages.values()) ids.add(id);
    }
    return ids;
  }

  async includes(page, ids) {
    if (ids === null) return true; // Older Chrome: retain renderer-focus fallback.
    let id = this.pageIds.get(page);
    if (!id) {
      const session = await page.createCDPSession();
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        id = targetInfo.targetId;
        this.pageIds.set(page, id);
      } finally { await session.detach().catch(() => {}); }
    }
    return ids.has(id);
  }

  async stop() {
    await this.pending;
    await this.session?.detach().catch(() => {});
    this.session = null;
    this.tabs.clear();
  }
}
