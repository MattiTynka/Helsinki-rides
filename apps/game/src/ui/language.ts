import { i18n, isMessageKey, type MessageKey } from '../i18n/index.ts';

/** Reuse trusted, authored links without parsing translated strings as markup or replacing their listeners. */
function translateRich(element: HTMLElement, key: MessageKey): void {
  const slots = new Map(Array.from(element.querySelectorAll<HTMLElement>('[data-i18n-slot]'))
    .map(node => [node.dataset.i18nSlot!, node]));
  const template = i18n.template(key);
  const nodes: Node[] = [];
  let offset = 0;
  for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
    const node = slots.get(match[1]!);
    if (!node) throw new Error(`Missing translation link slot: ${key}.${match[1]}`);
    nodes.push(document.createTextNode(template.slice(offset, match.index)), node);
    offset = match.index! + match[0].length;
  }
  nodes.push(document.createTextNode(template.slice(offset)));
  element.replaceChildren(...nodes);
}

export function installLanguageChoice(): void {
  const group = document.getElementById('language-choice');
  const update = (): void => {
    document.documentElement.lang = i18n.language;
    document.title = i18n.text('page.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', i18n.text('page.description'));
    group?.setAttribute('aria-label', i18n.text('language.label'));
    for (const button of group?.querySelectorAll<HTMLButtonElement>('[data-language]') ?? []) {
      button.setAttribute('aria-pressed', String(button.dataset.language === i18n.language));
    }
    for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = node.dataset.i18n!;
      if (!isMessageKey(key)) throw new Error(`Unknown translation key: ${key}`);
      node.textContent = i18n.template(key);
    }
    for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
      const key = node.dataset.i18nTitle!;
      if (!isMessageKey(key)) throw new Error(`Unknown translation key: ${key}`);
      node.title = i18n.template(key);
    }
    for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-rich]')) {
      const key = node.dataset.i18nRich!;
      if (!isMessageKey(key)) throw new Error(`Unknown translation key: ${key}`);
      translateRich(node, key);
    }
  };
  for (const button of group?.querySelectorAll<HTMLButtonElement>('[data-language]') ?? []) {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const language = button.dataset.language;
      if (language === 'en' || language === 'fi') i18n.setLanguage(language);
    });
  }
  update();
  i18n.subscribe(update);
}
