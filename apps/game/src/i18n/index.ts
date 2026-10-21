import { catalogs, english, type Language, type MessageKey } from './catalog.ts';

export type { Language, MessageKey } from './catalog.ts';
export const LANGUAGE_STORAGE_KEY = 'helsinki-rides:language';
type LanguageStorage = Pick<Storage, 'getItem' | 'setItem'>;
type ParametersOf<T extends string> = T extends `${string}{${infer Name}}${infer Rest}` ? Name | ParametersOf<Rest> : never;
type MessageArgs<Key extends MessageKey> = [ParametersOf<typeof english[Key]>] extends [never]
  ? [] : [values: Record<ParametersOf<typeof english[Key]>, string | number>];

const isLanguage = (value: unknown): value is Language => value === 'en' || value === 'fi';
export const isMessageKey = (value: string): value is MessageKey => Object.hasOwn(english, value);

function browserStorage(): LanguageStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** English remains the default. Browser preferences never silently change the player's chosen language. */
export function savedLanguage(storage: LanguageStorage | undefined = browserStorage()): Language {
  try { const value = storage?.getItem(LANGUAGE_STORAGE_KEY); return isLanguage(value) ? value : 'en'; }
  catch { return 'en'; }
}

export function formatTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing translation parameter: ${name}`);
    // One pass: values containing braces remain literal text, never another template or HTML.
    return String(values[name]);
  });
}

export class I18n {
  private readonly storage: LanguageStorage | undefined;
  private current: Language;
  private readonly listeners = new Set<() => void>();
  private numberFormat: Intl.NumberFormat;

  constructor(storage: LanguageStorage | undefined = browserStorage()) {
    this.storage = storage;
    this.current = savedLanguage(storage);
    this.numberFormat = this.makeNumberFormat();
  }

  get language(): Language { return this.current; }

  setLanguage(value: Language): void {
    if (!isLanguage(value)) return;
    // The in-memory choice works even when private browsing or a storage policy rejects writes.
    try { this.storage?.setItem(LANGUAGE_STORAGE_KEY, value); } catch { /* Keep this visit's selection. */ }
    if (value === this.current) return;
    this.current = value;
    this.numberFormat = this.makeNumberFormat();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  template(key: MessageKey): string { return catalogs[this.current][key]; }

  text<Key extends MessageKey>(key: Key, ...args: MessageArgs<Key>): string {
    return formatTemplate(this.template(key), args[0] ?? {});
  }

  number(value: number, fractionDigits = 0): string {
    return fractionDigits === 0 ? this.numberFormat.format(value)
      : new Intl.NumberFormat(this.current === 'fi' ? 'fi-FI' : 'en-GB', {
        useGrouping: false, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
      }).format(value);
  }

  private makeNumberFormat(): Intl.NumberFormat {
    return new Intl.NumberFormat(this.current === 'fi' ? 'fi-FI' : 'en-GB', { useGrouping: false, maximumFractionDigits: 0 });
  }
}

export const i18n = new I18n();

const placeKeys = new Map<string, MessageKey>(Object.entries(english)
  .filter(([key]) => key.startsWith('place.')).map(([key, value]) => [value, key as MessageKey]));

/** World labels remain stable values for drop-ins/replays; only the displayed label changes. */
export function placeLabel(label: string, language: I18n = i18n): string {
  const key = placeKeys.get(label);
  return key ? language.template(key) : label;
}

/** Existing loader callbacks are shared by review tooling, so keep their protocol labels unchanged. */
export function progressLabel(label: string, language: I18n = i18n): string {
  const keys: Readonly<Record<string, MessageKey>> = {
    terrain: 'loading.terrain', roads: 'loading.roads', gameplay: 'loading.gameplay', scenery: 'loading.scenery',
    'hero assets': 'loading.hero', 'nearby streets': 'loading.streets', 'nearby buildings': 'loading.buildings',
  };
  const key = Object.hasOwn(keys, label) ? keys[label] : undefined;
  if (key) return language.template(key);
  if (label.startsWith('collision ')) return language.text('loading.collision');
  if (label.startsWith('cell ')) return language.text('loading.cell');
  return language.text('loading.world');
}
