// Offline diagnosis of a recorded drive. Never edits the recording, world or running game.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { decodeCommand, initPhysics, Simulation } from '../../packages/sim/src/index.ts';
import { vehicleDoorClearance } from '../../packages/sim/src/vehicle-interaction.ts';
import { readRoadGraph, readSimulationPayload, replayWorld } from './lib/simulation-payload.ts';
const { values } = parseArgs({ options: { release: { type: 'string' }, recording: { type: 'string' }, out: { type: 'string' },
  from: { type: 'string' }, to: { type: 'string' }, stride: { type: 'string', default: '30' } } });
if (!values.release || !values.recording || !values.out || !values.from || !values.to || fs.existsSync(values.out)) throw new Error('release, recording, from, to and fresh out required');
const recordingBytes = fs.readFileSync(values.recording), recording = JSON.parse(recordingBytes);
const manifestBytes = fs.readFileSync(path.join(values.release, 'manifest.json')), manifest = JSON.parse(manifestBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = ref => { const bytes = fs.readFileSync(path.join(values.release, ref.path)); if (sha(bytes) !== ref.sha256) throw new Error(`Hash mismatch ${ref.path}`); return bytes; };
await initPhysics();
const collision = new Map();
for (const cell of manifest.cells) collision.set(cell.id, await readSimulationPayload(values.release, cell.collision));
const world = replayWorld(await readSimulationPayload(values.release, manifest.terrain), await readRoadGraph(values.release,manifest.roads), JSON.parse(payload(manifest.gameplay)), manifest.cells, collision, recording.collision);
const sim = new Simulation(world, { seed: recording.seed }), samples = [], events = [], interactionInputs = [];
try {
  for (const encoded of recording.commands) {
    const command = decodeCommand(encoded);
    let before = null;
    if (sim.tick + 1 >= Number(values.from) && sim.tick + 1 <= Number(values.to)) {
      const car = sim.vehicles.get('car-1');
      before = { mode: sim.mode, speed: car.speed, up: car.up,
        doorClearance: vehicleDoorClearance(world, car, sim.player, sim.blocksUpperDoor),
        interactionTicks: sim.interactionTicks, exitReturning: sim.exitReturning };
    }
    sim.step(command);
    for (const event of sim.events) if (/Vehicle|vehicle|Police|fire|wasted|busted|respawn/i.test(event.type)) {
      const car = sim.vehicles.get('car-1');
      events.push({ ...event, mode: sim.mode, position: car.position, up: car.up, speed: car.speed });
    }
    if (command.buttons & 2) interactionInputs.push({ tick: sim.tick, mode: sim.mode, position: sim.vehicles.get('car-1').position });
    if (sim.tick < Number(values.from) || sim.tick > Number(values.to) || sim.tick % Number(values.stride)) continue;
    const car = sim.vehicles.get('car-1'), contacts = [];
    for (const [part, collider] of [['chassis', car.collider], ['skid', car.skidCollider]]) {
      if (!collider) continue;
      world.physics.contactPairsWith(collider, other => world.physics.contactPair(collider, other, (manifold, flipped) => {
        if (!manifold.numSolverContacts()) return;
        const triangle = flipped ? manifold.subshape1() : manifold.subshape2();
        contacts.push({ part, otherVehicle: sim.vehicleOf(other.handle)?.id, surface: world.surfaceAt(other.handle, triangle),
          normal: manifold.normal(), triangle,
          points: Array.from({ length: manifold.numSolverContacts() }, (_, i) => ({ point: manifold.solverContactPoint(i), distance: manifold.solverContactDist(i) })) });
      }));
    }
    const lane = world.roads.nearestLane(car.position[0], car.position[2], [car.forward[0], car.forward[2]], 20);
    samples.push({ tick: sim.tick, before, mode: sim.mode, position: car.position, rotation: car.rotation, speed: car.speed, input: { ...car.input },
      lane, road: lane ? world.roads.laneById.get(lane.laneId)?.name : null, contacts,
      wheels: car.def.wheels.map((wheel, i) => { const hardPoint = car.controller.wheelHardPoint(i), point = car.controller.wheelContactPoint(i);
        return { name: wheel.socket, point, hardPoint, groundAtHardPoint: world.groundBelow(hardPoint.x, 30, hardPoint.z), groundAtContact: world.groundBelow(point.x, 30, point.z),
          grounded: car.wheelContact[i], suspension: car.wheelSuspension[i], surface: world.surfaceAt(car.controller.wheelGroundObject(i)?.handle, null) }; }) });
  }
  const hash = sim.hash();
  const crossSection = [];
  for (let x = -161; x <= -155; x += .25) crossSection.push({ x, z: 133.7, ground: world.groundBelow(x, 30, 133.7), terrain: world.groundHeight(x, 133.7) });
  fs.writeFileSync(values.out, JSON.stringify({ release: manifest.worldReleaseId, manifestSha256: sha(manifestBytes), recordingSha256: sha(recordingBytes),
    replayHash: hash, recordedHash: recording.hash, replayPass: hash === recording.hash, samples, crossSection, events, interactionInputs }, null, 2));
  console.log(JSON.stringify({ replayHash: hash, replayPass: hash === recording.hash, samples: samples.length,
    contacts: samples.flatMap(sample => sample.contacts.map(contact => ({ tick: sample.tick, ...contact }))) }));
} finally { world.physics.free(); }
