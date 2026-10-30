// Adapter-only registrations do not change the native city producer import closure.
import {facadeRestorationModules} from './facade-restoration-registry.ts';
import type {FacadeRestorationModule} from './facade-restoration-types.ts';
import {createBulevardi46Restoration} from './bulevardi46-facade-restoration.ts';
export const deliveryOwnerFacadeModules:readonly FacadeRestorationModule[]=[createBulevardi46Restoration(109),createBulevardi46Restoration(866)];
export function registeredOwnerFacadeModules(){return[...facadeRestorationModules,...deliveryOwnerFacadeModules];}
