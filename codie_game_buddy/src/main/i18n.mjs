import en from '../locales/en.json' with { type: 'json' };
import zhCN from '../locales/zh-CN.json' with { type: 'json' };
import { translator } from '../shared/translate.mjs';

// UI language (spec §4.3): the `language` setting, where "system" follows
// the app locale (Windows display language, or Electron's --lang).
// The setting also offers the other languages Codie speaks (GET ai-language):
// chosen, Codie speaks it and the UI is English, or Chinese for zh-TW.

export const LANGUAGES = Object.freeze(['system', 'en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt']);
export const MESSAGES = Object.freeze({ en, 'zh-CN': zhCN });

// Only Simplified Chinese is translated, so every Chinese locale gets it.
export function resolveLocale(language, appLocale) {
  return /^zh\b/i.test(language === 'system' ? appLocale : language) ? 'zh-CN' : 'en';
}

export const translatorFor = locale => translator(MESSAGES[locale]);
