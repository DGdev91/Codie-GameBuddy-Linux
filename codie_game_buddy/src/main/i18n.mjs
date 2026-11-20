import en from '../locales/en.json' with { type: 'json' };
import zhCN from '../locales/zh-CN.json' with { type: 'json' };
import { translator } from '../shared/translate.mjs';

// UI language (spec §4.3): the `language` setting, where "system" follows
// the app locale (Windows display language, or Electron's --lang).

export const LANGUAGES = Object.freeze(['system', 'en', 'zh-CN']);
export const MESSAGES = Object.freeze({ en, 'zh-CN': zhCN });

// Only Simplified Chinese is translated, so every Chinese locale gets it.
export function resolveLocale(language, appLocale) {
  if (language !== 'system') return language;
  return /^zh\b/i.test(appLocale) ? 'zh-CN' : 'en';
}

export const translatorFor = locale => translator(MESSAGES[locale]);
