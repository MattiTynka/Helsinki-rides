import type { FacadeRestorationEvidence, FacadeRestorationModule, FacadeSourceImage, FacadeSources } from './facade-restoration-types.ts';

type Point = readonly [number, number];
// Source vertex: local east/metres, height/metres, image U, image V. Normals and geometry stay native.
type Vertex = readonly [number, number, number, number];
type Triangle = readonly [Vertex, Vertex, Vertex];
interface Face { readonly id: number; readonly page: number; readonly minE: number; readonly maxE: number; readonly triangles: readonly Triangle[] }
export const KIRKKOKATU14_SOURCES = [
  { page: 59, sha256: '9a5f3a0dd801f000e953e1cc25510a86f2788981fb3c9545d6f9de7f38150945' },
  { page: 60, sha256: 'd6a696b2bb12b6c9fdcde881fe2003990342df9aa2ef60efb2b29cdb8726e6b9' },
  { page: 61, sha256: '1e1e6745470a764ca6b058fc3aafcf4ffaf040f3f6a046ce9f0ff5e1dc47a592' },
  { page: 62, sha256: 'd296aaf61c28a41d5d6bd125e1742dc8eee987f06a4ef9fbae397ca5d7399ea0' },
] as const;
// VTJ1030176223 / Gustaf Estlander's1905–06 Kirkkokatu14. Curated source vertices/triangles from
// the eleven street-front facets. Image V is inverted exactly once from the native model UV.
export const KIRKKOKATU14_FACES: readonly Face[] = [
  { id: 0, page: 60, minE: 98.9166030883789, maxE: 123.8364028930664, triangles: [
    [[123.40302276611328,22.565078735351562,0.7988001108169556,0.3454989194869995], [123.8364028930664,22.977447509765625,0.8077183961868286,0.35178327560424805], [123.8364028930664,0.20007887482643127,0.8398872017860413,0.0009765625]],
    [[123.07601165771484,21.98865509033203,0.7924537062644958,0.3366316556930542], [123.40302276611328,22.565078735351562,0.7988001108169556,0.3454989194869995], [123.8364028930664,0.20007887482643127,0.8398872017860413,0.0009765625]],
    [[122.96446990966797,21.370079040527344,0.7908955216407776,0.32704663276672363], [123.07601165771484,21.98865509033203,0.7924537062644958,0.3366316556930542], [123.8364028930664,0.20007887482643127,0.8398872017860413,0.0009765625]],
    [[122.96446990966797,18.9760799407959,0.7943266034126282,0.28987014293670654], [122.96446990966797,21.370079040527344,0.7908955216407776,0.32704663276672363], [123.8364028930664,0.20007887482643127,0.8398872017860413,0.0009765625]],
    [[122.96446990966797,18.9760799407959,0.7943266034126282,0.28987014293670654], [123.8364028930664,0.20007887482643127,0.8398872017860413,0.0009765625], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[116.08106994628906,18.952510833740234,0.643641471862793,0.29165810346603394], [122.96446990966797,18.9760799407959,0.7943266034126282,0.28987014293670654], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[114.82135772705078,18.952144622802734,0.6160627603530884,0.2920464277267456], [116.08106994628906,18.952510833740234,0.643641471862793,0.29165810346603394], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[114.82135772705078,19.642425537109375,0.6150149703025818,0.3027563691139221], [114.82135772705078,18.952144622802734,0.6160627603530884,0.2920464277267456], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[111.64932250976562,21.370080947875977,0.5428666472434998,0.33058422803878784], [114.82135772705078,19.642425537109375,0.6150149703025818,0.3027563691139221], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[108.46887969970703,18.933168411254883,0.4770317077636719,0.2937391996383667], [108.46887969970703,19.637847900390625,0.475914865732193,0.3046719431877136], [111.64932250976562,21.370080947875977,0.5428666472434998,0.33058422803878784]],
    [[108.46887969970703,18.933168411254883,0.4770317077636719,0.2937391996383667], [111.64932250976562,21.370080947875977,0.5428666472434998,0.33058422803878784], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[100.6183090209961,18.90378189086914,0.3052629828453064,0.29573845863342285], [108.46887969970703,18.933168411254883,0.4770317077636719,0.2937391996383667], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[99.36509704589844,18.903329849243164,0.2778400182723999,0.2961232662200928], [100.6183090209961,18.90378189086914,0.3052629828453064,0.29573845863342285], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494]],
    [[99.36509704589844,18.903329849243164,0.2778400182723999,0.2961232662200928], [98.9166030883789,0.20007990300655365,0.2992592453956604,0.008807241916656494], [98.9166030883789,22.598291397094727,0.2617887854576111,0.35366761684417725]],
    [[99.36509704589844,18.903329849243164,0.2778400182723999,0.2961232662200928], [98.94966125488281,22.56507682800293,0.26256969571113586,0.35314035415649414], [99.25943756103516,21.988656997680664,0.27033257484436035,0.34407520294189453]],
    [[99.36509704589844,18.903329849243164,0.2778400182723999,0.2961232662200928], [99.25943756103516,21.988656997680664,0.27033257484436035,0.34407520294189453], [99.36509704589844,21.37007713317871,0.27369022369384766,0.3344234824180603]],
  ] },
  { id: 1, page: 60, minE: 124.90150451660156, maxE: 127.37879943847656, triangles: [
    [[126.4659423828125,21.988656997680664,0.9214279651641846,0.340700626373291], [127.37879943847656,21.678180694580078,0.9416747689247131,0.33688831329345703], [127.37879943847656,0.2000785917043686,0.9411082863807678,0.0037723779678344727]],
    [[126.4659423828125,21.988656997680664,0.9214279651641846,0.340700626373291], [127.37879943847656,0.2000785917043686,0.9411082863807678,0.0037723779678344727], [124.90150451660156,0.200079545378685,0.88671875,0.0009765625]],
    [[126.4659423828125,21.988656997680664,0.9214279651641846,0.340700626373291], [124.90150451660156,0.200079545378685,0.88671875,0.0009765625], [124.90150451660156,22.157773971557617,0.88671875,0.3415454626083374]],
  ] },
  { id: 2, page: 59, minE: 93.91799926757812, maxE: 95.48590087890625, triangles: [
    [[94.11116790771484,23.093141555786133,0.490234375,0.957366406917572], [95.48590087890625,23.09581756591797,0.49117210507392883,0.9875732064247131], [95.48590087890625,0.2000793069601059,0.8441239595413208,0.9875732064247131]],
    [[94.11116790771484,23.093141555786133,0.490234375,0.957366406917572], [95.48590087890625,0.2000793069601059,0.8441239595413208,0.9875732064247131], [93.91800689697266,0.2000790685415268,0.8430094122886658,0.9534992575645447]],
    [[94.11116790771484,23.093141555786133,0.490234375,0.957366406917572], [93.91800689697266,0.2000790685415268,0.8430094122886658,0.9534992575645447], [93.91799926757812,22.92218780517578,0.4927610754966736,0.953125]],
    [[94.11116790771484,23.093141555786133,0.490234375,0.957366406917572], [93.91799926757812,22.92218780517578,0.4927610754966736,0.953125], [94.05524444580078,23.06006622314453,0.4907100796699524,0.9561381936073303]],
  ] },
  { id: 3, page: 60, minE: 96.35270690917969, maxE: 97.98180389404297, triangles: [
    [[97.47653198242188,21.98865509033203,0.2307838499546051,0.3367367386817932], [97.98180389404297,21.88374137878418,0.2420235425233841,0.33471810817718506], [97.98180389404297,0.20007890462875366,0.2785123288631439,0.0009765625]],
    [[97.47653198242188,21.98865509033203,0.2307838499546051,0.3367367386817932], [97.98180389404297,0.20007890462875366,0.2785123288631439,0.0009765625], [96.35270690917969,0.20007935166358948,0.2432193011045456,0.002226531505584717]],
    [[97.47653198242188,21.98865509033203,0.2307838499546051,0.3367367386817932], [96.35270690917969,0.20007935166358948,0.2432193011045456,0.002226531505584717], [96.35270690917969,22.06282615661621,0.2060546875,0.33875083923339844]],
  ] },
  { id: 4, page: 59, minE: 127.37879943847656, maxE: 128.47869873046875, triangles: [
    [[128.47869873046875,23.10188102722168,0.3498992621898651,0.9962847828865051], [128.47869873046875,0.20007771253585815,0.008538633584976196,0.9962847828865051], [127.37879943847656,0.2000785917043686,0.0009765625,0.9767325520515442]],
    [[128.47869873046875,23.10188102722168,0.3498992621898651,0.9962847828865051], [127.37879943847656,0.2000785917043686,0.0009765625,0.9767325520515442], [127.37879943847656,21.678180694580078,0.32095348834991455,0.9765625]],
    [[128.47869873046875,23.10188102722168,0.3498992621898651,0.9962847828865051], [127.37879943847656,21.678180694580078,0.32095348834991455,0.9765625], [127.4372787475586,21.988656997680664,0.32602065801620483,0.9776089191436768]],
    [[128.47869873046875,23.10188102722168,0.3498992621898651,0.9962847828865051], [127.4372787475586,21.988656997680664,0.32602065801620483,0.9776089191436768], [127.77884674072266,22.56507682800293,0.3370286822319031,0.9837324619293213]],
    [[128.47869873046875,23.10188102722168,0.3498992621898651,0.9962847828865051], [127.77884674072266,22.56507682800293,0.3370286822319031,0.9837324619293213], [128.3222198486328,23.0600643157959,0.3481977880001068,0.9934778809547424]],
    [[128.47869873046875,23.10188102722168,0.3498992621898651,0.9962847828865051], [128.3222198486328,23.0600643157959,0.3481977880001068,0.9934778809547424], [128.43959045410156,23.123023986816406,0.34994933009147644,0.9955832958221436]],
  ] },
  { id: 5, page: 62, minE: 123.8364028930664, maxE: 124.90150451660156, triangles: [
    [[124.90150451660156,22.157773971557617,0.9760560989379883,0.9819462299346924], [124.90150451660156,0.200079545378685,0.6376953125,0.9816946387290955], [123.8364028930664,0.20007887482643127,0.6470301747322083,0.9580078125]],
    [[124.90150451660156,22.157773971557617,0.9760560989379883,0.9819462299346924], [123.8364028930664,0.20007887482643127,0.6470301747322083,0.9580078125], [123.8364028930664,22.977447509765625,0.998157799243927,0.9580078125]],
    [[124.90150451660156,22.157773971557617,0.9760560989379883,0.9819462299346924], [123.8364028930664,22.977447509765625,0.998157799243927,0.9580078125], [123.92070770263672,23.0600643157959,0.9987070560455322,0.9599029421806335]],
    [[124.90150451660156,22.157773971557617,0.9760560989379883,0.9819462299346924], [123.92070770263672,23.0600643157959,0.9987070560455322,0.9599029421806335], [123.94324493408203,23.073068618774414,0.9987123012542725,0.9604095816612244]],
    [[124.90150451660156,22.157773971557617,0.9760560989379883,0.9819462299346924], [123.97196960449219,23.060062408447266,0.9982580542564392,0.9610552191734314], [124.6156005859375,22.56507682800293,0.9849058389663696,0.9755225777626038]],
  ] },
  { id: 6, page: 59, minE: 95.48590087890625, maxE: 96.35270690917969, triangles: [
    [[96.06847381591797,22.565078735351562,0.9912501573562622,0.01344311237335205], [96.35270690917969,22.06282615661621,0.9965083003044128,0.023182213306427002], [96.35270690917969,0.20007935166358948,0.9963676333427429,0.34889447689056396]],
    [[96.06847381591797,22.565078735351562,0.9912501573562622,0.01344311237335205], [96.35270690917969,0.20007935166358948,0.9963676333427429,0.34889447689056396], [95.48590087890625,0.2000793069601059,0.98046875,0.3422001004219055]],
    [[96.06847381591797,22.565078735351562,0.9912501573562622,0.01344311237335205], [95.48590087890625,0.2000793069601059,0.98046875,0.3422001004219055], [95.48590087890625,23.09581756591797,0.98046875,0.0009765625]],
    [[96.06847381591797,22.565078735351562,0.9912501573562622,0.01344311237335205], [95.48590087890625,23.09581756591797,0.98046875,0.0009765625], [95.549560546875,23.0600643157959,0.9816469550132751,0.002004384994506836]],
  ] },
  { id: 7, page: 61, minE: 97.98180389404297, maxE: 98.9166030883789, triangles: [
    [[98.6906509399414,22.818330764770508,0.0009765625,0.9920013546943665], [98.9166030883789,22.598291397094727,0.002580881118774414,0.9969244003295898], [98.9166030883789,0.20007990300655365,0.3477756083011627,0.9969244003295898]],
    [[98.6906509399414,22.818330764770508,0.0009765625,0.9920013546943665], [98.9166030883789,0.20007990300655365,0.3477756083011627,0.9969244003295898], [97.98180389404297,0.20007890462875366,0.3553239405155182,0.9767736792564392]],
    [[98.6906509399414,22.818330764770508,0.0009765625,0.9920013546943665], [97.98180389404297,0.20007890462875366,0.3553239405155182,0.9767736792564392], [97.98180389404297,21.88374137878418,0.0212560947984457,0.9765625]],
    [[98.6906509399414,22.818330764770508,0.0009765625,0.9920013546943665], [97.98180389404297,21.88374137878418,0.0212560947984457,0.9765625], [98.00370788574219,21.98865509033203,0.019445782527327538,0.9770388007164001]],
    [[98.6906509399414,22.818330764770508,0.0009765625,0.9920013546943665], [98.00370788574219,21.98865509033203,0.019445782527327538,0.9770388007164001], [98.3824234008789,22.56507682800293,0.0074106669053435326,0.9852861762046814]],
  ] },
  { id: 8, page: 62, minE: 128.47869873046875, maxE: 129.06080627441406, triangles: [
    [[128.55332946777344,23.06006622314453,0.9902387261390686,0.9860175848007202], [129.06080627441406,22.577133178710938,0.9826028347015381,0.9971836805343628], [129.06080627441406,0.20007893443107605,0.6376953125,0.9970465302467346]],
    [[128.55332946777344,23.06006622314453,0.9902387261390686,0.9860175848007202], [129.06080627441406,0.20007893443107605,0.6376953125,0.9970465302467346], [128.47869873046875,0.20007771253585815,0.6378236413002014,0.984375]],
    [[128.55332946777344,23.06006622314453,0.9902387261390686,0.9860175848007202], [128.47869873046875,0.20007771253585815,0.6378236413002014,0.984375], [128.47869873046875,23.10188102722168,0.9909067749977112,0.984375]],
  ] },
  { id: 9, page: 59, minE: 93.83160400390625, maxE: 93.91800689697266, triangles: [
    [[93.83160400390625,0.20007863640785217,0.8895016312599182,0.9464502334594727], [93.83160400390625,22.82305145263672,0.5373666286468506,0.9464102983474731], [93.91799926757812,22.92218780517578,0.5350703001022339,0.9503727555274963]],
    [[93.83160400390625,0.20007863640785217,0.8895016312599182,0.9464502334594727], [93.91799926757812,22.92218780517578,0.5350703001022339,0.9503727555274963], [93.91800689697266,0.2000790685415268,0.8887569904327393,0.9503727555274963]],
  ] },
  { id: 10, page: 62, minE: 93.71792602539062, maxE: 93.83160400390625, triangles: [
    [[93.71793365478516,0.2000788152217865,0.2685546875,0.9707220196723938], [93.71792602539062,22.708829879760742,0.604551374912262,0.970703125], [93.83160400390625,22.82305145263672,0.6063507199287415,0.9727934002876282]],
    [[93.71793365478516,0.2000788152217865,0.2685546875,0.9707220196723938], [93.83160400390625,22.82305145263672,0.6063507199287415,0.9727934002876282], [93.83160400390625,0.20007863640785217,0.26863211393356323,0.9727934002876282]],
  ] },
];
export const KIRKKOKATU14_ARCHITECTURE = {
  eastGroundWideAxes: [116.30, 121.72], westGroundPairedAxes: [101.47, 106.08],
  portal: { centreE: 111.38, innerHalfWidth: 1.55, outerHalfWidth: 2.15, springHeight: 2.70, thresholdHeight: 0.60 },
  mainCorniceHeight: 6.75, mainRetainedUpperFrom: 10.55, crownCoveredCornerTop: 14.30,
  // These intervals follow the existing corner glass columns; a window crossing two curve facets
  // uses one continuous interval, instead of adding an invented window on each atlas chart.
  cornerGroundIntervals: [[94.30, 95.16], [96.07, 97.20], [98.16, 98.61], [124.14, 124.60], [125.56, 126.69], [127.82, 128.30]],
} as const;
const mirror = (n: number) => { const phase = ((n % 2) + 2) % 2; return phase <= 1 ? phase : 2 - phase; };
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
function barycentric(p: Point, a: Point, b: Point, c: Point): readonly [number, number, number] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-14) return null;
  const u = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const v = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  return u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9 ? [u, v, 1 - u - v] : null;
}
function sample(image: FacadeSourceImage, u: number, v: number, ch: number): number {
  const x = clamp(u * image.width - 0.5, 0, image.width - 1), y = clamp(v * image.height - 0.5, 0, image.height - 1), x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const at = (xx: number, yy: number) => image.data[(yy * image.width + xx) * 4 + ch]!;
  return (at(x0, y0) * (1 - tx) + at(Math.min(image.width - 1, x0 + 1), y0) * tx) * (1 - ty)
    + (at(x0, Math.min(image.height - 1, y0 + 1)) * (1 - tx) + at(Math.min(image.width - 1, x0 + 1), Math.min(image.height - 1, y0 + 1)) * tx) * ty;
}
function worldSample(sources: FacadeSources, face: Face, e: number, h: number, ch: number): number {
  for (const triangle of face.triangles) {
    const weights = barycentric([e, h], ...triangle.map(p => [p[0], p[1]] as Point) as [Point, Point, Point]);
    if (!weights) continue;
    const u = weights.reduce((sum, w, i) => sum + w * triangle[i]![2], 0), v = weights.reduce((sum, w, i) => sum + w * triangle[i]![3], 0);
    return sample(sources.get(face.page)!, u, v, ch);
  }
  throw new Error(`Kirkkokatu14 donor point outside face ${face.id}: ${e},${h}`);
}
function plaster(sources: FacadeSources, e: number, h: number, ch: number): number {
  return worldSample(sources, KIRKKOKATU14_FACES[0]!, 103.20 + mirror(e / 1.3) * 1.05, 8.10 + mirror(h / 1.4) * 1.15, ch);
}
function roughBase(sources: FacadeSources, e: number, h: number, ch: number): number {
  // The clear strip immediately below the original cornice supplies this same-building rough grey
  // finish. The wrap obscures the lower stonework, so its joints/arch blocks are authored explicitly.
  return worldSample(sources, KIRKKOKATU14_FACES[0]!, 103.0 + mirror(e / 1.7) * 1.15, 6.22 + mirror(h / 0.38) * 0.30, ch);
}
function windowPixel(sources: FacadeSources, u: number, v: number, pairedNarrow: boolean, ch: number): number {
  // Native clear lowest upper-rank glass supplies the actual building's reflections and frame palette.
  // Ground windows have their own reference-verified transoms; do not stamp the upper grid whole.
  const frame = worldSample(sources, KIRKKOKATU14_FACES[0]!, 100.38, 8.70, ch) * 0.86;
  const glass = worldSample(sources, KIRKKOKATU14_FACES[0]!, 100.80 + mirror(u * 3) * 0.22, 8.04 + mirror(v * 4) * 0.35, ch);
  const divisions = pairedNarrow ? 2 : 3;
  const vertical = Math.abs(u * divisions - Math.round(u * divisions)) < 0.026;
  const transom = Math.abs(v - 0.56) < 0.018;
  const topGrid = v > 0.56 && (Math.abs(u * divisions * 2 - Math.round(u * divisions * 2)) < 0.030 || Math.abs(v - 0.78) < 0.016);
  return u < 0.035 || u > 0.965 || v < 0.025 || v > 0.975 || vertical || transom || topGrid ? frame : glass;
}
function portalTop(e: number, halfWidth: number): number {
  return KIRKKOKATU14_ARCHITECTURE.portal.springHeight + Math.sqrt(Math.max(0, 4 * halfWidth * halfWidth - (Math.abs(e) + halfWidth) ** 2));
}
function groundPixel(sources: FacadeSources, face: Face, e: number, h: number, ch: number): number {
  const rough = roughBase(sources, e, h, ch), portal = KIRKKOKATU14_ARCHITECTURE.portal, offset = e - portal.centreE;
  if (face.id === 0 && Math.abs(offset) <= portal.outerHalfWidth && h <= portalTop(offset, portal.outerHalfWidth)) {
    if (Math.abs(offset) < portal.innerHalfWidth && h > portal.thresholdHeight && h < portalTop(offset, portal.innerHalfWidth)) {
      const wood = worldSample(sources, KIRKKOKATU14_FACES[0]!, 111.10, 12.90, ch);
      const gateBar = h < 2.8 && (Math.abs(offset * 5 - Math.round(offset * 5)) < 0.095 || Math.abs(h - 1.0) < 0.035 || Math.abs(h - 2.50) < 0.035);
      return wood * (gateBar ? 0.30 : 0.105);
    }
    const angle = Math.atan2(Math.max(0, h - portal.springHeight), offset);
    const joint = h < portal.springHeight ? Math.abs((h - 0.55) / 0.47 - Math.round((h - 0.55) / 0.47)) < 0.045 : Math.abs(angle / Math.PI * 17 - Math.round(angle / Math.PI * 17)) < 0.045;
    return rough * (joint ? 0.56 : 0.92 + 0.10 * Math.sin(angle * 19));
  }
  if (h < 1.50) {
    const course = h / 0.45, brick = e / 1.25 + (Math.floor(course) % 2 ? 0.5 : 0), joint = Math.abs(course - Math.round(course)) < 0.035 || Math.abs(brick - Math.round(brick)) < 0.02;
    return rough * (joint ? 0.63 : 0.81);
  }
  const drawWindow = (centre: number, width: number, bottom: number, top: number, narrow: boolean): number | null => {
    const u = (e - centre) / width + 0.5, v = (h - bottom) / (top - bottom);
    if (u < -0.035 || u > 1.035 || v < -0.025 || v > 1.025) return null;
    if (u < 0 || u > 1 || v < 0 || v > 1) return rough * 1.30;
    return windowPixel(sources, u, v, narrow, ch);
  };
  if (face.id === 0) {
    for (const centre of KIRKKOKATU14_ARCHITECTURE.eastGroundWideAxes) { const pixel = drawWindow(centre, 1.88, 2.35, 5.95, false); if (pixel !== null) return pixel; }
    for (const centre of KIRKKOKATU14_ARCHITECTURE.westGroundPairedAxes) for (const offset of [-0.48, 0.48]) { const pixel = drawWindow(centre + offset, 0.66, 1.85, 5.95, true); if (pixel !== null) return pixel; }
  } else {
    for (const [lo, hi] of KIRKKOKATU14_ARCHITECTURE.cornerGroundIntervals) { const pixel = drawWindow((lo + hi) / 2, hi - lo, 2.0, 5.95, hi - lo < 0.9); if (pixel !== null) return pixel; }
  }
  return rough;
}
function repairPixel(sources: FacadeSources, face: Face, e: number, h: number, ch: number): number | null {
  if (h < 6.75) return groundPixel(sources, face, e, h, ch);
  if (face.id === 0) {
    // The crown hides the left of the two narrow windows below the balcony. The original right
    // narrow window is clear and supplies its homologous full profile; all balcony/upper detail stays.
    if (h < 10.55 && e > 105.00 && e < 111.45) {
      if (e > 105.08 && e < 107.10 && h > 7.45 && h < 10.02) return worldSample(sources, face, e - 4.61, h, ch);
      if (e > 109.10 && e < 110.40 && h > 7.45 && h < 10.02) return worldSample(sources, face, e + 2.45, h, ch);
      return plaster(sources, e, h, ch);
    }
    if (h < 10.55 && e > 122.45) return plaster(sources, e, h, ch);
  }
  if (face.id === 1 && h < 11.70) {
    if (e > 125.52 && e < 126.78 && h > 7.45 && h < 10.02) return worldSample(sources, KIRKKOKATU14_FACES[0]!, 100.49 + (e - 125.52) / 1.26 * 1.94, h, ch);
    return plaster(sources, e, h, ch);
  }
  if (face.id === 4 && h < 14.30) {
    const base = h < 10.55 ? 7.45 : 11.65, top = h < 10.55 ? 10.02 : 14.03;
    // This narrow curve facet has a photographed crown across two ranks. Its literal clear top-rank
    // window gives the same horizontal glass column; do not infer an opening from the green pixels.
    if (h > base && h < top) return worldSample(sources, face, e, 15.95 + (h - base) / (top - base) * 2.55, ch);
    return plaster(sources, e, h, ch);
  }
  if (face.id === 5 && h < 11.70) {
    if (h > 7.45 && h < 10.02) return worldSample(sources, face, e, 11.70 + (h - 7.45) / 2.57 * 2.40, ch);
    return plaster(sources, e, h, ch);
  }
  if (face.id === 6 && h < 11.70) {
    if (e > 96.07 && h > 7.45 && h < 10.02) return worldSample(sources, KIRKKOKATU14_FACES[0]!, 100.49 + (e - 96.07) / 1.13 * 1.94, h, ch);
    return plaster(sources, e, h, ch);
  }
  // A source construction-fence reflection reaches only the blank western edge of this curve
  // facet, above the first rank. Preserve its clear middle glass column on the eastern half.
  if (face.id === 6 && e < 95.86 && h < 12.18) return plaster(sources, e, h, ch);
  if (face.id === 2 && e > 95.28 && h < 12.18) return plaster(sources, e, h, ch);
  if ((face.id === 8 || face.id === 10) && h < 11.70) return plaster(sources, e, h, ch);
  return null;
}

export const kirkkokatu14Restoration: FacadeRestorationModule = {
  id: 'kirkkokatu14-street-wrap-and-crowns', targetPages: [59, 60, 61, 62], sourcePages: [59, 60, 61, 62],
  apply(page, rgba, width, height, sources): FacadeRestorationEvidence[] {
    if (![59, 60, 61, 62].includes(page)) return [];
    for (const identity of KIRKKOKATU14_SOURCES) {
      const image = sources.get(identity.page);
      if (!image || image.pngSha256 !== identity.sha256) throw new Error(`Kirkkokatu14 page${identity.page} source master changed; curated mapping requires review`);
      if (image.width !== 1024 || image.height !== 1024 || image.data.length !== 1024 * 1024 * 4) throw new Error('Kirkkokatu14 source image dimensions invalid');
    }
    if (width < 128 || height < 128 || rgba.length !== width * height * 4) throw new Error('Kirkkokatu14 target image dimensions invalid');
    const changed = new Set<number>(), faceCounts: Record<number, number> = {};
    for (const face of KIRKKOKATU14_FACES.filter(f => f.page === page)) for (const triangle of face.triangles) {
      const uv = triangle.map(p => [p[2], p[3]] as Point) as [Point, Point, Point];
      const x0 = Math.max(0, Math.floor(Math.min(...uv.map(p => p[0])) * width)), x1 = Math.min(width - 1, Math.ceil(Math.max(...uv.map(p => p[0])) * width));
      const y0 = Math.max(0, Math.floor(Math.min(...uv.map(p => p[1])) * height)), y1 = Math.min(height - 1, Math.ceil(Math.max(...uv.map(p => p[1])) * height));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const weights = barycentric([(x + 0.5) / width, (y + 0.5) / height], ...uv);
        if (!weights) continue;
        const e = weights.reduce((sum, w, i) => sum + w * triangle[i]![0], 0), h = weights.reduce((sum, w, i) => sum + w * triangle[i]![1], 0);
        const index = (y * width + x) * 4;
        let didChange = false;
        for (let ch = 0; ch < 3; ch++) {
          const donor = repairPixel(sources, face, e, h, ch);
          if (donor === null) continue;
          const value = Math.round(clamp(donor, 0, 255));
          if (value !== rgba[index + ch]) didChange = true;
          rgba[index + ch] = value;
        }
        if (didChange && !changed.has(index)) { changed.add(index); faceCounts[face.id] = (faceCounts[face.id] ?? 0) + 1; }
      }
    }
    return [{ id: 'kirkkokatu14-licensed-native-material-reconstruction', page, changedTexels: changed.size, faceChangedTexels: faceCounts,
      architecture: KIRKKOKATU14_ARCHITECTURE, sourceIdentities: KIRKKOKATU14_SOURCES,
      limits: 'Only the eleven source-bound street-front facets of VTJ1030176223 are touched. Removes lower construction wrap and the two observed crown areas. Same-building clear native window/plaster/rough-grey pixels provide materials; hidden ground profiles and rough-stone pointed portal are authored from the observed architecture, not recovered historical pixels. Ground east wide windows, west paired narrow windows and the central gated recess remain distinct. Original clear upper wall, balcony, gables, roofs, courtyard, side/party walls, geometry/collision, and unrelated shared-page charts stay exact. Google is visual reference only; no Google pixels are asset inputs.' }];
  },
};
