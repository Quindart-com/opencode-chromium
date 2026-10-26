import { interactionHelpersSource } from "./interaction-helpers.ts";

export function focusExpression(target: { nodeId?: string; selector?: string }) {
  return `(() => { ${interactionHelpersSource()} return prepareFocus(${target.nodeId ? `nodeByIdStrict(${JSON.stringify(target.nodeId)})` : `querySelectorStrict(${JSON.stringify(target.selector)})`}); })()`;
}

export function selectionSnapshotExpression(verify = false) {
  return `(() => {
    ${interactionHelpersSource()}
    const element = focusedEditableElement(false);
    if (element) {
      const snapshot = editableSnapshot(element, editableKind(element));
      if (${verify} && ['input', 'textarea'].includes(snapshot.kind) && (snapshot.selectionStart !== 0 || snapshot.selectionEnd !== snapshot.value.length)) agentFail('INPUT_VERIFICATION_FAILED', 'Select-all did not select the editable value.');
      return snapshot;
    }
    const selectedText = String(window.getSelection() || '');
    if (${verify} && document.body?.innerText.trim() && !selectedText) agentFail('INPUT_VERIFICATION_FAILED', 'Select-all did not select page text.');
    return { kind: 'document', selectedLength: selectedText.length, verified: ${verify} };
  })()`;
}
