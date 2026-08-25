// Decides whether a controlled-tab operation may steal tab activation or
// window focus. Background automation must never activate the tab or bring
// its window forward, so the default is fully passive. Activation is only
// granted when a caller explicitly requests it.
export function resolveTabActivation(params = {}) {
  const foreground = params.foreground === true;
  const active = params.active === true || foreground;
  return { active, foreground };
}