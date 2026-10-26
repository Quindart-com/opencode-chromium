/** Shared by every page expression. Handles are opaque and never recycled. */
export function pageStateSource() {
  return `
    const agentFail = (code, message, details) => { throw new Error('[' + code + '] ' + message + (details ? '\\n[DETAILS]' + JSON.stringify(details) : '')); };
    const agentFrameId = globalThis.__agentBrowserFrameId || 'main';
    let agentState = globalThis.__agentBrowserPageState;
    if (!agentState || agentState.document !== document) {
      const documentId = (globalThis.crypto?.randomUUID?.() || (performance.timeOrigin + '-' + Math.random().toString(36).slice(2)));
      agentState = { document, documentId, nodes: new Map(), ids: new WeakMap(), next: 1, revision: 0, changedAt: performance.now() };
      const relevant = node => {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        return !element?.closest?.('[data-opencode-cursor], #opencode-agent-cursor-root, [data-opencode-overlay]');
      };
      agentState.observer = new MutationObserver(records => {
        if (records.some(record => relevant(record.target) && (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(relevant)))) { agentState.revision++; agentState.changedAt = performance.now(); }
      });
      agentState.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      globalThis.__agentBrowserPageState = agentState;
    }
    // Preserve the historic diagnostic map, without resetting its counter.
    if (agentState.nodes.size > 4000) for (const [id, node] of agentState.nodes) if (!node.isConnected || node.ownerDocument !== document) agentState.nodes.delete(id);
    window.__agentBrowserDomNodeMap = agentState.nodes;
    const agentNodeId = element => {
      let id = agentState.ids.get(element);
      if (!id) {
        id = 'node:' + encodeURIComponent(agentFrameId) + ':' + agentState.documentId + ':' + agentState.next++;
        agentState.ids.set(element, id);
      }
      agentState.nodes.delete(id);
      agentState.nodes.set(id, element);
      return id;
    };
    const agentNodeById = id => {
      const node = agentState.nodes.get(id);
      if (!node || !node.isConnected || node.ownerDocument !== document) agentFail('STALE_TARGET', 'Node belongs to an expired document or is detached. Observe the selected frame again.');
      return node;
    };
    const agentVisible = element => {
      if (!element?.isConnected || element.closest?.('[inert]')) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && Number(style.opacity) !== 0 && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    };
    const agentDialogRoot = () => {
      const elements = [...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"],[popover]:popover-open,.modal,.popover,.dialog')].filter(agentVisible);
      const active = document.activeElement;
      return elements.sort((a, b) => {
        if (a.contains(b)) return 1;
        if (b.contains(a)) return -1;
        const focus = Number(b.contains(active)) - Number(a.contains(active));
        return focus || (parseInt(getComputedStyle(b).zIndex) || 0) - (parseInt(getComputedStyle(a).zIndex) || 0);
      })[0] || null;
    };
    const agentObservation = (scope = 'page') => ({ capturedAt: new Date().toISOString(), documentId: agentState.documentId, frameId: agentFrameId, revision: agentState.revision, lastMutationAgeMs: performance.now() - agentState.changedAt, scope, focusedRoot: agentDialogRoot() ? agentNodeId(agentDialogRoot()) : null });
    const agentUnique = (selector, root = document) => {
      let matches;
      try { matches = [...root.querySelectorAll(selector)]; } catch { agentFail('INVALID_SELECTOR', 'Invalid selector: ' + selector); }
      const visible = matches.filter(agentVisible);
      const candidates = visible.length ? visible : matches;
      if (candidates.length > 1) agentFail('AMBIGUOUS_TARGET', 'Selector matches ' + candidates.length + ' elements. Use a fresh nodeId or a narrower selector: ' + selector);
      if (!candidates.length) agentFail('TARGET_NOT_FOUND', 'No element matches selector: ' + selector);
      return candidates[0];
    };
  `;
}

export function pageStateExpression() {
  return `(() => { ${pageStateSource()} return { ...agentObservation(), lastMutationAgeMs: performance.now() - agentState.changedAt, readyState: document.readyState }; })()`;
}

export function nodeFrameId(nodeId: unknown): string | undefined {
  if (typeof nodeId !== "string" || !nodeId.startsWith("node:")) return undefined;
  const id = decodeURIComponent(nodeId.split(":")[1] ?? "");
  return id === "main" ? undefined : id;
}
