export function interactionHelpersSource() {
  return `
    const describeElement = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'none';
      const id = element.id ? '#' + element.id : '';
      const classes = element.classList?.length ? '.' + [...element.classList].slice(0, 3).join('.') : '';
      const text = (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      return '<' + element.localName + id + classes + '>' + (text ? ' "' + text + '"' : '');
    };

    const composedContains = (root, candidate) => {
      for (let node = candidate; node; node = node.parentElement || node.getRootNode?.().host || null) {
        if (node === root) return true;
      }
      return false;
    };

    const querySelectorStrict = (selector) => {
      let element;
      try {
        element = document.querySelector(selector);
      } catch (error) {
        throw new Error('Invalid selector: ' + selector + ': ' + (error && error.message ? error.message : String(error)));
      }
      if (!element) throw new Error('No element matches selector: ' + selector);
      return element;
    };

    const nodeByIdStrict = (nodeId) => {
      const node = window.__agentBrowserDomNodeMap && window.__agentBrowserDomNodeMap.get(nodeId);
      if (!node) throw new Error('Unknown DOM node id. Take a fresh browser_dom_snapshot first.');
      if (!node.isConnected) throw new Error('DOM node is detached. Take a fresh browser_dom_snapshot first.');
      return node;
    };

    const disabledReason = (element) => {
      if (element.disabled === true) return 'element is disabled';
      if (element.getAttribute('aria-disabled') === 'true') return 'element has aria-disabled=true';
      if (element.closest?.('fieldset[disabled]')) return 'element is inside a disabled fieldset';
      return null;
    };

    const editableKind = (element, includeSelect = false) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
      const localName = element.localName;
      if (localName === 'textarea') return element.readOnly || disabledReason(element) ? null : 'textarea';
      if (localName === 'input') {
        const type = String(element.type || 'text').toLowerCase();
        const blocked = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
        if (blocked.has(type) || element.readOnly || disabledReason(element)) return null;
        return 'input';
      }
      if (includeSelect && localName === 'select') return disabledReason(element) ? null : 'select';
      if (element.isContentEditable) return disabledReason(element) ? null : 'contenteditable';
      return null;
    };

    const editableValue = (element, kind) => {
      if (kind === 'input' || kind === 'textarea' || kind === 'select') return String(element.value ?? '');
      return String(element.innerText || element.textContent || '');
    };

    const textHash = (value) => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };

    const editableSnapshot = (element, kind) => {
      const value = editableValue(element, kind);
      const selection = window.getSelection();
      return {
        kind,
        tagName: element.localName,
        type: element.getAttribute('type'),
        value,
        valueHash: textHash(value),
        selectionStart: Number.isFinite(element.selectionStart) ? element.selectionStart : null,
        selectionEnd: Number.isFinite(element.selectionEnd) ? element.selectionEnd : null,
        selectedText: selection && selection.rangeCount ? String(selection.toString()) : '',
      };
    };

    const visibleRect = (element) => {
      if (!element.isConnected) throw new Error('Element is detached: ' + describeElement(element));
      const style = getComputedStyle(element);
      if (style.display === 'none') throw new Error('Element is not visible: display is none: ' + describeElement(element));
      if (style.visibility === 'hidden' || style.visibility === 'collapse') throw new Error('Element is not visible: visibility is ' + style.visibility + ': ' + describeElement(element));
      const virtualEditorInput = element.matches?.('textarea.inputarea, textarea[aria-label*="editor" i]') || Boolean(element.closest?.('.monaco-editor, [data-editor]'));
      if (Number(style.opacity) === 0 && !virtualEditorInput) throw new Error('Element is not visible: opacity is 0: ' + describeElement(element));

      let best = null;
      for (const rect of element.getClientRects()) {
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right);
        const bottom = Math.min(innerHeight, rect.bottom);
        const width = right - left;
        const height = bottom - top;
        if (width <= 0 || height <= 0) continue;
        const area = width * height;
        if (!best || area > best.area) best = { left, top, right, bottom, width, height, area };
      }
      if (!best) throw new Error('Element has no visible viewport area: ' + describeElement(element));
      return best;
    };

    const assertPointerInteractable = (element) => {
      const reason = disabledReason(element);
      if (reason) throw new Error('Element is not interactable: ' + reason + ': ' + describeElement(element));
      const style = getComputedStyle(element);
      if (style.pointerEvents === 'none') throw new Error('Element is not clickable: pointer-events is none: ' + describeElement(element));
    };

    const clickTarget = (element) => {
      assertPointerInteractable(element);
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = visibleRect(element);
      const fractions = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.2], [0.5, 0.8]];
      let coveredBy = null;
      for (const [fx, fy] of fractions) {
        const x = Math.floor(rect.left + Math.max(1, rect.width - 1) * fx);
        const y = Math.floor(rect.top + Math.max(1, rect.height - 1) * fy);
        const hit = document.elementFromPoint(x, y);
        if (hit && composedContains(element, hit)) {
          return { x, y, tagName: element.localName, text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
        }
        coveredBy = hit;
      }
      throw new Error('Element is not clickable: safe click points are covered by ' + describeElement(coveredBy) + ': ' + describeElement(element));
    };

    // Keep ordinary activation inside the page. HTMLElement.click() preserves
    // the historical click behavior without sending a renderer-focusing CDP
    // mouse event through the browser widget.
    const backgroundClick = (element, point, options = {}) => {
      assertPointerInteractable(element);
      const button = options.button || 'left';
      const clickCount = Math.max(1, Math.floor(Number(options.clickCount) || 1));
      const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
      const eventInit = (detail) => ({
        bubbles: true,
        cancelable: true,
        view: window,
        detail,
        screenX: Number(point?.x) || 0,
        screenY: Number(point?.y) || 0,
        clientX: Number(point?.x) || 0,
        clientY: Number(point?.y) || 0,
        button: buttonCode,
        buttons: button === 'right' ? 2 : button === 'middle' ? 4 : 1,
      });

      if (button === 'left') {
        for (let count = 1; count <= clickCount; count += 1) element.click();
        if (clickCount > 1) element.dispatchEvent(new MouseEvent('dblclick', eventInit(clickCount)));
      } else if (button === 'right') {
        element.dispatchEvent(new MouseEvent('contextmenu', eventInit(1)));
      } else {
        element.dispatchEvent(new MouseEvent('auxclick', eventInit(1)));
      }
    };

    const backgroundHover = (element, point) => {
      assertPointerInteractable(element);
      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Number(point?.x) || 0,
        clientY: Number(point?.y) || 0,
        screenX: Number(point?.x) || 0,
        screenY: Number(point?.y) || 0,
        button: 0,
        buttons: 0,
      };
      element.dispatchEvent(new MouseEvent('mouseover', eventInit));
      element.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, bubbles: false }));
      element.dispatchEvent(new MouseEvent('mousemove', eventInit));
    };

    const hoverTarget = (element) => {
      assertPointerInteractable(element);
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = visibleRect(element);
      const x = Math.floor(rect.left + Math.max(1, rect.width - 1) * 0.5);
      const y = Math.floor(rect.top + Math.max(1, rect.height - 1) * 0.5);
      return { x, y, tagName: element.localName, text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
    };

    const focusedEditableElement = (includeSelect = false) => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (editableKind(active, includeSelect)) return active;
      const selection = window.getSelection();
      let node = selection?.anchorNode;
      if (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
      const editable = node?.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
      return editableKind(editable, includeSelect) ? editable : null;
    };

    const selectEditableText = (element, kind) => {
      element.focus({ preventScroll: true });
      if (kind === 'input' || kind === 'textarea') {
        element.select();
        return;
      }
      if (kind === 'contenteditable') {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };

    const placeCursorAtEnd = (element, kind) => {
      element.focus({ preventScroll: true });
      if (kind === 'input' || kind === 'textarea') {
        const length = String(element.value ?? '').length;
        element.setSelectionRange(length, length);
        return;
      }
      if (kind === 'contenteditable') {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };

    const prepareEditable = (element, options = {}) => {
      const kind = editableKind(element, Boolean(options.includeSelect));
      if (!kind) throw new Error('Element is not editable: ' + describeElement(element));
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      visibleRect(element);
      element.focus({ preventScroll: true });
      if (document.activeElement !== element && !composedContains(element, document.activeElement)) {
        throw new Error('Element could not be focused: ' + describeElement(element));
      }
      if (options.selectAll && kind !== 'select') selectEditableText(element, kind);
      if (options.cursorAtEnd && kind !== 'select') placeCursorAtEnd(element, kind);
      return editableSnapshot(element, kind);
    };

    const setFocusedSelectValue = (value) => {
      const element = focusedEditableElement(true);
      const kind = editableKind(element, true);
      if (kind !== 'select') throw new Error('Focused element is not a select element');
      const option = [...element.options].find((item) => item.value === value || item.text.trim() === value);
      if (!option) throw new Error('No select option matches value or text: ' + value);
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return editableSnapshot(element, kind);
    };
  `;
}
