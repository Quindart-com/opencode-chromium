export type InspectionOptions = { maxResults?: number; scope?: string; selector?: string; nodeId?: string; query?: string; detail?: string; clip?: { x: number; y: number; width: number; height: number }; tabId?: number; depth?: number; maxChildren?: number; maxText?: number };
export function visualMapExpression(options: InspectionOptions = {}) {
  const maxResults = options.maxResults !== undefined && Number.isInteger(options.maxResults) && options.maxResults > 0 ? Math.min(options.maxResults, 250) : 80;
  const scope = ["auto", "page", "viewport", "focused"].includes(options.scope ?? "") ? options.scope : "auto";
  const rootSelector = typeof options.selector === "string" && options.selector.length > 0 ? options.selector : null;
  const containerNodeId = typeof options.nodeId === "string" && options.nodeId.length > 0 ? options.nodeId : null;
  const query = typeof options.query === "string" && options.query.length > 0 ? options.query : "";
  const detail = options.detail === "debug" ? "debug" : "lean";
  const clip = options.clip && Number.isFinite(options.clip.x) && Number.isFinite(options.clip.y) && Number.isFinite(options.clip.width) && Number.isFinite(options.clip.height)
    ? {
        x: Math.round(options.clip.x),
        y: Math.round(options.clip.y),
        width: Math.max(1, Math.round(options.clip.width)),
        height: Math.max(1, Math.round(options.clip.height)),
      }
    : null;
  return `(() => {
    const previousNodeMap = window.__agentBrowserDomNodeMap instanceof Map ? window.__agentBrowserDomNodeMap : null;
    window.__agentBrowserDomNodeMap = new Map();
    window.__agentBrowserDomNextNodeId = 1;
    const maxResults = ${JSON.stringify(maxResults)};
    const requestedScope = ${JSON.stringify(scope)};
    const requestedSelector = ${JSON.stringify(rootSelector)};
    const requestedNodeId = ${JSON.stringify(containerNodeId)};
    const requestedQuery = ${JSON.stringify(query)};
    const requestedDetail = ${JSON.stringify(detail)};
    const requestedClip = ${JSON.stringify(clip)};
    const compact = (value, max = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const textOf = (element, max = 240) => compact(element.innerText || (element.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]') ? '' : element.value) || element.textContent || '', max);
    const textById = (id) => id ? compact((document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ''), 180) : '';
    const visible = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      for (const rect of element.getClientRects()) {
        if (rect.width > 1 && rect.height > 1) return true;
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
      const type = String(element.getAttribute('type') || '').toLowerCase();
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'a' || role === 'link') return 'link';
      if (tag === 'input' && (type === 'checkbox' || role === 'checkbox')) return 'checkbox';
      if (tag === 'input' && (type === 'radio' || role === 'radio')) return 'radio';
      if (role === 'switch') return 'switch';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || role === 'textbox' || element.isContentEditable) return 'field';
      if (role === 'menuitem') return 'menuitem';
      if (role === 'tab') return 'tab';
      if (tag === 'dialog' || role === 'dialog') return 'dialog';
      if (tag === 'form' || role === 'form') return 'form';
      if (tag === 'label') return 'label';
      if (tag === 'summary') return 'summary';
      if (tag === 'svg') return 'icon';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return role || tag || 'element';
    };
    const interactive = (element) => element.matches('a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="combobox"],[role="tab"],[tabindex],summary,label,[contenteditable],option');
    const idFor = (element) => {
      for (const [id, mapped] of window.__agentBrowserDomNodeMap) {
        if (mapped === element) return id;
      }
      const id = 'node-' + window.__agentBrowserDomNextNodeId++;
      window.__agentBrowserDomNodeMap.set(id, element);
      return id;
    };
    const focusedRoot = () => {
      const modalSelector = 'dialog[open],[role="dialog"],[aria-modal="true"],[popover]:popover-open,.modal,.popover,.dialog';
      const candidates = [...document.querySelectorAll(modalSelector)]
        .filter(visible)
        .filter(inViewport)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const zIndex = Number.parseInt(style.zIndex, 10);
          return { element, area: Math.max(0, rect.width * rect.height), zIndex: Number.isFinite(zIndex) ? zIndex : 0 };
        })
        .filter((item) => item.area > 0)
        .sort((first, second) => second.zIndex - first.zIndex || second.area - first.area);
      return candidates[0]?.element ?? null;
    };
    const rootForScope = () => {
      if (requestedNodeId && previousNodeMap?.has(requestedNodeId)) {
        const node = previousNodeMap.get(requestedNodeId);
        if (node?.isConnected) return { root: node, mode: 'node' };
      }
      if (requestedSelector) {
        const node = document.querySelector(requestedSelector);
        if (node) return { root: node, mode: 'selector' };
      }
      if (requestedScope === 'focused' || requestedScope === 'auto') {
        const root = focusedRoot();
        if (root) return { root, mode: 'focused' };
      }
      return { root: document, mode: requestedScope === 'viewport' ? 'viewport' : 'page' };
    };
    const lexicalScore = (value) => {
      const query = compact(requestedQuery, 240).toLowerCase();
      if (!query) return 0;
      const text = compact(value, 500).toLowerCase();
      const tokens = [...new Set(query.match(/[a-z0-9]{2,}/g) || [])];
      if (!tokens.length) return text.includes(query) ? 1 : 0;
      const matches = tokens.filter((token) => text.includes(token)).length;
      return (text.includes(query) ? 0.45 : 0) + matches / tokens.length * 0.55;
    };
    const coveredAtCenter = (element) => {
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, Math.floor(rect.left + rect.width / 2)));
      const y = Math.max(0, Math.min(innerHeight - 1, Math.floor(rect.top + rect.height / 2)));
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && hit !== element && !element.contains(hit));
    };
    const candidateSelector = 'a,button,input,textarea,select,[role],[tabindex],summary,label,[contenteditable],details,option,svg,[aria-label],[title],dialog,form,h1,h2,h3,h4,h5,h6';
    const scopeInfo = rootForScope();
    const queryRoot = scopeInfo.root === document ? document : scopeInfo.root;
    const rawCandidates = queryRoot === document
      ? [...document.querySelectorAll(candidateSelector)]
      : [queryRoot, ...queryRoot.querySelectorAll(candidateSelector)];
    const candidates = [...new Set(rawCandidates)]
      .filter(visible)
      .filter((element) => scopeInfo.mode !== 'viewport' || inViewport(element))
      .filter(intersectsClip)
      .filter((element) => interactive(element) || nameFor(element) || textOf(element, 80))
      .map((element) => {
        const label = nameFor(element) || textOf(element, 160) || kindFor(element);
        const searchText = [kindFor(element), element.getAttribute('role'), label, textOf(element, 220), selectorFor(element)].filter(Boolean).join(' ');
        const score = lexicalScore(searchText);
        return { element, label, score, interactive: interactive(element) };
      })
      .sort((first, second) => {
        if (requestedQuery && second.score !== first.score) return second.score - first.score;
        if (second.interactive !== first.interactive) return Number(second.interactive) - Number(first.interactive);
        return first.element.compareDocumentPosition(second.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    const elements = candidates.slice(0, maxResults).map((item) => {
      const element = item.element;
      const base = {
        node_id: idFor(element),
        kind: kindFor(element),
        label: item.label || null,
        box: boxFor(element),
        source: 'dom',
      };
      if (requestedDetail !== 'debug') return base;
      return {
        ...base,
        tagName: element.localName,
        role: element.getAttribute('role'),
        selector: selectorFor(element),
        text: textOf(element, 240) || null,
        interactive: item.interactive,
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        covered: coveredAtCenter(element),
        score: Number(item.score.toFixed(4)),
      };
    });
    const scopeBox = scopeInfo.root && scopeInfo.root !== document ? boxFor(scopeInfo.root) : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    return {
url: location.href,
      title: document.title,
      query: requestedQuery || null,
      scope: {
        requested: requestedScope,
        mode: scopeInfo.mode,
        ...(requestedSelector ? { selector: requestedSelector } : {}),
        ...(scopeInfo.root && scopeInfo.root !== document ? { node_id: idFor(scopeInfo.root) } : {}),
        boundingBox: scopeBox,
        ...(requestedClip ? { clip: requestedClip } : {}),
      },
      totalCandidates: candidates.length,
      returned: elements.length,
      truncated: candidates.length > elements.length,
      elements,
    };
  })()`;
}

export function pageInspectExpression(options: InspectionOptions = {}) {
  const nodeId = typeof options.nodeId === "string" && options.nodeId.length > 0 ? options.nodeId : null;
  const selector = typeof options.selector === "string" && options.selector.length > 0 ? options.selector : null;
  const detail = options.detail === "debug" || options.detail === "full" ? "debug" : "lean";
  const depth = options.depth !== undefined && Number.isInteger(options.depth) && options.depth >= 0 ? Math.min(options.depth, 4) : 2;
  const maxChildren = options.maxChildren !== undefined && Number.isInteger(options.maxChildren) && options.maxChildren > 0 ? Math.min(options.maxChildren, 80) : 30;
  const maxText = options.maxText !== undefined && Number.isInteger(options.maxText) && options.maxText > 0 ? Math.min(options.maxText, 2000) : 700;
  return `(() => {
    if (!window.__agentBrowserDomNodeMap) window.__agentBrowserDomNodeMap = new Map();
    if (!window.__agentBrowserDomNextNodeId) window.__agentBrowserDomNextNodeId = 1;
    const requestedNodeId = ${JSON.stringify(nodeId)};
    const requestedSelector = ${JSON.stringify(selector)};
    const requestedDetail = ${JSON.stringify(detail)};
    const maxDepth = ${JSON.stringify(depth)};
    const maxChildren = ${JSON.stringify(maxChildren)};
    const maxText = ${JSON.stringify(maxText)};
    const compact = (value, max = 500) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const textOf = (element, max = maxText) => compact(element.innerText || (element.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]') ? '' : element.value) || element.textContent || '', max);
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
        if (parts.length >= 5) break;
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
    const idFor = (element) => {
      for (const [id, mapped] of window.__agentBrowserDomNodeMap) {
        if (mapped === element) return id;
      }
      const id = 'node-' + window.__agentBrowserDomNextNodeId++;
      window.__agentBrowserDomNodeMap.set(id, element);
      return id;
    };
    const boxFor = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const styleFor = (element) => {
      const style = getComputedStyle(element);
      return {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        font: compact([style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].filter(Boolean).join(' '), 160),
        border: compact(style.border, 160),
        borderRadius: style.borderRadius,
        padding: style.padding,
        margin: style.margin,
        cursor: style.cursor,
        opacity: style.opacity,
zIndex: style.zIndex,
      };
    };
    const summaryFor = (element, textMax = 220) => {
      const type = element.getAttribute('type');
      const summary = {
        node_id: idFor(element),
        kind: kindFor(element),
        text: type === 'password' ? '' : textOf(element, textMax),
        selector: selectorFor(element),
        boundingBox: boxFor(element),
        inViewport: (() => { const rect = element.getBoundingClientRect(); return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth; })(),
        interactive: interactive(element),
      };
      const role = element.getAttribute('role');
      if (role) summary.role = role;
      const name = nameFor(element);
      if (name) summary.name = name;
      if (type) summary.type = type;
      const placeholder = element.getAttribute('placeholder');
      if (placeholder) summary.placeholder = placeholder;
      if (Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true') summary.disabled = true;
      return summary;
    };
    const childTree = (element, level = 0) => {
      if (level >= maxDepth) return [];
      return [...element.children]
        .filter(visible)
        .slice(0, maxChildren)
        .map((child) => ({
          ...summaryFor(child, 180),
          children: childTree(child, level + 1),
        }));
    };
    const target = requestedNodeId
      ? window.__agentBrowserDomNodeMap.get(requestedNodeId)
      : requestedSelector
        ? document.querySelector(requestedSelector)
        : null;
if (!target) throw new Error(requestedNodeId ? 'DOM node ID not found in current page map: ' + requestedNodeId : 'Selector not found: ' + requestedSelector);
    const contextRoot = target.closest('main,section,article,form,dialog,nav,aside,[role="main"],[role="region"],[role="dialog"],[role="form"]') || target.parentElement || target;
    const ancestors = [];
    for (let node = target.parentElement; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
      ancestors.unshift(summaryFor(node, 80));
      if (ancestors.length >= 5) break;
    }
    const siblings = target.parentElement
      ? [...target.parentElement.children].filter((child) => child !== target && visible(child)).slice(0, 12).map((child) => summaryFor(child, 180))
      : [];
    const nearbyInteractives = [...contextRoot.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[tabindex],summary,label,[contenteditable]')]
      .filter((element) => element !== target && visible(element))
      .slice(0, 20)
      .map((element) => summaryFor(element, 180));
    return {
      url: location.href,
      title: document.title,
      requested: { nodeId: requestedNodeId, selector: requestedSelector },
      target: requestedDetail === 'debug'
        ? { ...summaryFor(target, maxText), styles: styleFor(target), html: compact(target.outerHTML, 1600) }
        : summaryFor(target, maxText),
      contextRoot: summaryFor(contextRoot, 160),
      ancestors,
      siblings,
      nearbyInteractives,
      children: childTree(target),
    };
  })()`;
}
