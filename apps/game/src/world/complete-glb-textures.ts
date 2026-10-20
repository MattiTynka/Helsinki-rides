import type { BufferGeometry, Material, Object3D, Texture } from 'three';
import type { GLTF, GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

type JsonObject = Record<string, unknown>;
type TextureSlots = Readonly<Record<string, readonly string[]>>;

// These are the texture assignments supported by the installed GLTFLoader. An
// unknown texture-bearing extension must be reviewed instead of silently lost.
const CORE_SLOTS: TextureSlots = {
  'pbrMetallicRoughness.baseColorTexture': ['map'],
  'pbrMetallicRoughness.metallicRoughnessTexture': ['metalnessMap', 'roughnessMap'],
  normalTexture: ['normalMap'], occlusionTexture: ['aoMap'], emissiveTexture: ['emissiveMap'],
};
const EXTENSION_SLOTS: TextureSlots = {
  'KHR_materials_clearcoat.clearcoatTexture': ['clearcoatMap'],
  'KHR_materials_clearcoat.clearcoatRoughnessTexture': ['clearcoatRoughnessMap'],
  'KHR_materials_clearcoat.clearcoatNormalTexture': ['clearcoatNormalMap'],
  'KHR_materials_iridescence.iridescenceTexture': ['iridescenceMap'],
  'KHR_materials_iridescence.iridescenceThicknessTexture': ['iridescenceThicknessMap'],
  'KHR_materials_sheen.sheenColorTexture': ['sheenColorMap'],
  'KHR_materials_sheen.sheenRoughnessTexture': ['sheenRoughnessMap'],
  'KHR_materials_transmission.transmissionTexture': ['transmissionMap'],
  'KHR_materials_volume.thicknessTexture': ['thicknessMap'],
  'KHR_materials_specular.specularTexture': ['specularIntensityMap'],
  'KHR_materials_specular.specularColorTexture': ['specularColorMap'],
  'EXT_materials_bump.bumpTexture': ['bumpMap'],
  'KHR_materials_anisotropy.anisotropyTexture': ['anisotropyMap'],
};

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`GLB texture validation: invalid ${label}`);
  return value as JsonObject;
}

function textureDeclarations(value: JsonObject, prefix = ''): [string, unknown][] {
  const declarations: [string, unknown][] = [];
  for (const [name, field] of Object.entries(value)) {
    if (name === 'extras') continue; // application metadata is not a glTF texture declaration
    const path = prefix ? `${prefix}.${name}` : name;
    if (name.endsWith('Texture')) declarations.push([path, field]);
    else if (field && typeof field === 'object' && !Array.isArray(field)) declarations.push(...textureDeclarations(field as JsonObject, path));
  }
  return declarations;
}

/** Three intentionally tolerates failed image requests by returning null. A
 * cell must instead fail as a whole, so the residency manager can retry it. */
function validateTextures(gltf: GLTF, materials: ReadonlySet<Material>, defaultMaterials: ReadonlySet<Material>,
  simpleSources: ReadonlyMap<Material, ReadonlySet<number>>): void {
  const parser = gltf.parser, json = object(parser.json, 'document');
  const definitions = json.materials ?? [], textures = json.textures ?? [];
  if (!Array.isArray(definitions) || !Array.isArray(textures)) throw new Error('GLB texture validation: invalid material/texture tables');
  for (const material of materials) {
    const association = parser.associations.get(material);
    const simpleMaterial = (material as Material & { isLineBasicMaterial?: boolean; isPointsMaterial?: boolean }).isLineBasicMaterial
      || (material as Material & { isPointsMaterial?: boolean }).isPointsMaterial;
    // GLTFLoader's line/point conversion loses the material association. Its
    // primitive association still identifies exactly one original material.
    const simpleIndices = simpleMaterial && !association ? simpleSources.get(material) : undefined;
    const sourceIndex = association?.materials ?? (simpleIndices?.size === 1 ? [...simpleIndices][0] : undefined);
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex! < 0 || sourceIndex! >= definitions.length) {
      // GLTFLoader creates an unassociated default material for primitives that
      // omit material. Explicit materials must always retain their association.
      if (defaultMaterials.has(material) && !association) continue;
      throw new Error(`GLB texture validation: material ${material.name || '(unnamed)'} has no valid source association`);
    }
    const index = sourceIndex!, definition = object(definitions[index], `material ${index}`);
    const extensions = definition.extensions === undefined ? {} : object(definition.extensions, `material ${index} extensions`);
    const unlit = extensions.KHR_materials_unlit !== undefined;
    const simple = unlit || simpleMaterial;
    for (const [path, declaration] of textureDeclarations(definition)) {
      const slots = path.startsWith('extensions.') ? EXTENSION_SLOTS[path.slice('extensions.'.length)] : CORE_SLOTS[path];
      if (!slots) throw new Error(`GLB texture validation: material ${index} has unsupported texture declaration ${path}`);
      const reference = object(declaration, `material ${index} ${path}`);
      const textureIndex = reference.index;
      if (!Number.isSafeInteger(textureIndex) || (textureIndex as number) < 0 || (textureIndex as number) >= textures.length
        || !textures[textureIndex as number] || typeof textures[textureIndex as number] !== 'object') {
        throw new Error(`GLB texture validation: material ${index} ${path} has invalid texture index`);
      }
      // Unlit and line/point materials intentionally use only base colour.
      if (simple && path !== 'pbrMetallicRoughness.baseColorTexture') continue;
      for (const slot of slots) {
        const texture = (material as unknown as JsonObject)[slot] as Texture | undefined;
        if (!texture?.isTexture) throw new Error(`GLB texture validation: material ${index} (${material.name || 'unnamed'}) is missing ${path} (${slot}, texture ${textureIndex})`);
      }
    }
  }
}

class ParsedResources {
  readonly geometries = new Set<BufferGeometry>();
  readonly materials = new Set<Material>();
  readonly textures = new Set<Texture>();
  readonly defaultMaterials = new Set<Material>();
  readonly simpleSources = new Map<Material, Set<number>>();
  private readonly objects = new Set<Object3D>();

  remember(value: unknown): void {
    if (Array.isArray(value)) { for (const child of value) this.remember(child); return; }
    if (!value || typeof value !== 'object') return;
    if ((value as Texture).isTexture) this.textures.add(value as Texture);
    else if ((value as Material).isMaterial) this.materials.add(value as Material);
    else if ((value as BufferGeometry).isBufferGeometry) this.geometries.add(value as BufferGeometry);
    else if ((value as Object3D).isObject3D) this.objects.add(value as Object3D);
  }

  collect(gltf: GLTF): void {
    for (const scene of gltf.scenes) this.objects.add(scene);
    for (const value of gltf.parser.associations.keys()) this.remember(value);
    // Dependencies also include animation-target nodes outside every scene;
    // GLTFLoader removes their node associations when it finishes a scene.
    for (const root of this.objects) root.traverse(node => {
      const renderable = node as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
      this.remember(renderable.geometry); this.remember(renderable.material);
      if (renderable.material) {
        const reference = gltf.parser.associations.get(node);
        const primitive = reference?.meshes !== undefined && reference.primitives !== undefined
          ? gltf.parser.json.meshes?.[reference.meshes]?.primitives?.[reference.primitives] : undefined;
        if (primitive) for (const material of Array.isArray(renderable.material) ? renderable.material : [renderable.material]) {
          if (primitive.material === undefined) this.defaultMaterials.add(material);
          else {
            const indices = this.simpleSources.get(material) ?? new Set<number>();
            indices.add(primitive.material); this.simpleSources.set(material, indices);
          }
        }
      }
    });
    for (const material of this.materials) for (const value of Object.values(material)) this.remember(value);
  }

  dispose(gltf: GLTF): void {
    const bitmaps = new Set<ImageBitmap>();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) {
      texture.dispose();
      const image: unknown = texture.source?.data ?? texture.image;
      for (const source of Array.isArray(image) ? image : [image]) {
        if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) bitmaps.add(source);
      }
    }
    for (const bitmap of bitmaps) bitmap.close();
    for (const scene of gltf.scenes) { scene.removeFromParent(); scene.clear(); }
  }

  clear(): void {
    this.geometries.clear(); this.materials.clear(); this.textures.clear(); this.objects.clear(); this.defaultMaterials.clear(); this.simpleSources.clear();
  }
}

export function completeGlbTextures(parser: GLTFParser): GLTFLoaderPlugin {
  const resources = new ParsedResources(), getDependency = parser.getDependency;
  // Record only dependencies the real loader requests; do not fetch unused
  // images or create additional resources while checking a completed result.
  parser.getDependency = function (type, index) {
    const dependency = getDependency.call(this, type, index);
    if (type === 'scene' || type === 'node' || type === 'mesh' || type === 'material' || type === 'texture') {
      void dependency.then(value => resources.remember(value), () => {});
    }
    return dependency;
  };
  return {
    name: 'HELSINKI_complete_textures',
    afterRoot: async gltf => {
      try {
        resources.collect(gltf);
        validateTextures(gltf, resources.materials, resources.defaultMaterials, resources.simpleSources);
      } catch (error) {
        resources.dispose(gltf);
        throw error;
      } finally {
        parser.getDependency = getDependency;
        resources.clear();
      }
    },
  };
}
