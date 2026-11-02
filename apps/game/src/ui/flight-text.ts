import { i18n } from '../i18n/index.ts';

const text = {
  en: {
    loading: 'Loading aircraft...', failed: 'Aircraft could not load. Retrying...',
    ascend: 'Climb', descend: 'Descend', airports: 'Airports', malmi: 'Malmi airport',
    enter: 'F | Fly aircraft',
    controls: 'W/S speed | A/D turn | Space climb | Ctrl descend | Shift boost | X hold: return to Malmi',
    touchControls: 'Pedals: speed | Stick: turn | Climb / Descend | Hold Recover: return to Malmi',
    exit: 'F | Leave aircraft', airborne: 'Land and stop before leaving the aircraft',
    blocked: 'Flight held: ground or obstacle ahead', plane: 'Cessna 172', helicopter: 'Mi-17',
  },
  fi: {
    loading: 'Ladataan ilma-aluksia...', failed: 'Ilma-alusten lataus ep\u00e4onnistui. Yritet\u00e4\u00e4n uudelleen...',
    ascend: 'Nouse', descend: 'Laskeudu', airports: 'Lentoasemat', malmi: 'Malmin lentoasema',
    enter: 'F | Ohjaa ilma-alusta',
    controls: 'W/S nopeus | A/D k\u00e4\u00e4nny | V\u00e4lily\u00f6nti nouse | Ctrl laskeudu | Shift tehostus | Pid\u00e4 X: palaa Malmille',
    touchControls: 'Polkimet: nopeus | Sauva: k\u00e4\u00e4nny | Nouse / Laskeudu | Pid\u00e4 Palauta: palaa Malmille',
    exit: 'F | Poistu ilma-aluksesta', airborne: 'Laskeudu ja pys\u00e4hdy ennen poistumista',
    blocked: 'Lento pys\u00e4ytetty: maa tai este edess\u00e4', plane: 'Cessna 172', helicopter: 'Mi-17',
  },
} as const;

export function flightText(key: keyof typeof text.en): string { return text[i18n.language][key]; }
