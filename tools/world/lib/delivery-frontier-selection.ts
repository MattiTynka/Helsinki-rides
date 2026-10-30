import assert from 'node:assert/strict';
import type {Finish} from './ground.ts';

/** Authored bridge floors share the historical `_ground_` prefix, but a new city
 * strip has no authority to replace their independently qualified deck geometry. */
export function deliveryNativeGroundFinish(name:string,extras:Record<string,unknown>={}):Finish|null {
  if(extras.bridgeReconstruction===true||typeof extras.extraBridge==='string'||/_ground_(?:extra_)?bridge_/.test(name))return null;
  if(!name.includes('_ground_'))return null;
  const match=/_ground_(?:frontier_)?(asphalt|setts|cobble|slabs|gravel|grass|yard)$/.exec(name);
  assert.ok(match,`Unknown native ground finish ${name}`);
  return match[1]as Finish;
}

export function protectedDeliveryBridgeCollision(id:string,tag:string){
  return /(?:^|:)bridge-reconstruction:/.test(id)||tag.split(':').includes('bridge-reconstruction');
}
