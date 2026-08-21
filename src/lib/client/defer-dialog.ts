/**
 * Open a modal on the next task after a Radix dropdown has fully closed.
 *
 * Opening both modal layers in the same selection event can leave the
 * dropdown's document-level pointer lock behind when the dialog later closes,
 * making the page look frozen even though the save succeeded.
 */
export function deferDialogFromDropdown(open: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(open, 0)
}
