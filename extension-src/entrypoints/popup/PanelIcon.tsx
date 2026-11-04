// Lucide 0.468.0: layout-grid, users-round, sliders-horizontal, external-link,
// circle-help. ISC license: /images/lucide-LICENSE.txt in the extension bundle.
// https://github.com/lucide-icons/lucide/tree/0.468.0/icons

type IconName = "overview" | "profiles" | "settings" | "external" | "help" | "close" | "collapse" | "move";

const shapes: Record<IconName, React.JSX.Element> = {
  close: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  collapse: <path d="M5 12h14" />,
  move: <><path d="m5 9-3 3 3 3" /><path d="m9 5 3-3 3 3" /><path d="m15 19-3 3-3-3" /><path d="m19 9 3 3-3 3" /><path d="M2 12h20" /><path d="M12 2v20" /></>,
  overview: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>,
  profiles: <><path d="M18 21a8 8 0 0 0-16 0" /><circle cx="10" cy="8" r="5" /><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" /></>,
  settings: <><line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  help: <><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>,
};

export default function PanelIcon({ name }: { name: IconName }): React.JSX.Element {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}
