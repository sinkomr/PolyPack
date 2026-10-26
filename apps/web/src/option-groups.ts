/**
 * Options of a select, in groups where they name one (an <optgroup> per run of options with the same
 * group, in their order): the surface solids are grouped into Platonic, Catalan, prisms, antiprisms.
 */
export function addOptions(select: HTMLSelectElement, options: readonly { value: string; text: string; group?: string }[]): void {
  let group: HTMLOptGroupElement | null = null;
  for (const o of options) {
    const option = new Option(o.text, o.value);
    if (o.group === undefined) {
      group = null;
      select.add(option);
      continue;
    }
    if (!group || group.label !== o.group) {
      group = document.createElement("optgroup");
      group.label = o.group;
      select.append(group);
    }
    group.append(option);
  }
}
