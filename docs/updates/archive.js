// Native details keep keyboard behavior; each card owns its expanded state.
for (const details of document.querySelectorAll('details')) {
  const summary = details.querySelector(':scope > summary');
  if (!summary) continue;
  const update = () => summary.setAttribute('aria-expanded', String(details.open));
  details.addEventListener('toggle', update);
  update();
}
