import { browser } from "wxt/browser";

export function t(key: string, substitutions?: string | string[]): string {
  return browser.i18n.getMessage(key as never, substitutions);
}

/** Match the languages actually shipped, including regional fallback for generic locales. */
export function setDocumentLanguage(): void {
  const locale = browser.i18n.getUILanguage().replaceAll("_", "-").toLowerCase();
  const language = locale.split("-")[0];
  document.documentElement.lang = ["es", "fr", "ru"].includes(language ?? "") ? language! :
    locale === "zh-cn" || locale === "zh" ? "zh-CN" :
    locale === "pt-br" ? "pt-BR" : "en";
}
