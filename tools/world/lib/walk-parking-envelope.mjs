// Offline route authoring authority. Actor serials are not stable parking-slot identities.
import assert from 'node:assert/strict';
import {cityParkingSlots, ParkedCars} from '../../../packages/sim/src/parked-cars.ts';
import {fnv1a, quatYaw} from '../../../packages/sim/src/math.ts';
import {vehicleCoverageFootprint} from '../../../packages/sim/src/coverage-footprint.ts';

export function parkingRouteObstacles(gameplay, world, observations) {
  const civilian = gameplay.vehicleDefinitions.filter(d => d.role === 'civilian');
  assert.ok(civilian.length);
  const population = new ParkedCars({gameplay, world});
  // Execute the current immutable runtime road/junction rejection predicate. We
  // deliberately do not reject slots on occupancy, residency, cooldown, or the
  // current spawn population: those change during a return journey.
  assert.equal(typeof population.clearRoad, 'function');
  const slots = cityParkingSlots(world.roads.graph), rejected = [], obstacles = [];
  const add = (record, definition) => {
    assert.ok(record.position.length === 3 && record.rotation.length === 4 && [...record.position,...record.rotation].every(Number.isFinite));
    const footprint = vehicleCoverageFootprint(definition, record);
    assert.ok(footprint.length >= 3);
    obstacles.push({...record, definition:definition.id, footprint});
  };
  for (const slot of slots) {
    const definition = civilian[Number.parseInt(fnv1a(slot.id),16) % civilian.length];
    if (!population.clearRoad(slot,definition)) { rejected.push(slot.id); continue; }
    add({id:slot.id, authority:'potential-source-parking-slot', source:slot.source,
      position:slot.position.map(Math.fround), rotation:quatYaw(slot.yaw).map(Math.fround)}, definition);
  }
  for (const vehicle of gameplay.vehicles) {
    const definition = gameplay.vehicleDefinitions.find(d => d.id === vehicle.definition);
    if (definition?.role !== 'civilian') continue;
    add({id:vehicle.id, authority:'authored-initial-civilian', position:[vehicle.position[0],0,vehicle.position[1]],
      rotation:quatYaw(Math.PI-vehicle.headingDeg*Math.PI/180).map(Math.fround)}, definition);
  }
  for (const observation of observations) {
    const vehicles = observation.value.failureView?.state.vehicles ?? observation.value.vehicles;
    assert.ok(Array.isArray(vehicles));
    for (const vehicle of vehicles) {
      const definition = gameplay.vehicleDefinitions.find(d => d.id === vehicle.definition);
      if (vehicle.driver !== null || definition?.role !== 'civilian') continue;
      add({...vehicle,authority:'observed-unoccupied-civilian',observationSha256:observation.sha256},definition);
    }
  }
  return {obstacles, slotCount:slots.length, staticRoadRejectedSlotIds:rejected,
    policy:'All runtime source slots surviving its immutable road/junction test; no filtering by mutable population, occupancy, cooldown or static spawn support. Stable runtime FNV slot vehicle selection and exact yaw, without jitter. Authored civilian spawns plus observed unoccupied civilian poses are included. Future physical motion remains bounded only by the declared route clearance, not proven indefinitely.'};
}

export function obstacleGrid(obstacles, cellSize=16) {
  const buckets = new Map();
  for(const obstacle of obstacles){const xs=obstacle.footprint.map(p=>p[0]),zs=obstacle.footprint.map(p=>p[1]);
    for(let x=Math.floor(Math.min(...xs)/cellSize);x<=Math.floor(Math.max(...xs)/cellSize);x++)
      for(let z=Math.floor(Math.min(...zs)/cellSize);z<=Math.floor(Math.max(...zs)/cellSize);z++){
        const key=`${x},${z}`, bucket=buckets.get(key)??[];bucket.push(obstacle);buckets.set(key,bucket);
      }
  }
  return (a,b,margin)=>{const out=new Set();
    for(let x=Math.floor((Math.min(a[0],b[0])-margin)/cellSize);x<=Math.floor((Math.max(a[0],b[0])+margin)/cellSize);x++)
      for(let z=Math.floor((Math.min(a[1],b[1])-margin)/cellSize);z<=Math.floor((Math.max(a[1],b[1])+margin)/cellSize);z++)
        for(const v of buckets.get(`${x},${z}`)??[])out.add(v);
    return [...out];
  };
}
