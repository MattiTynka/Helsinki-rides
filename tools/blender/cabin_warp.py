"""Map Finn's Lumi GT car clips onto another car's cabin (used by build_finn_vehicle_poses.py --target).

A target spec (JSON) pairs Lumi GT landmarks with the same landmarks measured on the target car, per car-local axis
(metres, +X driver side, +Y up, +Z forward). Keyed positions move through a continuous field; directions, angles and
timing are kept, so every clip keeps its choreography and duration and the solver refits the limbs to the new points.

- X: a piecewise-linear map of |X| (the sides mirror). Past the last landmark it shifts rigidly, so standing points
  keep their distance from the body side.
- Z: a piecewise-linear map, rigid past the ends.
- Y: piecewise-linear maps for the cabin and for the body side, blended by |X|, fading to no change outside the car,
  so a standing Finn keeps his height while seat, sill, beltline and roof move.
- Over the bonnet the windshield exit keeps its height above the target bonnet surface.

Spec keys: x, z, yCabin, ySide ([[lumi, target], ...]); zones [cabinEnd, side, outside] (Lumi |X|);
bonnet {lumi: [[z, y], ...], target: [[z, y], ...], from, full} (Lumi Z where the bonnet takes over);
roof (target collider top), doors {DOOR_FL: [x, y, z], DOOR_FR: [...]}, openDeg, carSha256, lumiEnds;
tweaks [{clip, from, to, add (offsets, see add), set (parameters set outright)}] on the keys in [from, to];
optional seated (SEATED overrides, Lumi GT space) and cabinPosture {add, full, from, pitchFloor} (see
CabinWarp.posture).
"""
import json
import math
from pathlib import Path

POINTS = ('hip', 'footL', 'footR', 'gripL', 'gripR', 'dptL', 'dptR')


def piecewise(pairs):
    """Monotone piecewise-linear map through (source, target) pairs, slope 1 past both ends."""
    pairs = sorted(pairs)
    xs, ys = [a for a, _ in pairs], [b for _, b in pairs]
    for (a0, b0), (a1, b1) in zip(pairs, pairs[1:]):
        if not (a1 > a0 and b1 > b0):
            raise ValueError(f'landmarks must increase on both sides: {pairs}')

    def f(v):
        if v <= xs[0]:
            return ys[0] + (v - xs[0])
        if v >= xs[-1]:
            return ys[-1] + (v - xs[-1])
        for (a0, b0), (a1, b1) in zip(pairs, pairs[1:]):
            if v <= a1:
                return b0 + (b1 - b0) * (v - a0) / (a1 - a0)
        return ys[-1]
    return f


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def profile(points):
    """Height of a surface along Z through (z, y) samples, flat past the ends."""
    points = sorted(points)

    def at(z):
        if z <= points[0][0]:
            return points[0][1]
        for (z0, y0), (z1, y1) in zip(points, points[1:]):
            if z <= z1:
                return y0 + (y1 - y0) * (z - z0) / (z1 - z0)
        return points[-1][1]
    return at


class CabinWarp:
    def __init__(self, spec, lumi_roof):
        self.spec = spec
        self.fx, self.fz = piecewise(spec['x']), piecewise(spec['z'])
        self.fy_cabin, self.fy_side = piecewise(spec['yCabin']), piecewise(spec['ySide'])
        self.zones = spec['zones']
        b = spec.get('bonnet')
        self.bonnet = (profile(b['lumi']), profile(b['target']), b['from'], b['full']) if b else None
        self.lumi_roof, self.roof = lumi_roof, spec['roof']

    @classmethod
    def load(cls, path, lumi_roof):
        return cls(json.loads(Path(path).read_text(encoding='utf-8')), lumi_roof)

    def point(self, p, over_bonnet=False):
        x, y, z = (float(c) for c in p)
        ax = abs(x)
        c0, c1, c2 = self.zones
        yc, ys = self.fy_cabin(y), self.fy_side(y)
        if ax <= c0:
            yw = yc
        elif ax <= c1:
            yw = yc + (ys - yc) * smooth((ax - c0) / (c1 - c0))
        else:
            yw = ys + (y - ys) * smooth((ax - c1) / (c2 - c1))
        zw = self.fz(z)
        ahead = self.beyond_ends(z)
        yw += (y - yw) * ahead
        if over_bonnet and self.bonnet:
            lumi, target, z0, z1 = self.bonnet
            w = smooth((z - z0) / (z1 - z0)) * (1.0 - ahead)
            yw = yw + w * ((y - lumi(z) + target(zw)) - yw)
        return (math.copysign(self.fx(ax), x) if ax > 0 else 0.0, yw, zw)

    def beyond_ends(self, z):
        """0 over the car, rising to 1 within 0.4 m past the Lumi GT's nose or tail (spec `lumiEnds`): there the
        pose stands on the ground and keeps its height."""
        ends = self.spec.get('lumiEnds')
        if not ends:
            return 0.0
        return max(smooth((z - ends[1]) / 0.4), smooth((ends[0] - z) / 0.4))

    def flipped_point(self, p, kind='hip'):
        """A point in the roof-plane frame of a car on its roof: to car space, warp, and back with the target roof."""
        car = (-p[0], self.lumi_roof - p[1], p[2])
        x, y, z = self.point(car)
        y = self.roof - y
        # The ground is the roof plane: crawling on the liner (below `flippedKeep` heights: hips and feet up to a
        # crawl, hands only flat on the liner, not on the wheel) and outside the car the pose keeps its height above
        # it; only up by the seats does it follow the cabin.
        c0, c1, c2 = self.zones
        k0, k1 = self.spec.get('flippedKeep', {}).get('hands' if kind.startswith(('grip', 'dpt')) else 'body',
                                                      (0.1, 0.25) if kind.startswith(('grip', 'dpt')) else (0.5, 0.8))
        y += (p[1] - y) * max(smooth((abs(p[0]) - c1) / (c2 - c1)), 1.0 - smooth((p[1] - k0) / (k1 - k0)),
                              self.beyond_ends(p[2]))
        return (-x, y, z)

    def posture(self, clip):
        """A lower roof: angle offsets (cabinPosture.add) on every upright key whose hips are in the cabin, fading
        out between Lumi |X| `full` and `from`, so the seated pose and everything near it recline alike."""
        spec = self.spec.get('cabinPosture')
        if not spec or clip.get('flipped', False):
            return clip['base'], clip['keys']
        span = spec['from'] - spec['full']

        def shifted(params, hip):
            w = smooth((spec['from'] - abs(hip[0])) / span)
            out = add(params, {k: v * w if isinstance(v, (int, float)) else [c * w for c in v] for k, v in spec['add'].items()})
            if 'pitch' in out and 'pitchFloor' in spec:
                # Keys already lying further back than the seated pose keep their own recline.
                out['pitch'] = max(out['pitch'], min(params['pitch'], spec['pitchFloor']))
            return out
        hip = clip['base']['hip']
        base = shifted(clip['base'], hip)
        keys = []
        for t, k in clip['keys']:
            hip = k.get('hip', hip)
            keys.append((t, shifted(k, hip)))
        return base, keys

    def seated_posture(self, seated):
        """The seated pose with the full cabin posture (its hips are always well inside the cabin)."""
        spec = self.spec.get('cabinPosture')
        return add(seated, spec['add']) if spec else dict(seated)

    def clip(self, clip):
        flipped = clip.get('flipped', False)
        bonnet = clip['name'].startswith('exitWindshield')
        move = (lambda p, k: self.flipped_point(p, k)) if flipped else (lambda p, k: self.point(p, bonnet))

        def params(d):
            out = dict(d)
            for k in POINTS:
                if k in out:
                    out[k] = move(out[k], k)
            return out
        base, keys = self.posture(clip)
        keys = [(t, params(k)) for t, k in keys]
        for tw in self.spec.get('tweaks', []):
            if tw['clip'] != clip['name']:
                continue
            keys = [(t, dict(add(k, tw.get('add', {})), **tw.get('set', {})) if tw['from'] <= t <= tw['to'] else k) for t, k in keys]
        out = dict(clip, keys=keys, base=params(base))
        if 'roofZMax' in out:
            out['roofZMax'] = self.fz(out['roofZMax'])
        return out


def add(params, delta):
    """Offsets angle parameters (scalars, or triples like neck) of one key; only parameters the key sets."""
    out = dict(params)
    for k, d in delta.items():
        if k not in out:
            continue
        out[k] = out[k] + d if isinstance(d, (int, float)) else tuple(a + b for a, b in zip(out[k], d))
    return out
