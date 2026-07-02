/** Test-fixture client plugin: marks the page so tests/browsers can see it mounted. */
export function mount({ addon, root }) {
  root.dataset.mounted = addon.id;
}
