import { loadKZG } from 'kzg-wasm'

let pending

export async function loadNodeKzg() {
  pending ??= loadKZG()
  return pending
}

export function resetNodeKzgForTests() {
  pending = undefined
}
