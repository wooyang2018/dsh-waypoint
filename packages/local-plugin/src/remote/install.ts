/**
 * Install and restore instance methods on a service object.
 *
 * Every adapter in `remote/` works the same way: it reads a service through
 * `ctx.get`, replaces an own property, and must put the object back exactly as
 * it found it. Getting that restore wrong is quiet and expensive — a plain
 * `delete` removes the property outright when the implementation happened to be
 * an own property rather than a prototype method, leaving the service with a
 * hole instead of its original behaviour.
 *
 * The installer therefore captures each property descriptor BEFORE assigning,
 * and an uninstall restores that exact descriptor (or removes the property when
 * there was none). Callers pass the replacement implementations and let this
 * function assign them: assigning first and capturing afterwards would record
 * the new value as the "original" and restore the patch instead of the stock
 * method.
 *
 * @module dsh-waypoint/remote/install
 */

/** One captured slot, before replacement. */
interface Slot {
  readonly name: string
  readonly descriptor: PropertyDescriptor | undefined
  readonly installed: unknown
}

/**
 * Replace methods on a service instance and return a restorer.
 *
 * A replacement is skipped, with a warning, when the service does not expose a
 * callable of that name: patching a method the load never had would produce an
 * adapter that silently never runs.
 *
 * @param target - the live service instance.
 * @param replacements - method name to implementation; this function assigns them.
 * @param onMissing - called once per name the service does not expose.
 * @returns a restorer that is safe to call more than once.
 */
export function replaceMethods(
  target: object,
  replacements: Readonly<Record<string, unknown>>,
  onMissing?: (name: string) => void,
): () => void {
  const slots: Slot[] = []
  const bag = target as Record<string, unknown>
  for (const [name, implementation] of Object.entries(replacements)) {
    if (typeof Reflect.get(target, name) !== 'function') {
      onMissing?.(name)
      continue
    }
    // The descriptor must be read before the assignment: afterwards it already
    // describes this patch and could never restore the stock method.
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    bag[name] = implementation
    slots.push({ name, descriptor, installed: implementation })
  }

  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const slot of slots) {
      // A later installer (or a later load of this plugin) may own the slot by
      // now; undoing its work would break it, so only undo our own assignment.
      if (bag[slot.name] !== slot.installed) continue
      if (slot.descriptor === undefined) {
        Reflect.deleteProperty(target, slot.name)
        continue
      }
      Object.defineProperty(target, slot.name, slot.descriptor)
    }
  }
}
