import { pageStateSource } from "./page-state.ts";
export function domSnapshotExpression() {
  return `(() => {
    ${pageStateSource()}
    const previousNodeMap = agentState.nodes;
    const selectorFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
        let part = node.localName;
        if (!part) break;
        if (node.classList.length) part += '.' + [...node.classList].slice(0, 3).map((name) => CSS.escape(name)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        if (parts.length >= 5) break;
      }
      return parts.join(' > ');
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const nameFor = (element) => element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.labels?.[0]?.innerText || '';
    const snapshotRoot = agentDialogRoot() || document;
    const nodes = [...snapshotRoot.querySelectorAll('a,button,input,textarea,select,[role],[tabindex],summary,label,[contenteditable],details,option')]
      .filter(visible)
      .slice(0, 500)
      .map((element) => {
        const id = agentNodeId(element);
        const rect = element.getBoundingClientRect();
        const sensitive = element.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]');
        const text = (element.innerText || (sensitive ? '' : element.value) || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
        return {
          node_id: id, frameId: agentFrameId,
          tagName: element.localName,
          role: element.getAttribute('role'),
          ariaName: nameFor(element) || null,
          text,
          type: element.getAttribute('type'),
          selector: selectorFor(element),
          boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        };
      });
    return { observation: agentObservation(snapshotRoot === document ? 'page' : 'focused'), url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, nodes };
  })()`;
}

export interface PageSearchOptions {
  maxUnits?: number;
  scope?: "auto" | "page" | "viewport" | "focused";
  selector?: string;
  containerNodeId?: string;
  clip?: { x: number; y: number; width: number; height: number };
}
export function pageSearchUnitsExpression(options: PageSearchOptions = {}) {
  const maxUnits = options.maxUnits !== undefined && Number.isInteger(options.maxUnits) && options.maxUnits > 0 ? Math.min(options.maxUnits, 1500) : 700;
  const scope = options.scope !== undefined && ["auto", "page", "viewport", "focused"].includes(options.scope) ? options.scope : "auto";
  const rootSelector = typeof options.selector === "string" && options.selector.length > 0 ? options.selector : null;
  const containerNodeId = typeof options.containerNodeId === "string" && options.containerNodeId.length > 0 ? options.containerNodeId : null;
  const clip = options.clip && Number.isFinite(options.clip.x) && Number.isFinite(options.clip.y) && Number.isFinite(options.clip.width) && Number.isFinite(options.clip.height)
    ? {
        x: Math.round(options.clip.x),
        y: Math.round(options.clip.y),
        width: Math.max(1, Math.round(options.clip.width)),
        height: Math.max(1, Math.round(options.clip.height)),
      }
    : null;
  return `(() => {
    ${pageStateSource()}
    const previousNodeMap = agentState.nodes;
    const maxUnits = ${JSON.stringify(maxUnits)};
    const requestedScope = ${JSON.stringify(scope)};
    const requestedSelector = ${JSON.stringify(rootSelector)};
    const requestedContainerNodeId = ${JSON.stringify(containerNodeId)};
    const requestedClip = ${JSON.stringify(clip)};
    const compact = (value, max = 500) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const textOf = (element, max = 500) => compact(element.innerText || (element.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]') ? '' : element.value) || element.textContent || '', max);
    const textById = (id) => id ? compact((document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ''), 180) : '';
    const visible = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      for (const rect of element.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) return true;
      }
      return false;
    };
    const boxFor = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const inViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const intersectsClip = (element) => {
      if (!requestedClip) return true;
      const rect = element.getBoundingClientRect();
      const left = Math.max(rect.left, requestedClip.x);
      const top = Math.max(rect.top, requestedClip.y);
      const right = Math.min(rect.right, requestedClip.x + requestedClip.width);
      const bottom = Math.min(rect.bottom, requestedClip.y + requestedClip.height);
      return right > left && bottom > top;
    };
    const selectorFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
        let part = node.localName;
        if (!part) break;
        const role = node.getAttribute('role');
        if (role && parts.length === 0) part += '[role="' + CSS.escape(role) + '"]';
        if (node.classList.length) part += '.' + [...node.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        if (parts.length >= 4) break;
      }
      return parts.join(' > ');
    };
    const nameFor = (element) => {
      const labelledBy = compact(String(element.getAttribute('aria-labelledby') || '').split(/\\s+/).map(textById).filter(Boolean).join(' '), 180);
      return compact(element.getAttribute('aria-label') || labelledBy || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.labels?.[0]?.innerText || '', 180);
    };
    const kindFor = (element) => {
      const tag = element.localName;
      const role = element.getAttribute('role');
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'a') return 'link';
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable) return 'field';
      if (tag === 'option') return 'option';
      if (tag === 'form') return 'form';
      if (tag === 'main' || tag === 'section' || tag === 'article' || tag === 'nav' || tag === 'aside' || role === 'region') return 'region';
      if (element.hasAttribute('aria-live') || role === 'status' || role === 'alert') return 'status';
      return role || 'element';
    };
    const interactive = (element) => element.matches('a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="combobox"],[tabindex],summary,label,[contenteditable],option');
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter(visible)
      .map((element) => ({ element, level: Number(element.localName.slice(1)), text: textOf(element, 120) }))
      .filter((heading) => heading.text);
    const headingPathFor = (element) => {
      const stack = [];
      for (const heading of headings) {
        if (!(heading.element.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        stack[heading.level - 1] = heading.text;
        stack.length = heading.level;
      }
      return stack.filter(Boolean).slice(-4);
    };
    const landmarkFor = (element) => {
      const landmark = element.closest('main,nav,aside,header,footer,form,dialog,[role="main"],[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],[role="form"],[role="dialog"]');
      if (!landmark) return null;
      return compact(nameFor(landmark) || landmark.getAttribute('role') || landmark.localName, 120) || null;
    };
    const idFor = agentNodeId;
    const focusedRoot = agentDialogRoot;
    const rootForScope = () => {
      if (requestedContainerNodeId) {
        return { root: agentNodeById(requestedContainerNodeId), mode: 'node' };
      }
      if (requestedSelector) {
        const node = agentUnique(requestedSelector);
        if (node) return { root: node, mode: 'selector' };
      }
      if (requestedScope === 'focused' || requestedScope === 'auto') {
        const root = focusedRoot();
        if (root) return { root, mode: 'focused' };
      }
      return { root: document, mode: requestedScope === 'viewport' ? 'viewport' : 'page' };
    };
    const candidateSelector = 'a,button,input,textarea,select,[role],[tabindex],summary,label,[contenteditable],details,option,h1,h2,h3,h4,h5,h6,main,section,article,nav,aside,form,dialog,[aria-live]';
    const priority = (element) => {
      const kind = kindFor(element);
      if (kind === 'form' || kind === 'region') return 4;
      if (kind === 'heading' || kind === 'status') return 3;
      if (interactive(element)) return 2;
      return 1;
    };
    const scopeInfo = rootForScope();
    const queryRoot = scopeInfo.root === document ? document : scopeInfo.root;
    const rawCandidates = queryRoot === document
      ? [...document.querySelectorAll(candidateSelector)]
      : [queryRoot, ...queryRoot.querySelectorAll(candidateSelector)];
    const candidates = [...new Set(rawCandidates)]
      .filter(visible)
      .filter((element) => scopeInfo.mode !== 'viewport' || inViewport(element))
      .filter(intersectsClip)
      .filter((element) => interactive(element) || textOf(element, 240).length > 0)
      .sort((first, second) => {
        const byPriority = priority(second) - priority(first);
        if (byPriority) return byPriority;
return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    const units = candidates.slice(0, maxUnits).map((element) => {
      const rect = element.getBoundingClientRect();
      const type = element.getAttribute('type');
      const unit = {
        node_id: idFor(element), frameId: agentFrameId,
        kind: kindFor(element),
        text: type === 'password' ? '' : textOf(element, interactive(element) ? 240 : 500),
        selector: selectorFor(element),
        boundingBox: boxFor(element),
        inViewport: inViewport(element),
        interactive: interactive(element),
      };
      const role = element.getAttribute('role');
      if (role) unit.role = role;
      const name = nameFor(element);
      if (name) unit.name = name;
      if (type) unit.type = type;
      const placeholder = element.getAttribute('placeholder');
      if (placeholder) unit.placeholder = placeholder;
      const headingPath = headingPathFor(element);
      if (Array.isArray(headingPath) && headingPath.length > 0) unit.headingPath = headingPath;
      const landmark = landmarkFor(element);
      if (landmark) unit.landmark = landmark;
      if (Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true') unit.disabled = true;
      return unit;
    });
    const scopeBox = scopeInfo.root && scopeInfo.root !== document ? boxFor(scopeInfo.root) : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    let stateHash = 2166136261;
    for (const character of (document.body?.innerText ?? '').slice(0, 32000)) stateHash = Math.imul(stateHash ^ character.charCodeAt(0), 16777619);
    return {
      observation: agentObservation(typeof scopeInfo === 'undefined' ? 'page' : scopeInfo.mode),
      url: location.href,
      title: document.title,
      decisionState: JSON.stringify([performance.timeOrigin, location.href, innerWidth, innerHeight, scrollX, scrollY, stateHash]),
      scope: {
        requested: requestedScope,
        mode: scopeInfo.mode,
        ...(requestedSelector ? { selector: requestedSelector } : {}),
        ...(scopeInfo.root && scopeInfo.root !== document ? { node_id: idFor(scopeInfo.root) } : {}),
        boundingBox: scopeBox,
        ...(requestedClip ? { clip: requestedClip } : {}),
      },
      totalCandidates: candidates.length,
      truncated: candidates.length > units.length,
      units,
    };
  })()`;
}
