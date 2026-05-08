const ROOT_ID = "opencode-agent-cursor-root";

function ensureCursor() {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;

  root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText = [
    "position: fixed",
    "left: 0",
    "top: 0",
    "width: 18px",
    "height: 18px",
    "z-index: 2147483647",
    "pointer-events: none",
    "transform: translate(-100px, -100px)",
    "transition: transform 120ms ease-out, opacity 120ms ease-out",
    "opacity: 0",
  ].join(";");

  root.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 1.5L15.5 8L9.8 10.1L7.4 16L2 1.5Z" fill="#10A37F" stroke="white" stroke-width="1.5"/>
    </svg>
  `;
  document.documentElement.appendChild(root);
  return root;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OPENCODE_CURSOR_STATE") return false;
  const cursor = ensureCursor();
  cursor.style.opacity = message.visible === false ? "0" : "1";
  cursor.style.transform = `translate(${Math.round(message.x)}px, ${Math.round(message.y)}px)`;
  sendResponse({ ok: true });
  return true;
});
