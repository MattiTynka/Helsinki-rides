/** Chromium's dispatchTouchEvent releases the IDs supplied with touchEnd; an empty list releases all.
 * Keep this protocol mapping shared by mobile harnesses so releasing one thumb cannot release the other.
 */
export function createNativeTouch(session) {
  const active = new Map();
  return async (type, id, x = 0, y = 0) => {
    let touchPoints;
    if (type === 'touchStart' || type === 'touchMove') {
      active.set(id, { x, y, id, radiusX: 5, radiusY: 5, force: 1 });
      touchPoints = [...active.values()];
    } else if (type === 'touchEnd') {
      const ended = active.get(id);
      if (!ended) throw new Error('Cannot release an inactive touch pointer');
      active.delete(id);
      touchPoints = active.size ? [ended] : [];
    } else if (type === 'touchCancel') {
      active.clear(); touchPoints = [];
    } else throw new Error('Unsupported native touch event');
    await session.send('Input.dispatchTouchEvent', { type, touchPoints });
  };
}
