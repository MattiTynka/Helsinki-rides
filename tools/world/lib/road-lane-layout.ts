// OSM lanes describe physical lanes, not one independent carriageway per travel
// direction. Placement numbers lanes from left to right in the tagged direction.
export interface LaneLayoutDiagnostic { code: string; key: string; value: string; reason: string }
export interface RoadLaneLayout {
  forward: number; backward: number; width: number; physicalLanes: number;
  shared: boolean; widthSource: 'configured' | 'width';
  offsets: { forward: number[]; backward: number[] };
  appliedPlacements: { key: string; value: string }[];
  diagnostics: LaneLayoutDiagnostic[];
}

/** Unsupported source placement is surfaced explicitly; it is never interpreted
 * as a guessed shift or used to silently remove a source road from the graph. */
export function roadLaneLayout(tags: Readonly<Record<string, string>>, configuredWidth: number): RoadLaneLayout {
  if (!(configuredWidth > 0 && Number.isFinite(configuredWidth))) throw new Error('Configured road lane width must be finite and positive');
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout' ? 1 : tags.oneway === '-1' ? -1 : 0;
  const total = Number(tags.lanes ?? (oneway ? 1 : 2));
  let forward = Number(tags['lanes:forward'] ?? (oneway === 1 ? total : oneway === -1 ? 0 : Math.max(1, Math.ceil(total / 2))));
  let backward = Number(tags['lanes:backward'] ?? (oneway === -1 ? total : oneway === 1 ? 0 : Math.max(1, total - forward)));
  if (!Number.isFinite(forward)) forward = 1;
  if (!Number.isFinite(backward)) backward = oneway ? 0 : 1;
  for (const [label, count] of [['forward', forward], ['backward', backward]] as const) {
    if (!Number.isInteger(count) || count < 0 || count > 8) throw new Error(`Invalid ${label} road lane count ${count}`);
  }
  const unlanedService = ['service','living_street'].includes(tags.highway??'') && !['lanes', 'lanes:forward', 'lanes:backward'].some(key => tags[key] !== undefined);
  const shared = !oneway && (total === 1 || unlanedService);
  if (shared) {
    if (['lanes:forward', 'lanes:backward'].some(key => tags[key] !== undefined && tags[key] !== '1')) throw new Error('Single physical road corridor has conflicting directional lane counts');
    forward = backward = 1;
  }
  let width = configuredWidth, widthSource: RoadLaneLayout['widthSource'] = 'configured';
  const diagnostics: LaneLayoutDiagnostic[] = [], appliedPlacements: RoadLaneLayout['appliedPlacements'] = [];
  // Width on ordinary streets can include parking and cycle lanes. Only the
  // single-corridor case has no invented subdivision of that total source width.
  if (shared && tags.width !== undefined) {
    const match = /^(\d+(?:\.\d+)?)\s*(?:m)?$/.exec(tags.width);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 40) { width = Number(match[1]); widthSource = 'width'; }
    else diagnostics.push({code:'unsupported-width',key:'width',value:tags.width,reason:'Single physical corridor requires a finite positive source width in metres, at most 40 m'});
  }
  const offsets = {
    forward: Array.from({length:forward}, (_, i) => shared ? 0 : (oneway ? i - (forward - 1) / 2 : i + .5) * width),
    backward: Array.from({length:backward}, (_, i) => shared ? 0 : (oneway ? i - (backward - 1) / 2 : i + .5) * width),
  };
  for (const [key, value] of Object.entries(tags).filter(([key]) => key === 'placement' || key.startsWith('placement:'))) {
    const direction = key === 'placement:forward' ? 'forward' : key === 'placement:backward' ? 'backward' : key === 'placement' && oneway === 1 ? 'forward' : null;
    const count = direction ? offsets[direction].length : 0;
    const match = /^(left_of|middle_of|right_of):(\d+)$/.exec(value);
    const number = match ? Number(match[2]) : NaN;
    if (!direction || !match || number < 1 || number > count || shared) {
      diagnostics.push({code:'unsupported-placement',key,value,reason:!direction?'Generic placement on a two-way/reversed way or endpoint placement needs a source-bound interpretation':value==='transition'?'The source axis is a transition, so no constant lane translation is established':shared?'Directional translation would split a shared physical corridor':'Placement lane number/type does not match the directional lane count'});
      continue;
    }
    const axisAt = number - (match[1] === 'left_of' ? 1 : match[1] === 'middle_of' ? .5 : 0);
    offsets[direction] = Array.from({length:count}, (_, i) => (i + .5 - axisAt) * width);
    appliedPlacements.push({key,value});
  }
  return {forward,backward,width,physicalLanes:shared?1:forward+backward,shared,widthSource,offsets,appliedPlacements,diagnostics};
}
