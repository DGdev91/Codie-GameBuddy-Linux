// The voice language: what Codie says on its own (reminders, the agent's
// proposals) is in it. Task answers are not: the agent writes those in the
// language the user spoke to the device.

export const systemLocale = () => Intl.DateTimeFormat().resolvedOptions().locale;

// A BCP 47 tag in canonical form, or null ('system' is the setting's own value).
export function canonicalLanguage(tag) {
  if (typeof tag !== 'string' || !tag.trim() || tag === 'system') return null;
  try {
    return Intl.getCanonicalLocales(tag.trim())[0] ?? null;
  } catch {
    return null;
  }
}

// settings.json `voiceLanguage`: 'system' (or absent) follows the computer.
export function resolveVoiceLanguage(setting, system = systemLocale()) {
  return canonicalLanguage(setting) ?? canonicalLanguage(system) ?? 'en';
}

// Why a turn ended on an API error, by the StopFailure hook's `error`.
const FAILURE_KIND = {
  rate_limit: 'limit', overloaded: 'busy',
  authentication_failed: 'auth', oauth_org_not_allowed: 'auth', cloud_credential_error: 'auth',
  billing_error: 'account', account_on_hold: 'account',
};
export const failureKind = error => FAILURE_KIND[error] ?? 'error';

// The fixed sentences agentd speaks itself: Chinese for zh-*, else English.
const SENTENCES = {
  en: {
    reminder: host => `${host} on the computer needs you to take a look.`,
    approval: (host, action) => `${host} on the computer needs your approval: ${action}`,
    failed: (host, kind) => `${host} on the computer stopped: ${{
      limit: 'it reached its usage limit', busy: 'the AI service is overloaded', auth: 'it is not signed in',
      account: 'there is a problem with the account', error: 'the AI service returned an error',
    }[kind]}. Please try again later.`,
  },
  zh: {
    reminder: host => `电脑上的 ${host} 需要你过去看一下。`,
    approval: (host, action) => `电脑上的 ${host} 需要你批准：${action}`,
    failed: (host, kind) => `电脑上的 ${host} 停下了：${{
      limit: '用量到上限了', busy: 'AI 服务太忙', auth: '没有登录', account: '账户有问题', error: 'AI 服务出错了',
    }[kind]}。请稍后再试。`,
  },
};

export const sentences = language => SENTENCES[new Intl.Locale(language).language] ?? SENTENCES.en;

// "Chinese (China), zh-CN": the agent reads it, so in English.
export function languageName(language) {
  let name = language;
  try { name = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(language) ?? language; } catch { /* keep the tag */ }
  return name === language ? language : `${name}, ${language}`;
}

// The line a session adds to its MCP instructions, which the agent reads once
// at the MCP handshake.
export const voiceLanguageLine = language => `The Codie voice language is ${languageName(language)}: write codie_notify messages in it.`;
