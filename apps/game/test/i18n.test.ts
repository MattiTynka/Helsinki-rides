import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogs, english, finnish, type MessageKey } from '../src/i18n/catalog.ts';
import { I18n, LANGUAGE_STORAGE_KEY, formatTemplate, isMessageKey, placeLabel, progressLabel, savedLanguage } from '../src/i18n/index.ts';
import { Input } from '../src/input/input.ts';

const parameters = (value: string): string[] => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]!).sort();
const memoryStorage = (initial: string | null = null) => {
  let value = initial;
  return { getItem(key: string) { assert.equal(key, LANGUAGE_STORAGE_KEY); return value; }, setItem(key: string, next: string) { assert.equal(key, LANGUAGE_STORAGE_KEY); value = next; } };
};

test('Finnish catalog covers every English message with the same interpolation parameters', () => {
  assert.deepEqual(Object.keys(finnish).sort(), Object.keys(english).sort());
  for (const key of Object.keys(english) as MessageKey[]) {
    assert.ok(finnish[key].trim(), key);
    assert.deepEqual(parameters(finnish[key]), parameters(english[key]), key);
    for (const language of ['en', 'fi'] as const) assert.doesNotMatch(catalogs[language][key], /<\/?(?:script|iframe|img|a|span)\b/i, key);
  }
});

test('language starts in English, persists explicit selections and ignores invalid stored data', () => {
  for (const initial of [null, '', 'sv', 'FI', 'en<script>', '__proto__']) assert.equal(savedLanguage(memoryStorage(initial)), 'en');
  const storage = memoryStorage();
  const language = new I18n(storage);
  assert.equal(language.language, 'en');
  let changes = 0;
  const unsubscribe = language.subscribe(() => { changes++; });
  language.setLanguage('fi');
  assert.equal(language.text('play.button'), 'Aloita tutkiminen');
  assert.equal(new I18n(storage).language, 'fi');
  language.setLanguage('fi');
  assert.equal(changes, 1);
  unsubscribe(); language.setLanguage('en');
  assert.equal(changes, 1);
  assert.equal(new I18n(storage).language, 'en');
});

test('unavailable storage never blocks choosing Finnish for the current visit', () => {
  const storage = { getItem() { throw new Error('Storage disabled'); }, setItem() { throw new Error('Quota blocked'); } };
  const language = new I18n(storage);
  assert.equal(language.language, 'en');
  assert.doesNotThrow(() => language.setLanguage('fi'));
  assert.equal(language.language, 'fi');
  assert.equal(language.number(12.34, 1), '12,3');
  language.setLanguage('en');
  assert.equal(language.number(12.34, 1), '12.3');
});

test('typed complete-message interpolation treats values as literal text and fails for missing fields', () => {
  const language = new I18n(memoryStorage('fi'));
  assert.equal(language.text('loading.progress', { label: 'kadut', done: 1, total: 3 }), 'Ladataan: kadut (1/3)');
  assert.equal(formatTemplate('{label} {done}', { label: '<img src=x onerror=alert(1)>{done}', done: 3 }), '<img src=x onerror=alert(1)>{done} 3');
  assert.throws(() => formatTemplate('{absent}', {}), /Missing translation parameter: absent/);
  assert.equal(isMessageKey('__proto__'), false);
  assert.equal(isMessageKey('constructor'), false);
});

test('drop-in and respawn names translate for display while addresses and proper names remain stable', () => {
  const language = new I18n(memoryStorage('fi'));
  assert.equal(placeLabel('Senate Square', language), 'Senaatintori');
  assert.equal(placeLabel('Helsinki Cathedral steps', language), 'Helsingin tuomiokirkon portaat');
  assert.equal(placeLabel('Meilahti hospital', language), 'Meilahden sairaala');
  assert.equal(placeLabel('Aleksanterinkatu 16', language), 'Aleksanterinkatu 16');
  assert.equal(placeLabel('Revontuli', language), 'Revontuli');
  language.setLanguage('en');
  assert.equal(placeLabel('Senate Square', language), 'Senate Square');
});

test('all startup progress labels have Finnish display text without leaking technical cell identifiers', () => {
  const language = new I18n(memoryStorage('fi'));
  for (const label of ['terrain', 'roads', 'gameplay', 'scenery', 'hero assets', 'nearby streets', 'nearby buildings', 'collision c_m01_m02', 'cell c_p01_p00']) {
    const translated = progressLabel(label, language);
    assert.notEqual(translated, label);
    assert.doesNotMatch(translated, /c_[mp]\d/);
  }
  assert.equal(progressLabel('__proto__', language), 'kaupunkitiedot');
});

test('authored startup translation bindings and rich-link slots match both catalogs', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/data-i18n(?:-title|-rich)?="([^"]+)"/g)) assert.equal(isMessageKey(match[1]!), true, match[1]);
  for (const match of html.matchAll(/<(?:li|p)[^>]*data-i18n-rich="([^"]+)"[^>]*>(.*?)<\/(?:li|p)>/gs)) {
    const slots = [...match[2]!.matchAll(/data-i18n-slot="([^"]+)"/g)].map(slot => slot[1]!).sort();
    assert.deepEqual(slots, parameters(english[match[1] as MessageKey]), match[1]);
  }
  assert.match(html, /data-language="fi"[^>]*lang="fi"[^>]*aria-pressed="false"/);
  assert.match(html, /data-language="en"[^>]*lang="en"[^>]*aria-pressed="true"/);
  assert.match(html, /id="dropin"[^>]*data-i18n-title="dropin.title"/);
  assert.match(html, /<option value="" data-i18n="dropin.placeholder">/);
});

test('startup keyboard controls retain native Tab and Space behaviour and do not move Finn', () => {
  const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const old = Object.fromEntries(['addEventListener', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const on = (type: string, callback: (event: Record<string, unknown>) => void) => listeners.set(type, [...listeners.get(type) ?? [], callback]);
  const keydown = (code: string) => {
    let prevented = false;
    listeners.get('keydown')?.forEach(callback => callback({ code, repeat: false, preventDefault() { prevented = true; } }));
    return prevented;
  };
  let loadingVisible = true;
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: on });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener: on, getElementById: () => ({ classList: { contains: () => !loadingVisible } }) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [] } });
  try {
    const input = new Input({ addEventListener: on } as unknown as HTMLCanvasElement);
    assert.equal(keydown('Tab'), false);
    assert.equal(keydown('Space'), false);
    assert.equal(keydown('KeyW'), false);
    assert.equal(input.command(0, 0, false).moveZ, 0);
    assert.equal(input.command(0, 0, false).buttons, 0);
    loadingVisible = false;
    assert.equal(keydown('Space'), true);
    assert.notEqual(input.command(0, 0, false).buttons, 0);
  } finally {
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
