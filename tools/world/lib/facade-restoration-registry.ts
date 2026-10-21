// Shared source-bound authoring path for full city builds and texture-only repairs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { assertUniversityMaster, restoreUniversityFacade, topeliaRestoration, UNIVERSITY_PAGE } from './facade-restoration.ts';
import { libraryRestoration } from './library-facade-restoration.ts';
import { bankRestoration } from './bank-facade-restoration.ts';
import { kirkkokatuRestoration } from './kirkkokatu-facade-restoration.ts';
import { kirkkokatu12Restoration } from './kirkkokatu12-facade-restoration.ts';
import { rauhankatu19Restoration } from './rauhankatu19-facade-restoration.ts';
import { estatesRestoration } from './estates-facade-restoration.ts';
import { kirkkokatu14Restoration } from './kirkkokatu14-facade-restoration.ts';
import { churchRestoration } from './church-facade-restoration.ts';
import { esplanadiRestoration } from './esplanadi-facade-restoration.ts';
import { finlandiaRestoration } from './finlandia-facade-restoration.ts';
import { runeberg55aRestoration, RUNE_BERG55A_PAGE } from './runeberg55a-facade.ts';
import type { FacadeExternalSourceImage, FacadeRestorationEvidence, FacadeRestorationModule, FacadeSourceImage } from './facade-restoration-types.ts';

const universityRestoration: FacadeRestorationModule = {
  id: 'university-ne-lower-wing', targetPages: [UNIVERSITY_PAGE], sourcePages: [UNIVERSITY_PAGE],
  apply(page, rgba, width, height) {
    if (page !== UNIVERSITY_PAGE) return [];
    return [{ ...restoreUniversityFacade(rgba, width, height), id: this.id, page }];
  }
};
export const facadeRestorationModules: readonly FacadeRestorationModule[] = [universityRestoration, topeliaRestoration, libraryRestoration, bankRestoration, kirkkokatuRestoration, kirkkokatu12Restoration, rauhankatu19Restoration, estatesRestoration, kirkkokatu14Restoration, churchRestoration, esplanadiRestoration, finlandiaRestoration, runeberg55aRestoration];
export const facadeRestorationSourceFiles: readonly string[] = [
  'tools/world/lib/facade-restoration.ts', 'tools/world/lib/facade-restoration-types.ts',
  'tools/world/lib/facade-restoration-registry.ts', 'tools/world/lib/topelia-facade-map.ts',
  'tools/world/lib/library-facade-restoration.ts', 'tools/world/lib/bank-facade-restoration.ts',
  'tools/world/lib/kirkkokatu-facade-restoration.ts', 'content/helsinki/facade-restorations/bank.json',
  'tools/world/lib/kirkkokatu12-facade-restoration.ts', 'tools/world/lib/rauhankatu19-facade-restoration.ts',
  'tools/world/lib/estates-facade-restoration.ts',
  'tools/world/lib/kirkkokatu14-facade-restoration.ts',
  'tools/world/lib/church-facade-restoration.ts',
  'tools/world/lib/esplanadi-facade-restoration.ts',
  'tools/world/lib/finlandia-facade-restoration.ts',
  'tools/world/lib/runeberg55a-facade.ts',
  'content/assets/facades/esplanadi/source-ledger.json',
  ...facadeRestorationModules.flatMap(m => [...(m.externalSources ?? []).map(s => s.file), ...(m.supportFiles ?? []).map(s => s.file)])
];

export async function createFacadeRestorer(cityDir: string, textures: readonly { file: string; width: number; height: number }[],options?:{newStripOnly:true}) {
  // Expansion appends pages while preserving the original Senate source indices. Keep historical
  // source builds reproducible; an expanded source still has to pass every pinned master hash.
  const modules = (options?.newStripOnly?[]:facadeRestorationModules).filter(module =>
    (module !== esplanadiRestoration || textures.length >= 702) &&
    (module !== finlandiaRestoration || textures.length >= 1019) &&
    (module !== runeberg55aRestoration || textures.length > RUNE_BERG55A_PAGE));
  const sources = new Map<number, FacadeSourceImage>();
  const externalSources = new Map<string, FacadeExternalSourceImage>();
  const inputs: { page: number; file: string; pngSha256: string }[] = [];
  const externalInputs: { id: string; file: string; sha256: string; width: number; height: number }[] = [];
  const supportInputs: { file: string; sha256: string }[] = [];
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  for (const module of modules) {
    for (const input of module.supportFiles ?? []) {
      if (supportInputs.some(s => s.file === input.file && s.sha256 === input.sha256)) continue;
      if (sha(readFileSync(input.file)) !== input.sha256) throw new Error(`curated facade support file changed: ${input.file}`);
      supportInputs.push(input);
    }
    for (const input of module.externalSources ?? []) {
      const previous = externalInputs.find(s => s.id === input.id);
      if (previous) {
        if (previous.file !== input.file || previous.sha256 !== input.sha256) throw new Error(`conflicting external facade source id: ${input.id}`);
        continue;
      }
      const bytes = readFileSync(input.file);
      if (sha(bytes) !== input.sha256) throw new Error(`curated external facade source changed: ${input.id}`);
      const image = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      externalSources.set(input.id, { width: image.info.width, height: image.info.height, data: image.data, sha256: input.sha256 });
      externalInputs.push({ ...input, width: image.info.width, height: image.info.height });
    }
  }
  for (const page of new Set(modules.flatMap(m => [...m.sourcePages]))) {
    const texture = textures[page]; if (!texture) throw new Error(`curated facade page${page} is absent`);
    const bytes = readFileSync(path.join(cityDir, texture.file));
    if (page === UNIVERSITY_PAGE) assertUniversityMaster(bytes);
    const image = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (image.info.width !== texture.width || image.info.height !== texture.height) throw new Error(`curated facade page${page} dimensions differ from city model`);
    const pngSha256 = createHash('sha256').update(bytes).digest('hex');
    sources.set(page, { width: image.info.width, height: image.info.height, data: image.data, pngSha256 });
    inputs.push({ page, file: texture.file, pngSha256 });
  }
  return {
    inputs,
    externalInputs,
    supportInputs,
    modules: modules.map(m => ({ id: m.id, targetPages: m.targetPages, sourcePages: m.sourcePages, externalSources: m.externalSources, supportFiles: m.supportFiles })),
    apply(page: number, rgba: Uint8Array, width: number, height: number, options: { excludeModuleIds?: readonly string[] } = {}): FacadeRestorationEvidence[] {
      // A texture-only repair must reproduce the frozen atlas before enabling its new modules.
      // Ordinary/full builds retain every registered restoration; exclusion is explicit and validated.
      for (const id of options.excludeModuleIds ?? []) if (!modules.some(m => m.id === id)) throw new Error(`unknown excluded facade restoration: ${id}`);
      return modules.filter(m => m.targetPages.includes(page) && !options.excludeModuleIds?.includes(m.id)).flatMap(m => m.apply(page, rgba, width, height, sources, externalSources));
    }
  };
}
